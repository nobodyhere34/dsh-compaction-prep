/**
 * Probe the compaction service for a live ACP engine without importing it.
 * Returns null when either no compactor is mounted or the mounted one is not
 * an ACP engine (e.g. the stock compaction-basic service).
 */
export function engineOf(ctx) {
    // Read the service through the dynamic get() rather than a ctx property:
    // cordis throws on property access for names the fiber did not declare in
    // inject, and this suite injects only 'tools'. get() answers undefined for
    // an unmounted name, keeping the null contract.
    const found = ctx.get?.('compaction');
    const engine = found;
    if (!engine || typeof engine !== 'object')
        return null;
    const kernel = engine.kernel;
    const store = engine.store;
    // billion-context-dsh >= 0.2 keeps the settings-exposed knobs as live
    // getters on engine.env, not on the instance; read the instance first and
    // fall back to env so both shapes pass. The env getter hot-reads the
    // settings source, so the value never goes stale behind this snapshot —
    // windowFor (when present) supplies the per-request live window downstream.
    const modelContextLimit = typeof engine.modelContextLimit === 'number'
        ? engine.modelContextLimit
        : engine.env?.modelContextLimit;
    if (typeof modelContextLimit !== 'number' || modelContextLimit <= 0)
        return null;
    if (!kernel || typeof kernel !== 'object' || !store || typeof store !== 'object')
        return null;
    // Prefer the engine's own bound env.windowFor closure; a raw class method
    // taken off the instance would lose its this binding when forwarded.
    const windowFor = typeof engine.env?.windowFor === 'function'
        ? engine.env.windowFor
        : typeof engine.windowFor === 'function'
            ? engine.windowFor.bind(engine)
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
