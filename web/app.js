'use strict';
/* Plugin Harness web UI. No framework, no build step.
 * All plugin-provided strings are rendered as text nodes (never innerHTML). */

// ------------------------------------------------------------------ token
(function captureToken() {
  // Accepts "#token=…" or "#plugins&token=…"; the token is moved out of the URL.
  const m = /(?:^#|&)token=([a-f0-9]+)/.exec(location.hash);
  if (m) {
    sessionStorage.setItem('harness-token', m[1]);
    const page = location.hash.slice(1).split('&').find((x) => x && !x.startsWith('token=')) || 'chat';
    history.replaceState(null, '', `${location.pathname}#${page}`);
  }
})();
const TOKEN = sessionStorage.getItem('harness-token') || '';

// ------------------------------------------------------------------ dom helpers
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: allowed under our strict CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const clear = (el) => {
  while (el.firstChild) el.firstChild.remove();
  return el;
};

/** Tiny, safe markdown: paragraphs, "- " lists, **bold**, `code`. */
function md(text) {
  const frag = document.createDocumentFragment();
  const inline = (s) => {
    const out = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      out.push(m[0].startsWith('**') ? h('strong', {}, m[0].slice(2, -2)) : h('code', {}, m[0].slice(1, -1)));
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  let list = null;
  for (const line of String(text || '').split('\n')) {
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      if (!list) frag.append((list = h('ul')));
      list.append(h('li', {}, inline(li[1])));
      continue;
    }
    list = null;
    if (line.trim()) frag.append(h('p', {}, inline(line)));
  }
  return frag;
}

function toast(msg, { error = false, details } = {}) {
  const t = h('div', { class: `toast${error ? ' error' : ''}` }, msg, details && details.length ? h('ul', {}, details.map((d) => h('li', {}, d))) : null);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), error ? 7000 : 3500);
}

const STATE_META = {
  running: ['green', '运行中'],
  starting: ['yellow', '启动中'],
  stopping: ['yellow', '停止中'],
  stopped: ['', '已停止'],
  disabled: ['', '已禁用'],
  crashed: ['yellow', '崩溃 · 自动重启中'],
  failed: ['red', '失败'],
  incompatible: ['red', '版本不兼容'],
  invalid: ['red', '清单无效'],
  'needs-approval': ['yellow', '等待批准新权限'],
};
const stateBadge = (s) => {
  const [color, label] = STATE_META[s] || ['', s];
  return h('span', { class: `badge ${color}` }, h('span', { class: 'pulse' }), label);
};
const RISK = { high: ['red', '高风险'], medium: ['yellow', '中风险'], low: ['', '低风险'] };
const riskBadge = (r) => h('span', { class: `badge ${RISK[r][0]}` }, RISK[r][1]);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
/** Two-column key/value grid; every cell wrapped so text nodes don't merge. */
const kvGrid = (...pairs) => h('div', { class: 'kv' }, pairs.map((x) => h('div', {}, x)));

// ------------------------------------------------------------------ api
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.details = data.details;
    throw e;
  }
  return data;
}
async function act(promise, okMsg) {
  try {
    const r = await promise;
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, { error: true, details: e.details });
    throw e;
  }
}

// ------------------------------------------------------------------ app state
const S = {
  page: 'chat',
  state: null, // { info, plugins, providers, tools }
  catalog: null,
  logs: [],
  logFilter: { pluginId: '', level: '' },
  sessionId: localStorage.getItem('harness-session') || null,
  transcript: [],
  sessions: [],
  sessionLoading: false,
  busy: false,
  drawer: null, // { id, tab }
  updates: {},
  errorsSeen: 0,
};

async function refresh() {
  S.state = await api('/api/state');
  $('#host-version').textContent = `v${S.state.info.hostVersion} · 协议 v${S.state.info.apiVersion}`;
  $('#nav-plugins-count').textContent = S.state.plugins.length || '';
  const bad = S.state.plugins.filter((p) => ['failed', 'crashed', 'needs-approval'].includes(p.state)).length;
  $('#nav-errors').textContent = bad || '';
}
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await refresh().catch(() => {});
    if (S.page === 'plugins' || S.page === 'settings') render();
    if (S.page === 'chat') renderChatHeader();
    if (S.drawer) renderDrawer();
  }, 150);
}

async function refreshSessions() {
  try {
    S.sessions = await api('/api/sessions');
  } catch (e) {
    S.sessions = [];
  }
  renderSessionList();
}

function renderSessionList() {
  const list = $('#session-list');
  if (!list) return;
  clear(list);
  for (const s of S.sessions) {
    const item = h(
      'div',
      { class: `session-item${s.id === S.sessionId ? ' active' : ''}` },
    );
    const title = h('button', {
      class: 'session-title',
      title: s.title,
      onclick: () => switchSession(s.id),
    }, s.title);
    const meta = h('button', {
      class: 'session-menu',
      title: '重命名或删除会话',
      onclick: () => showSessionMenu(s),
    }, '•••');
    item.append(title, meta);
    list.append(item);
  }
  if (!S.sessions.length) list.append(h('div', { class: 'session-empty' }, '暂无会话'));
}

async function createSession(title = '') {
  if (S.busy) return;
  const s = await act(api('/api/sessions', { method: 'POST', body: { title } }), '');
  S.sessionId = s.id;
  S.transcript = [];
  localStorage.setItem('harness-session', s.id);
  await refreshSessions();
  renderTranscript();
  renderChatHeader();
  setTimeout(() => chatEls.ta && chatEls.ta.focus(), 0);
  return s;
}

async function switchSession(id) {
  if (S.busy || S.sessionLoading || id === S.sessionId) return;
  S.sessionLoading = true;
  S.sessionId = id;
  S.transcript = [];
  localStorage.setItem('harness-session', id);
  renderTranscript();
  renderSessionList();
  renderChatHeader();
  try {
    const s = await api(`/api/sessions/${id}`);
    if (S.sessionId !== id) return;
    S.transcript = s.transcript;
    renderTranscript();
    renderChatHeader();
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    S.sessionLoading = false;
  }
}

function showSessionMenu(s) {
  showModal((close) => {
    const title = h('input', { class: 'text', value: s.title, style: 'width:100%' });
    return h(
      'div',
      {},
      h('div', { class: 'modal-head' }, h('h2', {}, '会话'), h('button', { class: 'btn ghost', onclick: close }, '关闭')),
      h('label', { class: 'form', style: 'display:block' }, h('span', {}, '标题'), title),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:16px' }, h('button', {
        class: 'btn danger',
        onclick: async () => {
          await act(api(`/api/sessions/${s.id}`, { method: 'DELETE' }), '会话已删除');
          close();
          if (S.sessionId === s.id) {
            S.sessionId = null;
            S.transcript = [];
            localStorage.removeItem('harness-session');
            renderTranscript();
          }
          await refreshSessions();
        },
      }, '删除'), h('button', {
        class: 'btn primary',
        onclick: async () => {
          await act(api(`/api/sessions/${s.id}`, { method: 'PATCH', body: { title: title.value } }), '标题已更新');
          close();
          await refreshSessions();
        },
      }, '保存')),
    );
  });
}

// ------------------------------------------------------------------ router
function go(page) {
  S.page = page;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.page === page);
  render();
}
window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'chat'));

function render() {
  const main = clear($('#main'));
  if (!TOKEN) return main.append(noToken());
  if (!S.state) return main.append(h('div', { class: 'empty' }, '加载中…'));
  const pages = { chat: pageChat, plugins: pagePlugins, discover: pageDiscover, logs: pageLogs, settings: pageSettings };
  main.append((pages[S.page] || pageChat)());
}

function noToken() {
  return h('div', { class: 'page' }, h('div', { class: 'empty' }, h('h2', {}, '需要访问令牌'), h('p', {}, '请使用 `harness start` 在终端打印的完整链接（包含 #token=…）打开本页面。')));
}

// ================================================================== CHAT
let chatEls = {};
function pageChat() {
  const root = h('div', { class: 'chat' });
  const head = h('div', { class: 'chat-head' });
  const scroll = h('div', { class: 'chat-scroll' });
  const inner = h('div', { class: 'chat-inner' });
  scroll.append(inner);
  const ta = h('textarea', {
    rows: 1,
    placeholder: '输入消息，或 / 开头的命令（/help）… Enter 发送，Shift+Enter 换行',
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    },
    oninput: () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    },
  });
  const sendBtn = h('button', { class: 'btn primary', onclick: () => send() }, '发送');
  const suggest = h('div', { class: 'suggest' });
  const composer = h('div', { class: 'composer' }, h('div', { class: 'composer-inner' }, suggest, h('div', { class: 'input-row' }, ta, sendBtn)));
  root.append(head, scroll, composer);
  chatEls = { head, scroll, inner, ta, sendBtn, suggest };

  async function send(text) {
    const t = (text ?? ta.value).trim();
    if (!t || S.busy || S.sessionLoading) return;
    if (!S.sessionId) await createSession();
    ta.value = '';
    ta.style.height = 'auto';
    await runChat(t);
  }
  chatEls.send = send;

  renderChatHeader();
  renderTranscript();
  setTimeout(() => ta.focus(), 0);
  return root;
}

function renderChatHeader() {
  if (!chatEls.head || !S.state) return;
  const head = clear(chatEls.head);
  const providers = S.state.providers;
  const active = S.state.info.settings.activeProvider;
  const sessionSel = h(
    'select',
    {
      title: '切换会话',
      onchange: (e) => e.target.value && switchSession(e.target.value),
    },
    h('option', { value: '' }, '选择会话'),
    S.sessions.map((s) => h('option', { value: s.id, selected: s.id === S.sessionId }, s.title)),
  );
  sessionSel.className = 'session-select';
  const sel = h(
    'select',
    {
      title: 'Agent 的决策层（也是插件）',
      onchange: async (e) => {
        await act(api('/api/settings', { method: 'POST', body: { activeProvider: e.target.value || null } }), '已切换 Provider');
        await refresh();
        renderChatHeader();
      },
    },
    h('option', { value: '' }, '— 选择 Provider —'),
    providers.map((p) => h('option', { value: p.ref, selected: p.ref === active, disabled: p.state !== 'running' }, `${p.label}${p.state !== 'running' ? `（${(STATE_META[p.state] || [0, p.state])[1]}）` : ''}`)),
  );
  const ap = providers.find((p) => p.ref === active);
  head.append(
    ...[
    h('h1', {}, '对话'),
    sessionSel,
    h('span', { class: 'muted small' }, 'Provider'),
    sel,
    ap && ap.state !== 'running' ? h('span', { class: 'badge red' }, 'Provider 不可用') : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn small', onclick: () => createSession() }, '＋ 新对话'),
    h('span', { class: 'faint small' }, `${S.state.tools.filter((t) => t.available).length} 个可用工具`),
    ].filter(Boolean),
  );
  // suggestions from tool examples — contributed by plugins, not hard-coded
  const sug = clear(chatEls.suggest);
  const ex = S.state.tools.filter((t) => t.available).flatMap((t) => t.examples.map((e) => [e, t.pluginId])).slice(0, 8);
  if (ex.length) sug.append(h('span', { class: 'faint small', style: 'align-self:center' }, '试试：'));
  for (const [e, pid] of ex) sug.append(h('button', { title: `来自插件 ${pid}`, onclick: () => chatEls.send(e) }, e));
  sug.append(h('button', { onclick: () => chatEls.send('/help') }, '/help'));
}

function renderTranscript() {
  const inner = clear(chatEls.inner);
  if (!S.transcript.length) {
    const active = S.state && S.state.info.settings.activeProvider;
    const activeProvider = S.state && S.state.providers.find((p) => p.ref === active);
    const needsOnboarding = !active || activeProvider?.state !== 'running';
    const empty = h('div', { class: 'empty chat-onboarding' });
    empty.append(h('h2', {}, '你好 👋'), h('p', {}, '选择一个 Agent 的大脑。所有工具和 Hook 仍由已安装插件提供。'));
    if (needsOnboarding) {
      const cards = h('div', { class: 'provider-choice-grid' });
      const offline = S.state?.providers.find((p) => p.ref === 'rule-router/rules');
      cards.append(
        h('div', { class: 'provider-choice' },
          h('div', { class: 'provider-choice-title' }, '离线规则路由器'),
          h('p', { class: 'small muted' }, '不调用大模型，不需要 API Key。适合确定性测试、笔记和天气演示。'),
          h('button', {
            class: 'btn primary',
            disabled: !offline || offline.state !== 'running',
            onclick: async () => {
              await act(api('/api/settings', { method: 'POST', body: { activeProvider: 'rule-router/rules' } }), '已切换到离线规则路由器');
              await refresh();
              renderChatHeader();
              renderTranscript();
            },
          }, '使用离线模式'),
        ),
        h('div', { class: 'provider-choice' },
          h('div', { class: 'provider-choice-title' }, '配置云模型'),
          h('p', { class: 'small muted' }, '支持 OpenRouter、OpenAI、Anthropic、Gemini 和 DeepSeek。密钥只会下发给已授权插件。'),
          h('button', { class: 'btn', onclick: () => { location.hash = 'settings'; } }, '前往配置 API Key'),
        ),
      );
      empty.append(cards);
    } else {
      empty.append(h('p', { class: 'small' }, '点击下方的示例，或到「已安装」页启用 / 禁用插件，看看对话能力如何随之变化。'));
      if (active && active !== 'rule-router/rules') {
        const keyByProvider = {
          'openrouter-provider/openrouter': 'OPENROUTER_API_KEY',
          'cloud-providers/openai': 'OPENAI_API_KEY',
          'cloud-providers/anthropic': 'ANTHROPIC_API_KEY',
          'cloud-providers/gemini': 'GEMINI_API_KEY',
          'cloud-providers/deepseek': 'DEEPSEEK_API_KEY',
        };
        const keyName = keyByProvider[active];
        if (keyName) {
          api('/api/secrets').then((list) => {
            const key = list.find((s) => s.name === keyName);
            if (key && !key.stored && !key.fromEnv) {
              clear(empty);
              empty.append(
                h('h2', {}, '需要配置 API Key'),
                h('p', {}, `当前 Provider 需要 ${keyName}。密钥配置完成后即可继续对话。`),
                h('button', { class: 'btn primary', onclick: () => { location.hash = 'settings'; } }, '前往设置'),
              );
            }
          }).catch(() => {});
        }
      }
    }
    inner.append(empty);
    return;
  }
  for (const ev of S.transcript) appendEvent(ev, false);
  chatEls.scroll.scrollTop = chatEls.scroll.scrollHeight;
}

const toolCards = new Map();
function appendEvent(ev, live = true) {
  const inner = chatEls.inner;
  if (!inner) return;
  if (live && inner.querySelector('.empty')) clear(inner);
  switch (ev.type) {
    case 'user':
      inner.append(h('div', { class: 'msg user' }, ev.text, ev.rewritten ? h('div', { class: 'rewritten' }, '🛡 实际发送给模型：', ev.rewritten) : null));
      break;
    case 'assistant':
      if (!ev.text) break;
      inner.append(h('div', { class: `msg assistant${ev.interim ? ' interim' : ''}` }, ev.interim ? ev.text : md(ev.text)));
      break;
    case 'note':
      inner.append(h('div', { class: `note${ev.error ? ' err' : ''}` }, h('span', { class: 'badge accent' }, ev.pluginId), ev.text));
      break;
    case 'error':
      inner.append(h('div', { class: 'msg error' }, '⚠ ', ev.text));
      break;
    case 'tool_call': {
      const body = h('div', { class: 'tool-body', hidden: true });
      const status = h('span', { class: 'spinner' });
      const progress = h('span', { class: 'progress' });
      const card = h(
        'div',
        { class: 'tool' },
        h('div', { class: 'tool-head', onclick: () => (body.hidden = !body.hidden) }, status, h('span', { class: 'name' }, ev.tool.replace('__', ' › ')), h('span', { class: 'args' }, JSON.stringify(ev.input)), progress),
        body,
      );
      inner.append(card);
      toolCards.set(ev.callId, { card, body, status, progress, input: ev.input });
      break;
    }
    case 'tool_result': {
      let tc = toolCards.get(ev.callId);
      if (!tc) {
        appendEvent({ type: 'tool_call', callId: ev.callId, tool: ev.tool, input: {} }, live);
        tc = toolCards.get(ev.callId);
      }
      tc.status.replaceWith(h('span', { class: `badge ${ev.ok ? 'green' : 'red'}` }, ev.ok ? '✓' : '✗', ` ${ev.durationMs ?? '–'}ms`));
      clear(tc.progress);
      if (!ev.ok) {
        tc.card.classList.add('fail');
        tc.progress.textContent = ev.errorKind ? `· ${ev.errorKind}` : '';
      }
      clear(tc.body).append(renderResult(ev), h('details', { class: 'small faint', style: 'margin-top:8px' }, h('summary', {}, '输入参数'), h('pre', {}, JSON.stringify(tc.input, null, 2))));
      tc.body.hidden = false;
      break;
    }
  }
  if (live) chatEls.scroll.scrollTop = chatEls.scroll.scrollHeight;
}

function renderResult(ev) {
  const d = ev.display;
  if (ev.ok && d && d.type === 'table' && Array.isArray(ev.data) && ev.data.length) {
    return h('table', { class: 'data' }, h('tr', {}, d.columns.map((c) => h('th', {}, c))), ev.data.map((row) => h('tr', {}, d.columns.map((c) => h('td', {}, String(row[c] ?? ''))))));
  }
  if (ev.ok && d && d.type === 'card' && ev.data && typeof ev.data === 'object') {
    const labels = d.labels || {};
    return h('div', {}, h('div', { class: 'wcard' }, Object.entries(ev.data).map(([k, v]) => h('div', {}, h('b', {}, labels[k] || k), String(v)))));
  }
  return h('pre', {}, ev.content);
}

async function runChat(text) {
  S.busy = true;
  chatEls.sendBtn.disabled = true;
  const requestSessionId = S.sessionId;
  const thinking = h('div', { class: 'note' }, h('span', { class: 'spinner' }), '思考中…');
  const showThinking = () => {
    chatEls.inner.append(thinking);
    chatEls.scroll.scrollTop = chatEls.scroll.scrollHeight;
  };
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: requestSessionId, text }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'session') {
          if (!S.sessionId) {
            S.sessionId = ev.sessionId;
            localStorage.setItem('harness-session', ev.sessionId);
          }
          continue;
        }
        if (ev.sessionId && ev.sessionId !== requestSessionId) {
          continue;
        }
        thinking.remove();
        if (ev.type === 'thinking') {
          showThinking();
          continue;
        }
        if (ev.type === 'done') continue;
        S.transcript.push(ev);
        appendEvent(ev);
      }
    }
  } catch (e) {
    const ev = { type: 'error', text: `请求失败：${e.message}` };
    S.transcript.push(ev);
    appendEvent(ev);
  } finally {
    thinking.remove();
    S.busy = false;
    chatEls.sendBtn.disabled = false;
    await refreshSessions();
    chatEls.ta.focus();
  }
}

// ================================================================== PLUGINS
function pagePlugins() {
  const page = h('div', { class: 'page' });
  const plugins = S.state.plugins;
  page.append(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, '已安装插件'), h('p', {}, '每个插件运行在独立的受限进程中。点击卡片查看权限、配置、日志与调试工具。')),
      h('a', { class: 'btn primary', href: '#discover' }, '＋ 安装插件'),
    ),
  );
  if (!plugins.length) {
    page.append(h('div', { class: 'card empty' }, h('h2', {}, '还没有插件'), h('p', {}, '到「发现」安装第一个插件，或在终端运行 harness setup。')));
    return page;
  }
  const grid = h('div', { class: 'grid' });
  for (const p of plugins) grid.append(pluginCard(p));
  page.append(grid);
  return page;
}

function contribChips(c) {
  return h(
    'div',
    { class: 'chips' },
    c.tools.length ? h('span', { class: 'chip' }, `🔧 ${c.tools.length} 工具`) : null,
    c.hooks.length ? h('span', { class: 'chip' }, `🪝 ${c.hooks.length} Hook`) : null,
    c.providers.length ? h('span', { class: 'chip' }, `🧠 Provider`) : null,
  );
}

function pluginCard(p) {
  const canEnable = p.compat.compatible && !p.manifestErrors.length;
  const err = p.process && p.process.lastError && ['failed', 'crashed'].includes(p.state) ? p.process.lastError.message : !p.compat.compatible ? p.compat.reason : p.state === 'needs-approval' ? '新版本申请了额外权限，批准或拒绝后才会启动' : null;
  return h(
    'div',
    { class: 'card pcard', onclick: () => openDrawer(p.id) },
    h(
      'div',
      { class: 'row' },
      h('div', { style: 'min-width:0' }, h('div', { class: 'title' }, p.name), h('div', { class: 'id' }, `${p.id}@${p.version}`, p.source.type === 'dev' ? ' · dev' : '')),
      h('span', { class: 'spacer' }),
      h(
        'label',
        { class: 'switch', title: canEnable ? (p.enabled ? '禁用' : '启用') : '无法启用', onclick: (e) => e.stopPropagation() },
        h('input', {
          type: 'checkbox',
          checked: p.enabled,
          disabled: !canEnable,
          onchange: async (e) => {
            await act(api(`/api/plugins/${p.id}/${e.target.checked ? 'enable' : 'disable'}`, { method: 'POST' }), `${p.name} 已${e.target.checked ? '启用' : '禁用'}`).catch(() => (e.target.checked = !e.target.checked));
            scheduleRefresh();
          },
        }),
        h('span'),
      ),
    ),
    h('div', { class: 'desc' }, p.description),
    h('div', { class: 'row' }, stateBadge(p.state), contribChips(p.contributes), S.updates[p.id] ? h('span', { class: 'badge accent' }, `可更新 ${S.updates[p.id]}`) : null),
    err ? h('div', { class: 'err' }, err) : null,
  );
}

// ------------------------------------------------------------------ drawer
function openDrawer(id, tab = 'overview') {
  S.drawer = { id, tab };
  renderDrawer();
}
function closeDrawer() {
  S.drawer = null;
  clear($('#drawer-root'));
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('#modal-root').firstChild) clear($('#modal-root'));
    else if (S.drawer) closeDrawer();
  }
});

function renderDrawer() {
  const root = clear($('#drawer-root'));
  const p = S.state.plugins.find((x) => x.id === S.drawer.id);
  if (!p) return closeDrawer();
  const tabs = [
    ['overview', '概览'],
    ['permissions', `权限${p.permissions.some((x) => x.pending) ? ' •' : ''}`],
    ['config', '配置'],
    ['tools', '调试工具'],
    ['logs', '日志'],
  ];
  const body = h('div', { class: 'drawer-body' });
  const drawer = h(
    'div',
    { class: 'drawer' },
    h(
      'div',
      { class: 'drawer-head' },
      h('div', { class: 'row' }, h('h2', {}, p.name), stateBadge(p.state), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: closeDrawer, title: '关闭 (Esc)' }, '✕')),
      h('div', { class: 'id faint mono' }, `${p.id}@${p.version} · ${p.author || '未知作者'}`),
    ),
    h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('button', { class: S.drawer.tab === k ? 'active' : '', onclick: () => ((S.drawer.tab = k), renderDrawer()) }, label))),
    body,
  );
  root.append(h('div', { class: 'drawer-backdrop', onclick: closeDrawer }), drawer);
  const tabsFn = { overview: tabOverview, permissions: tabPermissions, config: tabConfig, tools: tabTools, logs: tabLogs };
  body.append(tabsFn[S.drawer.tab](p));
}

function tabOverview(p) {
  const wrap = h('div');
  const proc = p.process;
  if (['failed', 'crashed'].includes(p.state) && proc && proc.lastError) {
    wrap.append(
      h(
        'div',
        { class: `alert ${p.state === 'failed' ? 'red' : 'yellow'}` },
        h('div', { class: 'title' }, p.state === 'failed' ? '插件已停止运行' : '插件崩溃，正在自动恢复'),
        proc.lastError.message,
        proc.lastError.stderr && proc.lastError.stderr.length ? h('pre', {}, proc.lastError.stderr.join('\n')) : null,
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small', onclick: () => pluginAct(p, 'restart', '已重启') }, '重新启动'), h('button', { class: 'btn small', onclick: () => ((S.drawer.tab = 'logs'), renderDrawer()) }, '查看日志')),
      ),
    );
  }
  if (!p.compat.compatible) wrap.append(h('div', { class: 'alert red' }, h('div', { class: 'title' }, '与当前宿主不兼容'), p.compat.reason, '。请联系作者更新插件，或安装兼容的版本。'));
  if (p.manifestErrors.length) wrap.append(h('div', { class: 'alert red' }, h('div', { class: 'title' }, '插件清单无效'), h('ul', {}, p.manifestErrors.map((e) => h('li', {}, e)))));
  if (p.state === 'needs-approval') wrap.append(h('div', { class: 'alert yellow' }, h('div', { class: 'title' }, '更新后申请了新权限'), '在「权限」页批准或拒绝后插件才会启动。', h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn small', onclick: () => ((S.drawer.tab = 'permissions'), renderDrawer()) }, '去处理'))));

  wrap.append(h('p', { class: 'muted' }, p.description));
  wrap.append(
    h(
      'div',
      { class: 'section' },
      h('h3', {}, '运行状况'),
      kvGrid(
        '状态', stateBadge(p.state),
        '进程', proc && proc.pid ? `pid ${proc.pid} · 启动于 ${fmtTime(proc.startedAt)}` : '—',
        '调用', proc ? `${proc.stats.calls} 次 · 错误 ${proc.stats.errors} · 超时 ${proc.stats.timeouts} · 近期崩溃 ${proc.restarts}` : '—',
        '来源', `${p.source.type} · ${p.source.ref}`,
        '安装位置', h('span', { class: 'mono small' }, p.path),
      ),
    ),
  );
  const c = p.contributes;
  wrap.append(
    h(
      'div',
      { class: 'section' },
      h('h3', {}, '扩展了宿主的哪些能力'),
      c.tools.map((t) => h('div', { class: 'perm' }, h('span', { class: 'badge' }, '工具'), h('div', { class: 'what' }, h('div', { class: 'mono' }, t.qualifiedName.replace('__', '.')), h('div', { class: 'small muted' }, t.description)))),
      c.hooks.map((x) => h('div', { class: 'perm' }, h('span', { class: 'badge' }, 'Hook'), h('div', { class: 'what' }, h('div', { class: 'mono' }, x.event), h('div', { class: 'small muted' }, `priority ${x.priority || 100} · 失败时${x.failMode === 'closed' ? '阻止操作（closed）' : '跳过（open）'}`)))),
      c.providers.map((x) => h('div', { class: 'perm' }, h('span', { class: 'badge' }, 'Provider'), h('div', { class: 'what' }, h('div', {}, x.label || x.name), h('div', { class: 'small muted' }, x.description || '')))),
    ),
  );
  if (proc && proc.sandbox) {
    wrap.append(h('div', { class: 'section' }, h('h3', {}, '沙箱参数（Node 权限模型）'), h('pre', { class: 'small', style: 'white-space:pre-wrap;background:var(--sunken);padding:10px;border-radius:8px' }, proc.sandbox.nodeArgs.join('\n'))));
  }
  wrap.append(
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn', onclick: () => pluginAct(p, 'restart', '已重启'), disabled: !p.enabled }, '↻ 重启'),
      h('button', { class: 'btn', onclick: () => checkUpdate(p) }, '检查更新'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn danger', onclick: () => confirmUninstall(p) }, '卸载'),
    ),
  );
  return wrap;
}

async function pluginAct(p, action, msg, body) {
  const r = await act(api(`/api/plugins/${p.id}/${action}`, { method: 'POST', body: body || {} }), msg).catch(() => null);
  await refresh();
  if (S.drawer) renderDrawer();
  // Discover shows install/update status too, so it must refresh after updates.
  if (S.page === 'plugins' || S.page === 'discover') render();
  return r;
}

async function checkUpdate(p) {
  const u = await act(api(`/api/plugins/${p.id}/check-update`));
  if (!u.available) return toast(`${p.name} 已是最新版本 ${u.current}${u.reason ? `（${u.reason}）` : ''}`);
  showModal((close) => [
    h('h2', {}, `更新 ${p.name}`),
    h('p', { class: 'muted' }, `${u.current} → ${u.available}`),
    !u.compat.compatible ? h('div', { class: 'alert red' }, `新版本不兼容：${u.compat.reason}`) : null,
    u.newPermissions.length
      ? h('div', { class: 'alert yellow' }, h('div', { class: 'title' }, '新版本需要额外权限'), u.newPermissions.map((x) => h('div', {}, '· ', x.description)), h('div', { class: 'small', style: 'margin-top:6px' }, '更新后插件会暂停，等你批准或拒绝这些权限。'))
      : h('p', { class: 'small muted' }, '不需要新的权限。'),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, '取消'), h('button', { class: 'btn primary', onclick: async () => (close(), await pluginAct(p, 'update', `已更新到 ${u.available}`), delete S.updates[p.id]) }, '更新')),
  ]);
}

function confirmUninstall(p) {
  let purge = false;
  showModal((close) => [
    h('h2', {}, `卸载 ${p.name}？`),
    h('p', { class: 'muted' }, '插件进程会被停止，代码将被删除。'),
    h('label', { class: 'inline-check form' }, h('input', { type: 'checkbox', onchange: (e) => (purge = e.target.checked) }), h('span', {}, '同时删除插件的私有数据')),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: close }, '取消'), h('button', { class: 'btn primary', onclick: async () => (close(), closeDrawer(), await pluginAct(p, 'uninstall', '已卸载', { purge })) }, '卸载')),
  ]);
}

function tabPermissions(p) {
  const wrap = h('div');
  wrap.append(h('p', { class: 'muted small' }, '插件只能使用这里「已授予」的权限。文件权限由 Node 运行时强制执行；网络与密钥由宿主代理并校验。撤销会立即重启插件进程使其生效。'));
  const pending = p.permissions.filter((x) => x.pending).map((x) => x.id);
  if (pending.length) {
    wrap.append(
      h(
        'div',
        { class: 'alert yellow' },
        h('div', { class: 'title' }, `新版本申请了 ${pending.length} 项新权限`),
        h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn small primary', onclick: () => pluginAct(p, 'permissions', '已批准', { grant: pending }) }, '全部批准'), h('button', { class: 'btn small', onclick: () => pluginAct(p, 'permissions', '已拒绝，插件将以原有权限运行', { revoke: pending }) }, '拒绝')),
      ),
    );
  }
  if (!p.permissions.length) wrap.append(h('div', { class: 'alert blue' }, '这个插件不需要任何权限：它不能读写文件、不能联网、不能读取密钥。'));
  for (const x of p.permissions) {
    wrap.append(
      h(
        'div',
        { class: 'perm' },
        riskBadge(x.risk),
        h('div', { class: 'what' }, h('div', {}, x.description), h('div', { class: 'mono' }, x.id)),
        x.pending ? h('span', { class: 'badge yellow' }, '待批准') : null,
        h(
          'label',
          { class: 'switch', title: x.granted ? '撤销' : '授予' },
          h('input', { type: 'checkbox', checked: x.granted, onchange: (e) => pluginAct(p, 'permissions', e.target.checked ? '已授予' : '已撤销', e.target.checked ? { grant: [x.id] } : { revoke: [x.id] }) }),
          h('span'),
        ),
      ),
    );
  }
  return wrap;
}

function tabConfig(p) {
  const schema = p.settings || {};
  const keys = Object.keys(schema);
  if (!keys.length) return h('div', { class: 'alert blue' }, '这个插件没有可配置项。');
  const values = { ...p.config };
  const form = h('div', { class: 'form' });
  for (const k of keys) {
    const s = schema[k];
    let input;
    if (s.type === 'boolean') {
      form.append(h('label', { class: 'inline-check' }, h('input', { type: 'checkbox', checked: values[k], onchange: (e) => (values[k] = e.target.checked) }), h('span', {}, s.title || k)));
      if (s.description) form.append(h('small', { class: 'faint' }, s.description));
      continue;
    }
    if (s.type === 'select') input = h('select', { onchange: (e) => (values[k] = e.target.value) }, s.options.map((o) => h('option', { value: o, selected: values[k] === o }, o)));
    else input = h('input', { type: s.type === 'number' ? 'number' : 'text', value: values[k] ?? '', min: s.min, max: s.max, oninput: (e) => (values[k] = e.target.value) });
    form.append(h('label', {}, h('span', {}, s.title || k, ' ', h('code', { class: 'faint' }, k)), input, s.description ? h('small', {}, s.description) : null));
  }
  form.append(h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => pluginAct(p, 'config', '配置已保存，插件已热更新', { values }) }, '保存'), h('span', { class: 'faint small' }, '表单由插件清单中的 settings 自动生成')));
  return form;
}

function exampleInput(schema) {
  const out = {};
  for (const [k, v] of Object.entries((schema && schema.properties) || {})) {
    out[k] = v.type === 'number' || v.type === 'integer' ? 0 : v.type === 'boolean' ? false : '';
  }
  return out;
}

function tabTools(p) {
  const tools = p.contributes.tools;
  if (!tools.length) return h('div', { class: 'alert blue' }, '这个插件不提供工具（它通过 hook 或 Provider 扩展宿主）。');
  let current = tools[0];
  const ta = h('textarea', { class: 'code', spellcheck: 'false' });
  const out = h('div');
  const desc = h('p', { class: 'small muted' });
  const pick = (t) => {
    current = t;
    ta.value = JSON.stringify(exampleInput(t.input), null, 2);
    desc.textContent = t.description;
  };
  pick(current);
  return h(
    'div',
    { class: 'form' },
    h('p', { class: 'muted small' }, '直接调用工具，绕过 Provider —— 开发插件时最快的调试方式。调用同样经过参数校验、hook 与超时控制。'),
    h('label', {}, h('span', {}, '工具'), h('select', { onchange: (e) => pick(tools.find((t) => t.name === e.target.value)) }, tools.map((t) => h('option', { value: t.name }, t.name)))),
    desc,
    h('label', {}, h('span', {}, '输入（JSON）'), ta),
    h(
      'button',
      {
        class: 'btn primary',
        onclick: async () => {
          let input;
          try {
            input = JSON.parse(ta.value || '{}');
          } catch (e) {
            return toast(`JSON 无效：${e.message}`, { error: true });
          }
          clear(out).append(h('div', { class: 'note' }, h('span', { class: 'spinner' }), '调用中…'));
          const r = await act(api('/api/tools/invoke', { method: 'POST', body: { tool: current.qualifiedName, input } }));
          clear(out).append(
            h('div', { class: `tool${r.ok ? '' : ' fail'}`, style: 'margin-top:12px' }, h('div', { class: 'tool-head' }, h('span', { class: `badge ${r.ok ? 'green' : 'red'}` }, r.ok ? '成功' : r.error.kind, ` · ${r.durationMs}ms`)), h('div', { class: 'tool-body' }, renderResult({ ok: r.ok, content: r.ok ? r.content : r.error.message, data: r.data, display: r.display }))),
            (r.notes || []).map((n) => h('div', { class: 'note', style: 'margin-top:6px' }, h('span', { class: 'badge accent' }, n.pluginId), n.note)),
          );
        },
      },
      '▶ 运行',
    ),
    out,
  );
}

function tabLogs(p) {
  const box = h('div', { class: 'logbox', style: 'max-height:calc(100vh - 220px)' });
  api(`/api/logs?pluginId=${encodeURIComponent(p.id)}&limit=300`).then((logs) => {
    if (!logs.length) box.append(h('div', { class: 'empty small' }, '暂无日志'));
    for (const l of logs) box.append(logLine(l));
    box.scrollTop = box.scrollHeight;
  });
  box.dataset.plugin = p.id;
  return h('div', {}, h('p', { class: 'muted small' }, '插件的 console 输出、宿主事件与错误。完整日志文件位于数据目录 logs/。'), box);
}

function logLine(l) {
  return h('div', { class: 'logline' }, h('span', { class: 'faint' }, fmtTime(l.ts)), h('span', { class: `lvl-${l.level}` }, l.level.toUpperCase()), h('span', { class: 'src', title: l.source === 'host' ? '宿主记录' : '插件输出' }, l.pluginId || 'host'), h('span', {}, l.msg));
}

// ------------------------------------------------------------------ modal
function showModal(build) {
  const root = clear($('#modal-root'));
  const close = () => clear(root);
  const modal = h('div', { class: 'modal', role: 'dialog' }, build(close));
  root.append(h('div', { class: 'modal-backdrop', onclick: (e) => e.target === e.currentTarget && close() }, modal));
}

// ================================================================== DISCOVER
function pageDiscover() {
  const page = h('div', { class: 'page' });
  const grid = h('div', { class: 'grid' }, h('div', { class: 'muted' }, '加载中…'));
  const pathInput = h('input', { class: 'text', placeholder: '/path/to/my-plugin', style: 'max-width:360px' });
  page.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, '发现插件'), h('p', {}, '来自本地插件目录（catalog.json）。安装前会展示插件申请的全部权限。'))),
    h('div', { class: 'card', style: 'padding:14px 16px;margin-bottom:18px' }, h('div', { class: 'row' }, h('span', { class: 'small' }, '从本地目录安装：'), pathInput, h('button', { class: 'btn', onclick: () => pathInput.value.trim() && installFlow(pathInput.value.trim()) }, '检查并安装'))),
    grid,
  );
  api('/api/catalog').then((cat) => {
    S.catalog = cat;
    clear(grid);
    for (const c of cat) grid.append(catalogCard(c));
    // remember updates for badges
    S.updates = {};
    for (const c of cat) if (c.installedVersion && c.versions[0] && c.versions[0] !== c.installedVersion) S.updates[c.id] = c.versions[0];
    $('#nav-updates').textContent = Object.keys(S.updates).length || '';
  });
  return page;
}

function catalogCard(c) {
  const m = c.manifest;
  if (!m) return h('div', { class: 'card pcard' }, h('div', { class: 'title' }, c.id), h('div', { class: 'err' }, (c.errors || []).join('；')));
  const latest = c.versions[0];
  const action = c.installedVersion
    ? c.installedVersion !== latest
      ? h('button', { class: 'btn small primary', onclick: (e) => (e.stopPropagation(), checkUpdate(S.state.plugins.find((p) => p.id === c.id))) }, `更新到 ${latest}`)
      : h('span', { class: 'badge green' }, `已安装 ${c.installedVersion}`)
    : h('button', { class: 'btn small primary', onclick: (e) => (e.stopPropagation(), installFlow(c.id)) }, '安装');
  const tags = [];
  if (m.id === 'chaos-monkey') tags.push(h('span', { class: 'badge red' }, '故障演示'));
  if (!c.compat.compatible) tags.push(h('span', { class: 'badge red' }, '不兼容'));
  return h(
    'div',
    { class: 'card pcard', onclick: () => !c.installedVersion && installFlow(c.id) },
    h('div', { class: 'row' }, h('div', {}, h('div', { class: 'title' }, m.name), h('div', { class: 'id' }, `${m.id} · ${c.versions.join(', ')}`)), h('span', { class: 'spacer' }), action),
    h('div', { class: 'desc' }, m.description),
    h('div', { class: 'row' }, contribChips(m.contributes), tags, h('span', { class: 'faint small' }, c.permissions.length ? `${c.permissions.length} 项权限` : '无需权限')),
    !c.compat.compatible ? h('div', { class: 'err' }, c.compat.reason) : null,
  );
}

async function installFlow(source) {
  const info = await act(api('/api/inspect', { method: 'POST', body: { source } }));
  const m = info.manifest;
  const chosen = new Set(info.permissions.map((p) => p.id));
  showModal((close) => [
    h('h2', {}, `安装 ${m.name}`),
    h('div', { class: 'faint mono small' }, `${m.id}@${m.version} · ${m.author || '未知作者'}`),
    h('p', { class: 'muted' }, m.description),
    !info.compat.compatible ? h('div', { class: 'alert red' }, h('div', { class: 'title' }, '与当前宿主不兼容'), info.compat.reason, '。可以安装但无法启用。') : null,
    (info.warnings || []).map((w) => h('div', { class: 'alert yellow' }, w)),
    h('h3', { class: 'small', style: 'margin:16px 0 4px' }, info.permissions.length ? '该插件申请以下权限（可取消勾选，插件将在没有该权限的情况下运行）' : '权限'),
    info.permissions.length
      ? info.permissions.map((x) =>
          h('label', { class: 'perm', style: 'cursor:pointer' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? chosen.add(x.id) : chosen.delete(x.id)) }), riskBadge(x.risk), h('div', { class: 'what' }, h('div', {}, x.description), h('div', { class: 'mono' }, x.id))),
        )
      : h('div', { class: 'alert blue' }, '不需要任何权限：不能读写文件、不能联网、不能读取密钥。'),
    h('p', { class: 'small faint' }, '插件将运行在独立进程中，文件访问受 Node 权限模型限制，网络与密钥由宿主按授权代理。安装后可随时在插件详情中撤销。'),
    h(
      'div',
      { class: 'foot' },
      h('button', { class: 'btn', onclick: close }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            close();
            await act(api('/api/install', { method: 'POST', body: { source, grants: [...chosen], enable: info.compat.compatible } }), `已安装 ${m.name}`);
            await refresh();
            if (S.page === 'discover') render();
          },
        },
        info.permissions.length ? '授予所选权限并安装' : '安装',
      ),
    ),
  ]);
}

// ================================================================== LOGS
function pageLogs() {
  const page = h('div', { class: 'page' });
  const box = h('div', { class: 'logbox', id: 'global-logs' });
  const pluginSel = h('select', { onchange: (e) => ((S.logFilter.pluginId = e.target.value), loadLogs()) }, h('option', { value: '' }, '全部来源'), S.state.plugins.map((p) => h('option', { value: p.id, selected: S.logFilter.pluginId === p.id }, p.id)));
  const lvlSel = h('select', { onchange: (e) => ((S.logFilter.level = e.target.value), loadLogs()) }, [['', '全部级别'], ['info', 'info 及以上'], ['warn', 'warn 及以上'], ['error', '仅 error']].map(([v, l]) => h('option', { value: v, selected: S.logFilter.level === v }, l)));
  page.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, '日志'), h('p', {}, '实时汇总宿主与所有插件的日志。权限拦截、超时、崩溃都会出现在这里。')), h('div', { class: 'row' }, pluginSel, lvlSel)), box);
  async function loadLogs() {
    const q = new URLSearchParams({ limit: '500', ...(S.logFilter.pluginId ? { pluginId: S.logFilter.pluginId } : {}), ...(S.logFilter.level ? { level: S.logFilter.level } : {}) });
    const logs = await api(`/api/logs?${q}`);
    clear(box);
    for (const l of logs) box.append(logLine(l));
    if (!logs.length) box.append(h('div', { class: 'empty small' }, '暂无日志'));
    box.scrollTop = box.scrollHeight;
  }
  loadLogs();
  $('#nav-errors').textContent = '';
  return page;
}

function onLiveLog(l) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (S.page === 'logs') {
    const box = $('#global-logs');
    const f = S.logFilter;
    if (box && (!f.pluginId || f.pluginId === l.pluginId) && (levels[l.level] || 0) >= (levels[f.level] || 0)) {
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.append(logLine(l));
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
  }
  const dbox = document.querySelector('.drawer .logbox');
  if (dbox && dbox.dataset.plugin === l.pluginId) {
    dbox.append(logLine(l));
    dbox.scrollTop = dbox.scrollHeight;
  }
}

// ================================================================== SETTINGS
function pageSettings() {
  const page = h('div', { class: 'page' });
  const info = S.state.info;
  const secretsBox = h('div', {}, h('div', { class: 'muted' }, '加载中…'));
  page.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, '设置'))),
    h('div', { class: 'card', style: 'padding:18px 20px;margin-bottom:16px' }, h('div', { class: 'section' }, h('h3', {}, '密钥'), h('p', { class: 'small muted' }, '密钥保存在本机数据目录（文件权限 0600），界面只写不读。只有被授予对应 secrets 权限的插件可以在运行时向宿主索取。'), secretsBox)),
    h(
      'div',
      { class: 'card', style: 'padding:18px 20px' },
      h('div', { class: 'section' }, h('h3', {}, '宿主'), kvGrid('版本', info.hostVersion, '插件协议', `apiVersion ${info.apiVersion}`, 'Node.js', info.node, '数据目录', h('span', { class: 'mono small' }, info.home), '工作区', h('span', { class: 'mono small' }, info.workspace))),
    ),
  );
  api('/api/secrets').then((list) => {
    clear(secretsBox);
    if (!list.length) secretsBox.append(h('div', { class: 'faint small' }, '没有插件申请密钥权限。'));
    for (const s of list) {
      const input = h('input', { type: 'password', class: 'text', placeholder: s.stored ? '已设置 · 输入新值以替换' : s.fromEnv ? '使用环境变量中的值 · 可在此覆盖' : '未设置', autocomplete: 'off', style: 'max-width:340px' });
      secretsBox.append(
        h(
          'div',
          { class: 'perm' },
          h('div', { class: 'what' }, h('div', { class: 'mono' }, s.name), h('div', { class: 'small muted' }, s.usedBy.length ? `用于：${s.usedBy.map((u) => `${u.id}${u.granted ? '' : '（未授权）'}`).join('、')}` : '暂无插件使用')),
          s.stored ? h('span', { class: 'badge green' }, '已设置') : s.fromEnv ? h('span', { class: 'badge' }, '来自环境变量') : h('span', { class: 'badge yellow' }, '未设置'),
          input,
          h('button', { class: 'btn small primary', onclick: async () => input.value && (await act(api('/api/secrets', { method: 'POST', body: { name: s.name, value: input.value } }), `${s.name} 已保存`), render()) }, '保存'),
          s.stored ? h('button', { class: 'btn small danger', onclick: async () => (await act(api('/api/secrets', { method: 'POST', body: { name: s.name, value: null } }), `${s.name} 已删除`), render()) }, '删除') : null,
        ),
      );
    }
  });
  return page;
}

// ================================================================== live events
function connectEvents() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  const conn = $('#conn');
  es.onopen = () => {
    conn.textContent = '已连接本地宿主';
    conn.className = 'sidebar-foot ok';
    scheduleRefresh();
  };
  es.onerror = () => {
    conn.textContent = '与宿主断开，重连中…';
    conn.className = 'sidebar-foot bad';
  };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'log') return onLiveLog(ev.entry);
    if (ev.type === 'tool.progress') {
      const tc = toolCards.get(ev.callId);
      if (tc) tc.progress.textContent = ev.message;
      return;
    }
    if (ev.type === 'plugin.status' && ev.status === 'failed' && ev.lastError) toast(`插件 ${ev.id} 已停止：${ev.lastError.message}`, { error: true });
    scheduleRefresh();
  };
}

// ================================================================== boot
(async function boot() {
  for (const a of document.querySelectorAll('#nav a')) a.addEventListener('click', () => (location.hash = a.dataset.page));
  $('#session-new').addEventListener('click', async () => {
    location.hash = 'chat';
    await createSession();
  });
  if (!TOKEN) return render();
  try {
    await refresh();
  } catch (e) {
    clear($('#main')).append(h('div', { class: 'page' }, h('div', { class: 'empty' }, h('h2', {}, '无法连接宿主'), h('p', {}, e.message))));
    return;
  }
  await refreshSessions();
  if (S.sessionId) {
    try {
      const s = await api(`/api/sessions/${S.sessionId}`);
      S.sessionId = s.id;
      S.transcript = s.transcript;
    } catch {
      S.sessionId = null;
      S.transcript = [];
      localStorage.removeItem('harness-session');
    }
  }
  if (!S.sessionId && S.sessions.length) {
    try {
      const s = await api(`/api/sessions/${S.sessions[0].id}`);
      S.sessionId = s.id;
      S.transcript = s.transcript;
      localStorage.setItem('harness-session', s.id);
    } catch {}
  }
  connectEvents();
  go(location.hash.slice(1) || 'chat');
  api('/api/catalog').then((cat) => {
    for (const c of cat) if (c.installedVersion && c.versions[0] !== c.installedVersion) S.updates[c.id] = c.versions[0];
    $('#nav-updates').textContent = Object.keys(S.updates).length || '';
  }).catch(() => {});
})();
