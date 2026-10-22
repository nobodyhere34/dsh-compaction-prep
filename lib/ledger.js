/**
 * Minimal, frozen-format clone of billion-context-dsh's block-ledger decode
 * (marker/version/fields identical, so checkpoints written by the live engine
 * read back losslessly). Isolation rule: the kernel bundle stays untouched;
 * this module only READS the durable ledger the kernel writes.
 */
export const ACP_BLOCK_LEDGER_MARKER = '$dshAcpBlockLedger';
export const ACP_BLOCK_LEDGER_VERSION = 1;
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
/**
 * Decode the namespaced ledger JSON out of a checkpoint's rawOutput content
 * blocks. Strict on marker/version, lenient per field, never throws — absent
 * or unknown payloads yield an empty ledger (reconstruction fallback).
 */
export function decodeAcpBlockLedger(rawOutput) {
    try {
        if (!Array.isArray(rawOutput))
            return {};
        for (const block of rawOutput) {
            if (block === null || typeof block !== 'object')
                continue;
            const candidate = block;
            if (candidate.type !== 'text' || typeof candidate.text !== 'string')
                continue;
            let parsed;
            try {
                parsed = JSON.parse(candidate.text);
            }
            catch {
                continue;
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
                continue;
            const record = parsed;
            if (record[ACP_BLOCK_LEDGER_MARKER] !== ACP_BLOCK_LEDGER_VERSION)
                continue;
            const tier = record.tier === 1 || record.tier === 2 || record.tier === 3 ? record.tier : undefined;
            const kernelBlockId = typeof record.kernelBlockId === 'string' ? record.kernelBlockId : undefined;
            const topic = typeof record.topic === 'string' ? record.topic : undefined;
            const parentBlockIds = isStringArray(record.parentBlockIds) ? [...record.parentBlockIds] : undefined;
            const directMessageIds = isStringArray(record.directMessageIds) ? [...record.directMessageIds] : undefined;
            const effectiveMessageIds = isStringArray(record.effectiveMessageIds) ? [...record.effectiveMessageIds] : undefined;
            const verifiedReadings = isStringArray(record.verifiedReadings) ? [...record.verifiedReadings] : undefined;
            return {
                ...(tier !== undefined ? { tier } : {}),
                ...(kernelBlockId !== undefined ? { kernelBlockId } : {}),
                ...(topic !== undefined ? { topic } : {}),
                ...(parentBlockIds !== undefined ? { parentBlockIds } : {}),
                ...(directMessageIds !== undefined ? { directMessageIds } : {}),
                ...(effectiveMessageIds !== undefined ? { effectiveMessageIds } : {}),
                ...(verifiedReadings !== undefined ? { verifiedReadings } : {}),
            };
        }
        return {};
    }
    catch {
        // Malformed payloads degrade to an empty ledger, matching the kernel's reader.
        return {};
    }
}
