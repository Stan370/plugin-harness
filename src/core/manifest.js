'use strict';
const fs = require('node:fs');
const path = require('node:path');
const semver = require('./semver');
const { HOST_VERSION, API_VERSION, MANIFEST_FILE, HOOK_EVENTS, LIMITS } = require('./constants');
const { PERMISSION_KINDS } = require('./permissions');

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const NAME_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const SETTING_TYPES = ['string', 'number', 'boolean', 'select'];

function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    return { ok: false, errors: [`找不到 ${MANIFEST_FILE}（目录：${dir}）`], warnings: [] };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`${MANIFEST_FILE} 不是合法 JSON：${e.message}`], warnings: [] };
  }
  return validateManifest(raw, dir);
}

function validateManifest(m, dir) {
  const errors = [];
  const warnings = [];
  const err = (s) => errors.push(s);

  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['清单必须是 JSON 对象'], warnings };

  if (!ID_RE.test(m.id || '')) err('id 必须是 2-40 位小写字母/数字/连字符，且以字母开头');
  if (!m.name || typeof m.name !== 'string') err('缺少 name（展示名称）');
  if (!semver.valid(m.version)) err(`version "${m.version}" 不是合法的 semver（例：1.0.0）`);
  if (m.apiVersion !== API_VERSION) {
    if (typeof m.apiVersion !== 'number') err('缺少 apiVersion（当前宿主协议版本为 1）');
  }
  const range = m.engines && m.engines.harness;
  if (!range) err('缺少 engines.harness（例："^1.0.0"），用于声明兼容的宿主版本');
  else if (!semver.validRange(range)) err(`engines.harness "${range}" 不是合法的版本范围`);

  const main = m.main || 'index.js';
  if (dir && !fs.existsSync(path.join(dir, main))) err(`入口文件 ${main} 不存在`);

  // permissions
  const perms = m.permissions || {};
  if (typeof perms !== 'object' || Array.isArray(perms)) err('permissions 必须是对象');
  else {
    for (const [kind, values] of Object.entries(perms)) {
      if (!PERMISSION_KINDS[kind]) {
        err(`未知权限类型 "${kind}"。支持：${Object.keys(PERMISSION_KINDS).join(', ')}`);
        continue;
      }
      if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !v)) {
        err(`permissions.${kind} 必须是非空字符串数组`);
        continue;
      }
      for (const v of values) {
        const problem = PERMISSION_KINDS[kind].validate(v);
        if (problem) err(`permissions.${kind}: "${v}" ${problem}`);
      }
    }
  }

  // contributions
  const c = m.contributes || {};
  const tools = c.tools || [];
  const hooks = c.hooks || [];
  const providers = c.providers || [];
  const settings = c.settings || {};
  if (!Array.isArray(tools)) err('contributes.tools 必须是数组');
  if (!Array.isArray(hooks)) err('contributes.hooks 必须是数组');
  if (!Array.isArray(providers)) err('contributes.providers 必须是数组');

  const seen = new Set();
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!NAME_RE.test(t.name || '')) err(`工具名 "${t.name}" 不合法（字母开头，仅字母数字下划线）`);
    if (seen.has(t.name)) err(`工具名 "${t.name}" 重复`);
    seen.add(t.name);
    if (!t.description) err(`工具 ${t.name} 缺少 description（模型依赖它决定何时调用）`);
    const schema = t.input || { type: 'object', properties: {} };
    if (schema.type !== 'object') err(`工具 ${t.name} 的 input 必须是 type: "object" 的 JSON Schema`);
    if (t.timeoutMs !== undefined && !(t.timeoutMs > 0 && t.timeoutMs <= LIMITS.maxToolTimeoutMs)) {
      err(`工具 ${t.name} 的 timeoutMs 必须在 1-${LIMITS.maxToolTimeoutMs} 之间`);
    }
    for (const p of t.patterns || []) {
      try {
        new RegExp(p, 'iu');
      } catch (e) {
        err(`工具 ${t.name} 的 pattern 无法编译：${p}（${e.message}）`);
      }
    }
  }
  for (const h of Array.isArray(hooks) ? hooks : []) {
    if (!HOOK_EVENTS[h.event]) err(`未知 hook 事件 "${h.event}"。支持：${Object.keys(HOOK_EVENTS).join(', ')}`);
    if (h.failMode && !['open', 'closed'].includes(h.failMode)) err(`hook ${h.event} 的 failMode 只能是 open 或 closed`);
  }
  for (const p of Array.isArray(providers) ? providers : []) {
    if (!NAME_RE.test(p.name || '')) err(`provider 名 "${p.name}" 不合法`);
  }
  for (const [key, s] of Object.entries(settings)) {
    if (!NAME_RE.test(key)) err(`配置项名 "${key}" 不合法`);
    if (!SETTING_TYPES.includes(s.type)) err(`配置项 ${key} 的 type 必须是 ${SETTING_TYPES.join('/')}`);
    if (s.type === 'select' && (!Array.isArray(s.options) || !s.options.length)) err(`配置项 ${key} 是 select，需要 options`);
  }
  if (!tools.length && !hooks.length && !providers.length) warnings.push('插件没有贡献任何 tools / hooks / providers，启用后不会产生效果');
  if (m.memoryMb !== undefined && !(m.memoryMb >= 32 && m.memoryMb <= LIMITS.maxMemoryMb)) {
    err(`memoryMb 必须在 32-${LIMITS.maxMemoryMb} 之间`);
  }

  const manifest = {
    ...m,
    main,
    permissions: perms,
    contributes: { tools, hooks, providers, settings },
  };
  return { ok: errors.length === 0, errors, warnings, manifest };
}

function checkCompatibility(m) {
  if (m.apiVersion !== API_VERSION) {
    return {
      compatible: false,
      reason: `插件使用协议 apiVersion ${m.apiVersion}，宿主只支持 apiVersion ${API_VERSION}`,
    };
  }
  const range = (m.engines && m.engines.harness) || '*';
  if (!semver.satisfies(HOST_VERSION, range)) {
    return {
      compatible: false,
      reason: `插件要求宿主版本 ${range}，当前宿主为 ${HOST_VERSION}`,
    };
  }
  return { compatible: true };
}

function settingsDefaults(m) {
  const out = {};
  for (const [k, s] of Object.entries(m.contributes.settings || {})) {
    if (s.default !== undefined) out[k] = s.default;
  }
  return out;
}

// Coerce and validate user-provided config against the settings schema.
function validateConfig(m, values) {
  const schema = m.contributes.settings || {};
  const out = {};
  const errors = [];
  for (const [k, v] of Object.entries(values || {})) {
    const s = schema[k];
    if (!s) {
      errors.push(`未知配置项 ${k}`);
      continue;
    }
    if (s.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) errors.push(`${k} 必须是数字`);
      else if (s.min !== undefined && n < s.min) errors.push(`${k} 不能小于 ${s.min}`);
      else if (s.max !== undefined && n > s.max) errors.push(`${k} 不能大于 ${s.max}`);
      else out[k] = n;
    } else if (s.type === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
      else if (v === 'true' || v === 'false') out[k] = v === 'true';
      else errors.push(`${k} 必须是 true/false`);
    } else if (s.type === 'select') {
      if (!s.options.includes(v)) errors.push(`${k} 必须是 ${s.options.join(' / ')} 之一`);
      else out[k] = v;
    } else {
      out[k] = String(v);
    }
  }
  return { ok: errors.length === 0, errors, values: out };
}

module.exports = { readManifest, validateManifest, checkCompatibility, settingsDefaults, validateConfig };
