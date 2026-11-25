// Enforcement for the real harness session. `createToolPolicy` is handed to MinecraftSession as `toolPolicy`, which
// applies it to the final tool list, after session_history is appended and before pi or invokeTool can see any tool.
//
// These may never be allowlisted: they run code or commands, write to disk, read a transcript that could carry state
// between runs, or give movement a player does not have in a survival benchmark.
export const FORBIDDEN_TOOLS = Object.freeze([
    'run_shell',
    'shared_exec',
    'compute_js',
    'workspace_read',
    'workspace_write',
    'workspace_list',
    'session_history',
    'run_code',
    'run_tool',
    'fly_to',
    'read_plan',
    'append_plan',
]);

export class ToolPolicyError extends Error {
    code = 'TOOL_POLICY';
}

export function assertAllowlistSafe(allowlist) {
    if (!Array.isArray(allowlist) || !allowlist.length) throw new ToolPolicyError('The tool allowlist is empty');
    const banned = allowlist.filter(name => FORBIDDEN_TOOLS.includes(name));
    if (banned.length) throw new ToolPolicyError(`The allowlist includes forbidden tools: ${banned.join(', ')}`);
    if (new Set(allowlist).size !== allowlist.length) throw new ToolPolicyError('The allowlist has duplicate tools');
    return allowlist;
}

// Fails closed: a tool the scenario expects but the harness did not build stops startup, and so does an unknown tool
// unless it is explicitly listed as known and removed. Each admitted tool is wrapped so a reference held elsewhere
// still rechecks the frozen list at execution.
export function createToolPolicy({ allowlist, optional = [], onRemoved = () => {} }) {
    assertAllowlistSafe(allowlist);
    const allowed = new Set(allowlist);
    return tools => {
        const seen = new Set(tools.map(tool => tool.name));
        const missing = allowlist.filter(name => !seen.has(name) && !optional.includes(name));
        if (missing.length) throw new ToolPolicyError(`Allowlisted tools are missing: ${missing.join(', ')}`);
        const admitted = [];
        for (const tool of tools) {
            if (!allowed.has(tool.name)) {
                onRemoved(tool.name);
                continue;
            }
            const execute = tool.execute;
            admitted.push(
                Object.freeze({
                    ...tool,
                    execute(...args) {
                        if (!allowed.has(tool.name)) throw new ToolPolicyError(`Tool ${tool.name} is not allowed`);
                        return execute.apply(tool, args);
                    },
                }),
            );
        }
        return admitted;
    };
}
