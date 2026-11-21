'use strict';
const { freshHome } = require('./helpers');
freshHome('unit');

const test = require('node:test');
const assert = require('node:assert/strict');
const semver = require('../src/core/semver');
const path = require('node:path');
const { validateManifest, checkCompatibility, validateConfig, readManifest } = require('../src/core/manifest');
const { hostMatches, requestedPermissions, PERMISSION_KINDS } = require('../src/core/permissions');
const { validate } = require('../src/core/schema');
const { parseArgs } = require('../src/host/agent');

const base = () => ({
  id: 'demo-plugin',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: 1,
  engines: { harness: '^1.0.0' },
  contributes: { tools: [{ name: 'hello', description: 'hi', input: { type: 'object', properties: {} } }] },
});

test('semver ranges', () => {
  assert.ok(semver.satisfies('1.2.3', '^1.0.0'));
  assert.ok(!semver.satisfies('2.0.0', '^1.0.0'));
  assert.ok(semver.satisfies('0.9.5', '^0.9.0'));
  assert.ok(!semver.satisfies('0.10.0', '^0.9.0'));
  assert.ok(semver.satisfies('1.4.0', '>=1.2.0 <2.0.0'));
  assert.ok(semver.satisfies('3.0.0', '^1.0.0 || ^3.0.0'));
  assert.ok(semver.satisfies('1.2.9', '~1.2.0'));
  assert.ok(!semver.satisfies('1.3.0', '~1.2.0'));
  assert.ok(semver.satisfies('5.0.0', '*'));
  assert.equal(semver.compare('1.10.0', '1.9.0'), 1);
  assert.equal(semver.compare('1.0.0-beta', '1.0.0'), -1);
});

test('valid manifest passes', () => {
  const r = validateManifest(base());
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
});

test('common cloud provider manifest is valid', () => {
  const r = readManifest(path.join(__dirname, '..', 'plugins', 'cloud-providers'));
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
  assert.deepEqual(r.manifest.contributes.providers.map((p) => p.name), ['openai', 'anthropic', 'gemini', 'deepseek']);
  assert.ok(r.manifest.permissions.secrets.includes('OPENAI_API_KEY'));
  assert.ok(r.manifest.permissions.secrets.includes('ANTHROPIC_API_KEY'));
  assert.ok(r.manifest.permissions.secrets.includes('GEMINI_API_KEY'));
  assert.ok(r.manifest.permissions.secrets.includes('DEEPSEEK_API_KEY'));
});

test('manifest validation catches common mistakes with readable errors', () => {
  const m = base();
  m.id = 'Bad_ID';
  m.version = 'v1';
  m.permissions = { 'fs.read': ['/etc/../root'], network: ['https://x.com'], process: ['ls'], secrets: ['lower'] };
  m.contributes.tools.push({ name: 'hello', description: '' });
  m.contributes.hooks = [{ event: 'nope' }];
  const r = validateManifest(m);
  assert.ok(!r.ok);
  const all = r.errors.join('\n');
  for (const frag of ['id 必须', 'semver', '".."', '主机名', '未知权限类型 "process"', '大写', '重复', 'description', '未知 hook']) {
    assert.ok(all.includes(frag), `expected error mentioning ${frag}\n${all}`);
  }
});

test('whole-filesystem grants are rejected', () => {
  assert.ok(PERMISSION_KINDS['fs.read'].validate('/'));
  assert.ok(PERMISSION_KINDS['fs.write'].validate('relative/path'));
  assert.equal(PERMISSION_KINDS['fs.read'].validate('${workspace}/notes'), null);
});

test('compatibility: apiVersion and engines range', () => {
  assert.ok(checkCompatibility(base()).compatible);
  assert.match(checkCompatibility({ ...base(), engines: { harness: '^0.9.0' } }).reason, /要求宿主版本/);
  assert.match(checkCompatibility({ ...base(), apiVersion: 2 }).reason, /apiVersion 2/);
});

test('config validation coerces and rejects', () => {
  const m = validateManifest({
    ...base(),
    contributes: { ...base().contributes, settings: { n: { type: 'number', min: 1, max: 5 }, b: { type: 'boolean' }, s: { type: 'select', options: ['a', 'b'] } } },
  }).manifest;
  assert.deepEqual(validateConfig(m, { n: '3', b: 'true', s: 'a' }).values, { n: 3, b: true, s: 'a' });
  const bad = validateConfig(m, { n: 9, s: 'c', zzz: 1 });
  assert.equal(bad.errors.length, 3);
});

test('network host matching', () => {
  assert.ok(hostMatches('api.example.com', 'API.example.com'));
  assert.ok(!hostMatches('api.example.com', 'evil-api.example.com'));
  assert.ok(hostMatches('*.example.com', 'a.b.example.com'));
  assert.ok(!hostMatches('*.example.com', 'example.com'));
  assert.ok(!hostMatches('*.example.com', 'notexample.com'));
});

test('requested permissions carry risk and description', () => {
  const p = requestedPermissions({ permissions: { 'fs.write': ['${workspace}'], secrets: ['API_KEY'] } });
  assert.equal(p.length, 2);
  assert.ok(p.every((x) => x.risk === 'high' && x.description));
});

test('tool input schema validation', () => {
  const schema = { type: 'object', properties: { q: { type: 'string', minLength: 1 }, n: { type: 'integer', maximum: 10 } }, required: ['q'] };
  assert.ok(validate(schema, { q: 'x', n: '5' }).ok);
  assert.equal(validate(schema, { q: 'x', n: '5' }).value.n, 5);
  assert.match(validate(schema, {}).errors[0], /缺少必填参数 q/);
  assert.ok(!validate(schema, { q: 'x', n: 11 }).ok);
});

test('slash command argument parsing', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name'] };
  assert.deepEqual(parseArgs('{"name":"a"}', schema), { name: 'a' });
  assert.deepEqual(parseArgs('name=a content="b c"', schema), { name: 'a', content: 'b c' });
  assert.deepEqual(parseArgs('hello world', schema), { name: 'hello world' });
});
