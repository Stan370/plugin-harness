'use strict';

let host;

function openAiWire(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content || '(empty)' });
    } else if (m.raw && ['openai', 'deepseek'].includes(m.raw.provider)) {
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

function anthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (m.raw && m.raw.provider === 'anthropic') out.push(m.raw.message);
      else {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} });
        if (content.length) out.push({ role: 'assistant', content });
      }
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content || '(empty)', is_error: Boolean(r.isError) })),
      });
    }
  }
  return out;
}

function geminiContents(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.content || '(empty)' } } })),
      });
    } else if (m.role === 'assistant') {
      if (m.raw && m.raw.provider === 'gemini') out.push(m.raw.message);
      else {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.input || {} } });
        if (parts.length) out.push({ role: 'model', parts });
      }
    } else if (m.role === 'user') out.push({ role: 'user', parts: [{ text: m.content }] });
  }
  return out;
}

function toolDefs(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

function parseHttpError(status, body, provider) {
  let msg = body;
  try {
    const parsed = JSON.parse(body);
    msg = parsed.error?.message || parsed.message || parsed.error || body;
  } catch {}
  if (status === 401 || status === 403) return `${provider} API Key 无效、无权限或已失效（${status}）：${msg}`;
  if (status === 429) return `${provider} 请求过于频繁（429）：${msg}`;
  if (status >= 500) return `${provider} 服务暂时不可用（${status}）：${msg}`;
  return `${provider} 请求失败（${status}）：${msg}`;
}

async function openAiCompatible({ secretName, baseUrl, provider, model, system, messages, tools, signal }) {
  const key = await host.secrets.get(secretName);
  if (!key) throw new Error(`未配置 ${secretName}。运行 \`harness secrets set ${secretName}\`，或在 Web「设置」页填写。`);
  const cfg = host.config;
  const body = { model, max_tokens: cfg.maxTokens, temperature: cfg.temperature, messages: openAiWire(system, messages) };
  if (tools.length) body.tools = toolDefs(tools);
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), timeoutMs: 170000, signal });
    if (res.status !== 429 && res.status < 500) break;
    if (!attempt) await new Promise((r) => setTimeout(r, 1500));
  }
  const text = await res.text();
  if (!res.ok) throw new Error(parseHttpError(res.status, text, provider));
  const data = JSON.parse(text);
  const choice = data.choices?.[0];
  if (!choice) throw new Error(`${provider} 返回了空结果`);
  const msg = choice.message || {};
  const usage = data.usage && { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
  const said = typeof msg.content === 'string' ? msg.content.trim() : '';
  const raw = { provider, message: { role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) } };
  const calls = (msg.tool_calls || []).map((c) => {
    try { return { id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || '{}') }; }
    catch { host.log.warn(`模型返回的工具参数不是合法 JSON：${String(c.function.arguments).slice(0, 200)}`); return { id: c.id, name: c.function.name, input: {} }; }
  });
  if (calls.length) return { type: 'tool_calls', calls, text: said, raw, provider, usage };
  return { type: 'text', text: said, raw, provider, usage };
}

async function completeAnthropic({ system, messages, tools }, { signal } = {}) {
  const key = await host.secrets.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('未配置 ANTHROPIC_API_KEY。运行 `harness secrets set ANTHROPIC_API_KEY`，或在 Web「设置」页填写。');
  const cfg = host.config;
  const body = {
    model: cfg.anthropicModel,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    system,
    messages: anthropicMessages(messages),
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    timeoutMs: 170000,
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(parseHttpError(res.status, text, 'Anthropic'));
  const data = JSON.parse(text);
  const rawContent = data.content || [];
  const said = rawContent.filter((x) => x.type === 'text').map((x) => x.text).join('').trim();
  const calls = rawContent.filter((x) => x.type === 'tool_use').map((x) => ({ id: x.id, name: x.name, input: x.input || {} }));
  const raw = { provider: 'anthropic', message: { role: 'assistant', content: rawContent } };
  const usage = data.usage && { input: data.usage.input_tokens, output: data.usage.output_tokens };
  if (calls.length) return { type: 'tool_calls', calls, text: said, raw, provider: 'anthropic', usage };
  return { type: 'text', text: said, raw, provider: 'anthropic', usage };
}

async function completeGemini({ system, messages, tools }, { signal } = {}) {
  const key = await host.secrets.get('GEMINI_API_KEY');
  if (!key) throw new Error('未配置 GEMINI_API_KEY。运行 `harness secrets set GEMINI_API_KEY`，或在 Web「设置」页填写。');
  const cfg = host.config;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: geminiContents(messages),
    generationConfig: { maxOutputTokens: cfg.maxTokens, temperature: cfg.temperature },
  };
  if (tools.length) body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), timeoutMs: 170000, signal });
  const text = await res.text();
  if (!res.ok) throw new Error(parseHttpError(res.status, text, 'Google Gemini'));
  const data = JSON.parse(text);
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('Google Gemini 返回了空结果');
  const parts = candidate.content?.parts || [];
  const said = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('').trim();
  const calls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: `gemini_${Date.now()}_${i}`, name: p.functionCall.name, input: p.functionCall.args || {} }));
  const raw = { provider: 'gemini', message: { role: 'model', parts } };
  const usage = data.usageMetadata && { input: data.usageMetadata.promptTokenCount, output: data.usageMetadata.candidatesTokenCount };
  if (calls.length) return { type: 'tool_calls', calls, text: said, raw, provider: 'gemini', usage };
  return { type: 'text', text: said, raw, provider: 'gemini', usage };
}

module.exports = {
  activate(h) { host = h; },
  providers: {
    openai: {
      complete: (request, ctx) => openAiCompatible({ secretName: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', provider: 'openai', model: host.config.openaiModel, ...request, signal: ctx && ctx.signal }),
    },
    anthropic: { complete: completeAnthropic },
    gemini: { complete: completeGemini },
    deepseek: {
      complete: (request, ctx) => openAiCompatible({ secretName: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', provider: 'deepseek', model: host.config.deepseekModel, ...request, signal: ctx && ctx.signal }),
    },
  },
};
