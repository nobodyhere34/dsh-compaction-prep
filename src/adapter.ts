import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Adapter layer — the ONLY module that reaches into billion-context-dsh
 * internals or its npm identity. Everything else works against the typed
 * surface described here, so swapping the ACP engine keeps L1–L4 intact.
 */

/** Duck-typed view of the live billion-context-dsh AcpCompactionEngine. */
export interface AcpEngineHandle {
  readonly kind: 'acp-engine'
  readonly kernel: object
  readonly store: object
  readonly modelContextLimit: number
  readonly windowFor?: (payload: { agent?: unknown }) => Promise<{ limit: number }>
  readonly compressCallIdsToHide?: ReadonlySet<string>
  readonly prompts?: object
  readonly preset?: string | null
}

/**
 * Probe ctx.compaction for a live ACP engine without importing it.
 * Returns null when either no compactor is mounted or the mounted one is not
 * an ACP engine (e.g. the stock compaction-basic service).
 */
export function engineOf(ctx: Context): AcpEngineHandle | null {
  // ctx.compaction is the live engine service; its declared type widens across
  // host lines, so this adapter probes the public duck surface only.
  const probe = ctx as { compaction?: {
    readonly kernel?: unknown
    readonly store?: unknown
    readonly modelContextLimit?: unknown
    readonly windowFor?: unknown
    readonly compressCallIdsToHide?: unknown
    readonly prompts?: unknown
    readonly preset?: unknown
  } }
  const engine = probe.compaction
  if (!engine || typeof engine !== 'object') return null
  const kernel = engine.kernel
  const store = engine.store
  const modelContextLimit = engine.modelContextLimit
  if (typeof modelContextLimit !== 'number' || modelContextLimit <= 0) return null
  if (!kernel || typeof kernel !== 'object' || !store || typeof store !== 'object') return null
  const windowFor = typeof engine.windowFor === 'function'
    ? engine.windowFor as AcpEngineHandle['windowFor']
    : undefined
  const compressCallIdsToHide = engine.compressCallIdsToHide instanceof Set
    ? engine.compressCallIdsToHide as ReadonlySet<string>
    : undefined
  const prompts = engine.prompts && typeof engine.prompts === 'object' ? engine.prompts : undefined
  const preset = typeof engine.preset === 'string' ? engine.preset : null
  return {
    kind: 'acp-engine',
    kernel: kernel as object,
    store: store as object,
    modelContextLimit,
    windowFor,
    compressCallIdsToHide,
    prompts,
    preset,
  }
}

export type BcdModule = typeof import('billion-context-dsh')

let bcdPromise: Promise<BcdModule | null> | null = null

/** Memoized dynamic import of the vendored billion-context-dsh bundle. */
export function bcdModule(): Promise<BcdModule | null> {
  if (!bcdPromise) {
    bcdPromise = import('billion-context-dsh').catch((error: unknown) => {
      console.warn('[dsh-compaction-prep] billion-context-dsh import failed:', String(error))
      return null
    })
  }
  return bcdPromise
}

/**
 * Rebuild a bcd ToolEnvironment from the live engine's public fields — the
 * single seam cast. Requires the vendored bundle's types at compile time;
 * runtime shape is duck-checked by engineOf first.
 */
export async function envFor(ctx: Context): Promise<import('billion-context-dsh').ToolEnvironment | null> {
  const engine = engineOf(ctx)
  if (!engine) return null
  const bcd = await bcdModule()
  if (!bcd || typeof bcd.makeTools !== 'function') return null
  const env = {
    kernel: engine.kernel,
    store: engine.store,
    modelContextLimit: engine.modelContextLimit,
    ...(engine.windowFor ? { windowFor: engine.windowFor } : {}),
    ...(engine.compressCallIdsToHide ? { compressCallIdsToHide: engine.compressCallIdsToHide } : {}),
    ...(engine.prompts ? { prompts: engine.prompts } : {}),
  } as import('billion-context-dsh').ToolEnvironment
  return env
}

export interface CompressTool {
  readonly name: 'compress'
  execute(args: unknown, exec: ToolRunContext): Promise<{ text?: string } | { text: string }>
}

/**
 * The engine's own compress tool definition. microcompact delegates to it so
 * the checkpoint transaction (kernel block, ledger, framing) is produced by
 * the SAME bundle that injected the engine — layered distillation stays
 * coherent and later re-compressible.
 */
export async function compressToolOf(ctx: Context): Promise<CompressTool | null> {
  const bcd = await bcdModule()
  if (!bcd || typeof bcd.makeTools !== 'function') return null
  const env = await envFor(ctx)
  if (!env) return null
  const tools = bcd.makeTools(env) as readonly { readonly name: string; readonly execute?: unknown }[]
  const compress = tools.find((tool) => tool.name === 'compress')
  return compress && typeof compress.execute === 'function' ? compress as CompressTool : null
}

/** Hide a tool-use + result pair from the surface (provider-safe view). */
export async function hideCompressPair(session: Session, callId: string): Promise<boolean> {
  const bcd = await bcdModule()
  if (!bcd || typeof bcd.hideCompressToolPair !== 'function') return false
  try {
    bcd.hideCompressToolPair(session, callId)
    return true
  } catch (error: unknown) {
    console.warn('[dsh-compaction-prep] hideCompressToolPair failed:', String(error))
    return false
  }
}

/** Compress/decompress/search_context only make sense when the engine is live. */
export async function acpEngineAvailable(ctx: Context): Promise<boolean> {
  return (await bcdModule()) !== null && engineOf(ctx) !== null
}
