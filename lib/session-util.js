/** Content blocks of an event's message payload (user rows contribute none). */
export function contentBlocksOfEvent(event) {
    const data = event.data;
    return data?.message?.content ?? [];
}
export function extractText(blocks) {
    let out = '';
    for (const block of blocks) {
        if (block.type === 'text')
            out += block.text;
        else if (block.type === 'tool-result' && block.content)
            out += extractText(block.content);
    }
    return out;
}
export function codePointLength(text) {
    return Array.from(text).length;
}
/** Tool call ids named by an assistant message (tool-call blocks, or a tool_calls field). */
export function toolCallIdsOf(event) {
    const ids = [];
    for (const block of contentBlocksOfEvent(event)) {
        if (block.type === 'tool-call')
            ids.push(String(block.id));
    }
    const extra = event.data.message?.tool_calls;
    if (extra)
        for (const call of extra)
            if (typeof call.id === 'string')
                ids.push(call.id);
    return ids;
}
/** Tool names named by an assistant message, keyed by call id. */
export function toolCallNamesOf(event) {
    const names = new Map();
    for (const block of contentBlocksOfEvent(event)) {
        if (block.type === 'tool-call')
            names.set(String(block.id), block.name);
    }
    const extra = event.data.message?.tool_calls;
    if (extra)
        for (const call of extra)
            if (call.id && typeof call.name === 'string')
                names.set(call.id, call.name);
    return names;
}
/** The call id answered by a tool/result node, or null. */
export function resultCallIdOf(event) {
    if (event.type !== 'tool/result')
        return null;
    return String(event.data.message.source.callId);
}
/** All surface nodes in log (seq) order. */
export function surfaceNodesOf(session) {
    const nodes = [];
    for (const seq of [...session.surface.nodes]) {
        const event = session.eventAt(seq);
        if (event)
            nodes.push(event);
    }
    return nodes;
}
/** Surface seqs strictly inside [start, end] (both inclusive). */
export function surfaceSeqsInRange(session, start, end) {
    const set = new Set([...session.surface.nodes]);
    const seqs = [];
    for (let seq = start; seq <= end; seq++)
        if (set.has(seq))
            seqs.push(seq);
    return seqs;
}
/** Group assistant tool-calls messages with their tool/result answers. */
export function pairGroupsOf(session) {
    const groups = [];
    const byCallId = new Map();
    for (const seq of [...session.surface.nodes]) {
        const event = session.eventAt(seq);
        if (!event)
            continue;
        if (event.type === 'assistant/message') {
            const ids = toolCallIdsOf(event);
            if (ids.length === 0)
                continue;
            const names = new Set(toolCallNamesOf(event).values());
            const group = { callSeq: seq, callIds: ids, names, resultSeqs: [], minSeq: seq, maxSeq: seq };
            for (const id of ids)
                byCallId.set(id, group);
            groups.push(group);
        }
        else if (event.type === 'tool/result') {
            const callId = resultCallIdOf(event);
            if (!callId)
                continue;
            const group = byCallId.get(callId);
            if (group) {
                group.resultSeqs.push(seq);
                if (seq > group.maxSeq)
                    group.maxSeq = seq;
                if (seq < group.minSeq)
                    group.minSeq = seq;
            }
        }
    }
    return groups;
}
/** Exact match or trailing-* glob against a tool name. */
export function globsMatch(globs, name) {
    for (const glob of globs) {
        if (glob === name)
            return true;
        if (glob.endsWith('*') && name.startsWith(glob.slice(0, -1)))
            return true;
    }
    return false;
}
