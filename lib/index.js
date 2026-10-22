import { Service } from '@deepseek-ai/cordis';
import { CompactionPrepConfigSchema, resolveConfig } from './config.js';
import { RuleLedger } from './rules.js';
import { buildToolDefinitions } from './tools.js';
import { hideCompressPair } from './adapter.js';
import { guardRange } from './protect.js';
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
export class CompactionPrepSuite extends Service {
    static inject = ['tools'];
    static Config = CompactionPrepConfigSchema;
    /** Immutable resolved configuration. */
    config;
    rules = new RuleLedger();
    microPairs = new Map();
    disposers = [];
    toolsRegistered = false;
    constructor(ctx, config = {}) {
        super(ctx, 'compactionPrepSuite');
        this.config = resolveConfig(config);
        if (!this.config.enable) {
            ctx.logger.info('dsh-compaction-prep disabled by config (enable:false); nothing registered');
            return;
        }
        this.registerTools();
        // Late tools arrival: when the ACP engine bundle injects after us.
        this.disposers.push(ctx.on('internal/service', (name) => {
            if (name === 'tools' && !this.toolsRegistered)
                this.registerTools();
        }));
        this.disposers.push(ctx.on('tools/pre-execute', (exec, next) => this.guard(exec, next)));
        this.disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
            try {
                const agent = payload.agent;
                if (agent?.session) {
                    await this.hideMicroPairs(agent.session);
                    if (this.config.acp_rule)
                        this.rules.injectIfChanged(agent.session);
                }
            }
            catch (error) {
                ctx.logger.warn('dsh-compaction-prep pre-step hook failed: %s', String(error));
            }
            return next();
        }));
        ctx.logger.info('dsh-compaction-prep active: trim_tool_results / snip_history / microcompact / acp_rule (acp_rule tool %s)', this.config.acp_rule ? 'enabled' : 'disabled');
    }
    registerTools() {
        if (this.toolsRegistered)
            return;
        const bindings = {
            ctx: this.ctx,
            config: this.config,
            rules: this.rules,
            microPairs: this.microPairs,
        };
        for (const def of buildToolDefinitions(bindings)) {
            this.disposers.push(this.ctx.tools.register(def));
        }
        this.toolsRegistered = true;
    }
    /** Hide completed microcompact call/result pairs from the surface (provider-safe view). */
    async hideMicroPairs(session) {
        const id = String(session.id);
        const pairs = this.microPairs.get(id);
        if (!pairs || pairs.size === 0)
            return;
        for (const callId of [...pairs]) {
            const hidden = await hideCompressPair(session, callId);
            if (hidden)
                pairs.delete(callId);
        }
    }
    /**
     * Pre-execute backstop: verified-readings checkpoints are never foldable
     * through the compress-family tools, whatever the calling route. The
     * microcompact handler repeats the full guard (instructions + readings);
     * this hook only enforces the readings invariant for both names.
     */
    async guard(exec, next) {
        if (exec.name === 'microcompact' || exec.name === 'compress') {
            const session = exec.agent?.session;
            if (session) {
                const args = exec.arguments;
                const range = args?.content?.[0];
                if (range && typeof range.startSeq === 'number' && typeof range.endSeq === 'number') {
                    const rejection = guardRange(session, range.startSeq, range.endSeq, {
                        checkInstructions: false,
                        checkVerifiedReadings: true,
                    });
                    if (rejection)
                        return { kind: 'deny', reason: rejection };
                }
            }
        }
        return next();
    }
}
export { RuleLedger, MAX_ACP_RULES, MAX_PRINCIPLE_CHARS } from './rules.js';
export { buildToolDefinitions } from './tools.js';
export { decodeAcpBlockLedger, ACP_BLOCK_LEDGER_MARKER } from './ledger.js';
export { CompactionPrepConfigSchema, resolveConfig } from './config.js';
export { engineOf, bcdModule } from './adapter.js';
export default CompactionPrepSuite;
