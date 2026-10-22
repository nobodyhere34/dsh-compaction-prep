# dsh-compaction-prep（compaction-prep-suite）

在 DSH（DeepSeek Harness）上、基于 `billion-context-dsh`（BCD）的 **ACP（model-driven）架构**下，以 bypass 插件复刻 **Claude Code pre-Autocompact 多步机制** 的压缩前置套件。它不改动 BCD 的 acp-kernel，所有内核调用经适配层隔离。

> **关系说明**：本仓库是 `billion-context-dsh`（BCD）的**独立配套插件**，不是代码 fork。`dsh-compaction-prep` 通过 `src/adapter.ts` 在运行时探测并调用 BCD 的 ACP 引擎，不修改其内核；联合安装时只需安装本插件，BCD 作为依赖自动带入。上游工程：https://github.com/Tyan66666/billion-context-dsh 。

## 联合安装（与 billion-context-dsh）

```bash
# 0) 先为 BCD 的精确版本授予兼容豁免（BCD 0.2.27 的 peer 声明早于当前 0.2.1 线，插件管理器会连同依赖一起做兼容检查）
dsh plugin --profile web allow-version billion-context-dsh@0.2.27 --dsh-version 0.2.1-rc.2 --accept-risk
#    把最后的 0.2.1-rc.2 换成你的 dsh 运行时版本（dsh --version）

# 方式 A：GitHub tag（推荐；lib 已提交，无需现场构建）
dsh plugin --profile web add 'github:nobodyhere34/dsh-compaction-prep#v0.1.1'

# 方式 B：Release tgz
dsh plugin --profile web add 'https://github.com/nobodyhere34/dsh-compaction-prep/releases/download/v0.1.1/dsh-compaction-prep-0.1.1.tgz'
```

- 本插件的 bundle patch 会禁用内置 `compaction-basic`，并插入 `compaction-acp`（`billion-context-dsh`）+ `compaction-prep-suite`（本插件，含 config）。
- **不要再单独安装 `billion-context-dsh` 的 bundle**：两者都会插入 `compaction-acp`，重复 loader id 会被拒绝；BCD 已由本插件依赖自动安装（npm `billion-context-dsh@0.2.27`）。
- 只有“只要 BCD 引擎、不要 prep 套件”时才单独安装 `billion-context-dsh`，二者互斥。


## 提供的工具

| 工具 | 层级 | 作用 |
| --- | --- | --- |
| `trim_tool_results` | L1 | 超大工具结果裁剪为「磁盘引用 + 短预览」，替换 surface 节点 |
| `snip_history` | L2 | 移除只读脚手架 tool 消息（call/result 配对整体移除，早于最近 N=5 轮），保持配对完整 |
| `microcompact` | L3 | 小范围（≤50 msgs）模型摘要压缩，要求 `## Micro-compact Digest`，可跨缓存边界（需 `cache_aware:false`） |
| `acp_rule` | L4 | model-written 分级压缩原则（principle），持久化于 session log，pre-step 注入为最新指令行 |

默认配置见 [src/config.ts](src/config.ts)：`l1_preview_limit: 2048`、`l2_snip_after_turns: 5`、`l3_micro_max_range: 50`、`l3_cache_aware: true`、`acp_rule: false`（默认关闭，需显式开启）、`context_store_dir: ~/.dsh/context-store`。

## 安装

### 方式一：profile patch（持久）
见 [cordis.patch.yml](cordis.patch.yml) —— 禁用内置 `compaction-basic`，装载 `billion-context-dsh` 与 `dsh-compaction-prep`（含 config 段）。

### 方式二：运行时注入（免重启）
```bash
# 先注入 ACP 引擎，再注入本套件
dev_inject_plugin --dir /path/to/billion-context-dsh
dev_inject_plugin --dir /path/to/dsh-compaction-prep
```
> 约束：不重启 dsh web/backend、不动 3080 端口；approval prompts 保持关闭（不设置 `sandbox_permissions`）。

## 行为要点

- **L1 trim**：仅 surface 级，**不产生 ACP node**；若该 node 已被 ACP 压缩块覆盖则拒绝；全量载荷落盘 `<context_store_dir>/<session_id>/<tool_use_id>.json`，surface 上保留预览 + 路径。
- **L2 snip**：只处理 `l2_query_tools` 白名单内的只读脚手架；同一 call/result 配对必须整体移除（可先 `dry_run: true` 预览）；被剪节点在 durable session log 保留，`search_context` 可检索。
- **L3 microcompact**：校验链（单 range → integer seq → surface membership → ≤50 → 指令行/verifiedReadings 守卫 → 缓存边界 → digest → 交 BCD engine）。`cache_aware:false` 接受缓存失效提示；摘要须含 `## Micro-compact Digest`。
- **L4 acp_rule**：上限 16 条、principle ≤2000 chars；rule 以 `compaction/prep-rules` 事件持久化，`injectIfChanged` 在下一个 agent pre-step 注入（source kind `plugin:dsh-compaction-prep`），压缩后自动重新注入（newest-row guard 保护）。
- **保护**：`acp_rule` 工具默认 gated 关闭（仅 list 可用）；含 verifiedReadings 的范围一律拒绝（改用 `compress` 显式保留）；最新注入指令行（AGENTS.md / skill catalog / ACP rule）永不被折叠。

## 测试

16 个自动化验收用例（无 host 直跑源码）：`bash scripts/test.sh`（需要 `$DSH_CHECKOUT` 提供 tsx）。

```bash
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/test.sh   # 16/16 pass
```

覆盖：P0-1 工具可见性 · P0-2 trim 归档/替换 · P0-3 snip 配对完整 · P0-4 microcompact 拒绝矩阵 · P0-5 BCD 委托（stub kernel） · P0-6 指令行/verifiedReadings 守卫 · L4 规则账本与注入。

## 目录

- `src/tools.ts` — 四个工具定义与 handler
- `src/session-util.ts` — surface/log 帮助（文本抽取、配对分组）
- `src/protect.ts` — 指令行与 verifiedReadings 守卫
- `src/ledger.ts` — ACP checkpoint ledger（verifiedReadings 解析）
- `src/context-store.ts` — L1 归档存储
- `src/rules.ts` — L4 规则账本 + pre-step 注入
- `src/adapter.ts` — **唯一**触及 BCD 的适配层（engineOf / bcdModule）
- `tests/compaction-prep.test.ts` — 验收套件
- `ARCHITECTURE.md` — 架构说明
