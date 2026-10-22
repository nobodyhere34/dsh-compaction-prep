import type { Session } from '@deepseek-ai/dsh-session';
import type { AcpRule } from './types.js';
/**
 * acp_rule (L4): model-written, principle-level compaction policy. Rules are
 * durable per session (log events, never rewritten), injected as the newest
 * instruction row per channel at the next agent pre-step, and automatically
 * re-injected after compression (they sit behind the kernel's newest-row
 * guard, so a compress never folds the active rule set).
 */
export interface PrepRuleEvent {
    readonly op: 'add' | 'remove';
    readonly ruleId?: string;
    readonly principle?: string;
    readonly at: string;
}
declare module '@deepseek-ai/dsh-session' {
    interface SessionEventMap {
        'compaction/prep-rules': PrepRuleEvent;
    }
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'plugin:dsh-compaction-prep': {
            readonly kind: 'plugin:dsh-compaction-prep';
        };
    }
}
/** Source kind stamped on every instruction row this plugin appends. */
export declare const PREP_SOURCE_KIND: "plugin:dsh-compaction-prep";
export declare const MAX_ACP_RULES = 16;
export declare const MAX_PRINCIPLE_CHARS = 2000;
export declare const RULE_CHANNEL = "dsh-compaction-prep";
export declare class RuleLedger {
    private readonly cache;
    private readonly lastInjected;
    /** Replay the durable per-session rule log (validating against the live chef). */
    rulesOf(session: Session): AcpRule[];
    /** Append a rule op durably, then invalidate the live cache. */
    apply(session: Session, op: {
        op: 'add';
        principle: string;
    } | {
        op: 'remove';
        ruleId: string;
    }): AcpRule[];
    /** True when the durable rule set differs from the last-injected one. */
    isDirty(session: Session): boolean;
    /**
     * Inject the current rule set as the newest instruction row when it
     * changed. Returns true when a row was appended. The pre-step hook is the
     * single commit point: rules become model-visible exactly at the next
     * request boundary and survive compression via the same newest-row guard
     * the host uses for AGENTS.md.
     */
    injectIfChanged(session: Session): boolean;
    private nextId;
    private replay;
}
