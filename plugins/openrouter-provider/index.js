'use strict';
// OpenRouter provider over the OpenAI-compatible Chat Completions API.
// The plugin can't open sockets itself: `fetch` is the host-brokered shim,
// allowed only to openrouter.ai (per the granted `network` permission).

const BASE_URL = 'https://openrouter.ai/api/v1';
let host;

function toWire(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content || '(empty)' });
    } else if (m.raw && m.raw.provider === 'openrouter') {
      // Replay our own assistant message unchanged (keeps reasoning_details valid for tool use).
      out.push(m.raw.message);
    } else {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }));
      }
      out.push(msg);
    }
  }
  return out;
}

function describeHttpError(status, body) {
  let msg = '';
  try {
    msg = JSON.parse(body).error.message;
  } catch {
    msg = String(body).slice(0, 200);
  }
  if (status === 401) return 'OpenRouter API Key 无效或已失效（401）。请重新设置 OPENROUTER_API_KEY。';
  if (status === 402) return `OpenRouter 账户余额不足（402）：${msg}`;
  if (status === 403) return `请求被模型的内容审核拦截（403）：${msg}`;
  if (status === 404) return `模型不存在或不支持工具调用（404）：${msg}。检查插件配置中的「模型」。`;
  if (status === 408) return `请求超时（408）：${msg}`;
  if (status === 429) return `请求过于频繁（429）：${msg}`;
  if (status >= 500) return `模型服务暂时不可用（${status}）：${msg}`;
  return `请求失败（${status}）：${msg}`;
}

function parseArgs(call) {
  try {
    return JSON.parse(call.function.arguments || '{}');
  } catch {
    host.log.warn(`模型返回的工具参数不是合法 JSON：${String(call.function.arguments).slice(0, 200)}`);
    return {};
  }
}

module.exports = {
  activate(h) {
    host = h;
  },
  providers: {
    openrouter: {
      async complete({ system, messages, tools }, { signal }) {
        const key = await host.secrets.get('OPENROUTER_API_KEY');
        if (!key) {
          throw new Error('未配置 OPENROUTER_API_KEY。运行 `harness secrets set OPENROUTER_API_KEY`，或在 Web「设置」页填写。');
        }
        const cfg = host.config;
        const body = {
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          temperature: cfg.temperature,
          messages: toWire(system, messages),
        };
        if (tools.length) {
          body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
        }
        const headers = {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'X-Title': 'Plugin Harness',
        };

        let res;
        for (let attempt = 0; attempt < 2; attempt++) {
          res = await fetch(`${BASE_URL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), timeoutMs: 170000, signal });
          if (res.status !== 429 && res.status < 500) break;
          host.log.warn(`OpenRouter 返回 ${res.status}，${attempt ? '放弃' : '1.5 秒后重试'}`);
          if (!attempt) await new Promise((r) => setTimeout(r, 1500));
        }
        const text = await res.text();
        if (!res.ok) throw new Error(describeHttpError(res.status, text));
        const data = JSON.parse(text);
        if (data.error) throw new Error(`OpenRouter 错误：${data.error.message || JSON.stringify(data.error)}`);
        const choice = data.choices && data.choices[0];
        if (!choice) throw new Error('OpenRouter 返回了空结果');

        const msg = choice.message || {};
        const usage = data.usage && { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
        host.log.debug(`model=${data.model} finish_reason=${choice.finish_reason} usage=${JSON.stringify(usage)}`);
        const said = typeof msg.content === 'string' ? msg.content.trim() : '';
        const raw = { provider: 'openrouter', message: { role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}), ...(msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}) } };

        const calls = (msg.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, input: parseArgs(c) }));
        if (calls.length) return { type: 'tool_calls', calls, text: said, raw, provider: 'openrouter', usage };
        const note = choice.finish_reason === 'length' ? '\n\n（回答因 max_tokens 上限被截断）' : '';
        return { type: 'text', text: said + note, raw, provider: 'openrouter', usage };
      },
    },
  },
};
