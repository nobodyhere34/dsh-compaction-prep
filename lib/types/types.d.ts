import type { SessionSeq } from '@deepseek-ai/dsh-session';
/** One L1 trim result entry: the replaced surface node + its archive. */
export interface TrimmedEntry {
    readonly seq: SessionSeq;
    readonly replacementSeq: SessionSeq;
    readonly callId: string;
    readonly charsBefore: number;
    readonly charsAfter: number;
    readonly archivePath: string;
}
export interface TrimSkip {
    readonly seq: SessionSeq;
    readonly reason: string;
}
export interface TrimResultText {
    readonly entries: TrimmedEntry[];
    readonly skipped: TrimSkip[];
}
/** One L2 snip result entry: an assistant tool-calls message + its results replaced by a stub. */
export interface SnippedEntry {
    readonly callSeq: SessionSeq;
    readonly callIds: string[];
    readonly names: string[];
    readonly resultSeqCount: number;
    readonly spanStart: SessionSeq;
    readonly spanEnd: SessionSeq;
    readonly charsFreed: number;
    readonly dryRun: boolean;
}
export interface SnipSkip {
    readonly callSeq: SessionSeq;
    readonly reason: string;
}
export interface SnipResultText {
    readonly entries: SnippedEntry[];
    readonly skipped: SnipSkip[];
}
export interface TrimArgs {
    /** Optional: trim only the result whose tool call id matches. */
    readonly tool_use_id?: string;
    /** Optional: trim only the surface tool/result at this seq. */
    readonly seq?: number;
    /** Optional per-call preview budget override (defaults to l1_preview_limit). */
    readonly preview_limit?: number;
}
export interface SnipArgs {
    /** Optional: keep the last N real user turns (defaults to l2_snip_after_turns). */
    readonly turns_to_keep?: number;
    /** Optional: only consider these tool names (exact or trailing-* glob). */
    readonly tool_names?: string[];
    /** Report what would be snipped without modifying the surface. */
    readonly dry_run?: boolean;
}
/** One microcompact range: same shape as a compress content item. */
export interface MicroCompactRange {
    /** Surface seq of the first message of the range (inclusive). */
    readonly startSeq: number;
    /** Surface seq of the last message of the range (inclusive). */
    readonly endSeq: number;
    /** Model-written dense summary, MUST contain a "## Micro-compact Digest" section. */
    readonly summary: string;
    /** Fallback topic for the compression block. */
    readonly topic?: string;
    /** Acceptance readings already green; preserved on the checkpoint ledger. */
    readonly verifiedReadings?: string[];
}
export interface MicroCompactArgs {
    /** Exactly one range (mirrors the compress tool's content wrapper). */
    readonly content: readonly MicroCompactRange[];
    /** Defaults to l3_cache_aware; false marks the range as cache-invalidating. */
    readonly cache_aware?: boolean;
}
export interface AcpRuleArgs {
    readonly action: 'add' | 'remove' | 'list';
    /** add: the principle-level rule text (≤ 2000 chars). */
    readonly principle?: string;
    /** remove: the rule id to delete. */
    readonly rule_id?: string;
}
/** ACP rule ledger entry (durably logged via `compaction/prep-rules` events). */
export interface AcpRule {
    readonly id: string;
    readonly principle: string;
}
