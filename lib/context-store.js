import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
/** Context-store helpers for L1: oversized tool results archived to disk. */
export function resolveStoreDir(raw) {
    return raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : resolve(raw);
}
/** Per-tool-call archive path: <store>/<sessionId>/<callId>.json (sanitized). */
export function archivePathFor(storeDir, sessionId, callId) {
    const safe = callId.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(storeDir, sessionId, safe + '.json');
}
export async function ensureStoreDir(storeDir) {
    await mkdir(storeDir, { recursive: true });
}
/**
 * Persist the FULL tool result payload for one call and return its absolute
 * path. Overwrites an existing entry — a later trim re-archives the newest
 * content, so the archive always mirrors the last trimmed state.
 */
export async function archiveToolResult(storeDir, sessionId, callId, payload) {
    const file = archivePathFor(storeDir, sessionId, callId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
}
/** Read a previously archived tool result back (used by decompress/search flows). */
export async function readArchived(storeDir, sessionId, callId) {
    const file = archivePathFor(storeDir, sessionId, callId);
    return JSON.parse(await readFile(file, 'utf8'));
}
