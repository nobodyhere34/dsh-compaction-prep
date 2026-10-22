import z from '@deepseek-ai/schemastery';
/**
 * Query-class read-only scaffolding tools that snip_history may remove when
 * they are older than the keep window. Matched exactly or by trailing
 * `*` glob. Never list write/execution tools here — snipping a write tool's
 * pair would hide its side effects from history.
 */
export declare const DEFAULT_QUERY_TOOLS: readonly ["search_context", "read_file", "glob", "grep", "web_search", "web_fetch", "ls", "read", "browse*", "session*"];
export declare const CompactionPrepConfigSchema: z<Schemastery.ObjectS<NoInfer<{
    /** Master switch: when false the suite registers no tools and no listeners. */
    enable: z<boolean, boolean, "defined">;
    /** L1: tool results longer than this many code points are archived + replaced. */
    l1_preview_limit: z<number, number, "defined">;
    /** L2: keep the last N real user turns untouched; older read-only scaffolding pairs are snipped. */
    l2_snip_after_turns: z<number, number, "defined">;
    /** L2: which tool names count as read-only query scaffolding (exact or trailing-* glob). */
    l2_query_tools: z<string[], string[], "defined">;
    /** L3: maximum surface messages one microcompact range may span. */
    l3_micro_max_range: z<number, number, "defined">;
    /** L3: default for cache_aware — reject ranges that strictly contain a real-user-turn start. */
    l3_cache_aware: z<boolean, boolean, "defined">;
    /** acp_rule: gate the acp_rule tool + per-turn rule injection. Default off. */
    acp_rule: z<boolean, boolean, "defined">;
    /** L1: root directory for archived full tool results (~ expanded). */
    context_store_dir: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** Master switch: when false the suite registers no tools and no listeners. */
    enable: z<boolean, boolean, "defined">;
    /** L1: tool results longer than this many code points are archived + replaced. */
    l1_preview_limit: z<number, number, "defined">;
    /** L2: keep the last N real user turns untouched; older read-only scaffolding pairs are snipped. */
    l2_snip_after_turns: z<number, number, "defined">;
    /** L2: which tool names count as read-only query scaffolding (exact or trailing-* glob). */
    l2_query_tools: z<string[], string[], "defined">;
    /** L3: maximum surface messages one microcompact range may span. */
    l3_micro_max_range: z<number, number, "defined">;
    /** L3: default for cache_aware — reject ranges that strictly contain a real-user-turn start. */
    l3_cache_aware: z<boolean, boolean, "defined">;
    /** acp_rule: gate the acp_rule tool + per-turn rule injection. Default off. */
    acp_rule: z<boolean, boolean, "defined">;
    /** L1: root directory for archived full tool results (~ expanded). */
    context_store_dir: z<string, string, "defined">;
}>>, "plain">;
export interface CompactionPrepConfig {
    enable: boolean;
    l1_preview_limit: number;
    l2_snip_after_turns: number;
    l2_query_tools: string[];
    l3_micro_max_range: number;
    l3_cache_aware: boolean;
    acp_rule: boolean;
    context_store_dir: string;
}
/** Validate + apply defaults. The plugin Config/Service layer owns this call. */
export declare function resolveConfig(config?: Partial<CompactionPrepConfig>): CompactionPrepConfig;
