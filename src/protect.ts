import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { decodeAcpBlockLedger, type AcpBlockLedgerPayload } from './ledger.js'
import { extractText, contentBlocksOfEvent } from './session-util.js'

/**
 * Surface protection: what L1–L4 may never replace or fold.
 * Mirrors billion-context-dsh's classifiers (same predicates, same outcomes)
 * so protection and the kernel's own guards always agree.
 */

export function sourcePluginOf(source: { kind?: unknown; plugin?: unknown } | undefined): string | undefined {
  if (source === undefined || typeof source !== 'object') return undefined
  const kind = source.kind
  if (kind === 'plugin') {
    return typeof source.plugin === 'string' && source.plugin.length > 0 ? source.plugin : undefined
  }
  if (typeof kind === 'string' && kind.startsWith('plugin:')) {
    const name = kind.slice('plugin:'.length)
    return name.length > 0 ? name : undefined
  }
  return undefined
}

export function isAgentInstructionsRow(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: string; plugin?: string } }).source
  if (!source) return false
  return source.kind === 'agent-instructions' || sourcePluginOf(source) === 'agent-instructions'
}

export function isSkillCatalogRow(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: unknown; plugin?: unknown } }).source
  if (source?.kind === 'skill-catalog') return true
  if (sourcePluginOf(source) === 'dsh-tool-skill') return true
  return extractText(contentBlocksOfEvent(event)).includes('<available_skills>')
}

export function isCheckpointNode(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: string; plugin?: string } }).source
  return source?.plugin === 'compact' || source?.kind === 'compact-checkpoint'
}

/** Also accepts checkpoints whose text carries the DSH host summary frame. */
export function appearsCheckpoint(event: SessionEvent): boolean {
  if (isCheckpointNode(event)) return true
  return event.type === 'user/message'
    && extractText(contentBlocksOfEvent(event)).startsWith('[Model-written summary')
}

/**
 * Verified readings carried by a checkpoint, when its ledger decodes them.
 * The ledger lives in rawOutput on the sibling 'compaction/summary' durable
 * event; the surface node (a user/message row) carries only the compactionId
 * in its source, so resolve through the log when no inline rawOutput exists.
 */
export function verifiedReadingsOfCheckpoint(session: Session, event: SessionEvent): readonly string[] | null {
  if (!appearsCheckpoint(event)) return null
  const data = event.data as { source?: { compactionId?: unknown }; rawOutput?: unknown }
  let raw = data.rawOutput
  if (raw === undefined) {
    const compactionId = typeof data.source?.compactionId === 'string' ? data.source.compactionId : null
    if (compactionId !== null) raw = summaryRawOutputOf(session, compactionId)
  }
  const ledger: AcpBlockLedgerPayload = decodeAcpBlockLedger(raw)
  return ledger.verifiedReadings && ledger.verifiedReadings.length > 0 ? ledger.verifiedReadings : null
}

/** rawOutput ledger of the compaction/summary event for one compaction id. */
function summaryRawOutputOf(session: Session, compactionId: string): unknown {
  for (const event of sessionEventsOf(session)) {
    if (event.type !== 'compaction/summary') continue
    const data = event.data as { compactionId?: unknown; rawOutput?: unknown }
    if (data.compactionId === compactionId) return data.rawOutput
  }
  return undefined
}

export type UserRowClass = 'real' | 'instruction' | 'checkpoint'

/**
 * Classify a user/message row like the kernel does: only rows a real human
 * sent (source absent, or {kind:'user'}) count as real turns; anything
 * stamped by a plugin/kind is a policy row until proven otherwise.
 */
export function classifyUserRow(event: SessionEvent): UserRowClass {
  if (event.type !== 'user/message') return 'real'
  if (appearsCheckpoint(event)) return 'checkpoint'
  const source = (event.data as { source?: { kind?: string; plugin?: string } }).source
  if (!source) return 'real'
  const kind = source.kind
  if (kind === 'user') return 'real'
  const plugin = sourcePluginOf(source)
  if (kind === 'plugin' || plugin !== undefined) return 'instruction'
  if (typeof kind !== 'string') return 'real'
  return 'instruction'
}

/** Seq of every real user turn start (request boundaries), oldest → newest. */
export function realUserTurnsOf(session: Session): SessionSeq[] {
  const seqs: SessionSeq[] = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'user/message' && classifyUserRow(event) === 'real') seqs.push(seq)
  }
  return seqs
}

/** Newest instruction row per channel (kind/plugin key) — never foldable. */
export function newestInstructionSeqsOf(session: Session): Set<SessionSeq> {
  const newest = new Map<string, SessionSeq>()
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type !== 'user/message' || classifyUserRow(event) !== 'instruction') continue
    const source = (event.data as { source?: { kind?: unknown; plugin?: unknown } }).source
    const key = typeof source?.kind === 'string' ? source.kind : (sourcePluginOf(source) ?? 'plugin-row')
    newest.set(key, seq)
  }
  return new Set(newest.values())
}

export interface GuardOptions {
  /** Reject when the range contains the newest injected instruction row. */
  readonly checkInstructions: boolean
  /** Reject when the range contains a checkpoint carrying verified readings. */
  readonly checkVerifiedReadings: boolean
}

/**
 * Central L1–L4 range guard. Returns the rejection text (wording per the
 * spec) or null when the range is safe. Both end points must be live surface
 * nodes — a covered seq means an ACP block already shadows it.
 */
export function guardRange(
  session: Session,
  startSeq: number,
  endSeq: number,
  options: GuardOptions,
): string | null {
  const surface = new Set([...session.surface.nodes])
  if (!surface.has(startSeq as SessionSeq) || !surface.has(endSeq as SessionSeq)) {
    const bad = !surface.has(startSeq as SessionSeq) ? startSeq : endSeq
    return '[Rejected: seq ' + bad + ' is not on the current surface — it may be covered by an ACP compression block. Use acp_status or search_context to locate the live seqs.]'
  }
  if (options.checkInstructions) {
    const newest = newestInstructionSeqsOf(session)
    for (const seq of newest) {
      if (seq >= startSeq && seq <= endSeq) {
        return '[Rejected: range contains the newest injected instruction row (AGENTS.md / skill catalog / ACP rule) at surface seq ' + seq + '. The host re-injects these rows; folding them loses the newest-row guard. Exclude that seq from the range.]'
      }
    }
  }
  if (options.checkVerifiedReadings) {
    const readings = new Set<string>()
    for (const seq of surface) {
      if (seq < startSeq || seq > endSeq) continue
      const event = session.eventAt(seq)
      if (!event) continue
      const held = verifiedReadingsOfCheckpoint(session, event)
      if (held) for (const file of held) readings.add(file)
    }
    if (readings.size > 0) {
      const files = [...readings].join(', ')
      return '[Rejected: range contains verified readings from ' + files + '. Use compress with explicit verifiedReadings preservation.]'
    }
  }
  return null
}

/** Real-user-turn starts delimit provider prompt-cache epochs. */
export function cacheBoundarySeqsOf(session: Session): SessionSeq[] {
  return realUserTurnsOf(session)
}

/** Iterate a session's durable log defensively (snapshot-aware sessions first). */
function sessionEventsOf(session: Session): SessionEvent[] {
  const snap = (session as { snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => unknown }).snapshotEvents
  if (typeof snap === 'function') {
    const result = snap.call(session)
    if (Array.isArray(result)) return result as SessionEvent[]
  }
  const events = (session as { events?: unknown }).events
  if (Array.isArray(events)) return events as SessionEvent[]
  return []
}
