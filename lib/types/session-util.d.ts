import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session';
/** Surface/log helpers shared by the L1–L4 handlers. */
/** A tool-calls message plus the tool/result nodes that answered it. */
export interface PairGroup {
    readonly callSeq: SessionSeq;
    readonly callIds: readonly string[];
    readonly names: ReadonlySet<string>;
    resultSeqs: SessionSeq[];
    minSeq: SessionSeq;
    maxSeq: SessionSeq;
}
/**
 * Session-log content blocks: the llm ContentBlock union plus the
 * session-format tool-result wrapper that carries a nested content array.
 */
export type SessionContentBlock = ContentBlock | {
    readonly type: 'tool-result';
    readonly content?: readonly SessionContentBlock[];
};
/** Content blocks of an event's message payload (user rows contribute none). */
export declare function contentBlocksOfEvent(event: SessionEvent): readonly SessionContentBlock[];
export declare function extractText(blocks: readonly SessionContentBlock[]): string;
export declare function codePointLength(text: string): number;
/** Tool call ids named by an assistant message (tool-call blocks, or a tool_calls field). */
export declare function toolCallIdsOf(event: SessionEvent): string[];
/** Tool names named by an assistant message, keyed by call id. */
export declare function toolCallNamesOf(event: SessionEvent): Map<string, string>;
/** The call id answered by a tool/result node, or null. */
export declare function resultCallIdOf(event: SessionEvent): string | null;
/** All surface nodes in log (seq) order. */
export declare function surfaceNodesOf(session: Session): SessionEvent[];
/** Surface seqs strictly inside [start, end] (both inclusive). */
export declare function surfaceSeqsInRange(session: Session, start: SessionSeq, end: SessionSeq): SessionSeq[];
/** Group assistant tool-calls messages with their tool/result answers. */
export declare function pairGroupsOf(session: Session): PairGroup[];
/** Exact match or trailing-* glob against a tool name. */
export declare function globsMatch(globs: readonly string[], name: string): boolean;
