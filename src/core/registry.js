'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./constants');
const semver = require('./semver');
const { readManifest, checkCompatibility, settingsDefaults, validateConfig } = require('./manifest');
const { requestedPermissions, realish } = require('./permissions');

class UserError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'UserError';
    this.details = details;
  }
}

/** Plugin directories the user can discover and install by id. */
function catalogDirs() {
  const dirs = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
    for (const s of cfg.sources || []) dirs.push(path.resolve(ROOT, s));
  } catch {}
  for (const s of (process.env.HARNESS_CATALOG || '').split(path.delimiter).filter(Boolean)) dirs.push(path.resolve(s));
  return dirs;
}

function listCatalog() {
  const out = [];
  for (const dir of catalogDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const pdir = path.join(dir, name);
      if (!fs.statSync(pdir).isDirectory() || !fs.existsSync(path.join(pdir, 'plugin.json'))) continue;
      const r = readManifest(pdir);
      if (!r.manifest && !r.ok) {
        out.push({ dir: pdir, id: name, ok: false, errors: r.errors });
        continue;
      }
      out.push({ dir: pdir, id: r.manifest.id, ok: r.ok, errors: r.errors, warnings: r.warnings, manifest: r.manifest });
    }
  }
  return out;
}

function resolveSource(source) {
  const looksLikePath = source.startsWith('.') || source.startsWith('/') || source.includes(path.sep) || source.startsWith('~');
  if (looksLikePath) {
    // realpath: Node's permission model checks resolved paths (macOS /tmp -> /private/tmp)
    const dir = realish(path.resolve(source.replace(/^~(?=$|\/)/, process.env.HOME || '~')));
    if (!fs.existsSync(dir)) throw new UserError(`目录不存在：${dir}`);
    return { dir, source: { type: 'path', ref: dir } };
  }
  const [id, version] = source.split('@');
  const hits = listCatalog().filter((c) => c.id === id && c.manifest && semver.valid(c.manifest.version));
  if (!hits.length) throw new UserError(`在插件目录中找不到 "${id}"。运行 \`harness catalog\` 查看可安装的插件`);
  let hit;
  if (version) {
    hit = hits.find((c) => c.manifest.version === version);
    if (!hit) throw new UserError(`插件 ${id} 没有版本 ${version}（可用：${hits.map((c) => c.manifest.version).join(', ')}）`);
  } else {
    hit = hits.sort((a, b) => semver.compare(b.manifest.version, a.manifest.version))[0];
  }
  return { dir: hit.dir, source: { type: 'catalog', ref: id } };
}

/** Inspect a plugin before installing: manifest, permissions, compatibility. */
function inspect(source) {
  const { dir, source: src } = resolveSource(source);
  const r = readManifest(dir);
  if (!r.ok) throw new UserError(`插件清单无效（${dir}）`, r.errors);
  return {
    dir,
    source: src,
    manifest: r.manifest,
    warnings: r.warnings,
    permissions: requestedPermissions(r.manifest),
    compat: checkCompatibility(r.manifest),
  };
}

function copyPlugin(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => !/(^|[\\/])(\.git|\.DS_Store)$/.test(src),
  });
}

/**
 * Pure state operations on installed plugins. Never touches processes —
 * the Host reconciles running processes against this state.
 */
class Registry {
  constructor(store) {
    this.store = store;
    this._cache = new Map();
  }

  manifestFor(record) {
    const file = path.join(record.path, 'plugin.json');
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {}
    const key = record.path;
    const hit = this._cache.get(key);
    if (hit && hit.mtime === mtime) return hit.result;
    const result = readManifest(record.path);
    this._cache.set(key, { mtime, result });
    return result;
  }

  list() {
    const state = this.store.load();
    return Object.values(state.plugins).map((rec) => this.describe(rec));
  }

  get(id) {
    const rec = this.store.load().plugins[id];
    if (!rec) throw new UserError(`插件 "${id}" 未安装`);
    return rec;
  }

  describe(rec) {
    const r = this.manifestFor(rec);
    const manifest = r.manifest;
    const compat = manifest ? checkCompatibility(manifest) : { compatible: false, reason: '清单无效' };
    const perms = manifest ? requestedPermissions(manifest) : [];
    const granted = new Set(rec.grants || []);
    return {
      ...rec,
      manifestOk: r.ok,
      manifestErrors: r.errors || [],
      manifest,
      compat,
      permissions: perms.map((p) => ({ ...p, granted: granted.has(p.id), pending: (rec.pendingPermissions || []).includes(p.id) })),
      config: manifest ? { ...settingsDefaults(manifest), ...(rec.config || {}) } : rec.config || {},
    };
  }

  install(source, { grants = 'all', enable = true, dev = false } = {}) {
    const info = inspect(source);
    const { manifest } = info;
    const state = this.store.load();
    if (state.plugins[manifest.id]) {
      throw new UserError(`插件 ${manifest.id} 已安装（${state.plugins[manifest.id].version}）。如需升级请使用 update`);
    }
    let installPath = info.dir;
    if (!dev) {
      installPath = path.join(this.store.paths.plugins, manifest.id, manifest.version);
      copyPlugin(info.dir, installPath);
    }
    const requested = info.permissions.map((p) => p.id);
    const granted = grants === 'all' ? requested : requested.filter((id) => grants.includes(id));
    const now = new Date().toISOString();
    const rec = {
      id: manifest.id,
      version: manifest.version,
      source: dev ? { type: 'dev', ref: info.dir } : info.source,
      path: installPath,
      enabled: Boolean(enable && info.compat.compatible),
      grants: granted,
      pendingPermissions: [],
      config: {},
      installedAt: now,
      updatedAt: now,
    };
    state.plugins[manifest.id] = rec;
    if (!state.settings.activeProvider && manifest.contributes.providers.length && rec.enabled) {
      state.settings.activeProvider = `${manifest.id}/${manifest.contributes.providers[0].name}`;
    }
    this.store.save(state);
    return { ...info, record: rec };
  }

  uninstall(id, { purge = false } = {}) {
    const state = this.store.load();
    const rec = state.plugins[id];
    if (!rec) throw new UserError(`插件 "${id}" 未安装`);
    delete state.plugins[id];
    if (state.settings.activeProvider && state.settings.activeProvider.startsWith(`${id}/`)) state.settings.activeProvider = null;
    this.store.save(state);
    if (rec.source.type !== 'dev') fs.rmSync(path.join(this.store.paths.plugins, id), { recursive: true, force: true });
    if (purge) fs.rmSync(path.join(this.store.paths.data, id), { recursive: true, force: true });
    return rec;
  }

  setEnabled(id, enabled) {
    return this.store.update((s) => {
      const rec = s.plugins[id];
      if (!rec) throw new UserError(`插件 "${id}" 未安装`);
      if (enabled) {
        const d = this.describe(rec);
        if (!d.manifestOk) throw new UserError(`无法启用：插件清单无效`, d.manifestErrors);
        if (!d.compat.compatible) throw new UserError(`无法启用：${d.compat.reason}`);
      }
      rec.enabled = enabled;
      rec.updatedAt = new Date().toISOString();
      return rec;
    });
  }

  setConfig(id, values) {
    return this.store.update((s) => {
      const rec = s.plugins[id];
      if (!rec) throw new UserError(`插件 "${id}" 未安装`);
      const { manifest } = this.manifestFor(rec);
      if (!manifest) throw new UserError('插件清单无效，无法配置');
      const v = validateConfig(manifest, values);
      if (!v.ok) throw new UserError('配置无效', v.errors);
      rec.config = { ...(rec.config || {}), ...v.values };
      return rec;
    });
  }

  grant(id, permIds) {
    return this.store.update((s) => {
      const rec = s.plugins[id];
      if (!rec) throw new UserError(`插件 "${id}" 未安装`);
      const { manifest } = this.manifestFor(rec);
      const requested = new Set(requestedPermissions(manifest).map((p) => p.id));
      const ids = permIds === 'all' ? [...requested] : permIds;
      for (const p of ids) {
        if (!requested.has(p)) throw new UserError(`插件没有申请权限 ${p}，不能授予未声明的权限`);
      }
      rec.grants = [...new Set([...(rec.grants || []), ...ids])];
      rec.pendingPermissions = (rec.pendingPermissions || []).filter((p) => !ids.includes(p));
      return rec;
    });
  }

  revoke(id, permIds) {
    return this.store.update((s) => {
      const rec = s.plugins[id];
      if (!rec) throw new UserError(`插件 "${id}" 未安装`);
      const ids = permIds === 'all' ? [...(rec.grants || [])] : permIds;
      rec.grants = (rec.grants || []).filter((p) => !ids.includes(p));
      // Declining pending permissions clears them; the plugin then runs without them.
      rec.pendingPermissions = (rec.pendingPermissions || []).filter((p) => !ids.includes(p));
      return rec;
    });
  }

  checkUpdate(id) {
    const rec = this.get(id);
    if (rec.source.type === 'dev') return { id, current: rec.version, available: null, reason: '开发模式插件随源码目录实时更新' };
    let info;
    try {
      info = inspect(rec.source.ref);
    } catch (e) {
      return { id, current: rec.version, available: null, reason: `更新源不可用：${e.message}` };
    }
    const newer = semver.compare(info.manifest.version, rec.version) > 0;
    const granted = new Set(rec.grants || []);
    return {
      id,
      current: rec.version,
      available: newer ? info.manifest.version : null,
      newPermissions: newer ? info.permissions.filter((p) => !granted.has(p.id)) : [],
      compat: info.compat,
    };
  }

  update(id) {
    const rec = this.get(id);
    const chk = this.checkUpdate(id);
    if (!chk.available) throw new UserError(`${id} 已是最新版本 ${rec.version}${chk.reason ? `（${chk.reason}）` : ''}`);
    const info = inspect(rec.source.ref);
    const newPath = path.join(this.store.paths.plugins, id, info.manifest.version);
    copyPlugin(info.dir, newPath);
    const oldPath = rec.path;
    const requested = info.permissions.map((p) => p.id);
    const result = this.store.update((s) => {
      const r = s.plugins[id];
      const oldGrants = new Set(r.grants || []);
      r.version = info.manifest.version;
      r.path = newPath;
      r.grants = requested.filter((p) => oldGrants.has(p)); // drop grants no longer requested
      r.pendingPermissions = requested.filter((p) => !oldGrants.has(p));
      if (!info.compat.compatible) r.enabled = false;
      r.updatedAt = new Date().toISOString();
      return { record: r, from: rec.version, to: info.manifest.version, pendingPermissions: r.pendingPermissions };
    });
    if (oldPath !== newPath) fs.rmSync(oldPath, { recursive: true, force: true });
    return result;
  }

  setSetting(key, value) {
    return this.store.update((s) => {
      s.settings[key] = value;
      return s.settings;
    });
  }
}

/** Catalog grouped by id: latest version first, with all available versions. */
function catalogIndex() {
  const byId = new Map();
  for (const c of listCatalog()) {
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id).push(c);
  }
  return [...byId.values()].map((entries) => {
    const valid = entries.filter((e) => e.manifest && semver.valid(e.manifest.version));
    valid.sort((a, b) => semver.compare(b.manifest.version, a.manifest.version));
    const latest = valid[0] || entries[0];
    return {
      id: latest.id,
      ok: latest.ok,
      errors: latest.errors,
      manifest: latest.manifest,
      versions: valid.map((e) => e.manifest.version),
      permissions: latest.manifest ? requestedPermissions(latest.manifest) : [],
      compat: latest.manifest ? checkCompatibility(latest.manifest) : { compatible: false, reason: '清单无效' },
    };
  });
}

module.exports = { Registry, UserError, listCatalog, catalogIndex, inspect, catalogDirs };
