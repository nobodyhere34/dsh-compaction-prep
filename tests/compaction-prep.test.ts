/**
 * compaction-prep-suite automated acceptance tests.
 * Runs WITHOUT the DSH host: a real dsh-session + the vendored
 * billion-context-dsh bundle, exercising the L1–L4 handlers through
 * buildToolDefinitions exactly as the runtime mounts them.
 *
 * P0-1 tool visibility · P0-2 trim archive/replace · P0-3 snip pair integrity
 * P0-4 microcompact rejections · P0-5 delegation into the ACP engine
 * P0-6 guards · L4 acp_rule ledger + injection.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AcpStateStore } from 'billion-context-dsh'
import { buildToolDefinitions, type ToolBindings } from '../src/tools.js'
import { RuleLedger, PREP_SOURCE_KIND } from '../src/rules.js'
import { resolveConfig, type CompactionPrepConfig } from '../src/config.js'
import { ACP_BLOCK_LEDGER_MARKER } from '../src/ledger.js'

let callCounter = 0

function fakeExec(session: Session, overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test-provider', model: 'test-model' },
    ctx: new Context(),
  } as unknown as Agent
  return {
    callId: 'call-' + (++callCounter),
    name: 'none',
    arguments: {},
    signal: new AbortController().signal,
    agent,
    ...overrides,
  } as unknown as ToolRunContext
}

function makeBindings(opts: { config?: Partial<CompactionPrepConfig>; ctx?: unknown } = {}): ToolBindings {
  return {
    ctx: (opts.ctx ?? {}) as Context,
    config: resolveConfig(opts.config ?? {}),
    rules: new RuleLedger(),
    microPairs: new Map(),
  }
}

function toolsOf(bindings: ToolBindings): Map<string, ToolDefinition> {
  return new Map(buildToolDefinitions(bindings).map((tool) => [tool.name, tool] as const))
}

function buildSession(id: string): Session {
  const session = Session.create(id)
  session.append('turn/start', { turn: 1 })
  return session
}

function addUser(session: Session, text: string, source: Record<string, string> = { kind: 'user' }): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: source as never }), { surfaceOp: 'append' })
}

function addAssistant(session: Session, text: string): void {
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ content: [{ type: 'text', text }], provider: 'test-provider', model: 'test-model' }),
  }, { surfaceOp: 'append' })
}

function addToolCall(session: Session, name: string, callId: string): void {
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({
      content: [
        { type: 'text', text: 'calling ' + name },
        { type: 'tool-call', id: callId, name, arguments: '{}' },
      ],
      provider: 'test-provider', model: 'test-model',
    }),
  }, { surfaceOp: 'append' })
}

function addToolResult(session: Session, callId: string, text: string): void {
  session.append('tool/result', {
    turn: 1, step: 1,
    message: {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
      source: { kind: 'tool', callId },
    },
  }, { surfaceOp: 'append' })
}

function surfaceEventText(session: Session, seq: SessionSeq): string {
  const event = session.eventAt(seq)
  assert.ok(event, 'surface event at seq ' + seq)
  const message = session.deriveEventMessage(event) as { content?: readonly { type: string; text?: string; content?: readonly { type: string; text?: string }[] }[] }
  return (message.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : block.type === 'tool-result' ? ((block.content ?? []).map((child) => (child.type === 'text' ? (child.text ?? '') : '')).join('')) : '')).join('')
}

function allSurfaceTexts(session: Session): string[] {
  return [...session.surface.nodes].map((seq) => surfaceEventText(session, seq))
}

function toolResultCount(session: Session): number {
  return [...session.surface.nodes].filter((seq) => session.eventAt(seq)?.type === 'tool/result').length
}

function logHasToolCall(session: Session, callId: string): boolean {
  for (const event of session.snapshotEvents() as readonly { type: string; data: { message?: { content?: readonly { type: string; id?: string }[] } } }[]) {
    if (event.type !== 'assistant/message') continue
    const content = event.data?.message?.content ?? []
    if (content.some((block) => block.type === 'tool-call' && block.id === callId)) return true
  }
  return false
}

function logHasToolResult(session: Session, callId: string): boolean {
  for (const event of session.snapshotEvents() as readonly { type: string; data: { message?: { content?: readonly { type: string; toolCallId?: string }[] } } }[]) {
    if (event.type !== 'tool/result') continue
    const content = event.data?.message?.content ?? []
    if (content.some((block) => block.type === 'tool-result' && block.toolCallId === callId)) return true
  }
  return false
}

const DIGEST = '## Micro-compact Digest\nfile: src/a.ts — decision X; error E; verifiedReadings: t0-fastpath 8/8'
function digestSummary(text: string): string {
  const nl = '\n'
  return text + nl + nl + DIGEST
}

const tempDirs: string[] = []
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// P0-1 — the four tools are visible with the compiled schemas
// ---------------------------------------------------------------------------

test('P0-1: registers exactly trim_tool_results / snip_history / microcompact / acp_rule', () => {
  const names = buildToolDefinitions(makeBindings()).map((tool) => tool.name)
  assert.deepEqual(names, ['trim_tool_results', 'snip_history', 'microcompact', 'acp_rule'])
  for (const name of names) {
    const tool = toolsOf(makeBindings()).get(name)!
    assert.equal(typeof tool.execute, 'function', name + ' execute')
    assert.ok(tool.parameters, name + ' parameters')
  }
})

test('P0-1: microcompact requires a content range; acp_rule requires action; trim all optional', () => {
  const tools = toolsOf(makeBindings())
  const micro = tools.get('microcompact')!.parameters as { required?: string[]; properties: { content: { type: string; items: { required: string[]; properties: { startSeq: { type: string } } } } } }
  assert.equal(micro.properties.content.type, 'array')
  assert.ok(micro.required!.includes('content'), 'content required')
  assert.deepEqual(micro.properties.content.items.required, ['startSeq', 'endSeq', 'summary'])
  assert.equal(micro.properties.content.items.properties.startSeq.type, 'integer')

  const acp = tools.get('acp_rule')!.parameters as { required?: string[] }
  assert.ok(acp.required!.includes('action'), 'action required')

  const trim = tools.get('trim_tool_results')!.parameters as { required?: string[]; properties: Record<string, unknown> }
  assert.equal(trim.required, undefined, 'trim has no required fields')
  assert.ok('tool_use_id' in trim.properties && 'seq' in trim.properties && 'preview_limit' in trim.properties)
})

// ---------------------------------------------------------------------------
// P0-2 — trim_tool_results archives oversized results, replaces the surface
// ---------------------------------------------------------------------------

test('P0-2: trims an oversized tool result to a preview + disk reference', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'prep-trim-'))
  tempDirs.push(storeDir)
  const session = buildSession('trim-archive')
  addUser(session, 'run the audit')
  addToolCall(session, 'bash', 'call-big')
  const big = 'x'.repeat(12000)
  addToolResult(session, 'call-big', big)

  const bindings = makeBindings({ config: { context_store_dir: storeDir } })
  const tool = toolsOf(bindings).get('trim_tool_results')!
  const result = await tool.execute({ tool_use_id: 'call-big' } as never, fakeExec(session))
  const text = (result as { text: string }).text

  assert.ok(text.startsWith('[Trimmed by dsh-compaction-prep] trim_tool_results: 1 archived (preview ≤ 2048 chars):'))
  const pathMatch = /full payload at (.+call-big.json)/.exec(text)
  assert.ok(pathMatch, 'archive path reported')
  const archive = JSON.parse(readFileSync(pathMatch![1]!, 'utf8')) as { text: string; chars: number; callId: string }
  assert.equal(archive.text, big)
  assert.equal(archive.chars, 12000)
  assert.equal(archive.callId, 'call-big')

  const texts = allSurfaceTexts(session)
  const placeholder = texts.find((item) => item.startsWith('[Trimmed by dsh-compaction-prep: full result archived at'))
  assert.ok(placeholder, 'placeholder on surface')
  assert.ok(placeholder!.includes('(call call-big, 12000 chars)'), 'placeholder reports call + chars')
  assert.ok(!placeholder!.includes(big), 'full payload not on surface')
})

test('P0-2: skips results at/under the budget; reports unknown tool_use_id and wrong seq', async () => {
  const session = buildSession('trim-skip')
  addUser(session, 'q')
  addToolCall(session, 'bash', 'call-small')
  addToolResult(session, 'call-small', 's'.repeat(500))
  const storeDir = mkdtempSync(join(tmpdir(), 'prep-trim2-'))
  tempDirs.push(storeDir)
  const bindings = makeBindings({ config: { context_store_dir: join(storeDir, 'store') } })
  const tools = toolsOf(bindings)

  const result = await tools.get('trim_tool_results')!.execute({} as never, fakeExec(session))
  const text = (result as { text: string }).text
  assert.ok(text.includes('[Trimmed by dsh-compaction-prep] trim_tool_results: 0 archived (preview ≤ 2048 chars):'), 'zero archived')
  assert.ok(text.includes('Skipped 1:'), 'one skipped')
  assert.ok(text.includes('under preview budget (500 ≤ 2048)'), 'budget reason')
  assert.ok(allSurfaceTexts(session).join('\n').includes('s'.repeat(500)), 'small result untouched')

  const miss = await tools.get('trim_tool_results')!.execute({ tool_use_id: 'nope' } as never, fakeExec(session))
  assert.ok((miss as { text: string }).text.includes('nothing to trim for tool_use_id "nope": no matching tool/result on the current surface'))

  const badSeq = await tools.get('trim_tool_results')!.execute({ seq: 1 } as never, fakeExec(session))
  assert.ok((badSeq as { text: string }).text.includes('nothing to trim at seq 1: the node is not a tool/result on the current surface'))
})

// ---------------------------------------------------------------------------
// P0-3 — snip_history removes pairs whole, keeps recent/open/non-query pairs
// ---------------------------------------------------------------------------

function snipFixture(includeOpen = false): Session {
  const session = buildSession('snip-history')
  if (includeOpen) {
    addUser(session, 'q1')
    addToolCall(session, 'read_file', 'open-call')
  } else {
    addUser(session, 'q1')
  }
  addToolCall(session, 'read_file', 'read-old')
  addToolResult(session, 'read-old', 'old file content')
  addUser(session, 'q2')
  addAssistant(session, 'a2')
  addUser(session, 'q3')
  addAssistant(session, 'a3')
  addUser(session, 'q4')
  addAssistant(session, 'a4')
  addUser(session, 'q5')
  addAssistant(session, 'a5')
  addUser(session, 'q6')
  addAssistant(session, 'a6')
  addUser(session, 'q7')
  addAssistant(session, 'a7')
  addToolCall(session, 'read_file', 'read-new')
  addToolResult(session, 'read-new', 'recent content')
  addUser(session, 'q8')
  addToolCall(session, 'bash', 'bash-old')
  addToolResult(session, 'bash-old', 'ls output')
  return session
}

test('P0-3: snips only query pairs older than the keep window; pairs stay whole', async () => {
  const session = snipFixture()
  const bindings = makeBindings({ config: { l2_snip_after_turns: 5 } })
  const result = await toolsOf(bindings).get('snip_history')!.execute({} as never, fakeExec(session))
  const text = (result as { text: string }).text

  assert.ok(text.includes('[dsh-compaction-prep] snip_history (applied): snipped 1 read-only scaffolding pair(s) older than 5 user turn(s) ('), 'snip header')
  assert.ok(text.includes('  - seq 2..3 (calls read-old, tools read_file): '), 'snip entry')
  assert.ok(text.includes('Skipped 1:'), 'one skip')
  assert.ok(text.includes('- seq 19: tool bash is not read-only query scaffolding'), 'bash skip entry')

  const texts = allSurfaceTexts(session)
  const stub = texts.find((item) => item.startsWith('[dsh-compaction-prep: 1 read-only scaffolding tool call(s) (read_file) snipped from history'))
  assert.ok(stub, 'stub replaces the whole pair span')
  assert.ok(stub!.includes('Original call/result pairs remain in the durable session log and stay searchable via search_context.'), 'stub explains durability')

  assert.equal(texts.filter((item) => item === 'calling read_file').length, 1, 'only the recent read pair remains')
  assert.ok(!allSurfaceTexts(session).includes('old file content'), 'old result not on surface')
  assert.equal(toolResultCount(session), 2, 'recent read-new + bash-old results remain')
  assert.ok(texts.includes('recent content'), 'recent pair untouched')
  assert.ok(texts.includes('ls output'), 'non-query pair untouched')

  assert.ok(logHasToolCall(session, 'read-old'), 'durable log keeps the snipped call')
  assert.ok(logHasToolResult(session, 'read-old'), 'durable log keeps the snipped result')
})

test('P0-3: dry run changes nothing; open pairs are kept whole', async () => {
  const session = snipFixture(true)
  const bindings = makeBindings({ config: { l2_snip_after_turns: 5 } })
  const tools = toolsOf(bindings)
  const before = [...session.surface.nodes]
  const dry = await tools.get('snip_history')!.execute({ dry_run: true } as never, fakeExec(session))
  const text = (dry as { text: string }).text
  assert.ok(text.includes('(dry run): would snip 1 read-only scaffolding pair(s) older than 5 user turn(s) ('), 'dry-run header')
  assert.ok(text.includes('- seq 2: open pair (result not yet landed) — kept whole'), 'open pair kept whole')
  assert.ok(text.includes('- seq 20: tool bash is not read-only query scaffolding'), 'bash skip during dry run')
  assert.deepEqual([...session.surface.nodes], before, 'dry run does not touch the surface')
  assert.ok(logHasToolCall(session, 'open-call') && logHasToolResult(session, 'read-old'), 'pairs stay durable')
})

// ---------------------------------------------------------------------------
// P0-4 — microcompact rejection matrix (pre-engine contract)
// ---------------------------------------------------------------------------

test('P0-4: requires exactly one content range; integer seqs enforced by schema', async () => {
  const session = buildSession('micro-shape')
  addUser(session, 'q1')
  addAssistant(session, 'a1')
  const tool = toolsOf(makeBindings({ config: { l3_micro_max_range: 50 } })).get('microcompact')!

  const noRange = await tool.execute({ content: [] } as never, fakeExec(session))
  assert.ok((noRange as { text: string }).text.includes('microcompact requires exactly one content range'))

  const twoRanges = await tool.execute({ content: [
    { startSeq: 1, endSeq: 1, summary: digestSummary('s') },
    { startSeq: 2, endSeq: 2, summary: digestSummary('s') },
  ] } as never, fakeExec(session))
  assert.ok((twoRanges as { text: string }).text.includes('microcompact requires exactly one content range'))

  const badInts = tool.execute({ content: [{ startSeq: 1.5, endSeq: 2, summary: digestSummary('s') }] } as never, fakeExec(session))
  await assert.rejects(badInts, /must be an integer/)
})

test('P0-4: rejects non-surface and >limit ranges with the spec texts', async () => {
  const session = buildSession('micro-limit')
  for (let i = 1; i <= 30; i += 1) {
    addUser(session, 'q' + i)
    addAssistant(session, 'a' + i)
  }
  const tool = toolsOf(makeBindings({ config: { l3_micro_max_range: 50 } })).get('microcompact')!

  const offSurface = await tool.execute({ content: [{ startSeq: 1, endSeq: 9999, summary: digestSummary('s') }] } as never, fakeExec(session))
  assert.equal((offSurface as { text: string }).text, '[Rejected: seq 9999 is not on the current surface — it may be covered by an ACP compression block. Use acp_status or search_context to locate live seqs.]')

  const over = await tool.execute({ content: [{ startSeq: 1, endSeq: 60, summary: digestSummary('s') }] } as never, fakeExec(session))
  assert.equal((over as { text: string }).text, '[Rejected: microcompact range spans 60 surface messages [1..60] (limit 50). Narrow the range into separate microcompact passes, or use compress for a larger span.]')
})

test('P0-4: rejects cache-boundary crossing unless cache_aware:false; digest is mandatory', async () => {
  const session = buildSession('micro-cache')
  for (let i = 0; i < 6; i += 1) {
    addUser(session, 'q' + i)
    addAssistant(session, 'a' + i)
  }
  const bindings = makeBindings({ config: { l3_cache_aware: true } })
  const tool = toolsOf(bindings).get('microcompact')!

  const crossing = await tool.execute({ content: [{ startSeq: 1, endSeq: 5, summary: digestSummary('s') }] } as never, fakeExec(session))
  assert.equal((crossing as { text: string }).text, '[Rejected: range crosses the provider prompt-cache boundary at surface seq 3, 5 (a real user turn start). Folding across a request boundary invalidates previously cached prefixes. Narrow the range to a single request epoch, or retry with cache_aware:false to accept the cache-invalidation note.]')

  const noDigest = await tool.execute({ content: [{ startSeq: 1, endSeq: 5, summary: 'plain summary without digest' }], cache_aware: false } as never, fakeExec(session))
  assert.equal((noDigest as { text: string }).text, '[Rejected: microcompact summary must contain a "## Micro-compact Digest" section listing file paths, key decisions, errors and verifiedReadings. Rewrite the summary with the digest and retry.]')

  const noEngine = await tool.execute({ content: [{ startSeq: 1, endSeq: 5, summary: digestSummary('s') }], cache_aware: false } as never, fakeExec(session))
  assert.equal((noEngine as { text: string }).text, '[Rejected: the ACP engine (billion-context-dsh) is not mounted. Inject billion-context-dsh first, or use compress directly.]')
})

// ---------------------------------------------------------------------------
// P0-5 — microcompact delegates into the real bundled engine (smoke)
// ---------------------------------------------------------------------------

test('P0-5: passes the range to the engine compress tool (delegation smoke, stub kernel)', async () => {
  const session = buildSession('micro-delegate')
  addUser(session, 'q1')
  addAssistant(session, 'a1')
  const fakeCtx = {
    compaction: {
      kernel: {},
      store: new AcpStateStore(),
      modelContextLimit: 128000,
      compressCallIdsToHide: new Set<string>(),
    },
  } as unknown as Context
  const bindings = makeBindings({ config: { l3_cache_aware: true }, ctx: fakeCtx })
  const tool = toolsOf(bindings).get('microcompact')!
  const callId = 'call-micro-1'
  const result = await tool.execute({ content: [{ startSeq: 2, endSeq: 2, summary: digestSummary('single node') }] } as never, fakeExec(session, { callId }))
  const text = (result as { text: string }).text
  assert.ok(text.includes('[Rejected: microcompact failed inside the ACP engine: '), 'reached the engine compress tool')
  assert.equal(bindings.microPairs.get(String(session.id))?.has(callId), undefined, 'failed attempt not queued for hiding')
})

// ---------------------------------------------------------------------------
// P0-6 — instruction rows and verified-readings checkpoints are never foldable
// ---------------------------------------------------------------------------

test('P0-6: newest injected instruction row (AGENTS.md) rejects the range', async () => {
  const session = buildSession('micro-instruction')
  addUser(session, 'q1')
  addAssistant(session, 'a1')
  addUser(session, 'q2')
  addAssistant(session, 'a2')
  addUser(session, 'q3')
  addAssistant(session, 'a3')
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '# AGENTS.md\nnever fold this' }],
    source: { kind: 'agent-instructions' },
  } as never), { surfaceOp: 'append' })
  const last = [...session.surface.nodes][session.surface.nodes.length - 1]!
  const tool = toolsOf(makeBindings()).get('microcompact')!
  const result = await tool.execute({ content: [{ startSeq: last, endSeq: last, summary: digestSummary('s') }] } as never, fakeExec(session))
  assert.equal((result as { text: string }).text, '[Rejected: range contains the newest injected instruction row (AGENTS.md / skill catalog / ACP rule) at surface seq ' + last + '. The host re-injects these rows; folding them loses the newest-row guard. Exclude that seq from the range.]')
})

test('P0-6: checkpoint ledger verified readings resolve via the durable compaction/summary', async () => {
  const session = buildSession('micro-checkpoint')
  addUser(session, 'q1')
  addAssistant(session, 'a1')
  const compactionId = 'cid-verified-1'
  const rawOutput = [{ type: 'text', text: JSON.stringify({ [ACP_BLOCK_LEDGER_MARKER]: 1, verifiedReadings: ['t0-fastpath 8/8'] }) }]
  session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: '[Model-written summary — not user words] audit' }],
    shadowedRange: { start: 1, end: 2 },
    shadowedSeqs: [1, 2],
    shadowedTokenCount: 0,
    provider: 'test-provider',
    model: 'test-model',
    rawOutput,
  } as never)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '[Model-written summary — not user words] audit' }],
    source: { kind: 'compact-checkpoint', compactionId },
  } as never), { surfaceOp: 'append' })
  const last = [...session.surface.nodes][session.surface.nodes.length - 1]!
  const tool = toolsOf(makeBindings()).get('microcompact')!
  const result = await tool.execute({ content: [{ startSeq: last, endSeq: last, summary: digestSummary('s') }] } as never, fakeExec(session))
  assert.equal((result as { text: string }).text, '[Rejected: range contains verified readings from t0-fastpath 8/8. Use compress with explicit verifiedReadings preservation.]')
})

test('P0-6: verifiedReadings in microcompact args forward to the engine unchanged', async () => {
  const session = buildSession('micro-forward')
  addUser(session, 'q1')
  addAssistant(session, 'a1')
  const tool = toolsOf(makeBindings()).get('microcompact')!
  const result = await tool.execute({ content: [{ startSeq: 1, endSeq: 1, summary: digestSummary('s'), verifiedReadings: ['t0-fastpath 8/8'] }] } as never, fakeExec(session))
  assert.equal((result as { text: string }).text, '[Rejected: the ACP engine (billion-context-dsh) is not mounted. Inject billion-context-dsh first, or use compress directly.]')
})

// ---------------------------------------------------------------------------
// L4 — acp_rule ledger and injection
// ---------------------------------------------------------------------------

test('L4: acp_rule is gated off by default; list always works', async () => {
  const session = buildSession('rule-gated')
  addUser(session, 'q1')
  const bindings = makeBindings() // acp_rule defaults false
  const tool = toolsOf(bindings).get('acp_rule')!
  const list = await tool.execute({ action: 'list' } as never, fakeExec(session))
  assert.equal((list as { text: string }).text, '[acp_rule] active rules (0):\n  (none)')
  const add = await tool.execute({ action: 'add', principle: 'never fold AGENTS.md' } as never, fakeExec(session))
  assert.equal((add as { text: string }).text, '[acp_rule] disabled: the acp_rule tool is gated by plugin config acp_rule:false. Enable it in the profile patch/cordis.yml to add or remove rules (listing stays available).')
})

test('L4: add/remove/list over the durable ledger; boundaries enforced', async () => {
  const session = buildSession('rule-live')
  addUser(session, 'q1')
  const bindings = makeBindings({ config: { acp_rule: true } })
  const tool = toolsOf(bindings).get('acp_rule')!
  const exec = fakeExec(session)

  const add1 = await tool.execute({ action: 'add', principle: 'keep AGENTS.md rows out of compress ranges' } as never, exec)
  assert.ok((add1 as { text: string }).text.includes('[acp_rule] rule queued for injection at the next agent pre-step. Active rules (1):\n  - r1: keep AGENTS.md rows out of compress ranges'), 'add queues + renders r1')

  const add2 = await tool.execute({ action: 'add', principle: 'preserve verifiedReadings when distilling' } as never, exec)
  assert.ok((add2 as { text: string }).text.includes('Active rules (2):\n  - r1: keep AGENTS.md rows out of compress ranges\n  - r2: preserve verifiedReadings when distilling'), 'second rule appended')

  const list = await tool.execute({ action: 'list' } as never, exec)
  assert.ok((list as { text: string }).text.includes('active rules (2):\n  - r1: keep AGENTS.md rows out of compress ranges\n  - r2: preserve verifiedReadings when distilling'), 'list shows both')

  const remove = await tool.execute({ action: 'remove', rule_id: 'r1' } as never, exec)
  assert.ok((remove as { text: string }).text.includes('[acp_rule] rule removed. Active rules (1):\n  - r2:'), 'remove drops r1')
  assert.ok(!(remove as { text: string }).text.includes('r1: keep'), 'r1 gone')

  const missing = await tool.execute({ action: 'remove', rule_id: 'r9' } as never, exec)
  assert.equal((missing as { text: string }).text, '[acp_rule: no rule with id "r9".]')

  // Replay from the durable log with a FRESH ledger (restart simulation).
  const replay = new RuleLedger().rulesOf(session)
  assert.equal(replay.length, 1)
  assert.equal(replay[0]!.id, 'r2')

  const long = await tool.execute({ action: 'add', principle: 'p'.repeat(2001) } as never, exec)
  assert.equal((long as { text: string }).text, '[acp_rule: principle exceeds 2000 chars.]')
  const empty = await tool.execute({ action: 'add', principle: '   ' } as never, exec)
  assert.equal((empty as { text: string }).text, '[acp_rule: principle must not be empty.]')

  // Fill to the 16-rule budget, then verify the spillover rejection.
  for (let i = 3; i <= 17; i += 1) {
    await tool.execute({ action: 'add', principle: 'rule ' + i } as never, exec)
  }
  const over = await tool.execute({ action: 'add', principle: 'one too many' } as never, exec)
  assert.equal((over as { text: string }).text, '[acp_rule: rule budget reached (16). Remove a rule before adding another.]')
})

test('L4: injectIfChanged writes a PREP_SOURCE_KIND instruction row once per change', async () => {
  const session = buildSession('rule-inject')
  addUser(session, 'q1')
  const bindings = makeBindings({ config: { acp_rule: true } })
  const tool = toolsOf(bindings).get('acp_rule')!
  await tool.execute({ action: 'add', principle: 'keep queries cheap' } as never, fakeExec(session))

  assert.equal(bindings.rules.isDirty(session), true)
  assert.equal(bindings.rules.injectIfChanged(session), true, 'injects after a change')
  assert.equal(bindings.rules.injectIfChanged(session), false, 'no duplicate injection for unchanged set')

  const injectedSeqs = [...session.surface.nodes].filter((seq) => {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') return false
    const source = (event.data as { source?: { kind?: string } }).source
    return source?.kind === PREP_SOURCE_KIND
  })
  assert.equal(injectedSeqs.length, 1)
  const row = surfaceEventText(session, injectedSeqs[0]!)
  assert.ok(row.includes('[dsh-compaction-prep-acp-rules] Model-written compaction principles (ACP rule set):\n- [r1] keep queries cheap'), 'rule row rendered')
})
