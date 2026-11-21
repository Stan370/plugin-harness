'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIMITS } = require('../core/constants');

const SYSTEM_PROMPT = [
  'You are a helpful local assistant running inside "Plugin Harness".',
  'Your capabilities come entirely from installed plugins, exposed to you as tools.',
  'Use a tool when it helps answer the request; otherwise answer directly.',
  'If a tool returns an error, explain it to the user plainly and suggest a fix (e.g. enabling a plugin or granting a permission).',
  "Reply in the user's language and keep answers concise.",
].join('\n');

/**
 * Agent loop. Provider-agnostic: messages use a neutral format
 *   { role: 'user', content }
 *   { role: 'assistant', content, toolCalls?: [{id,name,input}], raw?: {provider, content} }
 *   { role: 'tool', results: [{ toolCallId, name, content, isError }] }
 * Providers translate this to their own wire format.
 */
class Agent {
  constructor(host) {
    this.host = host;
    this.dir = host.store.paths.sessions;
    this.sessions = new Map();
  }

  createSession({ title = '' } = {}) {
    const now = Date.now();
    const s = {
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      provider: null,
      model: null,
      systemPrompt: SYSTEM_PROMPT,
      parameters: {},
      messages: [],
      transcript: [],
    };
    this.sessions.set(s.id, s);
    this.cacheSession(s);
    this.save(s);
    return s;
  }

  cacheSession(s) {
    this.sessions.delete(s.id);
    this.sessions.set(s.id, s);
    while (this.sessions.size > 20) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }
  }

  session(id) {
    if (id && this.sessions.has(id)) {
      const hit = this.sessions.get(id);
      this.cacheSession(hit);
      return hit;
    }
    if (id && /^[a-z0-9-]{8,64}$/.test(id)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8'));
        s.messages = Array.isArray(s.messages) ? s.messages : [];
        s.transcript = Array.isArray(s.transcript) ? s.transcript : [];
        s.createdAt = s.createdAt || s.updatedAt || Date.now();
        s.updatedAt = s.updatedAt || s.createdAt;
        s.title = s.title || this.sessionTitle(s);
        s.systemPrompt = s.systemPrompt || SYSTEM_PROMPT;
        s.parameters = s.parameters || {};
        this.cacheSession(s);
        return s;
      } catch {}
    }
    return this.createSession();
  }

  getSession(id) {
    if (!id) throw new Error('会话 ID 不能为空');
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) {
      const e = new Error(`找不到会话 ${id}`);
      e.code = 'SESSION_NOT_FOUND';
      throw e;
    }
    return this.session(id);
  }

  deleteSession(id) {
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    this.sessions.delete(id);
    return true;
  }

  renameSession(id, title) {
    const s = this.getSession(id);
    s.title = String(title || '').trim().slice(0, 80);
    if (!s.title) s.title = this.sessionTitle(s);
    this.save(s);
    return s;
  }

  sessionTitle(s) {
    const first = (s.transcript || []).find((t) => t.type === 'user');
    return first ? String(first.text || '').trim().slice(0, 40) : '新对话';
  }

  listSessions() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
            const transcript = Array.isArray(s.transcript) ? s.transcript : [];
            const first = transcript.find((t) => t.type === 'user');
            const turns = transcript.filter((t) => t.type === 'user').length;
            return {
              id: s.id,
              title: s.title || (first ? String(first.text).slice(0, 40) : '新对话'),
              createdAt: s.createdAt || s.updatedAt || 0,
              updatedAt: s.updatedAt || s.createdAt || 0,
              provider: s.provider || null,
              model: s.model || null,
              turns,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50);
    } catch {
      return [];
    }
  }

  save(s) {
    s.updatedAt = Date.now();
    if (!s.title || s.title === '新对话') s.title = this.sessionTitle(s);
    s.provider = s.provider || this.host.store.load().settings.activeProvider || null;
    try {
      fs.writeFileSync(path.join(this.dir, `${s.id}.json`), JSON.stringify(s));
    } catch {}
  }

  /**
   * Run one user turn. `emit(event)` receives transcript events as they
   * happen so the UI/CLI can render progress.
   */
  async run(sessionId, text, emit = () => {}) {
    const s = this.session(sessionId);
    s.provider = this.host.store.load().settings.activeProvider || s.provider || null;
    const push = (ev) => {
      const e = { ts: Date.now(), ...ev };
      if (!['thinking', 'done'].includes(e.type)) s.transcript.push(e);
      emit({ sessionId: s.id, ...e });
      return e;
    };
    const meta = { sessionId: s.id };
    try {
      const raw = String(text || '').trim();
      if (!raw) return s;
      if (raw.startsWith('/')) {
        push({ type: 'user', text: raw });
        await this.command(raw, push, meta);
        return s;
      }

      const hooked = await this.host.runHooks('chat.userMessage', { text: raw }, meta);
      push({ type: 'user', text: raw, ...(hooked.payload.text !== raw ? { rewritten: hooked.payload.text } : {}) });
      for (const n of hooked.notes) push({ type: 'note', pluginId: n.pluginId, text: n.note, error: n.error });
      if (hooked.blocked) {
        push({ type: 'error', text: hooked.reason });
        return s;
      }
      s.messages.push({ role: 'user', content: hooked.payload.text });

      for (let step = 0; step < LIMITS.agentMaxSteps; step++) {
        const tools = this.host.listTools().filter((t) => t.available);
        push({ type: 'thinking', step });
        const res = await this.host.complete({ system: SYSTEM_PROMPT, messages: s.messages, tools }, meta);
        if (!res || !['text', 'tool_calls'].includes(res.type)) throw new Error('Provider 返回了无法识别的结果');

        if (res.type === 'text') {
          s.messages.push({ role: 'assistant', content: res.text || '', raw: res.raw });
          push({ type: 'assistant', text: res.text || '', provider: res.provider, usage: res.usage });
          return s;
        }

        s.messages.push({ role: 'assistant', content: res.text || '', toolCalls: res.calls, raw: res.raw });
        if (res.text) push({ type: 'assistant', text: res.text, interim: true, provider: res.provider });
        const results = [];
        for (const call of res.calls) {
          push({ type: 'tool_call', callId: call.id, tool: call.name, input: call.input });
          const r = await this.host.invokeTool(call.name, call.input, { ...meta, callId: call.id, via: 'agent' });
          for (const n of r.notes || []) push({ type: 'note', pluginId: n.pluginId, text: n.note, error: n.error });
          push({ type: 'tool_result', callId: call.id, tool: call.name, ok: r.ok, content: r.ok ? r.content : r.error.message, errorKind: r.ok ? null : r.error.kind, display: r.display, data: r.data, durationMs: r.durationMs });
          results.push({ toolCallId: call.id, name: call.name, content: r.ok ? r.content : `ERROR (${r.error.kind}): ${r.error.message}`, isError: !r.ok });
        }
        s.messages.push({ role: 'tool', results });
      }
      push({ type: 'error', text: `已达到单轮最大步数（${LIMITS.agentMaxSteps}），停止以避免无限循环` });
    } catch (e) {
      push({ type: 'error', text: e.message });
      // Keep history valid for next turn: drop a dangling user message with no reply.
      const last = s.messages[s.messages.length - 1];
      if (last && last.role === 'user') s.messages.pop();
    } finally {
      push({ type: 'done' });
      this.save(s);
    }
    return s;
  }

  /** Slash commands: /help, /tools, /<plugin>.<tool> <args> */
  async command(raw, push, meta) {
    const [head] = raw.slice(1).split(/\s+/);
    const rest = raw.slice(1 + head.length).trim();
    if (head === 'help' || head === '') {
      push({ type: 'assistant', text: helpText(this.host.listTools()) });
      return;
    }
    if (head === 'tools') {
      const tools = this.host.listTools({ availableOnly: false });
      push({ type: 'assistant', text: tools.length ? tools.map((t) => `- \`/${t.pluginId}.${t.tool}\` ${t.available ? '' : '（不可用）'}— ${t.description}`).join('\n') : '没有已安装的工具。' });
      return;
    }
    const spec = this.host.resolveTool(head);
    if (!spec) {
      push({ type: 'error', text: `未知命令 /${head}。输入 /help 查看可用命令。` });
      return;
    }
    let input;
    try {
      input = parseArgs(rest, spec.input_schema);
    } catch (e) {
      push({ type: 'error', text: e.message });
      return;
    }
    const callId = `cmd-${Date.now()}`;
    push({ type: 'tool_call', callId, tool: spec.name, input });
    const r = await this.host.invokeTool(spec.name, input, { ...meta, callId, via: 'command' });
    for (const n of r.notes || []) push({ type: 'note', pluginId: n.pluginId, text: n.note, error: n.error });
    push({ type: 'tool_result', callId, tool: spec.name, ok: r.ok, content: r.ok ? r.content : r.error.message, errorKind: r.ok ? null : r.error.kind, display: r.display, data: r.data, durationMs: r.durationMs });
  }
}

/** `{json}` | `key=value key2="v 2"` | free text → first required string param. */
function parseArgs(rest, schema = {}) {
  if (!rest) return {};
  if (rest.startsWith('{')) {
    try {
      return JSON.parse(rest);
    } catch (e) {
      throw new Error(`参数 JSON 解析失败：${e.message}`);
    }
  }
  const props = schema.properties || {};
  const kv = [...rest.matchAll(/(\w+)=("([^"]*)"|(\S+))/g)];
  if (kv.length && kv.every((m) => props[m[1]])) {
    const out = {};
    for (const m of kv) out[m[1]] = m[3] !== undefined ? m[3] : m[4];
    return out;
  }
  const keys = (schema.required || []).filter((k) => (props[k] || {}).type === 'string');
  const key = keys[0] || Object.keys(props).find((k) => props[k].type === 'string');
  if (!key) throw new Error('这个工具不接受文本参数，请使用 {"key": "value"} 形式');
  return { [key]: rest };
}

function helpText(tools) {
  const lines = ['**可用命令**', '- `/help` 显示帮助', '- `/tools` 列出所有工具（含不可用的）'];
  for (const t of tools) lines.push(`- \`/${t.pluginId}.${t.tool} …\` ${t.description}`);
  lines.push('', '也可以直接用自然语言提问，由当前 Provider（规则路由或 OpenRouter 上的大模型）决定调用哪个工具。');
  return lines.join('\n');
}

module.exports = { Agent, parseArgs, SYSTEM_PROMPT };
