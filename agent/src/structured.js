// Structured output helpers (P1-10): NDJSON event stream + a mini JSON Schema
// validator (type/object/properties/required/items/enum/string length) used
// to constrain and check the final answer in -p mode.
export function writeEvent(out, obj) {
  out.write(`${JSON.stringify(obj)}\n`);
}

// --- mini JSON Schema validator ----------------------------------------------

export function validateSchema(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return { ok: true, errors };
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      errors.push(`${path}: 必须是 ${JSON.stringify(schema.enum)} 之一`);
    }
    return { ok: errors.length === 0, errors };
  }
  const t = schema.type;
  if (t) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (t === 'integer' ? (!Number.isInteger(value)) : actual !== t) {
      errors.push(`${path}: 类型应为 ${t}，实际是 ${actual}`);
      return { ok: false, errors };
    }
  }
  if (t === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: 长度 ${value.length} < minLength ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: 长度 ${value.length} > maxLength ${schema.maxLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${path}: 不匹配 pattern ${schema.pattern}`);
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (t === 'array' && schema.items) {
    value.forEach((item, i) => validateSchema(schema.items, item, `${path}[${i}]`, errors));
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: 元素数 ${value.length} < minItems ${schema.minItems}`);
  }
  if (t === 'object') {
    for (const req of schema.required || []) {
      if (value[req] === undefined) errors.push(`${path}: 缺必填属性 "${req}"`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (value[k] !== undefined) validateSchema(sub, value[k], `${path}.${k}`, errors);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Extract the first JSON value from model text (fences or bare object/array).
export function extractJson(text) {
  const m = String(text).match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const candidate = (m ? m[1] : text).trim();
  const start = candidate.search(/[{[]/);
  if (start === -1) return { value: null, raw: null };
  const slice = candidate.slice(start);
  // find matching end by brace counting
  let depth = 0; let inStr = false; let esc = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        const raw = slice.slice(0, i + 1);
        try { return { value: JSON.parse(raw), raw }; } catch (e) { return { value: null, raw, error: e.message }; }
      }
    }
  }
  return { value: null, raw: null, error: 'no complete JSON value found' };
}
