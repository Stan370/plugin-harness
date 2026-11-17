'use strict';
// An LLM-free provider. Same contract as a real model provider:
//   complete({ system, messages, tools }) ->
//     { type: 'text', text } | { type: 'tool_calls', calls: [{ id, name, input }], text? }

let host;
let seq = 0;

function match(text, tools) {
  for (const t of tools) {
    for (const p of t.patterns || []) {
      let m;
      try {
        m = new RegExp(p, 'iu').exec(text);
      } catch {
        continue;
      }
      if (!m) continue;
      const input = {};
      for (const [k, v] of Object.entries(m.groups || {})) if (v !== undefined) input[k] = v.trim();
      return { tool: t, input, pattern: p };
    }
  }
  return null;
}

function help(tools) {
  const ex = tools.flatMap((t) => (t.examples || []).map((e) => `- 「${e}」 → ${t.name.replace('__', ' › ')}`));
  if (!ex.length) return '我是离线规则路由器，但当前没有可用的工具。请先在「插件」页启用 workspace-notes 或 weather 等插件。';
  return ['我是离线规则路由器（不调用任何大模型），能理解这些说法：', ...ex, '', '想用自然语言自由对话，可以安装并启用 openrouter-provider。'].join('\n');
}

module.exports = {
  activate(h) {
    host = h;
  },
  providers: {
    rules: {
      async complete({ messages, tools }) {
        const last = messages[messages.length - 1];
        if (!last) return { type: 'text', text: help(tools) };

        if (last.role === 'tool') {
          // Results (and failures) are already rendered as tool cards by the host UI.
          return { type: 'text', text: '', provider: 'rule-router' };
        }

        const text = String(last.content || '').trim();
        if (/^(hi|hello|你好|您好|帮助|help|\?|？)$/i.test(text)) return { type: 'text', text: help(tools), provider: 'rule-router' };
        const m = match(text, tools);
        if (!m) return { type: 'text', text: `没有规则能匹配「${text}」。\n\n${help(tools)}`, provider: 'rule-router' };
        host.log.debug(`"${text}" 匹配 ${m.tool.name} via /${m.pattern}/`);
        return {
          type: 'tool_calls',
          text: host.config.explain ? `匹配到规则，调用 ${m.tool.name.replace('__', ' › ')}` : '',
          calls: [{ id: `rr_${Date.now()}_${++seq}`, name: m.tool.name, input: m.input }],
          provider: 'rule-router',
        };
      },
    },
  },
};
