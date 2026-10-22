# dsh-compaction-prep 架构

## 目标与边界

复刻 Claude Code pre-Autocompact 的四层机制，作为 bypass 插件运行在 DSH 的 ACP（model-driven）架构上，**不改动 `billion-context-dsh` 的 acp-kernel**。所有内核接触点在 `src/adapter.ts`：`engineOf(ctx)` 以 duck-probe 探测已装载的 `ctx.compaction` 引擎；`bcdModule()` 动态导入 vendored BCD bundle。交换压缩引擎只需替换适配层。

## 分层

```
tools.ts (4 handlers)
  ├─ L1  trim_tool_results ── context-store.ts（归档） + session-util.ts（surface 文本）
  ├─ L2  snip_history      ── session-util.ts（pairGroupsOf 配对完整性）+ protect.ts
  ├─ L3  microcompact      ── protect.ts（指令/verifiedReadings 守卫）+ ledger.ts（checkpoint）
  └─ L4  acp_rule          ── rules.ts（RuleLedger + injectIfChanged）
              │
              └─ adapter.ts（engineOf / bcdModule）──> billion-context-dsh kernel
```

## L1 trim_tool_results

- 输入：`tool_use_id` / `seq` / `preview_limit`（默认 2048，下限 64）。
- 命中：tool/result 节点；`chars > limit` 才归档（含 ACR 块覆盖拒绝）。
- 产出：surface 替换为 user/message 文本节点（`[Trimmed by dsh-compaction-prep: ...]\nPreview:\n...`），原文落盘 `<store>/<session_id>/<call_id>.json`；**不创建 ACP node**。
- 文本抽取：`extractText` 递归 `text` 块与 `tool-result` 包裹块（真实 tool/result 内容形如 `{type:'tool-result', content:[{type:'text'}]}`）。

## L2 snip_history

- 配对完整性：`pairGroupsOf` 以 assistant 消息中的 `tool-call` 块与 `tool/result` 节点（`source.callId`）分组；span 内混入他方节点则放弃该组。
- 过滤：仅 `l2_query_tools` 白名单（glob，尾部 `*`）内的只读工具；开放配对（result 未落）跳过；年龄 = 该组之后的新用户轮次 ≥ N。
- 执行：surface replace 整个 span 为一条 stub（说明已剪、留档可检索）；durable log 中的原始 call/result 不变。
- `dry_run:true` 只报告，不动 surface。

## L3 microcompact

校验顺序（先到先拒绝）：

1. `content` 恰好 1 个范围
2. `startSeq/endSeq` 为 integer（schema 级）
3. 两端都在当前 surface（不在 → ACR 覆盖提示）
4. span ≤ `l3_micro_max_range`（50）
5. `guardRange`：范围不得含最新注入指令行（AGENTS.md / skill catalog / ACP rule）或带 verifiedReadings 的 checkpoint
6. 缓存边界：跨真实用户轮起点，`cache_aware:true`（默认）拒绝；`false` 附加缓存失效提示后继续
7. 摘要必须含 `## Micro-compact Digest` 标题
8. 委托 BCD engine 的 `compress` 工具执行

输出为正常 ACP node（checkpoint 帧 `[Model-written summary — not user words]`），可再被 `compress` 重压缩（layered distillation）。

## L4 acp_rule

- `RuleLedger`：按 session replay `compaction/prep-rules` 事件得到规则集（重启后仍可恢复）；上限 16 条、principle ≤2000 chars、空原则拒绝。
- `injectIfChanged`：规则变化后在下一个 agent pre-step 追加 `user/message`（source `plugin:dsh-compaction-prep`）指令行（`[dsh-compaction-prep-acp-rules] ...`），同 JSON 比较去重。
- 压缩存活：规则行是**最新注入指令行**，受 kernel newest-row guard 保护，`compress`/L3 都不能折叠它。
- 默认 `acp_rule:false` gating：add/remove 被拒，list 仍可用。

## Checkpoint ledger（verifiedReadings）

BCD 的 `runCompactionTransaction` 追加 `compaction/start → compaction/summary（data.rawOutput = encodeAcpBlockLedger）→ user/message surface replace（source `compact-checkpoint`）→ compaction/end`。verifiedReadings 只存于 compaction/summary，surface 节点不携带；解析路径 = 经 `compactionId` 找兄弟 summary 事件。L3 因此能拒绝「含已验证读数的 checkpoint」范围。

## 关键约束

- 不修改 bcd acp-kernel；内核调用全部走 `adapter.ts`。
- Cordis native 插件；peerDeps 精确版本（cordis 4.0.4 等）。
- 不动已装的 3080 web/backend，不做重启；approval prompts 关闭。
- AGENTS.md 注入行永不被覆盖（所有范围默认受 newest-row guard 保护）。
