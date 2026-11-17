'use strict';
// Pure hook plugin: it contributes no tools and needs no permissions.
// It only transforms data flowing through the host.

const RULES = [
  { key: 'redactApiKeys', label: 'API Key', re: /\b(sk-[a-zA-Z0-9_-]{16,}|sk-or-v1-[a-f0-9]{32,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, mask: '[已脱敏:API_KEY]' },
  { key: 'redactEmail', label: '邮箱', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, mask: '[已脱敏:邮箱]' },
  { key: 'redactIdCard', label: '身份证号', re: /(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, mask: '[已脱敏:身份证]' },
  { key: 'redactPhone', label: '手机号', re: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, mask: '[已脱敏:手机号]' },
];

let host;

function redact(text) {
  if (typeof text !== 'string' || !text) return { text, counts: {} };
  const counts = {};
  let out = text;
  for (const r of RULES) {
    if (host.config[r.key] === false) continue;
    out = out.replace(r.re, () => {
      counts[r.label] = (counts[r.label] || 0) + 1;
      return r.mask;
    });
  }
  return { text: out, counts };
}

function deepRedact(v) {
  if (typeof v === 'string') return redact(v).text;
  if (Array.isArray(v)) return v.map(deepRedact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRedact(x)]));
  return v;
}

const summary = (counts) => Object.entries(counts).map(([k, n]) => `${k}×${n}`).join('、');

module.exports = {
  activate(h) {
    host = h;
  },

  hooks: {
    'chat.userMessage'({ text }) {
      const r = redact(text);
      if (!Object.keys(r.counts).length) return {};
      return { payload: { text: r.text }, note: `发送给模型前已脱敏：${summary(r.counts)}` };
    },

    'tool.beforeCall'({ tool, input }) {
      if (!host.config.blockSecretWrites) return {};
      const blob = JSON.stringify(input || {});
      const hasKey = RULES[0].re.test(blob);
      RULES[0].re.lastIndex = 0;
      if (hasKey && /write|save|create|upload|send|post/i.test(tool)) {
        return { block: true, reason: `检测到工具 ${tool} 的参数中包含疑似 API Key，已阻止写出` };
      }
      return {};
    },

    'tool.afterCall'({ result }) {
      const r = redact(result && result.content);
      if (!Object.keys(r.counts).length) return {};
      // Structured data is shown in the UI, so redact it the same way.
      const data = result.data === undefined ? undefined : deepRedact(result.data);
      return { payload: { result: { ...result, content: r.text, data } }, note: `工具结果已脱敏：${summary(r.counts)}` };
    },
  },
};
