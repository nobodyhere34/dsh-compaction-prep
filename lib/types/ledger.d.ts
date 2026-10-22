/**
 * Minimal, frozen-format clone of billion-context-dsh's block-ledger decode
 * (marker/version/fields identical, so checkpoints written by the live engine
 * read back losslessly). Isolation rule: the kernel bundle stays untouched;
 * this module only READS the durable ledger the kernel writes.
 */
export declare const ACP_BLOCK_LEDGER_MARKER = "$dshAcpBlockLedger";
export declare const ACP_BLOCK_LEDGER_VERSION = 1;
export interface AcpBlockLedgerPayload {
    readonly tier?: 1 | 2 | 3;
    readonly kernelBlockId?: string;
    readonly topic?: string;
    readonly parentBlockIds?: readonly string[];
    readonly directMessageIds?: readonly string[];
    readonly effectiveMessageIds?: readonly string[];
    readonly verifiedReadings?: readonly string[];
}
/**
 * Decode the namespaced ledger JSON out of a checkpoint's rawOutput content
 * blocks. Strict on marker/version, lenient per field, never throws — absent
 * or unknown payloads yield an empty ledger (reconstruction fallback).
 */
export declare function decodeAcpBlockLedger(rawOutput: unknown): AcpBlockLedgerPayload;
