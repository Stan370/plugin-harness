#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { ROOT, HOST_VERSION, API_VERSION } = require('../src/core/constants');
const { Store } = require('../src/core/store');
const { Registry, UserError, catalogIndex, inspect } = require('../src/core/registry');
const { readManifest, checkCompatibility } = require('../src/core/manifest');
const { requestedPermissions } = require('../src/core/permissions');

// ------------------------------------------------------------------ .env
// Load <project>/.env into the HOST process only (never overrides existing env).
// Plugin processes still get a clean env; secrets reach them solely through
// the broker, and only if the user granted `secrets:<NAME>`.
(function loadDotEnv() {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
})();

// ------------------------------------------------------------------ helpers
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), blue = c(34), cyan = c(36);

const STATE_STYLE = {
  running: green('● 运行中'),
  starting: yellow('◌ 启动中'),
  stopping: yellow('◌ 停止中'),
  stopped: dim('○ 已停止'),
  disabled: dim('○ 已禁用'),
  crashed: yellow('▲ 崩溃，自动重启中'),
  failed: red('✖ 失败'),
  incompatible: red('✖ 版本不兼容'),
  invalid: red('✖ 清单无效'),
  'needs-approval': yellow('? 等待批准新权限'),
};
const RISK = { high: red('高风险'), medium: yellow('中风险'), low: dim('低风险') };

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-') && ['port', 'id', 'name', 'level'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-y') flags.yes = true;
    else if (a === '-f') flags.follow = true;
    else pos.push(a);
  }
  return { pos, flags };
}

function ask(q) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => (rl.close(), r(a.trim()))));
}

function askHidden(q) {
  if (!process.stdin.isTTY) {
    // allow piping: echo $KEY | harness secrets set NAME
    return new Promise((r) => {
      let d = '';
      process.stdin.on('data', (x) => (d += x)).on('end', () => r(d.trim()));
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => {
    if (s.includes(q)) rl.output.write(s);
  };
  return new Promise((r) => rl.question(q, (a) => (rl.close(), process.stdout.write('\n'), r(a.trim()))));
}

function serverInfo(store) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(store.home, 'server.json'), 'utf8'));
    process.kill(s.pid, 0);
    return s;
  } catch {
    return null;
  }
}

function notifyServer(store) {
  const s = serverInfo(store);
  if (s) console.log(dim(`（检测到 Web 服务正在运行 pid ${s.pid}，变更将在 1 秒内自动生效）`));
}

function printPermissions(perms, { showGrant = false } = {}) {
  if (!perms.length) {
    console.log(`  ${green('不需要任何权限')}`);
    return;
  }
  for (const p of perms) {
    const mark = showGrant ? (p.pending ? yellow('[待批准] ') : p.granted ? green('[已授予] ') : dim('[未授予] ')) : '';
    console.log(`  ${mark}${RISK[p.risk]}  ${p.description}  ${dim(p.id)}`);
  }
}

async function withHost(fn) {
  const { Host } = require('../src/host/host');
  const host = new Host();
  host.logs.subscribe((e) => {
    if (e.level === 'error' || (e.level === 'warn' && process.env.HARNESS_VERBOSE !== '0')) console.error(dim(`  [${e.pluginId || 'host'}] ${e.level}: ${e.msg.split('\n')[0]}`));
    else if (process.env.HARNESS_VERBOSE) console.error(dim(`  [${e.pluginId || 'host'}] ${e.msg.split('\n')[0]}`));
  });
  await host.init({ watch: false });
  try {
    return await fn(host);
  } finally {
    await host.shutdown();
  }
}

function renderEvent(e) {
  switch (e.type) {
    case 'user':
      if (e.rewritten) console.log(dim(`  (发送给模型的内容已被插件改写为：${e.rewritten})`));
      break;
    case 'note':
      console.log(`  ${e.error ? yellow('!') : blue('ℹ')} ${dim(`[${e.pluginId}]`)} ${e.text}`);
      break;
    case 'tool_call':
      console.log(`  ${cyan('→')} ${bold(e.tool.replace('__', '.'))} ${dim(JSON.stringify(e.input))}`);
      break;
    case 'tool_result':
      console.log(`  ${e.ok ? green('✓') : red('✗')} ${dim(`${e.durationMs}ms`)}`);
      console.log((e.ok ? e.content : red(e.content)).replace(/^/gm, '    '));
      break;
    case 'assistant':
      if (e.text) console.log(e.interim ? dim(`  ${e.text}`) : `\n${e.text}\n`);
      break;
    case 'error':
      console.log(red(`  ✖ ${e.text}`));
      break;
  }
}

// ----------------------------------------------------------------- commands
const commands = {};

commands.help = () => {
  console.log(`${bold('Plugin Harness')} ${HOST_VERSION} ${dim(`(插件协议 apiVersion ${API_VERSION})`)}

${bold('快速开始')}
  harness setup                     安装推荐插件（会列出权限并征求同意）
  harness start [--port 7777]       启动本地 Web 界面

${bold('插件管理')}
  harness catalog                   浏览可安装的插件
  harness list                      已安装插件及运行状态
  harness info <id>                 详情：权限、贡献点、配置、最近错误
  harness install <id|路径>[@版本] [-y] [--disabled]
  harness uninstall <id> [--purge]  卸载（--purge 同时删除插件数据）
  harness enable|disable <id>
  harness config <id> [key=value…]  查看 / 修改配置
  harness grant|revoke <id> <权限|all>   例：harness revoke weather network:api.open-meteo.com
  harness outdated                  检查更新
  harness update <id> [-y]          更新（新增权限需要重新批准）
  harness logs [id] [-f]            查看 / 跟随日志

${bold('使用')}
  harness chat                      终端对话（REPL）
  harness run "<消息>"              单次执行
  harness call <插件.工具> [参数]   直接调用工具，例：harness call workspace-notes.search query=插件
  harness provider [<插件/名称>]    查看 / 切换 Agent 的模型提供方
  harness secrets list|set <NAME>|rm <NAME>

${bold('插件开发')}
  harness create <目录> [--id my-plugin]   生成插件骨架
  harness validate <目录>                   校验清单与兼容性
  harness dev <目录> [--port 7777]          链接安装 + Web + 改代码自动重载
  harness doctor                            环境自检

数据目录：${dim(new Store().home)}（可用 HARNESS_HOME 覆盖）`);
};

commands.catalog = () => {
  const store = new Store();
  const installed = Object.fromEntries(new Registry(store).list().map((p) => [p.id, p.version]));
  for (const e of catalogIndex()) {
    const m = e.manifest;
    if (!m) {
      console.log(`${red('✖')} ${e.id} ${red('清单无效')}`);
      continue;
    }
    const inst = installed[e.id] ? green(`已安装 ${installed[e.id]}`) : '';
    const compat = e.compat.compatible ? '' : red(` 不兼容：${e.compat.reason}`);
    console.log(`${bold(e.id)} ${dim(e.versions.join(', '))} ${inst}${compat}`);
    console.log(`  ${m.name} — ${m.description}`);
    const kinds = [];
    if (m.contributes.tools.length) kinds.push(`${m.contributes.tools.length} 个工具`);
    if (m.contributes.hooks.length) kinds.push(`${m.contributes.hooks.length} 个 hook`);
    if (m.contributes.providers.length) kinds.push(`${m.contributes.providers.length} 个 Provider`);
    console.log(`  ${dim(kinds.join(' · '))}  ${dim('权限：' + (e.permissions.map((p) => p.id).join(', ') || '无'))}\n`);
  }
};

commands.list = async () => {
  const store = new Store();
  const reg = new Registry(store);
  const list = reg.list();
  if (!list.length) return console.log('还没有安装插件。运行 `harness setup` 或 `harness catalog`。');
  const settings = store.load().settings;
  const srv = serverInfo(store);
  for (const p of list) {
    let state;
    if (!p.manifestOk) state = 'invalid';
    else if (!p.compat.compatible) state = 'incompatible';
    else if (!p.enabled) state = 'disabled';
    else if ((p.pendingPermissions || []).length) state = 'needs-approval';
    else state = srv ? 'running' : 'stopped';
    const label = state === 'running' ? green('● 已启用（Web 服务运行中）') : state === 'stopped' ? green('● 已启用') : STATE_STYLE[state];
    console.log(`${bold(p.id)} ${dim(p.version)}  ${label}${p.source.type === 'dev' ? yellow('  [dev]') : ''}`);
    if (p.manifest) console.log(`  ${p.manifest.name}`);
    if (!p.compat.compatible) console.log(red(`  ${p.compat.reason}`));
  }
  console.log(dim(`\n当前 Provider：${settings.activeProvider || '未设置'}`));
  if (srv) console.log(dim('实时进程状态请看 Web 界面或 `harness info <id>`'));
};

commands.info = async ({ pos }) => {
  const id = pos[0];
  if (!id) throw new UserError('用法：harness info <id>');
  const store = new Store();
  const reg = new Registry(store);
  const d = reg.describe(reg.get(id));
  const m = d.manifest;
  console.log(`${bold(m ? m.name : id)} ${dim(`${id}@${d.version}`)}`);
  if (m) console.log(`${m.description}\n${dim(`作者：${m.author || '未知'} · 来源：${d.source.type} ${d.source.ref}`)}`);
  console.log(`${dim('安装位置：')}${d.path}`);
  console.log(`启用：${d.enabled ? green('是') : dim('否')}   兼容：${d.compat.compatible ? green('是') : red(d.compat.reason)}`);
  if (!d.manifestOk) console.log(red(`清单错误：\n  - ${d.manifestErrors.join('\n  - ')}`));
  console.log(bold('\n权限'));
  printPermissions(d.permissions, { showGrant: true });
  if (m) {
    console.log(bold('\n贡献'));
    for (const t of m.contributes.tools) console.log(`  工具 ${cyan(`${id}.${t.name}`)} — ${t.description}`);
    for (const h of m.contributes.hooks) console.log(`  Hook ${cyan(h.event)} ${dim(`priority=${h.priority || 100} failMode=${h.failMode || 'open'}`)}`);
    for (const p of m.contributes.providers) console.log(`  Provider ${cyan(`${id}/${p.name}`)} — ${p.label || ''}`);
    console.log(bold('\n配置'));
    const s = m.contributes.settings;
    if (!Object.keys(s).length) console.log(dim('  无可配置项'));
    for (const [k, def] of Object.entries(s)) console.log(`  ${k} = ${JSON.stringify(d.config[k])} ${dim(`(${def.title || ''}${def.type === 'select' ? `；可选 ${def.options.join('/')}` : ''})`)}`);
  }
  const logFile = path.join(store.paths.logs, `${id}.log`);
  if (fs.existsSync(logFile)) {
    const errs = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter((l) => / (ERROR|WARN) /.test(l)).slice(-5);
    if (errs.length) {
      console.log(bold('\n最近的警告 / 错误'));
      for (const l of errs) console.log(`  ${dim(l.slice(0, 220))}`);
    }
  }
};

async function confirmInstall(info, flags) {
  const m = info.manifest;
  console.log(`\n${bold(m.name)} ${dim(`${m.id}@${m.version}`)}\n${m.description}\n`);
  if (!info.compat.compatible) console.log(red(`⚠ ${info.compat.reason}。可以安装，但无法启用。\n`));
  console.log(bold('该插件申请以下权限：'));
  printPermissions(info.permissions);
  for (const w of info.warnings || []) console.log(yellow(`⚠ ${w}`));
  if (flags.yes) return true;
  if (!process.stdin.isTTY) throw new UserError('非交互环境下需要 -y 明确同意授予以上权限');
  const a = await ask(`\n${info.permissions.length ? '授予以上全部权限并安装' : '安装'}？[y/N] `);
  return /^y(es)?$/i.test(a);
}

commands.install = async ({ pos, flags }) => {
  const src = pos[0];
  if (!src) throw new UserError('用法：harness install <id|路径>[@版本]');
  const store = new Store();
  const info = inspect(src);
  if (!(await confirmInstall(info, flags))) return console.log('已取消');
  const r = new Registry(store).install(src, { grants: 'all', enable: !flags.disabled, dev: Boolean(flags.dev) });
  console.log(green(`✓ 已安装 ${r.record.id}@${r.record.version}${r.record.enabled ? '，已启用' : '（未启用）'}`));
  notifyServer(store);
};

commands.uninstall = async ({ pos, flags }) => {
  const store = new Store();
  const rec = new Registry(store).uninstall(pos[0], { purge: Boolean(flags.purge) });
  console.log(green(`✓ 已卸载 ${rec.id}${flags.purge ? '（含数据）' : '，插件数据保留在 ' + store.paths.data}`));
  notifyServer(store);
};

for (const [cmd, on] of [['enable', true], ['disable', false]]) {
  commands[cmd] = async ({ pos }) => {
    const store = new Store();
    new Registry(store).setEnabled(pos[0], on);
    console.log(green(`✓ ${pos[0]} 已${on ? '启用' : '禁用'}`));
    notifyServer(store);
  };
}

commands.config = async ({ pos }) => {
  const [id, ...pairs] = pos;
  const store = new Store();
  const reg = new Registry(store);
  if (pairs.length) {
    const values = {};
    for (const p of pairs) {
      const i = p.indexOf('=');
      if (i < 0) throw new UserError(`参数 ${p} 应为 key=value`);
      values[p.slice(0, i)] = p.slice(i + 1);
    }
    reg.setConfig(id, values);
    console.log(green('✓ 配置已保存（运行中的插件会热更新）'));
    notifyServer(store);
  }
  const d = reg.describe(reg.get(id));
  for (const [k, def] of Object.entries(d.manifest.contributes.settings)) console.log(`${k} = ${JSON.stringify(d.config[k])} ${dim(def.title || '')}`);
};

for (const cmd of ['grant', 'revoke']) {
  commands[cmd] = async ({ pos }) => {
    const [id, ...perms] = pos;
    if (!id || !perms.length) throw new UserError(`用法：harness ${cmd} <id> <权限 id|all>，权限 id 见 harness info <id>`);
    const store = new Store();
    const reg = new Registry(store);
    reg[cmd](id, perms[0] === 'all' ? 'all' : perms);
    console.log(green(`✓ 已${cmd === 'grant' ? '授予' : '撤销'}`));
    printPermissions(reg.describe(reg.get(id)).permissions, { showGrant: true });
    notifyServer(store);
  };
}

commands.outdated = async () => {
  const reg = new Registry(new Store());
  let any = false;
  for (const p of reg.list()) {
    const u = reg.checkUpdate(p.id);
    if (!u.available) continue;
    any = true;
    console.log(`${bold(p.id)} ${u.current} → ${green(u.available)}${u.newPermissions.length ? yellow(`  需要新权限：${u.newPermissions.map((x) => x.id).join(', ')}`) : ''}`);
  }
  if (!any) console.log('所有插件都是最新的。');
};

commands.update = async ({ pos, flags }) => {
  const store = new Store();
  const reg = new Registry(store);
  const id = pos[0];
  if (!id) return commands.outdated();
  const u = reg.checkUpdate(id);
  if (!u.available) return console.log(`${id} 已是最新（${u.current}）${u.reason ? dim(` ${u.reason}`) : ''}`);
  console.log(`更新 ${bold(id)} ${u.current} → ${green(u.available)}`);
  if (!u.compat.compatible) console.log(red(`⚠ 新版本不兼容：${u.compat.reason}`));
  const r = reg.update(id);
  if (r.pendingPermissions.length) {
    console.log(yellow('\n新版本申请了额外权限：'));
    const perms = requestedPermissions(reg.manifestFor(reg.get(id)).manifest).filter((p) => r.pendingPermissions.includes(p.id));
    printPermissions(perms);
    const yes = flags.yes || /^y/i.test(await ask('授予这些新权限？（拒绝则插件以原有权限运行）[y/N] '));
    if (yes) reg.grant(id, r.pendingPermissions);
    else reg.revoke(id, r.pendingPermissions);
    console.log(yes ? green('✓ 已授予') : dim('已拒绝新权限，插件将在不具备这些权限的情况下运行'));
  }
  console.log(green(`✓ 已更新到 ${r.to}`));
  notifyServer(store);
};

commands.logs = async ({ pos, flags }) => {
  const store = new Store();
  const files = pos[0] ? [path.join(store.paths.logs, `${pos[0]}.log`)] : fs.readdirSync(store.paths.logs).filter((f) => f.endsWith('.log')).map((f) => path.join(store.paths.logs, f));
  const colorize = (l) => (/ ERROR /.test(l) ? red(l) : / WARN /.test(l) ? yellow(l) : / DEBUG /.test(l) ? dim(l) : l);
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.log(dim(`${path.basename(f)}：暂无日志`));
      continue;
    }
    if (files.length > 1) console.log(bold(`\n== ${path.basename(f, '.log')}`));
    for (const l of fs.readFileSync(f, 'utf8').trim().split('\n').slice(-40)) console.log(colorize(l));
  }
  if (flags.follow && files.length === 1) {
    let size = fs.existsSync(files[0]) ? fs.statSync(files[0]).size : 0;
    console.log(dim('— 跟随中，Ctrl+C 退出 —'));
    fs.watchFile(files[0], { interval: 300 }, (cur) => {
      if (cur.size < size) size = 0;
      const fd = fs.openSync(files[0], 'r');
      const buf = Buffer.alloc(cur.size - size);
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      size = cur.size;
      for (const l of buf.toString().trim().split('\n').filter(Boolean)) console.log(colorize(l));
    });
    await new Promise(() => {});
  }
};

commands.secrets = async ({ pos }) => {
  const store = new Store();
  const [sub, name] = pos;
  if (sub === 'set') {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name || '')) throw new UserError('用法：harness secrets set NAME（大写字母/数字/下划线）');
    const v = await askHidden(`输入 ${name} 的值（不会回显）：`);
    if (!v) throw new UserError('值为空，未保存');
    store.setSecret(name, v);
    console.log(green(`✓ 已保存到 ${store.paths.secrets}（权限 0600）。只有被授予 secrets:${name} 的插件可以读取。`));
  } else if (sub === 'rm') {
    store.setSecret(name, null);
    console.log(green(`✓ 已删除 ${name}`));
  } else {
    const list = store.listSecrets();
    if (!list.length) console.log(dim('没有保存的密钥（插件也可以读取同名环境变量，前提是被授权）'));
    for (const s of list) console.log(`${s.name}  ${dim('已设置（值不显示）')}`);
  }
};

commands.provider = async ({ pos }) => {
  const store = new Store();
  const reg = new Registry(store);
  if (pos[0]) {
    const [pid, name] = pos[0].split('/');
    const d = reg.describe(reg.get(pid));
    if (!d.manifest.contributes.providers.some((p) => p.name === name)) throw new UserError(`插件 ${pid} 没有 Provider ${name}`);
    reg.setSetting('activeProvider', pos[0]);
    console.log(green(`✓ 当前 Provider：${pos[0]}`));
    notifyServer(store);
    return;
  }
  const active = store.load().settings.activeProvider;
  for (const p of reg.list()) {
    for (const pr of (p.manifest && p.manifest.contributes.providers) || []) {
      const ref = `${p.id}/${pr.name}`;
      console.log(`${ref === active ? green('●') : '○'} ${ref}  ${dim(pr.label || '')}${p.enabled ? '' : dim('（插件未启用）')}`);
    }
  }
};

commands.call = async ({ pos }) => {
  const [tool, ...rest] = pos;
  if (!tool) throw new UserError('用法：harness call <插件.工具> [参数]');
  const { parseArgs: parseToolArgs } = require('../src/host/agent');
  await withHost(async (host) => {
    const spec = host.resolveTool(tool);
    if (!spec) throw new UserError(`找不到工具 ${tool}。可用：${host.listTools({ availableOnly: false }).map((t) => `${t.pluginId}.${t.tool}`).join(', ')}`);
    const input = parseToolArgs(rest.join(' '), spec.input_schema);
    renderEvent({ type: 'tool_call', tool: spec.name, input });
    const r = await host.invokeTool(spec.name, input, { via: 'cli' });
    for (const n of r.notes || []) renderEvent({ type: 'note', ...n, text: n.note });
    renderEvent({ type: 'tool_result', ok: r.ok, content: r.ok ? r.content : `${r.error.kind}: ${r.error.message}`, durationMs: r.durationMs });
    if (!r.ok) process.exitCode = 1;
  });
};

commands.run = async ({ pos }) => {
  const text = pos.join(' ');
  if (!text) throw new UserError('用法：harness run "<消息>"');
  const { Agent } = require('../src/host/agent');
  await withHost(async (host) => {
    const agent = new Agent(host);
    await agent.run(null, text, renderEvent);
  });
};

commands.chat = async () => {
  const { Agent } = require('../src/host/agent');
  await withHost(async (host) => {
    const agent = new Agent(host);
    const s = agent.session();
    console.log(`${bold('Plugin Harness 对话')} ${dim(`Provider：${host.info().settings.activeProvider || '未设置'} · /help 查看命令 · Ctrl+D 退出`)}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: cyan('› ') });
    rl.prompt();
    for await (const line of rl) {
      if (line.trim()) await agent.run(s.id, line, renderEvent);
      rl.prompt();
    }
  });
};

commands.setup = async ({ flags }) => {
  const store = new Store();
  const reg = new Registry(store);
  const recommended = ['workspace-notes', 'weather@1.0.0', 'pii-guard', 'rule-router', 'openrouter-provider', 'cloud-providers'];
  const installed = new Set(reg.list().map((p) => p.id));
  const todo = recommended.filter((s) => !installed.has(s.split('@')[0]));
  if (todo.length) {
    console.log(bold('将安装以下推荐插件：'));
    const infos = todo.map((s) => inspect(s));
    for (const i of infos) {
      console.log(`\n${bold(i.manifest.id)}@${i.manifest.version} — ${i.manifest.name}`);
      printPermissions(i.permissions);
    }
    if (!flags.yes) {
      if (!process.stdin.isTTY) throw new UserError('非交互环境下需要 -y 明确同意授予以上权限');
      if (!/^y/i.test(await ask('\n安装并授予以上权限？[y/N] '))) return console.log('已取消');
    }
    for (const s of todo) {
      const r = reg.install(s, { grants: 'all' });
      console.log(green(`✓ ${r.record.id}@${r.record.version}`));
    }
  } else {
    console.log(dim('推荐插件都已安装，将检查可用的云模型密钥。'));
  }
  const providerKeys = [
    ['OPENROUTER_API_KEY', 'openrouter-provider/openrouter', 'OpenRouter'],
    ['OPENAI_API_KEY', 'cloud-providers/openai', 'OpenAI'],
    ['ANTHROPIC_API_KEY', 'cloud-providers/anthropic', 'Anthropic'],
    ['GEMINI_API_KEY', 'cloud-providers/gemini', 'Google Gemini'],
    ['DEEPSEEK_API_KEY', 'cloud-providers/deepseek', 'DeepSeek'],
  ];
  const detected = providerKeys.find(([name]) => Boolean(store.getSecret(name)));
  reg.setSetting('activeProvider', detected ? detected[1] : 'rule-router/rules');
  console.log(`\nAgent Provider：${bold(detected ? `${detected[2]}（检测到 ${detected[0]}）` : '规则路由（离线）')}${detected ? '' : dim('  — 设置任一云模型密钥后可切换：harness provider')}`);
  console.log(`\n下一步：${cyan('harness start')}  打开 Web 界面`);
  notifyServer(store);
};

commands.start = async ({ flags }) => {
  const { Host } = require('../src/host/host');
  const { createServer } = require('../src/server/server');
  const store = new Store();
  const existing = serverInfo(store);
  if (existing) throw new UserError(`已有 Web 服务在运行（pid ${existing.pid}，端口 ${existing.port}）。同一个数据目录只能运行一个服务。`);
  const host = new Host({ store });
  host.logs.subscribe((e) => {
    if (e.level === 'error' || e.level === 'warn') console.error(`${dim(new Date(e.ts).toLocaleTimeString())} ${e.level === 'error' ? red('ERROR') : yellow('WARN ')} ${dim(`[${e.pluginId || 'host'}]`)} ${e.msg.split('\n')[0]}`);
  });
  await host.init({ watch: true });
  const srv = createServer(host, { port: Number(flags.port || process.env.PORT || 7777) });
  let addr;
  try {
    addr = await srv.listen();
  } catch (e) {
    await host.shutdown();
    if (e.code === 'EADDRINUSE') throw new UserError(`端口 ${flags.port || 7777} 已被占用，换一个：harness start --port 7788`);
    throw e;
  }
  const infoFile = path.join(store.home, 'server.json');
  fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, port: addr.port, startedAt: Date.now() }), { mode: 0o600 });
  const plugins = host.listPlugins();
  console.log(`\n${bold('Plugin Harness')} ${HOST_VERSION} 已启动`);
  console.log(`  插件：${plugins.filter((p) => p.state === 'running').length} 运行 / ${plugins.length} 已安装`);
  console.log(`  数据：${dim(store.home)}`);
  console.log(`\n  打开 → ${cyan(addr.url)}\n  ${dim('（链接包含本次启动的访问令牌，请勿分享）')}\n`);
  if (flags.open) require('node:child_process').spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [addr.url], { detached: true, stdio: 'ignore' }).unref();
  const stop = async () => {
    console.log(dim('\n正在停止插件…'));
    try {
      fs.unlinkSync(infoFile);
    } catch {}
    await srv.close();
    await host.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { host, srv };
};

commands.create = async ({ pos, flags }) => {
  const dir = path.resolve(pos[0] || '');
  if (!pos[0]) throw new UserError('用法：harness create <目录> [--id my-plugin] [--name 名称]');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new UserError(`目录 ${dir} 已存在且非空`);
  const id = flags.id || path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '');
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new UserError(`根据目录名推导的 id "${id}" 不合法，请用 --id 指定`);
  const tpl = path.join(ROOT, 'templates', 'basic');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(tpl)) {
    const s = fs.readFileSync(path.join(tpl, f), 'utf8').replaceAll('{{id}}', id).replaceAll('{{name}}', flags.name || id).replaceAll('{{author}}', process.env.USER || 'me');
    fs.writeFileSync(path.join(dir, f), s);
  }
  console.log(green(`✓ 已创建插件 ${id}：${dir}`));
  for (const f of fs.readdirSync(dir)) console.log(`  ${f}`);
  console.log(`\n下一步：\n  ${cyan(`harness dev ${pos[0]}`)}   ${dim('链接安装、启动 Web、保存即重载')}\n  ${cyan(`harness call ${id}.greet name=Alice`)}`);
};

commands.validate = async ({ pos }) => {
  const dir = path.resolve(pos[0] || '.');
  const r = readManifest(dir);
  if (r.manifest) {
    const compat = checkCompatibility(r.manifest);
    if (!compat.compatible) r.errors.push(`不兼容：${compat.reason}`);
  }
  for (const e of r.errors) console.log(red(`✖ ${e}`));
  for (const w of r.warnings || []) console.log(yellow(`⚠ ${w}`));
  if (r.errors.length) {
    process.exitCode = 1;
    return;
  }
  const m = r.manifest;
  console.log(green(`✓ ${m.id}@${m.version} 清单有效，与宿主 ${HOST_VERSION} 兼容`));
  console.log(dim(`  ${m.contributes.tools.length} 工具 · ${m.contributes.hooks.length} hook · ${m.contributes.providers.length} provider · ${requestedPermissions(m).length} 项权限`));
};

commands.dev = async ({ pos, flags }) => {
  const dir = path.resolve(pos[0] || '.');
  const store = new Store();
  const reg = new Registry(store);
  const r = readManifest(dir);
  if (!r.ok) {
    for (const e of r.errors) console.log(red(`✖ ${e}`));
    throw new UserError('清单无效，修复后重试');
  }
  const id = r.manifest.id;
  const cur = store.load().plugins[id];
  if (cur && cur.source.type !== 'dev') throw new UserError(`已存在非开发模式安装的 ${id}，请先 harness uninstall ${id}`);
  if (!cur) {
    const info = inspect(dir);
    if (!(await confirmInstall(info, flags))) return console.log('已取消');
    reg.install(dir, { dev: true, grants: 'all' });
    console.log(green(`✓ 以开发模式链接 ${id} → ${dir}`));
  }
  const { host } = await commands.start({ flags });
  host.logs.subscribe((e) => {
    if (e.pluginId === id && e.level !== 'error' && e.level !== 'warn') console.log(`${dim(new Date(e.ts).toLocaleTimeString())} ${dim(`[${id}]`)} ${e.msg}`);
  });
  let timer;
  fs.watch(dir, { recursive: true }, (_ev, file) => {
    if (!file || /node_modules|\.git/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = readManifest(dir);
      if (!v.ok) {
        console.log(red(`✖ ${file} 修改后清单无效：\n  ${v.errors.join('\n  ')}`));
        return;
      }
      // New permissions declared during development still need explicit approval.
      const rec = store.load().plugins[id];
      const newPerms = requestedPermissions(v.manifest).filter((p) => !(rec.grants || []).includes(p.id));
      if (newPerms.length) {
        console.log(yellow(`清单新增权限：${newPerms.map((p) => p.id).join(', ')}`));
        if (flags.yes || /^y/i.test(await ask('授予？[y/N] '))) reg.grant(id, newPerms.map((p) => p.id));
      }
      console.log(cyan(`↻ ${file} 已修改，重载 ${id}…`));
      await host.restart(id);
      const p = host.listPlugins().find((x) => x.id === id);
      console.log(p.state === 'running' ? green('✓ 重载完成') : red(`✖ ${p.state}：${p.process && p.process.lastError ? p.process.lastError.message : ''}`));
    }, 250);
  });
  console.log(dim(`监听 ${dir} 的修改…`));
};

commands.doctor = async () => {
  const store = new Store();
  const [maj, min] = process.versions.node.split('.').map(Number);
  const ok = (b, s, hint) => console.log(`${b ? green('✓') : red('✖')} ${s}${!b && hint ? dim(`  → ${hint}`) : ''}`);
  ok(maj > 22 || (maj === 22 && min >= 13), `Node.js ${process.version}（需要 ≥ 22.13，支持稳定的 --permission）`, '升级 Node.js');
  const { execFileSync } = require('node:child_process');
  let sandbox = false;
  try {
    const out = execFileSync(process.execPath, ['--permission', `--allow-fs-read=${__dirname}`, '-e', "try{require('fs').readFileSync('/etc/hosts');console.log('LEAK')}catch(e){console.log(e.code)}"], { encoding: 'utf8' });
    sandbox = out.trim() === 'ERR_ACCESS_DENIED';
  } catch {}
  ok(sandbox, 'Node 权限模型可用（插件文件系统沙箱）');
  ok(fs.existsSync(store.home), `数据目录 ${store.home}`);
  ok(true, `工作区 ${store.paths.workspace}`);
  const reg = new Registry(store);
  for (const p of reg.list()) ok(p.manifestOk && p.compat.compatible, `插件 ${p.id}@${p.version}`, p.manifestErrors.join('; ') || p.compat.reason);
  const providerKeys = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY'];
  for (const name of providerKeys) {
    const hasKey = Boolean(store.getSecret(name));
    console.log(`${hasKey ? green('✓') : dim('○')} ${name} ${dim(hasKey ? '已配置' : '未配置（可选）')}`);
  }
};

// --------------------------------------------------------------------- main
async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const fn = commands[cmd] || (cmd === '--help' || cmd === '-h' ? commands.help : null);
  if (!fn) {
    console.error(red(`未知命令 ${cmd}`));
    commands.help();
    process.exit(1);
  }
  try {
    await fn(parseArgs(rest));
  } catch (e) {
    if (e instanceof UserError) {
      console.error(red(`✖ ${e.message}`));
      for (const d of e.details || []) console.error(red(`  - ${d}`));
      process.exit(1);
    }
    throw e;
  }
}

main();
