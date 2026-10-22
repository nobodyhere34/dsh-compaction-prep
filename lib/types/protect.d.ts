import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session';
/**
 * Surface protection: what L1–L4 may never replace or fold.
 * Mirrors billion-context-dsh's classifiers (same predicates, same outcomes)
 * so protection and the kernel's own guards always agree.
 */
export declare function sourcePluginOf(source: {
    kind?: unknown;
    plugin?: unknown;
} | undefined): string | undefined;
export declare function isAgentInstructionsRow(event: SessionEvent): boolean;
export declare function isSkillCatalogRow(event: SessionEvent): boolean;
export declare function isCheckpointNode(event: SessionEvent): boolean;
/** Also accepts checkpoints whose text carries the DSH host summary frame. */
export declare function appearsCheckpoint(event: SessionEvent): boolean;
/**
 * Verified readings carried by a checkpoint, when its ledger decodes them.
 * The ledger lives in rawOutput on the sibling 'compaction/summary' durable
 * event; the surface node (a user/message row) carries only the compactionId
 * in its source, so resolve through the log when no inline rawOutput exists.
 */
export declare function verifiedReadingsOfCheckpoint(session: Session, event: SessionEvent): readonly string[] | null;
export type UserRowClass = 'real' | 'instruction' | 'checkpoint';
/**
 * Classify a user/message row like the kernel does: only rows a real human
 * sent (source absent, or {kind:'user'}) count as real turns; anything
 * stamped by a plugin/kind is a policy row until proven otherwise.
 */
export declare function classifyUserRow(event: SessionEvent): UserRowClass;
/** Seq of every real user turn start (request boundaries), oldest → newest. */
export declare function realUserTurnsOf(session: Session): SessionSeq[];
/** Newest instruction row per channel (kind/plugin key) — never foldable. */
export declare function newestInstructionSeqsOf(session: Session): Set<SessionSeq>;
export interface GuardOptions {
    /** Reject when the range contains the newest injected instruction row. */
    readonly checkInstructions: boolean;
    /** Reject when the range contains a checkpoint carrying verified readings. */
    readonly checkVerifiedReadings: boolean;
}
/**
 * Central L1–L4 range guard. Returns the rejection text (wording per the
 * spec) or null when the range is safe. Both end points must be live surface
 * nodes — a covered seq means an ACP block already shadows it.
 */
export declare function guardRange(session: Session, startSeq: number, endSeq: number, options: GuardOptions): string | null;
/** Real-user-turn starts delimit provider prompt-cache epochs. */
export declare function cacheBoundarySeqsOf(session: Session): SessionSeq[];
