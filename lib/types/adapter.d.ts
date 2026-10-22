import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { Session } from '@deepseek-ai/dsh-session';
/**
 * Adapter layer — the ONLY module that reaches into billion-context-dsh
 * internals or its npm identity. Everything else works against the typed
 * surface described here, so swapping the ACP engine keeps L1–L4 intact.
 */
/** Duck-typed view of the live billion-context-dsh AcpCompactionEngine. */
export interface AcpEngineHandle {
    readonly kind: 'acp-engine';
    readonly kernel: object;
    readonly store: object;
    readonly modelContextLimit: number;
    readonly windowFor?: (payload: {
        agent?: unknown;
    }) => Promise<{
        limit: number;
    }>;
    readonly compressCallIdsToHide?: ReadonlySet<string>;
    readonly prompts?: object;
    readonly preset?: string | null;
}
/**
 * Probe ctx.compaction for a live ACP engine without importing it.
 * Returns null when either no compactor is mounted or the mounted one is not
 * an ACP engine (e.g. the stock compaction-basic service).
 */
export declare function engineOf(ctx: Context): AcpEngineHandle | null;
export type BcdModule = typeof import('billion-context-dsh');
/** Memoized dynamic import of the vendored billion-context-dsh bundle. */
export declare function bcdModule(): Promise<BcdModule | null>;
/**
 * Rebuild a bcd ToolEnvironment from the live engine's public fields — the
 * single seam cast. Requires the vendored bundle's types at compile time;
 * runtime shape is duck-checked by engineOf first.
 */
export declare function envFor(ctx: Context): Promise<import('billion-context-dsh').ToolEnvironment | null>;
export interface CompressTool {
    readonly name: 'compress';
    execute(args: unknown, exec: ToolRunContext): Promise<{
        text?: string;
    } | {
        text: string;
    }>;
}
/**
 * The engine's own compress tool definition. microcompact delegates to it so
 * the checkpoint transaction (kernel block, ledger, framing) is produced by
 * the SAME bundle that injected the engine — layered distillation stays
 * coherent and later re-compressible.
 */
export declare function compressToolOf(ctx: Context): Promise<CompressTool | null>;
/** Hide a tool-use + result pair from the surface (provider-safe view). */
export declare function hideCompressPair(session: Session, callId: string): Promise<boolean>;
/** Compress/decompress/search_context only make sense when the engine is live. */
export declare function acpEngineAvailable(ctx: Context): Promise<boolean>;
