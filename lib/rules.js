import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** Source kind stamped on every instruction row this plugin appends. */
export const PREP_SOURCE_KIND = 'plugin:dsh-compaction-prep';
export const MAX_ACP_RULES = 16;
export const MAX_PRINCIPLE_CHARS = 2000;
export const RULE_CHANNEL = 'dsh-compaction-prep';
export class RuleLedger {
    cache = new WeakMap();
    lastInjected = new WeakMap();
    /** Replay the durable per-session rule log (validating against the live chef). */
    rulesOf(session) {
        const cached = this.cache.get(session);
        if (cached)
            return cached;
        const rules = this.replay(session);
        this.cache.set(session, rules);
        return rules;
    }
    /** Append a rule op durably, then invalidate the live cache. */
    apply(session, op) {
        const rules = [...this.rulesOf(session)];
        let eventData;
        if (op.op === 'add') {
            if (rules.length >= MAX_ACP_RULES) {
                throw new Error('acp_rule: rule budget reached (' + MAX_ACP_RULES + '). Remove a rule before adding another.');
            }
            const principle = op.principle.trim();
            if (principle.length === 0)
                throw new Error('acp_rule: principle must not be empty.');
            if (principle.length > MAX_PRINCIPLE_CHARS) {
                throw new Error('acp_rule: principle exceeds ' + MAX_PRINCIPLE_CHARS + ' chars.');
            }
            const id = 'r' + this.nextId(rules);
            rules.push({ id, principle });
            eventData = { op: 'add', ruleId: id, principle, at: new Date().toISOString() };
        }
        else {
            const index = rules.findIndex((rule) => rule.id === op.ruleId);
            if (index < 0)
                throw new Error('acp_rule: no rule with id "' + op.ruleId + '".');
            rules.splice(index, 1);
            eventData = { op: 'remove', ruleId: op.ruleId, at: new Date().toISOString() };
        }
        session.append('compaction/prep-rules', eventData);
        this.cache.set(session, rules);
        return rules;
    }
    /** True when the durable rule set differs from the last-injected one. */
    isDirty(session) {
        return this.lastInjected.get(session) !== JSON.stringify(this.rulesOf(session));
    }
    /**
     * Inject the current rule set as the newest instruction row when it
     * changed. Returns true when a row was appended. The pre-step hook is the
     * single commit point: rules become model-visible exactly at the next
     * request boundary and survive compression via the same newest-row guard
     * the host uses for AGENTS.md.
     */
    injectIfChanged(session) {
        const rules = this.rulesOf(session);
        const json = JSON.stringify(rules);
        if (this.lastInjected.get(session) === json)
            return false;
        if (rules.length > 0) {
            session.append('user/message', createUserMessage({
                content: [{ type: 'text', text: ruleRowText(rules) }],
                source: { kind: PREP_SOURCE_KIND },
            }), { surfaceOp: 'append' });
        }
        this.lastInjected.set(session, json);
        return true;
    }
    nextId(rules) {
        let max = 0;
        for (const rule of rules) {
            const match = /^r(\d+)$/.exec(rule.id);
            if (match)
                max = Math.max(max, Number(match[1]));
        }
        return max + 1;
    }
    replay(session) {
        const rules = [];
        for (const event of sessionEventsOf(session)) {
            if (event.type !== 'compaction/prep-rules')
                continue;
            const data = event.data;
            if (data?.op === 'add' && typeof data.principle === 'string') {
                const id = typeof data.ruleId === 'string' && /^r\d+$/.test(data.ruleId) ? data.ruleId : 'r' + (rules.length + 1);
                const principle = data.principle.slice(0, MAX_PRINCIPLE_CHARS);
                if (principle.trim().length > 0)
                    rules.push({ id, principle });
            }
            else if (data?.op === 'remove' && typeof data.ruleId === 'string') {
                const index = rules.findIndex((rule) => rule.id === data.ruleId);
                if (index >= 0)
                    rules.splice(index, 1);
            }
        }
        return rules.slice(0, MAX_ACP_RULES);
    }
}
function ruleRowText(rules) {
    const lines = rules.map((rule) => '- [' + rule.id + '] ' + rule.principle);
    return '[dsh-compaction-prep-acp-rules] Model-written compaction principles (ACP rule set):\n' + lines.join('\n');
}
/** Iterate a session's durable log defensively (snapshot-aware sessions first). */
function sessionEventsOf(session) {
    const snap = session.snapshotEvents;
    if (typeof snap === 'function') {
        const result = snap.call(session);
        if (Array.isArray(result))
            return result;
    }
    const events = session.events;
    if (Array.isArray(events))
        return events;
    return [];
}
