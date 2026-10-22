/**
 * Probe ctx.compaction for a live ACP engine without importing it.
 * Returns null when either no compactor is mounted or the mounted one is not
 * an ACP engine (e.g. the stock compaction-basic service).
 */
export function engineOf(ctx) {
    // ctx.compaction is the live engine service; its declared type widens across
    // host lines, so this adapter probes the public duck surface only.
    const probe = ctx;
    const engine = probe.compaction;
    if (!engine || typeof engine !== 'object')
        return null;
    const kernel = engine.kernel;
    const store = engine.store;
    const modelContextLimit = engine.modelContextLimit;
    if (typeof modelContextLimit !== 'number' || modelContextLimit <= 0)
        return null;
    if (!kernel || typeof kernel !== 'object' || !store || typeof store !== 'object')
        return null;
    const windowFor = typeof engine.windowFor === 'function'
        ? engine.windowFor
        : undefined;
    const compressCallIdsToHide = engine.compressCallIdsToHide instanceof Set
        ? engine.compressCallIdsToHide
        : undefined;
    const prompts = engine.prompts && typeof engine.prompts === 'object' ? engine.prompts : undefined;
    const preset = typeof engine.preset === 'string' ? engine.preset : null;
    return {
        kind: 'acp-engine',
        kernel: kernel,
        store: store,
        modelContextLimit,
        windowFor,
        compressCallIdsToHide,
        prompts,
        preset,
    };
}
let bcdPromise = null;
/** Memoized dynamic import of the vendored billion-context-dsh bundle. */
export function bcdModule() {
    if (!bcdPromise) {
        bcdPromise = import('billion-context-dsh').catch((error) => {
            console.warn('[dsh-compaction-prep] billion-context-dsh import failed:', String(error));
            return null;
        });
    }
    return bcdPromise;
}
/**
 * Rebuild a bcd ToolEnvironment from the live engine's public fields — the
 * single seam cast. Requires the vendored bundle's types at compile time;
 * runtime shape is duck-checked by engineOf first.
 */
export async function envFor(ctx) {
    const engine = engineOf(ctx);
    if (!engine)
        return null;
    const bcd = await bcdModule();
    if (!bcd || typeof bcd.makeTools !== 'function')
        return null;
    const env = {
        kernel: engine.kernel,
        store: engine.store,
        modelContextLimit: engine.modelContextLimit,
        ...(engine.windowFor ? { windowFor: engine.windowFor } : {}),
        ...(engine.compressCallIdsToHide ? { compressCallIdsToHide: engine.compressCallIdsToHide } : {}),
        ...(engine.prompts ? { prompts: engine.prompts } : {}),
    };
    return env;
}
/**
 * The engine's own compress tool definition. microcompact delegates to it so
 * the checkpoint transaction (kernel block, ledger, framing) is produced by
 * the SAME bundle that injected the engine — layered distillation stays
 * coherent and later re-compressible.
 */
export async function compressToolOf(ctx) {
    const bcd = await bcdModule();
    if (!bcd || typeof bcd.makeTools !== 'function')
        return null;
    const env = await envFor(ctx);
    if (!env)
        return null;
    const tools = bcd.makeTools(env);
    const compress = tools.find((tool) => tool.name === 'compress');
    return compress && typeof compress.execute === 'function' ? compress : null;
}
/** Hide a tool-use + result pair from the surface (provider-safe view). */
export async function hideCompressPair(session, callId) {
    const bcd = await bcdModule();
    if (!bcd || typeof bcd.hideCompressToolPair !== 'function')
        return false;
    try {
        bcd.hideCompressToolPair(session, callId);
        return true;
    }
    catch (error) {
        console.warn('[dsh-compaction-prep] hideCompressToolPair failed:', String(error));
        return false;
    }
}
/** Compress/decompress/search_context only make sense when the engine is live. */
export async function acpEngineAvailable(ctx) {
    return (await bcdModule()) !== null && engineOf(ctx) !== null;
}
