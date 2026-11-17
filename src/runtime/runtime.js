'use strict';
// Runs INSIDE the plugin process. Started by the host with Node's
// --permission flags, so filesystem / child_process / worker / addon access
// is already restricted by the runtime itself. This file:
//   1. blocks direct network sockets (network is brokered by the host),
//   2. installs a `fetch` shim that routes through the host broker,
//   3. loads the plugin entry and serves JSON-RPC over the IPC channel.

const path = require('node:path');

const entry = process.argv[2];
const pending = new Map(); // host requests awaiting response
const inflight = new Map(); // calls from host -> AbortController
let nextId = 1;
let plugin = null;
let host = null;
const configListeners = [];

function send(msg) {
  if (process.connected) process.send(msg);
}

function serializeError(e) {
  return {
    message: (e && e.message) || String(e),
    code: e && e.code,
    resource: e && e.resource,
    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : undefined,
  };
}

function hostRequest(method, params) {
  const id = `p${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

// ---- 1. network lockdown -------------------------------------------------
function denyNetwork(what) {
  const e = new Error(`[harness] 直接网络访问已被禁止（${what}）。请使用 fetch()/host.fetch()，它会由宿主按 network 权限代理。`);
  e.code = 'ERR_HARNESS_NETWORK_DENIED';
  throw e;
}
const net = require('node:net');
net.Socket.prototype.connect = function () {
  denyNetwork('net.Socket.connect');
};
const dgram = require('node:dgram');
dgram.createSocket = () => denyNetwork('dgram.createSocket');

// ---- 2. fetch shim ---------------------------------------------------------
async function brokeredFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let body = init.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    if (body instanceof URLSearchParams) body = body.toString();
    else if (Buffer.isBuffer(body) || body instanceof Uint8Array) body = Buffer.from(body).toString('utf8');
    else throw new TypeError('[harness] fetch body 仅支持 string / URLSearchParams / Buffer');
  }
  const headers = {};
  if (init.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const res = await hostRequest('http.fetch', { url, method: init.method || 'GET', headers, body, timeoutMs: init.timeoutMs });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
globalThis.fetch = brokeredFetch;

// ---- 3. plugin loading and RPC --------------------------------------------
function makeLog(level) {
  return (...args) =>
    send({
      method: 'log',
      params: { level, msg: args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ') },
    });
}
function safeJson(v) {
  try {
    return v instanceof Error ? v.stack || v.message : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const log = { debug: makeLog('debug'), info: makeLog('info'), warn: makeLog('warn'), error: makeLog('error') };

function normalizeResult(r) {
  if (r === undefined || r === null) return { content: '' };
  if (typeof r === 'string') return { content: r };
  if (typeof r === 'object' && 'content' in r) return { content: String(r.content), data: r.data, display: r.display };
  return { content: safeJson(r), data: r };
}

const handlers = {
  async activate(params) {
    host = {
      id: params.id,
      version: params.version,
      hostVersion: params.hostVersion,
      apiVersion: params.apiVersion,
      config: params.config,
      workspace: params.workspace,
      dataDir: params.dataDir,
      permissions: params.permissions,
      log,
      fetch: brokeredFetch,
      secrets: { get: (name) => hostRequest('secrets.get', { name }) },
      onConfigChange: (cb) => configListeners.push(cb),
    };
    const mod = require(path.resolve(entry));
    plugin = mod && mod.default ? mod.default : mod;
    if (typeof plugin === 'function') plugin = await plugin(host);
    if (!plugin || typeof plugin !== 'object') throw new Error('插件入口必须导出一个对象（或返回对象的函数）');

    // Contract check: every contribution declared in plugin.json must have a handler.
    const missing = [];
    for (const t of params.contributes.tools) if (typeof (plugin.tools || {})[t.name] !== 'function') missing.push(`tools.${t.name}`);
    for (const h of params.contributes.hooks) if (typeof (plugin.hooks || {})[h.event] !== 'function') missing.push(`hooks['${h.event}']`);
    for (const p of params.contributes.providers) {
      if (typeof ((plugin.providers || {})[p.name] || {}).complete !== 'function') missing.push(`providers.${p.name}.complete`);
    }
    if (missing.length) throw new Error(`plugin.json 中声明了，但入口没有实现：${missing.join(', ')}`);

    if (typeof plugin.activate === 'function') await plugin.activate(host);
    return { ok: true, pid: process.pid };
  },

  async 'tool.invoke'({ name, input, callId }, signal) {
    const ctx = { host, log, signal, progress: (message) => send({ method: 'progress', params: { callId, message } }) };
    return normalizeResult(await plugin.tools[name](input || {}, ctx));
  },

  async 'hook.run'({ event, payload }, signal) {
    const r = await plugin.hooks[event](payload, { host, log, signal });
    return r || {};
  },

  async 'provider.complete'({ name, request }, signal) {
    return plugin.providers[name].complete(request, { host, log, signal });
  },

  async 'config.changed'({ config }) {
    host.config = config;
    for (const cb of configListeners) await cb(config);
    return { ok: true };
  },

  async deactivate() {
    if (plugin && typeof plugin.deactivate === 'function') await plugin.deactivate();
    return { ok: true };
  },
};

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  // response to one of our host requests
  if (msg.id && !msg.method && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      const e = new Error(msg.error.message);
      e.code = msg.error.code;
      p.reject(e);
    } else p.resolve(msg.result);
    return;
  }
  if (msg.method === 'cancel') {
    const ac = inflight.get(msg.params.id);
    if (ac) ac.abort(new Error('宿主已取消调用（超时或用户中止）'));
    return;
  }
  const fn = handlers[msg.method];
  if (!fn) {
    send({ id: msg.id, error: { message: `未知方法 ${msg.method}` } });
    return;
  }
  const ac = new AbortController();
  inflight.set(msg.id, ac);
  try {
    const result = await fn(msg.params || {}, ac.signal);
    send({ id: msg.id, result });
  } catch (e) {
    send({ id: msg.id, error: serializeError(e) });
  } finally {
    inflight.delete(msg.id);
  }
});

// Route stray console output to the host log with the right level.
console.log = makeLog('info');
console.info = makeLog('info');
console.debug = makeLog('debug');
console.warn = makeLog('warn');
console.error = makeLog('error');

process.on('unhandledRejection', (e) => {
  log.error('未处理的 Promise 拒绝：', e);
});
process.on('disconnect', () => process.exit(0));
