// A deterministic stand-in for a model: it reads the observation and returns the next scripted tool call. It opens no
// sockets and has no dependencies on the network. Its output proves the pipeline runs; it says nothing about any model.

const WANT_LOGS = 4;

export function scriptedDecision(observation) {
    const inv = observation?.inventory ?? {};
    const done = new Set(observation?.completed ?? []);
    const has = (name, n = 1) => (inv[name] ?? 0) >= n;
    const planks = needed => {
        if (has('oak_log')) return call('craft', { item: 'oak_planks', count: 4 });
        if ((observation?.logsCollected ?? 0) < WANT_LOGS)
            return call('gather', { block: 'oak_log', count: WANT_LOGS });
        return { done: true, text: `scripted plan stuck: needs ${needed} planks and has no logs` };
    };
    if (!done.has('table_placed')) {
        if (has('crafting_table')) return call('place', { block: 'crafting_table', slot: 'table' });
        return has('oak_planks', 4) ? call('craft', { item: 'crafting_table', count: 1 }) : planks(4);
    }
    if (!done.has('chest_placed')) {
        if (has('chest')) return call('place', { block: 'chest', slot: 'chest' });
        return has('oak_planks', 8) ? call('craft', { item: 'chest', count: 1 }) : planks(8);
    }
    if (!done.has('deposited'))
        return has('oak_planks') ? call('deposit', { item: 'oak_planks', count: 1 }) : planks(1);
    if (!done.has('ate'))
        return has('sweet_berries')
            ? call('eat', { item: 'sweet_berries' })
            : call('gather', { block: 'sweet_berry_bush', count: 1 });
    return { done: true, text: 'scripted plan complete' };
}

const call = (tool, args) => ({ tool, args, text: `scripted: ${tool}` });

// faults (tests only, never reachable from a config file) is a list consumed one per request:
//   'timeout'    hangs until the broker's timeout, like a request whose billing outcome is unknown
//   'malformed'  returns a reply without usable usage data
//   'refused'    fails before anything could bill, for example a connection refused
//   'rate_limit' a provider 429 that did not bill
export function createMockProvider({
    faults = [],
    usage = { inputTokens: 10, outputTokens: 5 },
    model = 'scripted-v1',
} = {}) {
    const queue = [...faults];
    let calls = 0;
    return {
        name: 'mock',
        get calls() {
            return calls;
        },
        async invoke({ observation, signal }) {
            calls++;
            const fault = queue.shift();
            if (fault === 'timeout')
                return new Promise((_, reject) => {
                    signal.addEventListener('abort', () =>
                        reject(Object.assign(new Error('timed out'), { kind: 'timeout' })),
                    );
                });
            if (fault === 'malformed') return { model, malformed: true };
            if (fault === 'refused') throw Object.assign(new Error('connection refused'), { kind: 'not_sent' });
            if (fault === 'rate_limit')
                throw Object.assign(new Error('rate limited'), { kind: 'not_billed', retryable: true });
            return { model, usage, decision: scriptedDecision(observation) };
        },
    };
}
