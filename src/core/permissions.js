'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Every permission is a (kind, value) pair. A plugin *requests* them in its
// manifest; the user *grants* a subset; the host enforces the intersection.

function validatePathValue(v) {
  if (v.split(/[\\/]/).includes('..')) return '不能包含 ".."';
  if (!(v.startsWith('${workspace}') || v.startsWith('${pluginData}') || path.isAbsolute(v))) {
    return '必须以 ${workspace}、${pluginData} 开头，或是绝对路径';
  }
  if (v === '/' || v === path.parse(v).root) return '不允许授予整个文件系统';
  return null;
}

const PERMISSION_KINDS = {
  'fs.read': {
    label: '读取文件',
    validate: validatePathValue,
    risk: (v) => (v.startsWith('${') ? 'medium' : 'high'),
  },
  'fs.write': {
    label: '写入文件',
    validate: validatePathValue,
    risk: () => 'high',
  },
  network: {
    label: '访问网络',
    validate: (v) =>
      /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+$/i.test(v) ? null : '必须是主机名，例如 api.example.com 或 *.example.com（不含协议与端口）',
    risk: (v) => (v.startsWith('*.') ? 'high' : 'medium'),
  },
  secrets: {
    label: '读取密钥',
    validate: (v) => (/^[A-Z][A-Z0-9_]{1,63}$/.test(v) ? null : '必须是大写环境变量风格的名称，例如 OPENROUTER_API_KEY'),
    risk: () => 'high',
  },
};

const permId = (kind, value) => `${kind}:${value}`;

function splitPermId(id) {
  const i = id.indexOf(':');
  return [id.slice(0, i), id.slice(i + 1)];
}

/** Flatten a manifest's permissions into a list of items. */
function requestedPermissions(manifest) {
  const out = [];
  for (const [kind, values] of Object.entries(manifest.permissions || {})) {
    for (const value of values) {
      const k = PERMISSION_KINDS[kind];
      out.push({ id: permId(kind, value), kind, value, label: k.label, risk: k.risk(value), description: describe(kind, value) });
    }
  }
  return out;
}

function describe(kind, value) {
  const where = value
    .replace('${workspace}', '工作区')
    .replace('${pluginData}', '插件私有数据目录');
  switch (kind) {
    case 'fs.read': return `读取 ${where} 下的文件`;
    case 'fs.write': return `创建 / 修改 / 删除 ${where} 下的文件`;
    case 'network': return value.startsWith('*.') ? `访问 ${value.slice(2)} 及其所有子域名` : `访问 ${value}`;
    case 'secrets': return `读取密钥 ${value}（明文值会进入插件进程）`;
    default: return `${kind} ${value}`;
  }
}

function realish(p) {
  // Resolve symlinks for the longest existing prefix (macOS /tmp -> /private/tmp)
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    cur = fs.realpathSync(cur);
  } catch {}
  return path.join(cur, ...rest);
}

function resolvePathValue(value, ctx) {
  const v = value.replace('${workspace}', ctx.workspace).replace('${pluginData}', ctx.pluginData);
  return realish(v);
}

/** Effective (granted ∩ requested) permissions with variables resolved. */
function effectivePermissions(manifest, grants, ctx) {
  const granted = new Set(grants || []);
  const eff = { 'fs.read': [], 'fs.write': [], network: [], secrets: [] };
  for (const item of requestedPermissions(manifest)) {
    if (!granted.has(item.id)) continue;
    if (item.kind.startsWith('fs.')) eff[item.kind].push(resolvePathValue(item.value, ctx));
    else eff[item.kind].push(item.value);
  }
  return eff;
}

function hostMatches(pattern, hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

function isPathInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = {
  PERMISSION_KINDS,
  permId,
  splitPermId,
  requestedPermissions,
  effectivePermissions,
  resolvePathValue,
  hostMatches,
  isPathInside,
  realish,
  describe,
};
