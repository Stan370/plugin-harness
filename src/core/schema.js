'use strict';
// Tiny JSON-Schema subset validator for tool inputs: type, required,
// properties, enum, minimum/maximum, additionalProperties:false.
// Coerces numeric/boolean strings, which slash commands produce.

function check(schema, value, at, errors) {
  if (!schema) return value;
  const t = schema.type;
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at} 必须是 ${schema.enum.join(' / ')} 之一`);
    return value;
  }
  if (t === 'string') {
    if (typeof value !== 'string') errors.push(`${at} 应为字符串`);
    else if (schema.minLength && value.length < schema.minLength) errors.push(`${at} 不能为空`);
    return value;
  }
  if (t === 'number' || t === 'integer') {
    let v = value;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
    if (typeof v !== 'number' || !Number.isFinite(v) || (t === 'integer' && !Number.isInteger(v))) {
      errors.push(`${at} 应为${t === 'integer' ? '整数' : '数字'}`);
      return value;
    }
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${at} 不能小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${at} 不能大于 ${schema.maximum}`);
    return v;
  }
  if (t === 'boolean') {
    if (value === 'true' || value === 'false') return value === 'true';
    if (typeof value !== 'boolean') errors.push(`${at} 应为 true/false`);
    return value;
  }
  if (t === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${at} 应为数组`);
      return value;
    }
    return value.map((v, i) => check(schema.items, v, `${at}[${i}]`, errors));
  }
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${at} 应为对象`);
      return value;
    }
    const out = { ...value };
    for (const r of schema.required || []) {
      if (out[r] === undefined || out[r] === null || out[r] === '') errors.push(`缺少必填参数 ${at === '$' ? r : `${at}.${r}`}`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (out[k] !== undefined) out[k] = check(sub, out[k], at === '$' ? k : `${at}.${k}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(out)) if (!(schema.properties || {})[k]) errors.push(`未知参数 ${k}`);
    }
    return out;
  }
  return value;
}

function validate(schema, value) {
  const errors = [];
  const coerced = check(schema || { type: 'object' }, value === undefined ? {} : value, '$', errors);
  return { ok: errors.length === 0, errors, value: coerced };
}

module.exports = { validate };
