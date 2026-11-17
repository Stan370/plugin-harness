'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RUNTIME_DIR, LIMITS, HOST_VERSION, API_VERSION } = require('../core/constants');
const { realish } = require('../core/permissions');

class PluginCallError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'PluginCallError';
    this.kind = kind; // 'timeout' | 'crash' | 'error' | 'unavailable'
    Object.assign(this, extra);
  }
}

/** Turn low-level failures into something a user can act on. */
function explain(err, pluginId) {
  const msg = (err && err.message) || String(err);
  const code = err && err.code;
  if (code === 'ERR_ACCESS_DENIED' || /ERR_ACCESS_DENIED|Access to this API has been restricted/.test(msg)) {
    const res = (err && err.resource) || (msg.match(/resource: '([^']+)'/) || [])[1];
    if (/ChildProcess|child_process/i.test(msg)) return `插件 ${pluginId} 尝试启动子进程，宿主不允许插件创建进程。`;
    return `插件 ${pluginId} 尝试访问未授权的文件${res ? `（${res}）` : ''}。如确实需要，请在插件的权限中声明并授予 fs.read / fs.write。`;
  }
  if (code === 'ERR_HARNESS_NETWORK_DENIED' || code === 'ERR_PERMISSION_NETWORK') return msg;
  if (code === 'ERR_PERMISSION_SECRET') return msg;
  return msg;
}

/**
 * One plugin = one OS process. Owns spawn, JSON-RPC, timeouts, crash
 * detection and restart-with-backoff (circuit breaker).
 */
class PluginProcess extends EventEmitter {
  constructor({ id, record, manifest, perms, ctx, broker }) {
    super();
    this.id = id;
    this.record = record;
    this.manifest = manifest;
    this.perms = perms; // effective permissions, resolved
    this.ctx = ctx; // { workspace, dataDir, config }
    this.broker = broker; // handles plugin -> host requests
    this.status = 'stopped';
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.crashes = [];
    this.consecutiveTimeouts = 0;
    this.lastError = null;
    this.stderrTail = [];
    this.startedAt = null;
    this.restartTimer = null;
    this.stats = { calls: 0, errors: 0, timeouts: 0, totalMs: 0 };
  }

  setStatus(status, lastError) {
    this.status = status;
    if (lastError !== undefined) this.lastError = lastError;
    this.emit('status', { id: this.id, status, lastError: this.lastError });
  }

  nodeArgs() {
    const pluginDir = realish(this.record.path);
    const reads = [realish(RUNTIME_DIR), pluginDir, this.ctx.dataDir, ...this.perms['fs.read'], ...this.perms['fs.write']];
    const writes = [this.ctx.dataDir, ...this.perms['fs.write']];
    const mem = Math.min(this.manifest.memoryMb || LIMITS.defaultMemoryMb, LIMITS.maxMemoryMb);
    return [
      '--permission',
      // One flag per path (Node >= 22 no longer accepts comma-separated lists).
      ...[...new Set(reads)].map((p) => `--allow-fs-read=${p}`),
      ...[...new Set(writes)].map((p) => `--allow-fs-write=${p}`),
      `--max-old-space-size=${mem}`,
      '--no-warnings',
    ];
  }

  async start() {
    if (this.status === 'running' || this.status === 'starting') return;
    clearTimeout(this.restartTimer);
    this.setStatus('starting', null);
    this.stderrTail = [];
    const entry = path.join(realish(this.record.path), this.manifest.main);
    const child = fork(path.join(RUNTIME_DIR, 'runtime.js'), [entry], {
      cwd: realish(this.record.path),
      execArgv: this.nodeArgs(),
      // Clean environment: no inherited secrets/tokens. Secrets are brokered.
      env: { HARNESS_PLUGIN_ID: this.id, NODE_ENV: process.env.NODE_ENV || 'production', TZ: process.env.TZ || '', LANG: process.env.LANG || '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    this.child = child;
    this.startedAt = Date.now();

    child.stdout.on('data', (d) => this.emitLog('info', String(d).trimEnd()));
    child.stderr.on('data', (d) => {
      const text = String(d).trimEnd();
      this.stderrTail.push(...text.split('\n'));
      this.stderrTail = this.stderrTail.slice(-40);
      this.emitLog('error', text);
    });
    child.on('message', (msg) => this.onMessage(msg));
    child.on('error', (e) => this.emitLog('error', `进程错误：${e.message}`));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));

    try {
      await this.call(
        'activate',
        {
          id: this.id,
          version: this.manifest.version,
          hostVersion: HOST_VERSION,
          apiVersion: API_VERSION,
          config: this.ctx.config,
          workspace: this.ctx.workspace,
          dataDir: this.ctx.dataDir,
          permissions: this.perms,
          contributes: this.manifest.contributes,
        },
        { timeoutMs: this.manifest.activationTimeoutMs || LIMITS.activationTimeoutMs, internal: true },
      );
      if (this.child !== child) return; // superseded
      this.consecutiveTimeouts = 0;
      this.setStatus('running', null);
      this.emitLog('info', `已启动（pid ${child.pid}）`, 'host');
    } catch (e) {
      const reason = e.kind === 'timeout' ? `激活超时（>${this.manifest.activationTimeoutMs || LIMITS.activationTimeoutMs}ms）` : `激活失败：${explain(e, this.id)}`;
      this.emitLog('error', reason, 'host');
      // Activation failures are deterministic; don't restart-loop.
      this.kill();
      this.setStatus('failed', { message: reason, at: Date.now(), stderr: this.stderrTail.slice(-15) });
      throw new PluginCallError('unavailable', reason);
    }
  }

  emitLog(level, msg, source = 'plugin') {
    if (!msg) return;
    this.emit('log', { pluginId: this.id, level, msg, source, ts: Date.now() });
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return; // late reply after timeout
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = new PluginCallError('error', msg.error.message, { code: msg.error.code, resource: msg.error.resource, pluginStack: msg.error.stack });
        p.reject(err);
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'log') return this.emitLog(msg.params.level || 'info', String(msg.params.msg).slice(0, 4000));
    if (msg.method === 'progress') return this.emit('progress', { pluginId: this.id, ...msg.params });
    if (msg.id && msg.method) {
      // plugin -> host request (broker)
      Promise.resolve()
        .then(() => this.broker(this, msg.method, msg.params || {}))
        .then(
          (result) => this.child && this.child.connected && this.child.send({ id: msg.id, result }),
          (e) => this.child && this.child.connected && this.child.send({ id: msg.id, error: { message: e.message, code: e.code } }),
        );
    }
  }

  onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    const stopping = this.status === 'stopping' || this.status === 'stopped';
    const oom = this.stderrTail.some((l) => /heap out of memory|Allocation failed/i.test(l));
    const reason = oom
      ? `内存超出上限（${this.manifest.memoryMb || LIMITS.defaultMemoryMb}MB）被终止`
      : `进程退出（code=${code}${signal ? `, signal=${signal}` : ''}）`;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PluginCallError('crash', `插件 ${this.id} 在处理请求时崩溃：${reason}`));
    }
    this.pending.clear();
    if (stopping) {
      this.setStatus('stopped');
      return;
    }
    if (this.status === 'failed') return; // already handled (activation failure)

    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < LIMITS.crashWindowMs);
    this.crashes.push(now);
    const lastError = { message: `插件崩溃：${reason}`, at: now, stderr: this.stderrTail.slice(-15) };
    this.emitLog('error', lastError.message, 'host');
    if (this.crashes.length >= LIMITS.maxCrashesInWindow) {
      this.setStatus('failed', {
        ...lastError,
        message: `${LIMITS.crashWindowMs / 1000} 秒内崩溃 ${this.crashes.length} 次，已停止自动重启（熔断）。修复后可手动重启。最近一次：${reason}`,
      });
      return;
    }
    const delay = 500 * 2 ** (this.crashes.length - 1);
    this.setStatus('crashed', { ...lastError, message: `${lastError.message}；${delay}ms 后自动重启（第 ${this.crashes.length} 次）` });
    this.restartTimer = setTimeout(() => this.start().catch(() => {}), delay);
  }

  call(method, params, { timeoutMs = LIMITS.defaultToolTimeoutMs, internal = false } = {}) {
    if (!this.child || !this.child.connected || (!internal && this.status !== 'running')) {
      return Promise.reject(new PluginCallError('unavailable', `插件 ${this.id} 当前不可用（状态：${this.status}）`));
    }
    const id = `h${this.nextId++}`;
    const started = Date.now();
    if (!internal) this.stats.calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stats.timeouts++;
        try {
          this.child && this.child.send({ method: 'cancel', params: { id } });
        } catch {}
        reject(new PluginCallError('timeout', `插件 ${this.id} 处理 ${method} 超时（>${timeoutMs}ms）`));
        if (!internal) this.onTimeout();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          this.consecutiveTimeouts = 0;
          this.stats.totalMs += Date.now() - started;
          resolve(r);
        },
        reject: (e) => {
          if (e.kind === 'error') this.stats.errors++;
          reject(e);
        },
        timer,
      });
      try {
        this.child.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new PluginCallError('unavailable', `无法发送到插件 ${this.id}：${e.message}`));
      }
    });
  }

  onTimeout() {
    this.consecutiveTimeouts++;
    if (this.consecutiveTimeouts >= LIMITS.maxConsecutiveTimeouts && this.child) {
      // A plugin that keeps hanging is probably stuck (e.g. busy loop). Recycle it.
      this.emitLog('warn', `连续 ${this.consecutiveTimeouts} 次超时，强制重启插件进程`, 'host');
      this.consecutiveTimeouts = 0;
      this.child.kill('SIGKILL');
    }
  }

  kill() {
    if (this.child) {
      const c = this.child;
      this.child = null;
      c.kill('SIGKILL');
    }
  }

  async stop() {
    clearTimeout(this.restartTimer);
    if (!this.child) {
      this.setStatus('stopped');
      return;
    }
    const child = this.child;
    this.setStatus('stopping');
    try {
      await this.call('deactivate', {}, { timeoutMs: 1500, internal: true });
    } catch {}
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const t = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.disconnect && child.connected && child.disconnect();
    });
    this.child = null;
    this.setStatus('stopped');
  }

  resetCircuit() {
    this.crashes = [];
    this.consecutiveTimeouts = 0;
  }

  snapshot() {
    return {
      status: this.status,
      pid: this.child ? this.child.pid : null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      restarts: this.crashes.length,
      stats: this.stats,
      sandbox: { nodeArgs: this.nodeArgs() },
    };
  }
}

module.exports = { PluginProcess, PluginCallError, explain };
