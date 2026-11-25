'use strict';
// Stands in for the claude and codex binaries in tests. No test ever starts the real CLIs for a model request.
// usage: node fake-cli.cjs <mode> <captureFile> ...cli args
const fs = require('node:fs');
const [mode, captureFile, ...args] = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (stdin += chunk));
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const decision = { done: false, tool: 'gather', argsJson: '{"block":"oak_log","count":1}', note: 'collect logs' };
const claudeInit = {
    type: 'system',
    subtype: 'init',
    tools: [],
    mcp_servers: [],
    apiKeySource: 'none',
    model: 'fake-claude',
};
const claudeResult = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(decision),
    usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    modelUsage: { 'fake-claude': {} },
    total_cost_usd: 0.0123,
};
const modes = {
    claude_ok() {
        emit(claudeInit);
        emit(claudeResult);
    },
    claude_structured_tool() {
        emit(claudeInit);
        emit({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: decision }] },
        });
        emit({ ...claudeResult, result: '', structured_output: decision });
    },
    claude_tool_attempt() {
        emit(claudeInit);
        emit({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'whoami' } }] },
        });
        setTimeout(() => emit(claudeResult), 3000);
    },
    claude_tools_exposed() {
        emit({ ...claudeInit, tools: ['Bash', 'Read'] });
        setTimeout(() => emit(claudeResult), 3000);
    },
    claude_api_key_source() {
        emit({ ...claudeInit, apiKeySource: 'ANTHROPIC_API_KEY' });
        setTimeout(() => emit(claudeResult), 3000);
    },
    claude_not_logged_in() {
        emit({ type: 'result', is_error: true, subtype: 'error', result: 'Not logged in. Please run /login' });
        process.exitCode = 1;
    },
    claude_rate_limit() {
        emit({ type: 'result', is_error: true, subtype: 'error', result: 'Claude usage limit reached' });
        process.exitCode = 1;
    },
    claude_garbage() {
        process.stdout.write('this is not json\n');
    },
    codex_ok() {
        emit({ type: 'thread.started', thread_id: 't' });
        emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(decision) } });
        emit({ type: 'turn.completed', usage: { input_tokens: 21, cached_input_tokens: 4, output_tokens: 9 } });
    },
    codex_shell_attempt() {
        emit({ type: 'item.started', item: { type: 'command_execution', command: 'dir C:\\Users' } });
        setTimeout(() => emit({ type: 'turn.completed', usage: {} }), 3000);
    },
    hang() {
        setTimeout(() => {}, 60000);
    },
};
process.stdin.on('end', () => {
    if (captureFile !== '-') fs.writeFileSync(captureFile, JSON.stringify({ args, stdin, env: process.env }));
    modes[mode]();
});
