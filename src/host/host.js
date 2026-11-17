'use strict';
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { LIMITS, HOST_VERSION, API_VERSION } = require('../core/constants');
const { Store } = require('../core/store');
const { Registry, UserError } = require('../core/registry');
const { effectivePermissions, hostMatches, requestedPermissions } = require('../core/permissions');
const { settingsDefaults } = require('../core/manifest');
const { validate } = require('../core/schema');
const { PluginProcess, PluginCallError, explain } = require('./plugin-process');
const { LogStore } = require('./logs');

const SEP = '__';
const toolName = (pluginId, name) => `${pluginId}${SEP}${name}`;

function permError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * The Host: owns plugin processes and the only path between plugins and the
 * outside world (network, secrets, other plugins, the agent).
 */
class Host extends EventEmitter {
  constructor({ store, quiet = false } = {}) {
    super();
    this.setMaxListeners(100);
    this.store = store || new Store();
    this.registry = new Registry(this.store);
    this.logs = new LogStore(this.store.paths.logs);
    this.procs = new Map(); // id -> { proc, sig, configSig }
    this.quiet = quiet;
    this._reconciling = Promise.resolve();
    this.logs.subscribe((e) => this.emit('event', { type: 'log', entry: e }));
  }

  hostLog(level, msg, pluginId) {
    this.logs.add({ pluginId, level, msg, source: 'host' });
  }

  audit(entry) {
    try {
      fs.appendFileSync(this.store.paths.audit, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch {}
  }

  // ---------------------------------------------------------------- lifecycle
  async init({ watch = true } = {}) {
    await this.reconcile();
    if (watch) {
      this._unwatch = this.store.watch(() => {
        this.hostLog('info', '检测到外部（CLI）修改了插件状态，正在同步');
        this.reconcile();
        this.emit('event', { type: 'state.changed' });
      });
    }
  }

  /** Make running processes match the desired state in state.json. Serialized. */
  reconcile() {
    this._reconciling = this._reconciling.then(() => this._reconcile()).catch((e) => this.hostLog('error', `同步失败：${e.message}`));
    return this._reconciling;
  }

  async _reconcile() {
    const state = this.store.load();
    const wanted = new Set();
    for (const rec of Object.values(state.plugins)) {
      const d = this.registry.describe(rec);
      const shouldRun = rec.enabled && d.manifestOk && d.compat.compatible && !(rec.pendingPermissions || []).length;
      if (!shouldRun) continue;
      wanted.add(rec.id);
      const config = d.config;
      const sig = JSON.stringify({ path: rec.path, v: rec.version, g: [...(rec.grants || [])].sort(), ws: this.store.paths.workspace });
      const configSig = JSON.stringify(config);
      const cur = this.procs.get(rec.id);
      if (cur && cur.sig === sig) {
        if (cur.configSig !== configSig) {
          cur.configSig = configSig;
          cur.proc.ctx.config = config;
          if (cur.proc.status === 'running') {
            try {
              await cur.proc.call('config.changed', { config }, { timeoutMs: 3000 });
              this.hostLog('info', '配置已热更新', rec.id);
            } catch (e) {
              this.hostLog('warn', `配置热更新失败，重启插件：${e.message}`, rec.id);
              await this.restart(rec.id);
            }
          }
        }
        continue;
      }
      if (cur) {
        this.hostLog('info', '版本或权限变化，重启插件进程', rec.id);
        await cur.proc.stop();
        this.procs.delete(rec.id);
      }
      await this.spawn(rec, d, sig, configSig);
    }
    for (const [id, cur] of this.procs) {
      if (!wanted.has(id)) {
        await cur.proc.stop();
        this.procs.delete(id);
        this.hostLog('info', '已停止', id);
      }
    }
    this.emit('event', { type: 'plugins.changed' });
  }

  async spawn(rec, d, sig, configSig) {
    const ctx = { workspace: this.store.paths.workspace, dataDir: this.store.pluginDataDir(rec.id), config: d.config };
    const perms = effectivePermissions(d.manifest, rec.grants, { workspace: ctx.workspace, pluginData: ctx.dataDir });
    const proc = new PluginProcess({ id: rec.id, record: rec, manifest: d.manifest, perms, ctx, broker: (p, m, params) => this.broker(p, m, params) });
    proc.on('log', (e) => this.logs.add(e));
    proc.on('status', (s) => this.emit('event', { type: 'plugin.status', ...s }));
    proc.on('progress', (p) => this.emit('event', { type: 'tool.progress', ...p }));
    this.procs.set(rec.id, { proc, sig, configSig });
    try {
      await proc.start();
    } catch {
      // status + lastError already recorded on proc; host keeps running.
    }
  }

  async restart(id) {
    const cur = this.procs.get(id);
    if (!cur) {
      await this.reconcile();
      return;
    }
    cur.proc.resetCircuit();
    await cur.proc.stop();
    try {
      await cur.proc.start();
    } catch {}
  }

  async shutdown() {
    if (this._unwatch) this._unwatch();
    await Promise.all([...this.procs.values()].map((c) => c.proc.stop()));
    this.procs.clear();
  }

  // ------------------------------------------------------------------ broker
  async broker(proc, method, params) {
    const id = proc.id;
    if (method === 'http.fetch') return this.brokerFetch(proc, params);
    if (method === 'secrets.get') {
      if (!proc.perms.secrets.includes(params.name)) {
        this.hostLog('warn', `拒绝读取未授权的密钥 ${params.name}`, id);
        this.audit({ type: 'secret.denied', pluginId: id, name: params.name });
        throw permError('ERR_PERMISSION_SECRET', `插件 ${id} 没有读取密钥 ${params.name} 的权限`);
      }
      this.audit({ type: 'secret.read', pluginId: id, name: params.name });
      return this.store.getSecret(params.name);
    }
    throw new Error(`未知宿主 API：${method}`);
  }

  async brokerFetch(proc, { url, method = 'GET', headers = {}, body, timeoutMs }) {
    const id = proc.id;
    let target;
    try {
      target = new URL(url);
    } catch {
      throw new Error(`无效 URL：${url}`);
    }
    const started = Date.now();
    const deadline = Math.min(timeoutMs || 15000, LIMITS.providerTimeoutMs);
    for (let hop = 0; hop < 5; hop++) {
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error(`不支持的协议 ${target.protocol}`);
      if (!proc.perms.network.some((p) => hostMatches(p, target.hostname))) {
        this.hostLog('warn', `拦截网络请求 ${method} ${target.origin}（未授权）`, id);
        this.audit({ type: 'network.denied', pluginId: id, host: target.hostname });
        throw permError(
          'ERR_PERMISSION_NETWORK',
          `插件 ${id} 没有访问 ${target.hostname} 的网络权限（已授予：${proc.perms.network.join(', ') || '无'}）`,
        );
      }
      const res = await fetch(target, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(deadline) });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
        target = new URL(res.headers.get('location'), target); // re-checked against grants next hop
        continue;
      }
      const text = await readCapped(res, LIMITS.maxFetchBytes);
      const hdrs = {};
      res.headers.forEach((v, k) => (hdrs[k] = v));
      this.hostLog('debug', `${method} ${target.origin}${target.pathname} → ${res.status}（${Date.now() - started}ms）`, id);
      this.audit({ type: 'network', pluginId: id, host: target.hostname, status: res.status });
      return { status: res.status, statusText: res.statusText, headers: hdrs, body: text };
    }
    throw new Error('重定向次数过多');
  }

  // ------------------------------------------------------------------- views
  pluginState(d) {
    const cur = this.procs.get(d.id);
    if (!d.manifestOk) return 'invalid';
    if (!d.compat.compatible) return 'incompatible';
    if (!d.enabled) return 'disabled';
    if ((d.pendingPermissions || []).length) return 'needs-approval';
    return cur ? cur.proc.status : 'stopped';
  }

  listPlugins() {
    return this.registry.list().map((d) => {
      const cur = this.procs.get(d.id);
      const snap = cur ? cur.proc.snapshot() : null;
      return {
        id: d.id,
        name: d.manifest ? d.manifest.name : d.id,
        description: d.manifest ? d.manifest.description : '',
        author: d.manifest ? d.manifest.author : '',
        version: d.version,
        source: d.source,
        path: d.path,
        enabled: d.enabled,
        state: this.pluginState(d),
        manifestErrors: d.manifestErrors,
        compat: d.compat,
        permissions: d.permissions,
        config: d.config,
        settings: d.manifest ? d.manifest.contributes.settings : {},
        contributes: d.manifest
          ? {
              tools: d.manifest.contributes.tools.map((t) => ({
                name: t.name,
                qualifiedName: toolName(d.id, t.name),
                description: t.description,
                input: t.input || { type: 'object', properties: {} },
                examples: t.examples || [],
                patterns: t.patterns || [],
                timeoutMs: t.timeoutMs,
              })),
              hooks: d.manifest.contributes.hooks,
              providers: d.manifest.contributes.providers,
            }
          : { tools: [], hooks: [], providers: [] },
        process: snap,
        installedAt: d.installedAt,
        updatedAt: d.updatedAt,
      };
    });
  }

  running(id) {
    const cur = this.procs.get(id);
    return cur && cur.proc.status === 'running' ? cur.proc : null;
  }

  listTools({ availableOnly = true } = {}) {
    const out = [];
    for (const p of this.listPlugins()) {
      const usable = p.enabled && ['running', 'crashed', 'starting'].includes(p.state);
      if (availableOnly && !usable) continue;
      for (const t of p.contributes.tools) {
        out.push({
          name: t.qualifiedName,
          pluginId: p.id,
          tool: t.name,
          description: t.description,
          input_schema: t.input,
          patterns: t.patterns,
          examples: t.examples,
          timeoutMs: t.timeoutMs,
          available: p.state === 'running',
        });
      }
    }
    return out;
  }

  listProviders() {
    const out = [];
    for (const p of this.listPlugins()) {
      for (const pr of p.contributes.providers) {
        out.push({ ref: `${p.id}/${pr.name}`, pluginId: p.id, name: pr.name, label: pr.label || pr.name, description: pr.description || '', state: p.state });
      }
    }
    return out;
  }

  info() {
    return {
      hostVersion: HOST_VERSION,
      apiVersion: API_VERSION,
      home: this.store.home,
      workspace: this.store.paths.workspace,
      settings: this.store.load().settings,
      node: process.version,
    };
  }

  // ------------------------------------------------------------------- tools
  resolveTool(name) {
    const norm = name.includes(SEP) ? name : name.replace('.', SEP);
    const [pluginId, tool] = norm.split(SEP);
    const tools = this.listTools({ availableOnly: false });
    return tools.find((t) => t.pluginId === pluginId && t.tool === tool) || null;
  }

  async invokeTool(name, input, meta = {}) {
    const started = Date.now();
    const spec = this.resolveTool(name);
    const fail = (kind, message, extra = {}) => {
      const r = { ok: false, tool: spec ? spec.name : name, pluginId: spec && spec.pluginId, error: { kind, message, ...extra }, durationMs: Date.now() - started };
      this.audit({ type: 'tool', tool: r.tool, ok: false, kind, message, session: meta.sessionId, via: meta.via });
      return r;
    };
    if (!spec) return fail('not_found', `找不到工具 ${name}（插件未安装或未启用）`);
    const proc = this.running(spec.pluginId);
    if (!proc) {
      const p = this.listPlugins().find((x) => x.id === spec.pluginId);
      return fail('unavailable', `插件 ${spec.pluginId} 当前不可用（状态：${p ? p.state : '未知'}）${p && p.process && p.process.lastError ? `：${p.process.lastError.message}` : ''}`);
    }
    const v = validate(spec.input_schema, input);
    if (!v.ok) return fail('invalid_input', `参数错误：${v.errors.join('；')}`);
    let args = v.value;
    const notes = [];

    try {
      const before = await this.runHooks('tool.beforeCall', { tool: spec.name, pluginId: spec.pluginId, input: args }, meta);
      notes.push(...before.notes);
      if (before.blocked) return { ...fail('blocked', before.reason), notes };
      args = before.payload.input;
    } catch (e) {
      return fail('blocked', e.message);
    }

    let result;
    const timeoutMs = Math.min(spec.timeoutMs || LIMITS.defaultToolTimeoutMs, LIMITS.maxToolTimeoutMs);
    try {
      result = await proc.call('tool.invoke', { name: spec.tool, input: args, callId: meta.callId }, { timeoutMs });
    } catch (e) {
      const message = e instanceof PluginCallError ? explain(e, spec.pluginId) : e.message;
      this.hostLog(e.kind === 'error' ? 'warn' : 'error', `工具 ${spec.tool} 失败：${message}`, spec.pluginId);
      return { ...fail(e.kind || 'error', message), notes };
    }

    let content = String(result.content ?? '');
    if (content.length > LIMITS.maxResultChars) content = `${content.slice(0, LIMITS.maxResultChars)}\n…（结果过长，已截断 ${content.length - LIMITS.maxResultChars} 字符）`;
    let out = { content, data: result.data, display: result.display };

    try {
      const after = await this.runHooks('tool.afterCall', { tool: spec.name, pluginId: spec.pluginId, input: args, result: out }, meta);
      notes.push(...after.notes);
      if (after.blocked) return { ...fail('blocked', after.reason), notes };
      out = after.payload.result;
    } catch (e) {
      return fail('blocked', e.message);
    }
    const r = { ok: true, tool: spec.name, pluginId: spec.pluginId, input: args, ...out, notes, durationMs: Date.now() - started };
    this.audit({ type: 'tool', tool: spec.name, ok: true, ms: r.durationMs, session: meta.sessionId, via: meta.via });
    return r;
  }

  // ------------------------------------------------------------------- hooks
  /**
   * Run every enabled hook for `event` in priority order. Each hook may return
   * a partial payload (merged), `{ block: true, reason }`, and/or `{ note }`.
   * failMode "open" (default): a failing hook is skipped. "closed": the
   * action is blocked — for security hooks that must not be bypassed by a crash.
   */
  async runHooks(event, payload, meta = {}) {
    const subs = [];
    for (const p of this.listPlugins()) {
      if (!p.enabled || ['disabled', 'invalid', 'incompatible'].includes(p.state)) continue;
      for (const h of p.contributes.hooks) if (h.event === event) subs.push({ pluginId: p.id, state: p.state, ...h });
    }
    subs.sort((a, b) => (a.priority || 100) - (b.priority || 100));
    let cur = payload;
    const notes = [];
    for (const h of subs) {
      const proc = this.running(h.pluginId);
      try {
        if (!proc) throw new Error(`插件状态为 ${h.state}`);
        const r = await proc.call('hook.run', { event, payload: cur }, { timeoutMs: h.timeoutMs || LIMITS.defaultHookTimeoutMs });
        if (r.note) notes.push({ pluginId: h.pluginId, event, note: r.note });
        if (r.block) {
          this.hostLog('info', `hook ${event} 阻止了操作：${r.reason || '未说明原因'}`, h.pluginId);
          return { blocked: true, reason: `被插件 ${h.pluginId} 阻止：${r.reason || '未说明原因'}`, payload: cur, notes };
        }
        if (r.payload && typeof r.payload === 'object') cur = { ...cur, ...r.payload };
      } catch (e) {
        const msg = e instanceof PluginCallError ? explain(e, h.pluginId) : e.message;
        if (h.failMode === 'closed') {
          this.hostLog('error', `hook ${event} 失败且 failMode=closed，阻止操作：${msg}`, h.pluginId);
          return { blocked: true, reason: `安全 hook（${h.pluginId}）不可用，操作已按 failMode=closed 阻止：${msg}`, payload: cur, notes };
        }
        this.hostLog('warn', `hook ${event} 失败，已跳过（failMode=open）：${msg}`, h.pluginId);
        notes.push({ pluginId: h.pluginId, event, note: `hook 失败已跳过：${msg}`, error: true });
      }
    }
    return { blocked: false, payload: cur, notes };
  }

  // --------------------------------------------------------------- providers
  async complete(request, meta = {}) {
    const ref = this.store.load().settings.activeProvider;
    if (!ref) throw new UserError('没有选择模型提供方（Provider）。请在「插件」中启用 rule-router 或 openrouter-provider，并在对话页选择');
    const [pluginId, name] = ref.split('/');
    const proc = this.running(pluginId);
    if (!proc) {
      const p = this.listPlugins().find((x) => x.id === pluginId);
      throw new UserError(`当前 Provider ${ref} 不可用（插件状态：${p ? p.state : '未安装'}）`);
    }
    try {
      return await proc.call('provider.complete', { name, request }, { timeoutMs: LIMITS.providerTimeoutMs });
    } catch (e) {
      throw new UserError(`Provider ${ref} 出错：${e instanceof PluginCallError ? explain(e, pluginId) : e.message}`);
    }
  }

  // Convenience wrappers so CLI and server share behavior
  setActiveProvider(ref) {
    if (ref && !this.listProviders().some((p) => p.ref === ref)) throw new UserError(`未知 Provider ${ref}`);
    this.registry.setSetting('activeProvider', ref || null);
    this.emit('event', { type: 'state.changed' });
  }

  requestedPermissions(id) {
    const rec = this.registry.get(id);
    return requestedPermissions(this.registry.manifestFor(rec).manifest);
  }

  defaults(id) {
    return settingsDefaults(this.registry.manifestFor(this.registry.get(id)).manifest);
  }
}

async function readCapped(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw new Error(`响应体超过 ${Math.round(max / 1024)}KB 上限`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { Host, toolName, SEP };
