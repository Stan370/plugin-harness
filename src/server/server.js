'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT } = require('../core/constants');
const { UserError, catalogIndex, inspect } = require('../core/registry');
const { Agent } = require('../host/agent');

const WEB = path.join(ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UserError('请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new UserError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Local web UI + JSON API. Security model:
 *  - binds to 127.0.0.1 only
 *  - every /api call needs the per-launch random token (Authorization: Bearer)
 *  - Host header must be localhost/127.0.0.1 (blocks DNS-rebinding)
 *  - Origin, when present, must be this server (blocks cross-site requests)
 */
function createServer(host, { port = 7777, token = crypto.randomBytes(24).toString('hex') } = {}) {
  const agent = new Agent(host);
  const sse = new Set();
  let actualPort = port;

  host.on('event', (ev) => {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sse) res.write(data);
  });

  const fullState = () => ({
    info: host.info(),
    plugins: host.listPlugins(),
    providers: host.listProviders(),
    tools: host.listTools({ availableOnly: false }),
  });

  const pluginAction = async (id, action, body) => {
    const reg = host.registry;
    switch (action) {
      case 'enable':
        reg.setEnabled(id, true);
        break;
      case 'disable':
        reg.setEnabled(id, false);
        break;
      case 'restart':
        await host.restart(id);
        break;
      case 'uninstall':
        reg.uninstall(id, { purge: Boolean(body.purge) });
        break;
      case 'update': {
        const r = reg.update(id);
        await host.reconcile();
        return { result: r, state: fullState() };
      }
      case 'config':
        reg.setConfig(id, body.values || {});
        break;
      case 'permissions':
        if (body.grant && body.grant.length) reg.grant(id, body.grant);
        if (body.revoke && body.revoke.length) reg.revoke(id, body.revoke);
        break;
      case 'check-update':
        return reg.checkUpdate(id);
      default:
        throw new UserError(`未知操作 ${action}`);
    }
    await host.reconcile();
    return fullState();
  };

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (m === 'GET' && p === '/api/state') return send(res, 200, fullState());
    if (m === 'GET' && p === '/api/catalog') {
      const installed = Object.fromEntries(host.listPlugins().map((x) => [x.id, x.version]));
      return send(res, 200, catalogIndex().map((c) => ({ ...c, installedVersion: installed[c.id] || null })));
    }
    if (m === 'POST' && p === '/api/inspect') {
      const b = await readBody(req);
      return send(res, 200, inspect(String(b.source || '')));
    }
    if (m === 'POST' && p === '/api/install') {
      const b = await readBody(req);
      const r = host.registry.install(String(b.source || ''), { grants: Array.isArray(b.grants) ? b.grants : [], enable: b.enable !== false });
      await host.reconcile();
      return send(res, 200, { installed: r.record.id, state: fullState() });
    }
    let mm = /^\/api\/plugins\/([a-z0-9-]+)\/([a-z-]+)$/.exec(p);
    if (mm && (m === 'POST' || (m === 'GET' && mm[2] === 'check-update'))) {
      const b = m === 'POST' ? await readBody(req) : {};
      return send(res, 200, await pluginAction(mm[1], mm[2], b));
    }
    if (m === 'GET' && p === '/api/logs') {
      const q = Object.fromEntries(url.searchParams);
      return send(res, 200, host.logs.query({ pluginId: q.pluginId || undefined, level: q.level, since: Number(q.since || 0), limit: Number(q.limit || 300) }));
    }
    if (m === 'POST' && p === '/api/tools/invoke') {
      const b = await readBody(req);
      return send(res, 200, await host.invokeTool(String(b.tool || ''), b.input || {}, { via: 'playground' }));
    }
    if (m === 'POST' && p === '/api/settings') {
      const b = await readBody(req);
      if ('activeProvider' in b) host.setActiveProvider(b.activeProvider);
      return send(res, 200, fullState());
    }
    if (m === 'GET' && p === '/api/sessions') return send(res, 200, agent.listSessions());
    if (m === 'POST' && p === '/api/sessions') {
      const b = await readBody(req);
      const s = agent.createSession({ title: String(b.title || '').trim() });
      return send(res, 201, { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, provider: s.provider, transcript: s.transcript });
    }
    mm = /^\/api\/sessions\/([a-z0-9-]+)$/.exec(p);
    if (m === 'GET' && mm) {
      const s = agent.getSession(mm[1]);
      return send(res, 200, { id: s.id, transcript: s.transcript });
    }
    if (m === 'PATCH' && mm) {
      const b = await readBody(req);
      const s = agent.renameSession(mm[1], b.title);
      return send(res, 200, { id: s.id, title: s.title, updatedAt: s.updatedAt });
    }
    if (m === 'DELETE' && mm) {
      const deleted = agent.deleteSession(mm[1]);
      return send(res, 200, { ok: deleted });
    }
    if (m === 'POST' && p === '/api/chat') {
      const b = await readBody(req);
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      const s = b.sessionId ? agent.getSession(String(b.sessionId)) : agent.createSession();
      res.write(JSON.stringify({ type: 'session', sessionId: s.id }) + '\n');
      await agent.run(s.id, String(b.text || ''), (ev) => res.write(JSON.stringify(ev) + '\n'));
      return res.end();
    }
    if (m === 'GET' && p === '/api/secrets') {
      // Names only — values are write-only from the UI's point of view.
      const stored = host.store.listSecrets().map((x) => x.name);
      const wanted = new Set(stored);
      for (const pl of host.listPlugins()) for (const perm of pl.permissions) if (perm.kind === 'secrets') wanted.add(perm.value);
      return send(
        res,
        200,
        [...wanted].map((name) => ({
          name,
          stored: stored.includes(name),
          fromEnv: !stored.includes(name) && Boolean(process.env[name]),
          usedBy: host.listPlugins().filter((pl) => pl.permissions.some((x) => x.kind === 'secrets' && x.value === name)).map((pl) => ({ id: pl.id, granted: pl.permissions.find((x) => x.value === name).granted })),
        })),
      );
    }
    if (m === 'POST' && p === '/api/secrets') {
      const b = await readBody(req);
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(b.name || '')) throw new UserError('密钥名称不合法');
      host.store.setSecret(b.name, b.value || null);
      host.hostLog('info', `密钥 ${b.name} 已${b.value ? '更新' : '删除'}`);
      return send(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      sse.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        sse.delete(res);
      });
      return;
    }
    send(res, 404, { error: `未知接口 ${m} ${p}` });
  }

  function authorized(req, url) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '';
    const a = Buffer.from(t);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function sameHost(req) {
    const hostHeader = String(req.headers.host || '');
    const ok = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!ok.includes(hostHeader)) return false;
    const origin = req.headers.origin;
    if (origin && !ok.map((h) => `http://${h}`).includes(origin)) return false;
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (!sameHost(req)) return send(res, 403, { error: '拒绝：Host/Origin 不是本机（防 DNS 重绑定 / 跨站请求）' });

    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, url)) return send(res, 401, { error: '缺少或错误的访问令牌。请使用启动时终端打印的完整链接打开。' });
      try {
        await api(req, res, url);
      } catch (e) {
        const status = e instanceof UserError ? 400 : e.code === 'SESSION_NOT_FOUND' ? 404 : 500;
        if (status === 500) host.hostLog('error', `API ${req.method} ${url.pathname} 出错：${e.stack || e.message}`);
        if (!res.headersSent) send(res, status, { error: e.message, details: e.details });
        else res.end();
      }
      return;
    }

    // static files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(WEB, rel);
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    fs.createReadStream(file).pipe(res);
  });

  return {
    server,
    token,
    agent,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          actualPort = server.address().port;
          resolve({ port: actualPort, url: `http://127.0.0.1:${actualPort}/#token=${token}` });
        });
      });
    },
    close() {
      for (const r of sse) r.end();
      const done = new Promise((r) => server.close(r));
      server.closeAllConnections();
      return done;
    },
  };
}

module.exports = { createServer };
