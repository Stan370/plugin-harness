'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE = 1024 * 1024;

/** In-memory ring buffer + per-plugin log files (rotated at 1MB). */
class LogStore {
  constructor(dir, { capacity = 2000 } = {}) {
    this.dir = dir;
    this.capacity = capacity;
    this.entries = [];
    this.seq = 0;
    this.listeners = new Set();
  }

  add(entry) {
    const e = { seq: ++this.seq, ts: Date.now(), level: 'info', source: 'plugin', ...entry };
    this.entries.push(e);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    if (this.dir && e.pluginId) {
      const file = path.join(this.dir, `${e.pluginId}.log`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE) fs.renameSync(file, `${file}.1`);
        fs.appendFileSync(file, `${new Date(e.ts).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.msg}\n`);
      } catch {}
    }
    for (const l of this.listeners) l(e);
    return e;
  }

  query({ pluginId, level, limit = 300, since = 0 } = {}) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const min = levels[level] || 0;
    return this.entries
      .filter((e) => e.seq > since && (!pluginId || e.pluginId === pluginId) && (levels[e.level] || 0) >= min)
      .slice(-limit);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

module.exports = { LogStore };
