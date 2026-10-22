import z from '@deepseek-ai/schemastery';
/**
 * Query-class read-only scaffolding tools that snip_history may remove when
 * they are older than the keep window. Matched exactly or by trailing
 * `*` glob. Never list write/execution tools here — snipping a write tool's
 * pair would hide its side effects from history.
 */
export const DEFAULT_QUERY_TOOLS = [
    'search_context',
    'read_file',
    'glob',
    'grep',
    'web_search',
    'web_fetch',
    'ls',
    'read',
    'browse*',
    'session*',
];
export const CompactionPrepConfigSchema = z.object({
    /** Master switch: when false the suite registers no tools and no listeners. */
    enable: z.boolean().default(true),
    /** L1: tool results longer than this many code points are archived + replaced. */
    l1_preview_limit: z.number().step(1).min(64).default(2048),
    /** L2: keep the last N real user turns untouched; older read-only scaffolding pairs are snipped. */
    l2_snip_after_turns: z.number().step(1).min(1).default(5),
    /** L2: which tool names count as read-only query scaffolding (exact or trailing-* glob). */
    l2_query_tools: z.array(z.string()).default([...DEFAULT_QUERY_TOOLS]),
    /** L3: maximum surface messages one microcompact range may span. */
    l3_micro_max_range: z.number().step(1).min(2).default(50),
    /** L3: default for cache_aware — reject ranges that strictly contain a real-user-turn start. */
    l3_cache_aware: z.boolean().default(true),
    /** acp_rule: gate the acp_rule tool + per-turn rule injection. Default off. */
    acp_rule: z.boolean().default(false),
    /** L1: root directory for archived full tool results (~ expanded). */
    context_store_dir: z.string().default('~/.dsh/context-store'),
});
/** Validate + apply defaults. The plugin Config/Service layer owns this call. */
export function resolveConfig(config = {}) {
    const resolved = CompactionPrepConfigSchema(config);
    return {
        enable: resolved.enable,
        l1_preview_limit: resolved.l1_preview_limit,
        l2_snip_after_turns: resolved.l2_snip_after_turns,
        l2_query_tools: resolved.l2_query_tools,
        l3_micro_max_range: resolved.l3_micro_max_range,
        l3_cache_aware: resolved.l3_cache_aware,
        acp_rule: resolved.acp_rule,
        context_store_dir: resolved.context_store_dir,
    };
}
