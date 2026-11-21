'use strict';
const { freshHome, FIXTURES } = require('./helpers');
freshHome('lifecycle');

const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/core/store');
const { Registry, UserError } = require('../src/core/registry');
const { Host } = require('../src/host/host');
const { createServer } = require('../src/server/server');

const store = new Store();
const reg = new Registry(store);

test('install copies the plugin and records grants', () => {
  const r = reg.install('weather@1.0.0', { grants: ['network:api.open-meteo.com'] });
  assert.equal(r.record.version, '1.0.0');
  assert.ok(fs.existsSync(path.join(store.paths.plugins, 'weather', '1.0.0', 'plugin.json')));
  assert.deepEqual(r.record.grants, ['network:api.open-meteo.com']);
  assert.throws(() => reg.install('weather'), UserError);
});

test('cannot grant a permission the plugin did not request', () => {
  assert.throws(() => reg.grant('weather', ['network:evil.com']), /未声明/);
});

test('update with new permissions requires approval; declining keeps old rights', () => {
  reg.grant('weather', 'all');
  const u = reg.checkUpdate('weather');
  assert.equal(u.available, '1.1.0');
  assert.deepEqual(u.newPermissions.map((p) => p.id), ['network:air-quality-api.open-meteo.com']);
  const r = reg.update('weather');
  assert.deepEqual(r.pendingPermissions, ['network:air-quality-api.open-meteo.com']);
  assert.ok(!fs.existsSync(path.join(store.paths.plugins, 'weather', '1.0.0')), 'old version removed');
  const h = new Host({ store });
  const d = h.listPlugins().find((p) => p.id === 'weather');
  assert.equal(d.state, 'needs-approval');
  reg.revoke('weather', ['network:air-quality-api.open-meteo.com']);
  const rec = reg.get('weather');
  assert.equal(rec.pendingPermissions.length, 0);
  assert.ok(!rec.grants.includes('network:air-quality-api.open-meteo.com'));
});

test('incompatible plugin installs disabled and cannot be enabled', () => {
  const r = reg.install('legacy-plugin');
  assert.equal(r.record.enabled, false);
  assert.throws(() => reg.setEnabled('legacy-plugin', true), /宿主版本/);
});

test('uninstall removes code, keeps data unless purged', () => {
  fs.writeFileSync(path.join(store.pluginDataDir('legacy-plugin'), 'x'), '1');
  reg.uninstall('legacy-plugin');
  assert.ok(fs.existsSync(path.join(store.paths.data, 'legacy-plugin', 'x')));
  reg.install('legacy-plugin');
  reg.uninstall('legacy-plugin', { purge: true });
  assert.ok(!fs.existsSync(path.join(store.paths.data, 'legacy-plugin')));
});

test('dev install links the source directory instead of copying', () => {
  const r = reg.install(path.join(FIXTURES, 'broken-guard'), { dev: true });
  assert.equal(r.record.source.type, 'dev');
  assert.equal(fs.realpathSync(r.record.path), fs.realpathSync(path.join(FIXTURES, 'broken-guard')));
  reg.uninstall('broken-guard');
  assert.ok(fs.existsSync(path.join(FIXTURES, 'broken-guard', 'plugin.json')), 'dev uninstall must not delete source');
});

test('secrets file is private (0600)', () => {
  store.setSecret('MY_TOKEN', 'abc');
  const mode = fs.statSync(store.paths.secrets).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('server: token, host header and origin checks', async () => {
  const host = new Host({ store });
  await host.init({ watch: false });
  const srv = createServer(host, { port: 0, token: 'a'.repeat(48) });
  const { port } = await srv.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${'b'.repeat(48)}` } })).status, 401);
    const ok = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.plugins.some((p) => p.id === 'weather'));
    const xo = await fetch(`${base}/api/plugins/weather/disable`, { method: 'POST', headers: { authorization: `Bearer ${'a'.repeat(48)}`, origin: 'http://evil.example' } });
    assert.equal(xo.status, 403);
    const secrets = await (await fetch(`${base}/api/secrets`, { headers: { authorization: `Bearer ${'a'.repeat(48)}` } })).json();
    assert.ok(!JSON.stringify(secrets).includes('abc'), 'secret values must never be returned');
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'a'.repeat(48)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '测试会话' }),
    });
    assert.equal(created.status, 201);
    const session = await created.json();
    assert.equal(session.title, '测试会话');
    const loaded = await fetch(`${base}/api/sessions/${session.id}`, { headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
    assert.equal(loaded.status, 200);
    assert.deepEqual((await loaded.json()).transcript, []);
    const renamed = await fetch(`${base}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${'a'.repeat(48)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '重命名会话' }),
    });
    assert.equal((await renamed.json()).title, '重命名会话');
    const deleted = await fetch(`${base}/api/sessions/${session.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${'a'.repeat(48)}` },
    });
    assert.equal((await deleted.json()).ok, true);
    const missing = await fetch(`${base}/api/sessions/${session.id}`, { headers: { authorization: `Bearer ${'a'.repeat(48)}` } });
    assert.equal(missing.status, 404);
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  } finally {
    await srv.close();
    await host.shutdown();
  }
});
