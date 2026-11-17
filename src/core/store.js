'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./constants');
const { realish } = require('./permissions');

function resolveHome() {
  return realish(process.env.HARNESS_HOME || path.join(ROOT, '.harness-data'));
}

function emptyState() {
  return { version: 1, settings: { activeProvider: null }, plugins: {} };
}

function writeAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: mode || 0o644 });
  fs.renameSync(tmp, file);
}

/**
 * Durable host state (installed plugins, grants, config, settings) and
 * secrets. State is a single JSON file written atomically, so the CLI and a
 * running server can both edit it; the server watches it and reconciles.
 */
class Store {
  constructor(home = resolveHome()) {
    this.home = home;
    this.paths = {
      state: path.join(home, 'state.json'),
      secrets: path.join(home, 'secrets.json'),
      plugins: path.join(home, 'plugins'),
      data: path.join(home, 'data'),
      logs: path.join(home, 'logs'),
      sessions: path.join(home, 'sessions'),
      audit: path.join(home, 'logs', 'audit.jsonl'),
      workspace: realish(process.env.HARNESS_WORKSPACE || path.join(home, 'workspace')),
    };
    for (const k of ['plugins', 'data', 'logs', 'sessions', 'workspace']) fs.mkdirSync(this.paths[k], { recursive: true });
    this.seedWorkspace();
  }

  seedWorkspace() {
    const notes = path.join(this.paths.workspace, 'notes');
    if (fs.existsSync(notes)) return;
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(
      path.join(notes, 'welcome.md'),
      '# 欢迎使用 Plugin Harness\n\n这是工作区里的示例笔记。workspace-notes 插件可以列出、搜索、读取和写入这里的笔记。\n\n- 联系人：alice@example.com（pii-guard 启用后会被脱敏）\n- TODO: 试试 `搜索笔记 插件`\n',
    );
    fs.writeFileSync(
      path.join(notes, 'plugin-ideas.md'),
      '# 插件点子\n\n1. 日历插件：读取本地 ics 文件\n2. 翻译插件：调用翻译 API\n3. 代码统计插件：统计工作区代码行数\n',
    );
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.paths.state, 'utf8'));
      return { ...emptyState(), ...s, settings: { ...emptyState().settings, ...(s.settings || {}) } };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep the corrupt file for inspection rather than silently losing it.
        const bak = `${this.paths.state}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.paths.state, bak);
        } catch {}
        process.emitWarning(`state.json 损坏，已备份到 ${bak} 并重置`);
      }
      return emptyState();
    }
  }

  save(state) {
    writeAtomic(this.paths.state, JSON.stringify(state, null, 2));
    this._lastWrite = fs.statSync(this.paths.state).mtimeMs;
  }

  update(fn) {
    const s = this.load();
    const r = fn(s);
    this.save(s);
    return r;
  }

  /** Call cb when another process (e.g. the CLI) changes state.json. */
  watch(cb) {
    fs.watchFile(this.paths.state, { interval: 700 }, (cur) => {
      if (cur.mtimeMs && cur.mtimeMs !== this._lastWrite) cb();
    });
    return () => fs.unwatchFile(this.paths.state);
  }

  pluginDataDir(id) {
    const d = path.join(this.paths.data, id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  // ---- secrets (0600 file; values never leave the host except to granted plugins)
  loadSecrets() {
    try {
      return JSON.parse(fs.readFileSync(this.paths.secrets, 'utf8'));
    } catch {
      return {};
    }
  }

  setSecret(name, value) {
    const s = this.loadSecrets();
    if (value === null || value === undefined || value === '') delete s[name];
    else s[name] = String(value);
    writeAtomic(this.paths.secrets, JSON.stringify(s, null, 2), 0o600);
  }

  getSecret(name) {
    const s = this.loadSecrets();
    if (s[name]) return s[name];
    return process.env[name] || null;
  }

  listSecrets() {
    const s = this.loadSecrets();
    return Object.keys(s).map((name) => ({ name, source: 'store' }));
  }
}

module.exports = { Store, resolveHome };
