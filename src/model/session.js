import { mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSessionHistoryTool } from './session-history.js';
import { failureCode } from '../tools/game-tools.js';
import { findModel } from './extra-models.js';
import { sanitizeImages, isImageRejection, redactPayloads } from './image-guard.js';

export async function createMinecraftSession(options, dependencies = {}) {
    const runner = new MinecraftSession(options, dependencies);
    await runner.init();
    return runner;
}

export async function createPiSession(options, modules) {
    const sdk = modules?.sdk ?? (await import('@earendil-works/pi-coding-agent'));
    const directory = join(resolve(options.sessionDir), options.agentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const settingsManager = sdk.SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: false, provider: { maxRetries: 0 } },
        enableAnalytics: false,
        enableInstallTelemetry: false,
        enableSkillCommands: false,
    });
    const modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(directory, 'auth.json'),
        modelsPath: options.modelsPath ?? null,
        allowModelNetwork: false,
    });
    const m = options.model ?? {};
    const model = m.baseUrl
        ? await registerCompatibleModel(modelRuntime, m, options, modules)
        : await resolveCatalogModel(modelRuntime, m, options);
    const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: options.systemPrompt,
    });
    await resourceLoader.reload();
    const sessionManager = sdk.SessionManager.continueRecent(options.cwd, directory);
    const { session } = await sdk.createAgentSession({
        cwd: options.cwd,
        agentDir: directory,
        modelRuntime,
        model,
        thinkingLevel: options.thinkingLevel ?? 'medium',
        sessionManager,
        settingsManager,
        resourceLoader,
        noTools: 'builtin',
        tools: options.tools.map(tool => tool.name),
        customTools: options.tools,
    });
    return { session, sessionManager, compatible: Boolean(m.baseUrl) };
}

async function resolveCatalogModel(modelRuntime, m, options) {
    if (!m.provider || !m.id)
        throw new Error('Model must be given as <provider>/<model-id>, for example openai/gpt-6.1-terra');
    if (options.apiKey) await modelRuntime.setRuntimeApiKey(m.provider, options.apiKey);
    const model = findModel(modelRuntime, m.provider, m.id);
    if (!model)
        throw new Error(
            `Unknown model ${m.provider}/${m.id}. Use a model from the pi catalog, a models.json entry, or set a base URL for an OpenAI Responses compatible endpoint.`,
        );
    return model;
}

async function registerCompatibleModel(modelRuntime, m, options, modules) {
    const responses = modules?.responses ?? (await import('@earendil-works/pi-ai/api/openai-responses'));
    const provider = m.provider || 'custom';
    modelRuntime.registerProvider(provider, {
        api: 'openai-responses',
        baseUrl: m.baseUrl,
        models: [
            {
                contextWindow: m.contextWindow ?? 128000,
                maxTokens: m.maxTokens ?? 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                ...options.modelConfig,
                thinkingLevelMap: { off: m.offEffort ?? 'low' },
                id: m.id,
                name: m.name ?? m.id,
                reasoning: true,
                input: m.input ?? ['text', 'image'],
                api: 'openai-responses',
            },
        ],
        streamSimple: (model, context, streamOptions) =>
            responses.stream(model, context, {
                ...streamOptions,
                maxTokens: Math.min(streamOptions?.maxTokens ?? model.maxTokens, model.maxTokens),
                ...(m.headers ? { headers: { ...streamOptions?.headers, ...m.headers } } : {}),
                ...(m.serviceTier ? { serviceTier: m.serviceTier } : {}),
                ...(m.requestTimeoutMs
                    ? {
                          signal: streamOptions?.signal
                              ? AbortSignal.any([streamOptions.signal, AbortSignal.timeout(m.requestTimeoutMs)])
                              : AbortSignal.timeout(m.requestTimeoutMs),
                      }
                    : {}),
            }),
    });
    if (options.apiKey) await modelRuntime.setRuntimeApiKey(provider, options.apiKey);
    const model = modelRuntime.getModel(provider, m.id);
    if (!model) throw new Error('Model registration failed');
    return model;
}

const BREAKPOINT_TYPES = new Set(['input_text', 'input_image', 'input_file']);
function markParts(parts) {
    if (!Array.isArray(parts) || !parts.length) return null;
    const last = parts.at(-1);
    if (!last || !BREAKPOINT_TYPES.has(last.type)) return null;
    return [...parts.slice(0, -1), { ...last, prompt_cache_breakpoint: { mode: 'explicit' } }];
}
const TOOL_NOTE = '(tool results above)';
export function anthropicPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const strip = parts =>
        Array.isArray(parts)
            ? parts.map(p => {
                  if (!p?.prompt_cache_breakpoint) return p;
                  const { prompt_cache_breakpoint, ...rest } = p;
                  return rest;
              })
            : parts;
    const { prompt_cache_key, ...rest } = payload;
    if (!Array.isArray(rest.input)) return rest;
    const src = rest.input,
        out = [];
    let lastNote = -1;
    for (let i = 0; i < src.length; i++) {
        const it = src[i];
        out.push(
            it?.type === 'function_call_output'
                ? { ...it, output: strip(it.output) }
                : Array.isArray(it?.content)
                  ? { ...it, content: strip(it.content) }
                  : it,
        );
        if (it?.type === 'function_call_output' && src[i + 1]?.type !== 'function_call_output') {
            out.push({ role: 'user', content: [{ type: 'input_text', text: TOOL_NOTE }] });
            if (i + 1 < src.length) lastNote = out.length - 1;
        }
    }
    if (lastNote >= 0)
        out[lastNote] = {
            role: 'user',
            content: [{ type: 'input_text', text: TOOL_NOTE, cache_control: { type: 'ephemeral' } }],
        };
    return { ...rest, input: out };
}
export function markCacheBreakpoint(payload) {
    const input = payload?.input;
    if (!Array.isArray(input) || input.length < 2) return payload;
    for (let i = input.length - 2; i >= 0; i--) {
        const item = input[i];
        let next = null;
        if (item?.type === 'function_call_output') {
            const parts = markParts(
                typeof item.output === 'string' ? [{ type: 'input_text', text: item.output }] : item.output,
            );
            if (parts) next = { ...item, output: parts };
        } else if (item?.role === 'user' || item?.role === 'developer' || item?.role === 'system') {
            const parts = markParts(
                typeof item.content === 'string' ? [{ type: 'input_text', text: item.content }] : item.content,
            );
            if (parts) next = { ...item, content: parts };
        }
        if (next) {
            const copy = [...input];
            copy[i] = next;
            return { ...payload, input: copy };
        }
    }
    return payload;
}

const STATE_TYPE = 'minecraft-scheduler-v1';
const defaultClock = { now: () => Date.now(), setTimeout, clearTimeout };
const stopError = () => new Error('Minecraft cycle stopped');
function safeErrorMetadata(error) {
    const names = new Set([
        'Error',
        'TypeError',
        'RangeError',
        'AbortError',
        'TimeoutError',
        'APIError',
        'APIConnectionError',
        'APIConnectionTimeoutError',
        'AuthenticationError',
        'PermissionDeniedError',
        'RateLimitError',
        'BadRequestError',
        'InternalServerError',
        'NotFoundError',
    ]);
    const codes = new Set([
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ERR_MODULE_NOT_FOUND',
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        'ABORT_ERR',
        'invalid_api_key',
        'insufficient_quota',
        'rate_limit_exceeded',
        'model_not_found',
        'context_length_exceeded',
    ]);
    const metadata = { errorName: names.has(error?.name) ? error.name : 'Error' };
    if (codes.has(error?.code)) metadata.errorCode = error.code;
    const status = error?.status ?? error?.statusCode;
    if (Number.isInteger(status) && status >= 400 && status <= 599) metadata.httpStatus = status;
    return metadata;
}
const FATAL_MODEL_ERROR =
    /\b(401|403)\b|invalid.{0,3}(x-)?api.{0,3}key|incorrect api key|authentication|unauthori[sz]ed|permission_denied|no api key|api key not|credit balance|insufficient_quota|billing|model_not_found|not_found_error|model.{0,40}(not found|does not exist)/i;

export function interruptedTurn(entries, max = 1500) {
    const last = entries.filter(entry => entry.type === 'message').at(-1)?.message;
    if (last?.role !== 'assistant' || last.stopReason !== 'aborted') return null;
    const text = (last.content ?? [])
        .map(block => (block.type === 'thinking' ? block.thinking : block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();
    return { notes: text.length > max ? `...${text.slice(-max)}` : text };
}

export function resumePrompt({ reconnected = false, interrupted = null } = {}) {
    if (!reconnected && !interrupted) return '';
    const lines = [
        reconnected
            ? 'You were disconnected from the server and have just reconnected. Your body, inventory and sandbox are as you left them; check the observation for anything that changed.'
            : 'The harness restarted.',
    ];
    if (interrupted)
        lines.push(
            interrupted.notes
                ? `Your previous turn was cut off before you acted. Your reasoning so far, verbatim: <<${interrupted.notes}>>. Do not re-plan from scratch: continue that plan and make your next tool call right away.`
                : 'Your previous turn was cut off before you acted. Make your next tool call right away.',
        );
    return lines.join('\n');
}

export function isFatalModelError(message) {
    return FATAL_MODEL_ERROR.test(String(message ?? ''));
}

const textOf = result =>
    Array.isArray(result?.content)
        ? result.content
              .filter(c => c?.type === 'text')
              .map(c => c.text)
              .join('')
        : typeof result === 'string'
          ? result
          : '';
export function compactResult(text, max = 300) {
    let value;
    try {
        value = JSON.parse(text);
    } catch {
        return clip(String(text ?? '').replace(/\s+/g, ' '), max);
    }
    if (value && typeof value === 'object' && 'completed' in value && 'result' in value) value = value.result;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const { log, note, ...rest } = value;
        value = rest;
    }
    return clip(value, max);
}

const clip = (value, max) => {
    const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return s.length > max ? `${s.slice(0, max)}...` : s;
};

function metric(callback, data) {
    try {
        void Promise.resolve(callback?.(data)).catch(() => {});
    } catch {}
}

function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(stopError());
    return new Promise((resolvePromise, reject) => {
        const stop = () => reject(stopError());
        signal.addEventListener('abort', stop, { once: true });
        Promise.resolve(promise)
            .then(resolvePromise, reject)
            .finally(() => signal.removeEventListener('abort', stop));
    });
}

const IDLE_TOOLS = new Set([
    'wait',
    'read_dms',
    'unread_dms',
    'dm_counts',
    'observe_world',
    'look',
    'look_around',
    'session_history',
    'directory',
    'directory_search',
    'inventory',
]);

class MinecraftSession {
    constructor(options, dependencies) {
        if (!/^[A-Za-z0-9_-]+$/.test(options.agentId ?? '')) throw new Error('Invalid agentId');
        if (!options.cwd || !options.sessionDir || !options.systemPrompt?.trim())
            throw new Error('Explicit paths and systemPrompt required');
        if (typeof options.observe !== 'function') throw new Error('observe required');
        this.options = {
            idleMs: 10000,
            minWakeMs: 1000,
            maxWallMs: 1800000,
            maxModelCalls: 400,
            maxToolCalls: 1200,
            maxQueue: 64,
            maxBackoffMs: 300000,
            idleBackoffMaxMs: 300000,
            cacheBreakpoint: true,
            continuous: false,
            ...options,
        };
        for (const name of [
            'idleMs',
            'minWakeMs',
            'maxWallMs',
            'maxModelCalls',
            'maxToolCalls',
            'maxQueue',
            'maxBackoffMs',
        ]) {
            if (!Number.isSafeInteger(this.options[name]) || this.options[name] < 1) throw new Error(`Invalid ${name}`);
        }
        this.clock = dependencies.clock ?? defaultClock;
        this.createSession = dependencies.createSession ?? createPiSession;
        this.queue = new Map();
        this.paused = true;
        this.closed = false;
        this.timer = null;
        this.nextWakeAt = null;
        this.failures = 0;
        this.active = null;
        this.work = null;
        this.sequence = 0;
    }

    async invokeTool(name, args, signal) {
        const tool = this.wrappedTools?.get(name);
        if (!tool) throw new Error(`Unknown tool: ${String(name).slice(0, 60)}`);
        if (name === 'session_history' || name === 'run_code' || name === 'run_tool')
            throw new Error(`Tool ${name} cannot be called from code.`);
        const result = await tool.execute('code', args, signal);
        const text = result?.content?.map(c => c.text ?? '').join('') ?? '';
        if (result?.isError) throw new Error(`${name}: ${text.slice(0, 2000)}`);
        if (result?.details && 'result' in result.details) return result.details.result;
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    async init() {
        const names = new Set();
        if (this.options.tools?.some(tool => tool.name === 'session_history'))
            throw new Error('Reserved native tool name: session_history');
        const candidates = [...(this.options.tools ?? []), createSessionHistoryTool(() => this.manager.getEntries())];
        const admitted = this.options.toolPolicy ? this.options.toolPolicy(candidates) : candidates;
        const tools = admitted.map(
            tool => {
                if (!tool.name || names.has(tool.name) || typeof tool.execute !== 'function')
                    throw new Error('Invalid or duplicate native tool');
                names.add(tool.name);
                return {
                    ...tool,
                    executionMode: 'sequential',
                    execute: async (...args) => {
                        const cycle = this.active;
                        if (!cycle || cycle.stop || cycle.controller.signal.aborted) throw stopError();
                        if (cycle.tools >= this.options.maxToolCalls) {
                            this.stopCycle('budget');
                            throw stopError();
                        }
                        cycle.tools++;
                        cycle.inTool = (cycle.inTool ?? 0) + 1;
                        (cycle.toolNames ??= []).push(tool.name);
                        const start = this.clock.now();
                        let success = false;
                        let code = 'unknown';
                        let signal, errorText, resultText;
                        try {
                            signal = args[2]
                                ? AbortSignal.any([args[2], cycle.controller.signal])
                                : cycle.controller.signal;
                            let result = await tool.execute(args[0], args[1], signal, args[3], args[4]);
                            success = !signal.aborted && !result?.isError;
                            resultText = textOf(result);
                            if (!success) {
                                code = failureCode(result, signal);
                                errorText =
                                    result?.details?.error ?? result?.content?.find?.(c => c.type === 'text')?.text;
                            }
                            const note = this.options.toolResultNote?.();
                            if (note)
                                result = {
                                    ...(result ?? {}),
                                    content: [
                                        ...(Array.isArray(result?.content) ? result.content : []),
                                        { type: 'text', text: note },
                                    ],
                                };
                            return result;
                        } catch (error) {
                            code = failureCode(error, signal);
                            errorText = error?.message ?? error;
                            throw error;
                        } finally {
                            cycle.inTool--;
                            metric(this.options.telemetry, {
                                tool: tool.name,
                                args: clip(args[1] ?? {}, 500),
                                timeMs: this.clock.now() - start,
                                success,
                                ...(!success ? { failureCode: code } : {}),
                                result: redactPayloads(compactResult(String(errorText ?? resultText ?? ''), 300)),
                            });
                            if (!success && !signal?.aborted)
                                this.diagnose({
                                    event: 'tool_error',
                                    tool: tool.name,
                                    failureCode: code,
                                    errorMessage: redactPayloads(String(errorText ?? '').slice(0, 400)),
                                });
                        }
                    },
                };
            },
        );
        this.wrappedTools = new Map(tools.map(tool => [tool.name, tool]));
        const result = await this.createSession({ ...this.options, tools });
        this.session = result.session;
        this.compatible = result.compatible !== false;
        this.manager = result.sessionManager ?? this.session.sessionManager;
        const messages = this.manager.getEntries().filter(entry => entry.type === 'message').length;
        this.sessionInfo = { file: this.manager.getSessionFile?.() ?? null, resumed: messages > 0, messages };
        const interrupted = messages > 0 ? interruptedTurn(this.manager.getEntries()) : null;
        this.resume = resumePrompt({ reconnected: Boolean(this.options.reconnected), interrupted });
        if (interrupted) this.sessionInfo.interrupted = true;
        const saved = this.manager
            .getEntries()
            .filter(entry => entry.type === 'custom' && entry.customType === STATE_TYPE)
            .at(-1)?.data;
        if (Number.isFinite(saved?.nextWakeAt)) this.nextWakeAt = saved.nextWakeAt;
        const originalTransform = this.session.agent.transformContext?.bind(this.session.agent);
        this.session.agent.transformContext = async (messages, signal) => {
            const cycle = this.active;
            if (!cycle || cycle.stop || signal?.aborted) throw stopError();
            if (cycle.steps >= this.options.maxModelCalls) {
                this.stopCycle('budget');
                throw stopError();
            }
            cycle.steps++;
            const frameStart = this.clock.now();
            cycle.callStartedAt = frameStart;
            let observation;
            try {
                observation = await abortable(
                    this.options.observe({
                        events: cycle.events,
                        signal: cycle.controller.signal,
                        step: cycle.steps,
                    }),
                    cycle.controller.signal,
                );
                cycle.observations++;
            } finally {
                cycle.observationMs += this.clock.now() - frameStart;
            }
            if (cycle.stop || signal?.aborted) throw stopError();
            if (!observation || typeof observation.text !== 'string') throw new Error('Invalid observation');
            if (observation.waitUntil != null) {
                this.requestWait(observation.waitUntil);
                throw stopError();
            }
            const previous = originalTransform ? await originalTransform(messages, signal) : messages;
            if (cycle.stop || signal?.aborted) throw stopError();
            const { messages: outgoing, removed } = sanitizeImages(
                [
                    ...previous,
                    {
                        role: 'user',
                        timestamp: this.clock.now(),
                        content: [
                            {
                                type: 'text',
                                text: `Current observation (fresh for this decision):\n${observation.text}`,
                            },
                            ...(observation.images ?? []),
                        ],
                    },
                ],
                { allowImages: !cycle.imagesDisabled },
            );
            if (removed.length)
                this.diagnose({
                    event: 'images_omitted',
                    step: cycle.steps,
                    retry: Boolean(cycle.imagesDisabled),
                    removed,
                });
            return outgoing;
        };
        const originalPayload = this.session.agent.onPayload?.bind(this.session.agent);
        this.session.agent.onPayload = async (payload, model) => {
            const base = originalPayload ? ((await originalPayload(payload, model)) ?? payload) : payload;
            if (!this.compatible) return base;
            if (/claude/i.test(String(base?.model ?? model?.id ?? ''))) return anthropicPayload(base);
            return this.options.cacheBreakpoint === false ? base : markCacheBreakpoint(base);
        };
        this.unsubscribe = this.session.subscribe(event => {
            if (event.type === 'tool_execution_end' && this.active?.stop === 'wait') this.abortAgent();
            if (event.type === 'message_end' && event.message?.role === 'assistant') {
                const said = textOf(event.message).trim();
                if (said) metric(this.options.onText, said);
            }
            if (
                event.type === 'message_end' &&
                event.message?.role === 'assistant' &&
                event.message.stopReason === 'error' &&
                this.active &&
                !this.active.stop
            ) {
                this.active.failed = true;
                const errorMessage = redactPayloads(event.message.errorMessage);
                this.active.lastErrorMessage = event.message.errorMessage;
                this.diagnose({
                    event: 'model_error',
                    step: this.active.steps,
                    imageRetry: Boolean(this.active.imagesDisabled),
                    errorMessage,
                });
                this.active.error = { errorName: 'Error', errorCode: 'SDK_ASSISTANT_ERROR' };
                this.reportModelError(event.message.errorMessage);
            }
        });
    }

    reportModelError(message) {
        const text = redactPayloads(String(message ?? 'unknown model error')).slice(0, 600);
        if (isFatalModelError(text)) metric(this.options.onFatal, text);
        else metric(this.options.onModelError, text);
    }

    diagnose(event) {
        metric(this.options.diagnostics, { time: new Date(this.clock.now()).toISOString(), ...event });
    }

    save() {
        this.manager.appendCustomEntry(STATE_TYPE, { nextWakeAt: this.nextWakeAt });
    }

    start() {
        if (this.closed) throw new Error('Session closed');
        this.paused = false;
        this.arm(this.nextWakeAt ?? this.clock.now());
    }

    enqueue(event, { key, urgent = false, interrupt = true, restart = false } = {}) {
        if (this.closed) return false;
        this.queue.set(key ?? `event:${++this.sequence}`, event);
        if (this.idleStreak) {
            this.idleStreak = 0;
            if (!this.active && Number.isFinite(this.idleWaitUntil) && this.nextWakeAt > this.idleWaitUntil) {
                this.nextWakeAt = Math.max(this.clock.now(), this.idleWaitUntil);
                this.save();
                this.arm(this.nextWakeAt);
            }
        }
        while (this.queue.size > this.options.maxQueue) this.queue.delete(this.queue.keys().next().value);
        if (!this.paused && urgent && (!this.options.continuous || key === 'damage' || key === 'hit')) {
            this.nextWakeAt = this.clock.now();
            this.save();
            if (this.active) {
                this.active.wakeAt ??= this.nextWakeAt;
                if (interrupt && !this.options.continuous) this.stopCycle('interrupt');
                else if (restart && !(this.active.inTool > 0) && !this.active.stop) {
                    const now = this.clock.now(),
                        gap = this.options.hitRestartMs ?? 2000;
                    const informed =
                        (this.options.hitInfoAt?.() ?? -Infinity) >= (this.active.callStartedAt ?? Infinity) - 10000;
                    if (!informed && now - (this.lastRestartAt ?? -Infinity) >= gap) {
                        this.lastRestartAt = now;
                        this.diagnose({ event: 'hit_restart', step: this.active.steps });
                        this.stopCycle('hit');
                    }
                }
            } else this.arm(this.nextWakeAt);
        }
        return true;
    }

    requestWait(untilMs) {
        if (!Number.isFinite(untilMs)) throw new Error('Wait requires finite epoch milliseconds');
        if (!this.active) throw new Error('Wait requires active cycle');
        this.nextWakeAt = Math.min(
            Math.max(untilMs, this.clock.now() + this.options.minWakeMs),
            this.active.wakeAt ?? Infinity,
        );
        this.save();
        this.active.stop = 'wait';
        return this.nextWakeAt;
    }

    arm(at) {
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = null;
        if (this.paused || this.closed || this.active) return;
        const delay = Math.min(2147483647, Math.max(0, at - this.clock.now()));
        this.timer = this.clock.setTimeout(() => {
            this.timer = null;
            if (this.paused || this.closed) return;
            if (at > this.clock.now()) {
                this.arm(at);
                return;
            }
            this.work = this.runCycle();
        }, delay);
    }

    setThinking(level) {
        if (!level) return;
        try {
            this.session.setThinkingLevel?.(level);
        } catch {}
    }

    abortAgent() {
        try {
            void Promise.resolve(this.session.abort()).catch(() => {});
        } catch {}
    }

    stopCycle(reason) {
        if (!this.active) return;
        this.active.stop = reason;
        this.active.controller.abort();
        this.abortAgent();
    }

    async runCycle() {
        if (this.active || this.paused || this.closed) return;
        const cycle = {
            controller: new AbortController(),
            events: [...this.queue.values()],
            steps: 0,
            tools: 0,
            stop: null,
            failed: false,
            startedAt: this.clock.now(),
            observations: 0,
            observationMs: 0,
        };
        this.queue.clear();
        this.active = cycle;
        this.nextWakeAt = null;
        const deadline = this.clock.setTimeout(() => this.stopCycle('budget'), this.options.maxWallMs);
        const resume = this.resume;
        if (resume && this.options.resumeThinkingLevel) this.setThinking(this.options.resumeThinkingLevel);
        try {
            const headline = this.options.turnHeadline?.();
            await this.session.prompt(
                (resume ? `${resume}\n\n` : '') +
                    (headline ? `${headline}\n\n` : '') +
                    (this.options.continuous
                        ? `Next turn.${cycle.events.length ? `\nEvents since your last turn:\n${JSON.stringify(cycle.events)}` : ''}\nUse the current observation.`
                        : `Wake events:\n${JSON.stringify(cycle.events)}\nUse the current observation.`),
                { expandPromptTemplates: false },
            );
            await this.session.waitForIdle();
            const budgetLeftMs = cycle.startedAt + this.options.maxWallMs - this.clock.now();
            if (
                cycle.failed &&
                !cycle.stop &&
                !cycle.imagesDisabled &&
                isImageRejection(cycle.lastErrorMessage) &&
                (cycle.controller.signal.aborted || budgetLeftMs < 10000)
            ) {
                this.diagnose({
                    event: 'image_400_no_retry',
                    reason: cycle.controller.signal.aborted ? 'cycle aborted' : 'under 10 s of cycle budget left',
                    budgetLeftMs,
                });
            } else if (
                cycle.failed &&
                !cycle.stop &&
                !cycle.imagesDisabled &&
                isImageRejection(cycle.lastErrorMessage)
            ) {
                const messages = this.session.agent.state.messages;
                const last = messages.at(-1);
                if (last?.role === 'assistant' && last.stopReason === 'error') {
                    this.session.agent.state.messages = messages.slice(0, -1);
                    cycle.imagesDisabled = true;
                    cycle.failed = false;
                    cycle.firstError = cycle.error;
                    cycle.error = undefined;
                    cycle.imageRetries = 1;
                    this.diagnose({
                        event: 'image_400_retry',
                        step: cycle.steps,
                        action: 'retry same turn once without images',
                    });
                    await this.session.agent.continue();
                    await this.session.waitForIdle();
                }
            }
        } catch (error) {
            if (!cycle.stop) {
                cycle.failed = true;
                cycle.error = safeErrorMetadata(error);
                cycle.errorMessage = redactPayloads(String(error?.message ?? error)).slice(0, 600);
                this.diagnose({ event: 'cycle_error', step: cycle.steps, errorMessage: cycle.errorMessage });
                this.reportModelError(cycle.errorMessage);
            }
        } finally {
            this.clock.clearTimeout(deadline);
            if (resume && cycle.tools > 0) this.resume = '';
            if (resume && this.options.resumeThinkingLevel && !this.resume)
                this.setThinking(this.options.thinkingLevel);
            this.active = null;
            if (cycle.failed) {
                this.failures++;
                this.nextWakeAt =
                    this.clock.now() +
                    Math.max(
                        this.options.minWakeMs,
                        Math.min(this.options.maxBackoffMs, this.options.idleMs * 2 ** Math.min(this.failures - 1, 20)),
                    );
            } else if (cycle.stop === 'budget') {
                this.failures = 0;
                this.nextWakeAt = this.clock.now() + this.options.minWakeMs;
            } else {
                this.failures = 0;
                this.nextWakeAt ??= this.options.continuous
                    ? this.clock.now()
                    : this.clock.now() + Math.max(this.options.idleMs, this.options.minWakeMs);
            }
            const idleOnly =
                cycle.stop === 'wait' &&
                !cycle.failed &&
                !cycle.events.length &&
                (cycle.toolNames ?? []).includes('wait') &&
                cycle.toolNames.every(n => IDLE_TOOLS.has(n));
            if (idleOnly && this.options.idleBackoffMaxMs > 0 && Number.isFinite(this.nextWakeAt)) {
                this.idleStreak = (this.idleStreak ?? 0) + 1;
                const now = this.clock.now();
                const requested = Math.max(0, this.nextWakeAt - now);
                this.idleWaitUntil = this.nextWakeAt;
                if (this.idleStreak > 1)
                    this.nextWakeAt =
                        now +
                        Math.max(
                            requested,
                            Math.min(
                                this.options.idleBackoffMaxMs,
                                Math.max(requested, 15000) * 2 ** Math.min(this.idleStreak - 1, 6),
                            ),
                        );
            } else if (!cycle.failed) {
                this.idleStreak = 0;
                this.idleWaitUntil = null;
            }
            try {
                this.save();
            } catch {
                this.paused = true;
            }
            if (!this.paused && !this.closed) this.arm(this.nextWakeAt);
            metric(this.options.cycleTelemetry, {
                status: cycle.stop ?? (cycle.failed ? 'error' : 'complete'),
                ...(this.idleStreak ? { idleStreak: this.idleStreak } : {}),
                steps: cycle.steps,
                toolCalls: cycle.tools,
                observations: cycle.observations,
                observationMs: cycle.observationMs,
                timeMs: this.clock.now() - cycle.startedAt,
                nextWakeAt: !this.paused && !this.closed && Number.isFinite(this.nextWakeAt) ? this.nextWakeAt : null,
                ...cycle.error,
                ...(cycle.failed
                    ? {
                          errorMessage:
                              cycle.errorMessage ?? redactPayloads(String(cycle.lastErrorMessage ?? '')).slice(0, 600),
                      }
                    : {}),
                ...(cycle.imageRetries
                    ? { imageRetry: cycle.failed ? 'failed' : 'recovered', firstError: cycle.firstError }
                    : {}),
            });
        }
    }

    tryQuiesce() {
        if (
            this.active ||
            this.paused ||
            this.closed ||
            this.session.isIdle !== true ||
            !Number.isFinite(this.nextWakeAt)
        )
            return null;
        this.paused = true;
        this.closed = true;
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = null;
        this.save();
        return this.nextWakeAt;
    }

    async idle() {
        await this.work;
    }

    async cancel() {
        this.paused = true;
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = null;
        this.queue.clear();
        this.nextWakeAt = null;
        this.stopCycle('cancel');
        await this.idle();
    }

    async close() {
        this.closed = true;
        await this.cancel();
        this.unsubscribe?.();
        this.session.dispose();
    }
}
