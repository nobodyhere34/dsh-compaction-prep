import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
import { PREP_SOURCE_KIND, RuleLedger } from './rules.js'
import type { AcpRule, AcpRuleArgs, MicroCompactArgs, SnipArgs, SnippedEntry, TrimArgs, TrimmedEntry } from './types.js'
import { compressToolOf, engineOf } from './adapter.js'
import { archiveToolResult, ensureStoreDir, resolveStoreDir } from './context-store.js'
import { guardRange, cacheBoundarySeqsOf } from './protect.js'
import {
  codePointLength,
  contentBlocksOfEvent,
  extractText,
  globsMatch,
  pairGroupsOf,
  resultCallIdOf,
  surfaceNodesOf,
} from './session-util.js'
import type { CompactionPrepConfig } from './config.js'

/** Everything the L1–L4 handlers need from the plugin runtime. */
export interface ToolBindings {
  readonly ctx: Context
  readonly config: CompactionPrepConfig
  readonly rules: RuleLedger
  /** callIds of in-flight microcompact executions, keyed by session id; hidden at the next pre-step. */
  readonly microPairs: Map<string, Set<string>>
}

/** Tool-text output wrapper (same shape the ACP engine uses). */
function textOutput(): {
  schema: { type: 'object'; properties: { text: { type: 'string' } }; additionalProperties: boolean }
  render: (args: unknown, value: { text: string }) => ContentBlock[]
} {
  return {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

function requireAgent(exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (!agent) throw new Error('dsh-compaction-prep: this tool must run inside an agent loop with a session.')
  return agent
}

function sessionOf(exec: ToolRunContext): Session {
  return requireAgent(exec).session
}

/** First N code points, with a trailing marker when truncated. */
function previewText(text: string, limit: number): string {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  return chars.slice(0, limit).join('') + '\n…[preview truncated]'
}

/** Text of an assistant/message node (its message.content). */
function assistantTextOf(event: SessionEvent<'assistant/message'>): string {
  return event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

// ---------------------------------------------------------------------------
// L1 trim_tool_results
// ---------------------------------------------------------------------------

const trimParameters = {
  tool_use_id: {
    type: 'string' as const,
    description: 'Optional: trim only the tool result answered for this tool_use call id.',
  },
  seq: {
    type: 'number' as const,
    description: 'Optional: trim only the tool/result surface node at this seq.',
  },
  preview_limit: {
    type: 'number' as const,
    description: 'Optional preview budget in chars (default: plugin l1_preview_limit, 2048).',
  },
}

async function handleTrim(bindings: ToolBindings, args: TrimArgs, exec: ToolRunContext): Promise<{ text: string }> {
  const session = sessionOf(exec)
  const limit = Math.max(64, Math.floor(args.preview_limit ?? bindings.config.l1_preview_limit))
  const engine = engineOf(bindings.ctx)
  const hiddenIds = engine?.compressCallIdsToHide
  const storeDir = resolveStoreDir(bindings.config.context_store_dir)
  await ensureStoreDir(storeDir)

  const entries: TrimmedEntry[] = []
  const skipped: { seq: SessionSeq; reason: string }[] = []

  let candidates: { seq: SessionSeq; event: SessionEvent<'tool/result'> }[] = []
  for (const event of surfaceNodesOf(session)) {
    if (event.type !== 'tool/result') continue
    candidates.push({ seq: event.seq, event })
  }
  if (args.tool_use_id !== undefined) {
    const wanted = args.tool_use_id
    candidates = candidates.filter(({ event }) => resultCallIdOf(event) === wanted)
    if (candidates.length === 0) {
      return { text: '[Trimmed by dsh-compaction-prep] nothing to trim for tool_use_id "' + wanted + '": no matching tool/result on the current surface (it may be covered by an ACP compression block, or never ran).' }
    }
  }
  if (args.seq !== undefined) {
    const wanted = args.seq
    candidates = candidates.filter(({ seq }) => seq === wanted)
    if (candidates.length === 0) {
      return { text: '[Trimmed by dsh-compaction-prep] nothing to trim at seq ' + wanted + ': the node is not a tool/result on the current surface (it may be covered by an ACP compression block).' }
    }
  }

  for (const { seq, event } of candidates) {
    const callId = resultCallIdOf(event) ?? ('unknown-' + seq)
    if (hiddenIds?.has(callId)) {
      skipped.push({ seq, reason: 'compress tool pair (ACP node) — owned by the engine' })
      continue
    }
    const original = session.deriveEventMessage(event) as ToolResultMessage
    const text = extractText(original.content)
    const charsBefore = codePointLength(text)
    if (charsBefore <= limit) {
      skipped.push({ seq, reason: 'under preview budget (' + charsBefore + ' ≤ ' + limit + ')' })
      continue
    }
    const archivePath = await archiveToolResult(storeDir, String(session.id), callId, {
      archivedAt: new Date().toISOString(),
      sessionId: String(session.id),
      callId,
      seq,
      chars: charsBefore,
      content: original.content,
      text,
    })
    const placeholder = '[Trimmed by dsh-compaction-prep: full result archived at ' + archivePath
      + ' (call ' + callId + ', ' + charsBefore + ' chars).\nPreview:\n' + previewText(text, limit) + ']'
    const message = freezeMessage<ToolResultMessage>({
      ...original,
      content: [{ type: 'text', text: placeholder }],
    })
    const replacement = session.append('tool/result', { ...event.data, message }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    entries.push({
      seq,
      replacementSeq: replacement.seq,
      callId,
      charsBefore,
      charsAfter: codePointLength(placeholder),
      archivePath,
    })
  }
  return { text: renderTrim(entries, skipped, limit) }
}

function renderTrim(entries: TrimmedEntry[], skipped: { seq: SessionSeq; reason: string }[], limit: number): string {
  const lines: string[] = []
  lines.push('[Trimmed by dsh-compaction-prep] trim_tool_results: ' + entries.length + ' archived (preview ≤ ' + limit + ' chars):')
  for (const entry of entries) {
    lines.push('  - seq ' + entry.seq + ' → ' + entry.replacementSeq + ' (call ' + entry.callId + '): ' + entry.charsBefore + ' → ' + entry.charsAfter + ' chars; full payload at ' + entry.archivePath)
  }
  if (skipped.length > 0) {
    lines.push('Skipped ' + skipped.length + ':')
    for (const item of skipped) lines.push('  - seq ' + item.seq + ': ' + item.reason)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// L2 snip_history
// ---------------------------------------------------------------------------

const snipParameters = {
  turns_to_keep: {
    type: 'number' as const,
    description: 'Optional: keep the last N real user turns untouched (default: plugin l2_snip_after_turns, 5).',
  },
  tool_names: {
    type: 'array' as const,
    items: { type: 'string' as const },
    description: 'Optional: only consider these read-only scaffolding tool names.',
  },
  dry_run: {
    type: 'boolean' as const,
    description: 'Report what would be snipped without modifying the surface.',
  },
}

async function handleSnip(bindings: ToolBindings, args: SnipArgs, exec: ToolRunContext): Promise<{ text: string }> {
  const session = sessionOf(exec)
  const minAge = Math.max(1, Math.floor(args.turns_to_keep ?? bindings.config.l2_snip_after_turns))
  const nameFilter = args.tool_names && args.tool_names.length > 0 ? args.tool_names : null
  const userTurns = cacheBoundarySeqsOf(session)
  const dryRun = args.dry_run === true

  const entries: SnippedEntry[] = []
  const skipped: { callSeq: SessionSeq; reason: string }[] = []

  for (const group of pairGroupsOf(session)) {
    const names = [...group.names].sort()
    if (nameFilter && !names.some((name) => nameFilter.includes(name))) continue
    if (!names.every((name) => globsMatch(bindings.config.l2_query_tools, name))) {
      skipped.push({ callSeq: group.callSeq, reason: 'tool ' + names.join(',') + ' is not read-only query scaffolding' })
      continue
    }
    if (group.resultSeqs.length === 0) {
      skipped.push({ callSeq: group.callSeq, reason: 'open pair (result not yet landed) — kept whole' })
      continue
    }
    const age = userTurns.filter((seq) => seq > group.maxSeq).length
    if (age < minAge) continue
    // Pair integrity: the spanned range must contain only this pair's own nodes.
    const own = new Set<SessionSeq>([group.callSeq, ...group.resultSeqs])
    const interleaved: SessionSeq[] = []
    for (let seq = group.minSeq; seq <= group.maxSeq; seq++) {
      const cast = seq as SessionSeq
      if (!own.has(cast)) interleaved.push(cast)
    }
    if (interleaved.length > 0) {
      skipped.push({ callSeq: group.callSeq, reason: 'interleaved span (foreign nodes ' + interleaved.join(',') + ') — abandoned to keep pairs whole' })
      continue
    }
    let charsFreed = 0
    for (const seq of own) {
      const event = session.eventAt(seq)
      if (!event) continue
      charsFreed += codePointLength(event.type === 'assistant/message' ? assistantTextOf(event) : extractText(contentBlocksOfEvent(event)))
    }
    if (!dryRun) {
      const stub = '[dsh-compaction-prep: ' + group.callIds.length + ' read-only scaffolding tool call(s) (' + names.join(', ') + ') snipped from history after ' + age + ' newer user turn(s). Original call/result pairs remain in the durable session log and stay searchable via search_context.]'
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: stub }],
        source: { kind: PREP_SOURCE_KIND },
      }), {
        surfaceOp: { op: 'replace', startSeq: group.minSeq, endSeq: group.maxSeq },
        sourceEventSeqs: [...own],
      })
    }
    entries.push({
      callSeq: group.callSeq,
      callIds: [...group.callIds],
      names,
      resultSeqCount: group.resultSeqs.length,
      spanStart: group.minSeq,
      spanEnd: group.maxSeq,
      charsFreed,
      dryRun,
    })
  }
  return { text: renderSnip(entries, skipped, minAge, dryRun) }
}

function renderSnip(entries: SnippedEntry[], skipped: { callSeq: SessionSeq; reason: string }[], minAge: number, dryRun: boolean): string {
  const verb = dryRun ? 'would snip' : 'snipped'
  const lines: string[] = []
  const freed = entries.reduce((sum, entry) => sum + entry.charsFreed, 0)
  lines.push('[dsh-compaction-prep] snip_history (' + (dryRun ? 'dry run' : 'applied') + '): ' + verb + ' ' + entries.length + ' read-only scaffolding pair(s) older than ' + minAge + ' user turn(s) (' + freed + ' chars freed):')
  for (const entry of entries) {
    lines.push('  - seq ' + entry.spanStart + '..' + entry.spanEnd + ' (calls ' + entry.callIds.join(', ') + ', tools ' + entry.names.join(', ') + '): ' + entry.charsFreed + ' chars')
  }
  if (skipped.length > 0) {
    lines.push('Skipped ' + skipped.length + ':')
    for (const item of skipped) lines.push('  - seq ' + item.callSeq + ': ' + item.reason)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// L3/L4 microcompact
// ---------------------------------------------------------------------------

const microParameters = {
  content: {
    type: 'array' as const,
    description: 'Exactly one microcompact range (same shape as a compress content item).',
    items: {
      type: 'object' as const,
      properties: {
        startSeq: { type: 'integer' as const, required: true, description: 'Surface seq of the first message of the range (inclusive).' },
        endSeq: { type: 'integer' as const, required: true, description: 'Surface seq of the last message of the range (inclusive).' },
        summary: { type: 'string' as const, required: true, description: 'Model-written dense summary. MUST contain a "## Micro-compact Digest" section with file paths, key decisions, errors and verifiedReadings.' },
        topic: { type: 'string' as const, description: 'Optional fallback topic for the compression block.' },
        verifiedReadings: { type: 'array' as const, items: { type: 'string' as const }, description: 'Acceptance readings already green; preserved on the checkpoint ledger.' },
      },
      additionalProperties: false,
      description: 'One microcompact range.',
    },
    required: true,
  },
  cache_aware: {
    type: 'boolean' as const,
    description: 'Defaults from plugin l3_cache_aware (true). false accepts the cache-invalidation note.',
  },
} as const

async function handleMicro(bindings: ToolBindings, args: MicroCompactArgs, exec: ToolRunContext): Promise<{ text: string }> {
  const session = sessionOf(exec)
  if (!Array.isArray(args.content) || args.content.length !== 1) {
    return { text: '[Rejected: microcompact requires exactly one content range [{ startSeq, endSeq, summary }].]' }
  }
  const range: MicroCompactArgs['content'][number] = args.content[0]
  const { startSeq, endSeq } = range
  const summary = typeof range.summary === 'string' ? range.summary : ''
  if (typeof startSeq !== 'number' || typeof endSeq !== 'number' || !Number.isInteger(startSeq) || !Number.isInteger(endSeq)) {
    return { text: '[Rejected: microcompact requires integer startSeq/endSeq surface seqs.]' }
  }
  const start = startSeq as SessionSeq
  const end = endSeq as SessionSeq
  const surface = new Set([...session.surface.nodes])
  if (!surface.has(start) || !surface.has(end)) {
    const bad = !surface.has(start) ? startSeq : endSeq
    return { text: '[Rejected: seq ' + bad + ' is not on the current surface — it may be covered by an ACP compression block. Use acp_status or search_context to locate live seqs.]' }
  }
  const span: SessionSeq[] = []
  for (let seq = startSeq; seq <= endSeq; seq++) {
    const cast = seq as SessionSeq
    if (surface.has(cast)) span.push(cast)
  }
  const maxRange = Math.max(2, bindings.config.l3_micro_max_range)
  if (span.length > maxRange) {
    return { text: '[Rejected: microcompact range spans ' + span.length + ' surface messages [' + startSeq + '..' + endSeq + '] (limit ' + maxRange + '). Narrow the range into separate microcompact passes, or use compress for a larger span.]' }
  }
  const guard = guardRange(session, start, end, { checkInstructions: true, checkVerifiedReadings: true })
  if (guard) return { text: guard }
  const boundaries = cacheBoundarySeqsOf(session).filter((b) => startSeq < b && b <= endSeq)
  const cacheAware = args.cache_aware ?? bindings.config.l3_cache_aware
  let cacheNote = ''
  if (boundaries.length > 0) {
    if (cacheAware) {
      return { text: '[Rejected: range crosses the provider prompt-cache boundary at surface seq ' + boundaries.join(', ') + ' (a real user turn start). Folding across a request boundary invalidates previously cached prefixes. Narrow the range to a single request epoch, or retry with cache_aware:false to accept the cache-invalidation note.]' }
    }
    cacheNote = '[Cache invalidated — token cost may increase]'
  }
  if (!summary.includes('## Micro-compact Digest')) {
    return { text: '[Rejected: microcompact summary must contain a "## Micro-compact Digest" section listing file paths, key decisions, errors and verifiedReadings. Rewrite the summary with the digest and retry.]' }
  }
  const compress = await compressToolOf(bindings.ctx)
  if (!compress) {
    return { text: '[Rejected: the ACP engine (billion-context-dsh) is not mounted. Inject billion-context-dsh first, or use compress directly.]' }
  }
  const finalSummary = cacheNote.length > 0 ? cacheNote + '\n' + summary : summary
  const rangeArgs: MicroCompactArgs['content'][number] = {
    startSeq,
    endSeq,
    summary: finalSummary,
    ...(typeof range.topic === 'string' ? { topic: range.topic } : {}),
    ...(range.verifiedReadings && range.verifiedReadings.length > 0 ? { verifiedReadings: [...range.verifiedReadings] } : {}),
  }
  try {
    const result = await compress.execute({ content: [rangeArgs] }, exec)
    const sessionId = String(session.id)
    let pairs = bindings.microPairs.get(sessionId)
    if (!pairs) {
      pairs = new Set()
      bindings.microPairs.set(sessionId, pairs)
    }
    pairs.add(exec.callId)
    const engineText = typeof result?.text === 'string' ? result.text : JSON.stringify(result)
    return {
      text: '[dsh-compaction-prep] microcompact OK: folded ' + span.length + ' surface message(s) [' + startSeq + '..' + endSeq + '] into one re-compressible checkpoint node.' + (cacheNote ? ' ' + cacheNote : '') + '\n\n' + engineText,
    }
  } catch (error) {
    return { text: '[Rejected: microcompact failed inside the ACP engine: ' + String(error) + ']' }
  }
}

// ---------------------------------------------------------------------------
// L4 acp_rule
// ---------------------------------------------------------------------------

const acpRuleParameters = {
  action: {
    type: 'string' as const,
    enum: ['add', 'remove', 'list'] as const,
    required: true,
    description: 'add a principle-level rule, remove one, or list active rules.',
  },
  principle: {
    type: 'string' as const,
    description: 'add: the principle-level compaction rule text (≤ 2000 chars).',
  },
  rule_id: {
    type: 'string' as const,
    description: 'remove: the rule id to delete.',
  },
} as const

function handleAcpRule(bindings: ToolBindings, args: AcpRuleArgs, exec: ToolRunContext): { text: string } {
  const session = sessionOf(exec)
  if (args.action === 'list') {
    const rules = bindings.rules.rulesOf(session)
    return { text: renderRules('list', rules) }
  }
  if (!bindings.config.acp_rule) {
    return { text: '[acp_rule] disabled: the acp_rule tool is gated by plugin config acp_rule:false. Enable it in the profile patch/cordis.yml to add or remove rules (listing stays available).' }
  }
  try {
    if (args.action === 'add') {
      if (typeof args.principle !== 'string') return { text: '[acp_rule] add requires a principle string.' }
      const rules = bindings.rules.apply(session, { op: 'add', principle: args.principle })
      return { text: renderRules('add', rules) }
    }
    if (typeof args.rule_id !== 'string' || args.rule_id.length === 0) {
      return { text: '[acp_rule] remove requires a rule_id.' }
    }
    const rules = bindings.rules.apply(session, { op: 'remove', ruleId: args.rule_id })
    return { text: renderRules('remove', rules) }
  } catch (error) {
    return { text: '[' + (error as Error).message + ']' }
  }
}

function renderRules(op: 'add' | 'remove' | 'list', rules: AcpRule[]): string {
  const lines: string[] = []
  if (op === 'add') lines.push('[acp_rule] rule queued for injection at the next agent pre-step. Active rules (' + rules.length + '):')
  else if (op === 'remove') lines.push('[acp_rule] rule removed. Active rules (' + rules.length + '):')
  else lines.push('[acp_rule] active rules (' + rules.length + '):')
  for (const rule of rules) lines.push('  - ' + rule.id + ': ' + rule.principle)
  if (rules.length === 0) lines.push('  (none)')
  return lines.join('\n')
}

/** The four bypass-compaction tools. Registering them is the plugin's only effect. */
export function buildToolDefinitions(bindings: ToolBindings): ToolDefinition[] {
  return [
    defineTool({
      name: 'trim_tool_results',
      description: 'Archive oversized tool results to the context store and replace the surface node with a short preview + disk reference (Claude Code pre-Autocompact trimming). Refuses nodes covered by an ACP compression block. The full payload stays recoverable from the archive file.',
      parameters: trimParameters,
      output: textOutput(),
      async execute(args, exec) { return handleTrim(bindings, args as TrimArgs, exec) },
    }),
    defineTool({
      name: 'snip_history',
      description: 'Remove read-only scaffolding tool-call/result pairs (query-class tools) older than N real user turns, replacing each span with a stub. Call/result pairs are kept whole or skipped. No ACP node is created: decompress cannot restore snipped pairs, but search_context still finds them in the durable log.',
      parameters: snipParameters,
      output: textOutput(),
      async execute(args, exec) { return handleSnip(bindings, args as SnipArgs, exec) },
    }),
    defineTool({
      name: 'microcompact',
      description: 'Extend compress with mode:"micro": fold a SMALL range of surface messages (≤ l3_micro_max_range, default 50) into a "## Micro-compact Digest" checkpoint. The output is a normal ACP node, re-compressible later via compress (layered distillation). Rejects ranges with verified-readings checkpoints, the newest injected instruction rows, or that cross provider prompt-cache request boundaries (unless cache_aware:false).',
      parameters: microParameters,
      output: textOutput(),
      async execute(args, exec) { return handleMicro(bindings, args as MicroCompactArgs, exec) },
    }),
    defineTool({
      name: 'acp_rule',
      description: 'Manage model-written principle-level compaction rules (Claude Code pre-Autocompact style policy). Rules survive compression: the active set is re-injected as the newest instruction row at the next tool step. Gated by plugin config acp_rule (default false) for add/remove; list always works.',
      parameters: acpRuleParameters,
      output: textOutput(),
      async execute(args, exec) { return handleAcpRule(bindings, args as AcpRuleArgs, exec) },
    }),
  ]
}
