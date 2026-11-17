'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

/** @type {import('../../sdk/harness').Host} */
let host;

function notesRoot() {
  const root = path.resolve(host.workspace, host.config.notesDir || 'notes');
  if (!root.startsWith(host.workspace)) throw new Error('notesDir 必须位于工作区内');
  return root;
}

// Resolve a user-supplied name safely inside the notes folder.
function notePath(name) {
  const root = notesRoot();
  const p = path.resolve(root, name);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`非法文件名：${name}（不能跳出笔记目录）`);
  return p;
}

async function walk(dir, base = dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (/\.(md|txt)$/i.test(e.name)) out.push(path.relative(base, full));
  }
  return out.sort();
}

module.exports = {
  activate(h) {
    host = h;
    host.log.info(`笔记目录：${notesRoot()}`);
  },

  tools: {
    async list() {
      const root = notesRoot();
      const files = await walk(root);
      if (!files.length) return '笔记目录为空。';
      const rows = [];
      for (const f of files) {
        const st = await fs.stat(path.join(root, f));
        rows.push({ name: f, size: st.size, modified: st.mtime.toISOString().slice(0, 16).replace('T', ' ') });
      }
      return {
        content: rows.map((r) => `- ${r.name}（${r.size} 字节，${r.modified}）`).join('\n'),
        data: rows,
        display: { type: 'table', columns: ['name', 'size', 'modified'] },
      };
    },

    async search({ query }, ctx) {
      const root = notesRoot();
      const q = query.toLowerCase();
      const hits = [];
      for (const f of await walk(root)) {
        if (ctx.signal.aborted) break;
        const lines = (await fs.readFile(path.join(root, f), 'utf8')).split('\n');
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(q)) hits.push({ file: f, line: i + 1, text: line.trim() });
        });
        if (hits.length >= host.config.maxResults) break;
      }
      const shown = hits.slice(0, host.config.maxResults);
      if (!shown.length) return `没有找到包含「${query}」的笔记。`;
      return {
        content: shown.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n'),
        data: shown,
        display: { type: 'table', columns: ['file', 'line', 'text'] },
      };
    },

    async read({ name }) {
      try {
        return await fs.readFile(notePath(name), 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') throw new Error(`笔记 ${name} 不存在。可以先用 list 查看已有笔记。`);
        throw e;
      }
    },

    async write({ name, content }) {
      if (!/\.(md|txt)$/i.test(name)) name += '.md';
      const p = notePath(name);
      const exists = await fs.stat(p).then(() => true, () => false);
      if (exists && !host.config.allowOverwrite) {
        throw new Error(`笔记 ${name} 已存在。如需覆盖，请在插件配置中开启「允许覆盖已有笔记」。`);
      }
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content.endsWith('\n') ? content : content + '\n');
      host.log.info(`写入笔记 ${name}（${content.length} 字符）`);
      return `已${exists ? '覆盖' : '创建'}笔记 ${name}（${content.length} 字符）。`;
    },
  },
};
