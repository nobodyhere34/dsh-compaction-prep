/** Context-store helpers for L1: oversized tool results archived to disk. */
export declare function resolveStoreDir(raw: string): string;
/** Per-tool-call archive path: <store>/<sessionId>/<callId>.json (sanitized). */
export declare function archivePathFor(storeDir: string, sessionId: string, callId: string): string;
export declare function ensureStoreDir(storeDir: string): Promise<void>;
/**
 * Persist the FULL tool result payload for one call and return its absolute
 * path. Overwrites an existing entry — a later trim re-archives the newest
 * content, so the archive always mirrors the last trimmed state.
 */
export declare function archiveToolResult(storeDir: string, sessionId: string, callId: string, payload: unknown): Promise<string>;
/** Read a previously archived tool result back (used by decompress/search flows). */
export declare function readArchived(storeDir: string, sessionId: string, callId: string): Promise<unknown>;
