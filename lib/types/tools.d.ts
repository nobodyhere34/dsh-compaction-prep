import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { RuleLedger } from './rules.js';
import type { CompactionPrepConfig } from './config.js';
/** Everything the L1–L4 handlers need from the plugin runtime. */
export interface ToolBindings {
    readonly ctx: Context;
    readonly config: CompactionPrepConfig;
    readonly rules: RuleLedger;
    /** callIds of in-flight microcompact executions, keyed by session id; hidden at the next pre-step. */
    readonly microPairs: Map<string, Set<string>>;
}
/** The four bypass-compaction tools. Registering them is the plugin's only effect. */
export declare function buildToolDefinitions(bindings: ToolBindings): ToolDefinition[];
