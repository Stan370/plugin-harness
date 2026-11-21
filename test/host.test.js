'use strict';
const { freshHome, FIXTURES, sleep, waitFor } = require('./helpers');
freshHome('host');

const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Host } = require('../src/host/host');
const { Agent } = require('../src/host/agent');

let host;
const stateOf = (id) => host.listPlugins().find((p) => p.id === id).state;

test.before(async () => {
  host = new Host();
  for (const id of ['workspace-notes', 'pii-guard', 'rule-router', 'chaos-monkey']) host.registry.install(id);
  host.registry.install(path.join(FIXTURES, 'slow-start'));
  host.store.setSecret('OPENROUTER_API_KEY', 'sk-or-v1-test-secret-value-123456');
  await host.init({ watch: false });
});
test.after(() => host.shutdown());

test('plugins start in isolated processes', () => {
  for (const id of ['workspace-notes', 'pii-guard', 'rule-router', 'chaos-monkey']) assert.equal(stateOf(id), 'running', id);
  const pids = host.listPlugins().filter((p) => p.process && p.process.pid).map((p) => p.process.pid);
  assert.equal(new Set(pids).size, pids.length);
  assert.ok(!pids.includes(process.pid));
});

test('activation timeout fails the plugin without restart loop, host unaffected', async () => {
  assert.equal(stateOf('slow-start'), 'failed');
  const p = host.listPlugins().find((x) => x.id === 'slow-start');
  assert.match(p.process.lastError.message, /激活超时/);
  const r = await host.invokeTool('slow-start.noop', {});
  assert.equal(r.error.kind, 'unavailable');
});

test('tool works within granted permissions', async () => {
  const r = await host.invokeTool('workspace-notes.list', {});
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.match(r.content, /welcome\.md/);
});

test('sandbox: file access outside grants is denied by the runtime', async () => {
  const r = await host.invokeTool('chaos-monkey.readSecretFile', {});
  assert.ok(r.ok);
  assert.ok(!r.content.includes('❌'), r.content);
  assert.equal((r.content.match(/ERR_ACCESS_DENIED/g) || []).length, 4);
  assert.ok(!fs.existsSync('/tmp/pwned.txt'));
});

test('sandbox: network to un-granted hosts and raw sockets are blocked', async () => {
  const r = await host.invokeTool('chaos-monkey.phoneHome', {});
  assert.match(r.content, /ERR_PERMISSION_NETWORK/);
  assert.match(r.content, /ERR_HARNESS_NETWORK_DENIED/);
  assert.ok(!r.content.includes('❌'));
});

test('sandbox: no secrets in env, broker refuses un-granted secret, no child processes', async () => {
  const k = await host.invokeTool('chaos-monkey.stealKey', {});
  assert.match(k.content, /环境变量中没有任何密钥/);
  assert.match(k.content, /ERR_PERMISSION_SECRET/);
  const s = await host.invokeTool('chaos-monkey.spawn', {});
  assert.match(s.content, /ERR_ACCESS_DENIED/);
  const audit = fs.readFileSync(host.store.paths.audit, 'utf8');
  assert.match(audit, /secret\.denied/);
  assert.match(audit, /network\.denied/);
});

test('path traversal inside a plugin is rejected', async () => {
  const r = await host.invokeTool('workspace-notes.read', { name: '../../secrets.json' });
  assert.ok(!r.ok);
  assert.match(r.error.message, /不能跳出笔记目录/);
});

test('invalid input is rejected by the host before reaching the plugin', async () => {
  const r = await host.invokeTool('workspace-notes.search', {});
  assert.equal(r.error.kind, 'invalid_input');
});

test('hooks: pii-guard redacts tool results and blocks secret writes', async () => {
  const w = await host.invokeTool('workspace-notes.search', { query: 'alice' });
  assert.ok(w.ok);
  assert.ok(!w.content.includes('alice@example.com'));
  assert.match(w.content, /已脱敏:邮箱/);
  assert.ok(w.notes.some((n) => n.pluginId === 'pii-guard'));
  const b = await host.invokeTool('workspace-notes.write', { name: 'k.md', content: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
  assert.equal(b.error.kind, 'blocked');
});

test('agent turn via the offline provider plugin', async () => {
  host.setActiveProvider('rule-router/rules');
  const agent = new Agent(host);
  const events = [];
  const s = await agent.run(null, '搜索笔记 插件', (e) => events.push(e));
  const result = events.find((e) => e.type === 'tool_result');
  assert.ok(result && result.ok, JSON.stringify(events));
  assert.equal(result.tool, 'workspace-notes__search');
  // the user message passed through the pii hook first
  const s2 = await agent.run(s.id, '我的邮箱 bob@corp.com 列出笔记', (e) => events.push(e));
  assert.ok(s2.messages.some((m) => m.role === 'user' && m.content.includes('[已脱敏:邮箱]')));
});

test('sessions are persisted and isolated', async () => {
  host.setActiveProvider('rule-router/rules');
  const agent = new Agent(host);
  const first = agent.createSession();
  const second = agent.createSession();
  await agent.run(first.id, '搜索笔记 插件');
  await agent.run(second.id, '列出笔记');

  const loadedFirst = agent.getSession(first.id);
  const loadedSecond = agent.getSession(second.id);
  assert.notEqual(loadedFirst.id, loadedSecond.id);
  assert.ok(loadedFirst.messages.some((m) => m.role === 'user' && m.content.includes('搜索笔记')));
  assert.ok(!loadedSecond.messages.some((m) => m.role === 'user' && m.content.includes('搜索笔记')));
  assert.match(agent.listSessions().find((s) => s.id === second.id).title, /列出笔记|新对话/);

  const renamed = agent.renameSession(first.id, '笔记检索');
  assert.equal(renamed.title, '笔记检索');
  assert.equal(agent.deleteSession(first.id), true);
  assert.ok(!agent.listSessions().some((s) => s.id === first.id));
});

test('timeout: a hanging tool times out and the plugin keeps serving', async () => {
  const t0 = Date.now();
  const r = await host.invokeTool('chaos-monkey.hang', {});
  assert.equal(r.error.kind, 'timeout');
  assert.ok(Date.now() - t0 < 4000);
  const ok = await host.invokeTool('chaos-monkey.stealKey', {});
  assert.ok(ok.ok);
});

test('busy loop: repeated timeouts force-recycle the process', async () => {
  const pid = host.listPlugins().find((p) => p.id === 'chaos-monkey').process.pid;
  const a = await host.invokeTool('chaos-monkey.busyLoop', {});
  assert.equal(a.error.kind, 'timeout');
  const b = await host.invokeTool('chaos-monkey.busyLoop', {}); // event loop still stuck -> second timeout
  assert.ok(['timeout', 'unavailable', 'crash'].includes(b.error.kind));
  await waitFor(() => {
    const p = host.listPlugins().find((x) => x.id === 'chaos-monkey');
    return p.state === 'running' && p.process.pid !== pid;
  });
});

test('memory: heap limit kills only the plugin, reported as OOM', async () => {
  await host.restart('chaos-monkey');
  const r = await host.invokeTool('chaos-monkey.leak', {});
  assert.equal(r.error.kind, 'crash');
  assert.match(r.error.message, /内存超出上限/);
  await waitFor(() => stateOf('chaos-monkey') === 'running');
});

test('crash: auto-restart, then circuit breaker after 3 crashes in a minute', async () => {
  await host.restart('chaos-monkey'); // resets the circuit
  for (let i = 0; i < 3; i++) {
    await waitFor(() => stateOf('chaos-monkey') === 'running');
    const r = await host.invokeTool('chaos-monkey.crash', {});
    assert.equal(r.error.kind, 'crash');
  }
  await waitFor(() => stateOf('chaos-monkey') === 'failed');
  const p = host.listPlugins().find((x) => x.id === 'chaos-monkey');
  assert.match(p.process.lastError.message, /熔断/);
  // other plugins unaffected
  assert.equal(stateOf('workspace-notes'), 'running');
  // manual restart recovers
  await host.restart('chaos-monkey');
  assert.equal(stateOf('chaos-monkey'), 'running');
});

test('failMode=closed blocks when a security hook fails; open skips', async () => {
  host.registry.install(path.join(FIXTURES, 'broken-guard'));
  await host.reconcile();
  const agent = new Agent(host);
  const events = [];
  await agent.run(null, '列出笔记', (e) => events.push(e));
  const err = events.find((e) => e.type === 'error');
  assert.match(err.text, /failMode=closed/);
  const r = await host.invokeTool('workspace-notes.list', {});
  assert.ok(r.ok, 'open hook failure must not block');
  assert.ok(r.notes.some((n) => n.error && n.pluginId === 'broken-guard'));
  host.registry.uninstall('broken-guard');
  await host.reconcile();
});

test('revoking a permission restarts the plugin with reduced rights', async () => {
  host.registry.revoke('workspace-notes', ['fs.read:${workspace}', 'fs.write:${workspace}/notes']);
  await host.reconcile();
  const r = await host.invokeTool('workspace-notes.list', {});
  assert.ok(!r.ok);
  assert.match(r.error.message, /未授权的文件/);
  host.registry.grant('workspace-notes', 'all');
  await host.reconcile();
  assert.ok((await host.invokeTool('workspace-notes.list', {})).ok);
});

test('disable removes the plugin\'s tools; enable brings them back', async () => {
  host.registry.setEnabled('workspace-notes', false);
  await host.reconcile();
  assert.ok(!host.listTools().some((t) => t.pluginId === 'workspace-notes'));
  host.registry.setEnabled('workspace-notes', true);
  await host.reconcile();
  await sleep(50);
  assert.ok(host.listTools().some((t) => t.pluginId === 'workspace-notes' && t.available));
});

test('config change is hot-applied without restart', async () => {
  const pid = host.listPlugins().find((p) => p.id === 'workspace-notes').process.pid;
  host.registry.setConfig('workspace-notes', { maxResults: 1 });
  await host.reconcile();
  const r = await host.invokeTool('workspace-notes.search', { query: '插件' });
  assert.equal(r.content.split('\n').length, 1);
  assert.equal(host.listPlugins().find((p) => p.id === 'workspace-notes').process.pid, pid);
});
