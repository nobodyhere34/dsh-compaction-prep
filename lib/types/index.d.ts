import { Context, Service } from '@deepseek-ai/cordis';
import type { CompactionPrepConfig } from './config.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        compactionPrepSuite: CompactionPrepSuite;
    }
}
/**
 * compaction-prep-suite: Claude Code pre-Autocompact mechanisms as DSH ACP
 * bypass plugins — L1 trim_tool_results, L2 snip_history, L3/L4 microcompact,
 * plus the acp_rule principle ledger. Requires billion-context-dsh mounted
 * (ctx.compaction = AcpCompactionEngine); microcompact delegates to the same
 * engine bundle for coherent, re-compressible checkpoints.
 *
 * Class plugins are constructed with (ctx, config); all registrations live in
 * the constructor and are fiber-owned (unloaded with the owning fiber), so
 * hot reload/unload cycles leave no residue.
 */
export declare class CompactionPrepSuite extends Service {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        enable: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        l1_preview_limit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        l2_snip_after_turns: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        l2_query_tools: import("@deepseek-ai/schemastery").default<string[], string[], "defined">;
        l3_micro_max_range: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        l3_cache_aware: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        acp_rule: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        context_store_dir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enable: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        l1_preview_limit: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        l2_snip_after_turns: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        l2_query_tools: import("@deepseek-ai/schemastery").default<string[], string[], "defined">;
        l3_micro_max_range: import("@deepseek-ai/schemastery").default<number, number, "defined">;
        l3_cache_aware: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        acp_rule: import("@deepseek-ai/schemastery").default<boolean, boolean, "defined">;
        context_store_dir: import("@deepseek-ai/schemastery").default<string, string, "defined">;
    }>>, "plain">;
    /** Immutable resolved configuration. */
    readonly config: CompactionPrepConfig;
    private readonly rules;
    private readonly microPairs;
    private readonly disposers;
    private toolsRegistered;
    constructor(ctx: Context, config?: Partial<CompactionPrepConfig>);
    private registerTools;
    /** Hide completed microcompact call/result pairs from the surface (provider-safe view). */
    private hideMicroPairs;
    /**
     * Pre-execute backstop: verified-readings checkpoints are never foldable
     * through the compress-family tools, whatever the calling route. The
     * microcompact handler repeats the full guard (instructions + readings);
     * this hook only enforces the readings invariant for both names.
     */
    private guard;
}
export { RuleLedger, MAX_ACP_RULES, MAX_PRINCIPLE_CHARS } from './rules.js';
export { buildToolDefinitions } from './tools.js';
export type { ToolBindings } from './tools.js';
export { decodeAcpBlockLedger, ACP_BLOCK_LEDGER_MARKER } from './ledger.js';
export { CompactionPrepConfigSchema, resolveConfig } from './config.js';
export type { CompactionPrepConfig } from './config.js';
export { engineOf, bcdModule } from './adapter.js';
export default CompactionPrepSuite;
