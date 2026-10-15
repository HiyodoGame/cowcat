// Tool registry: name/description/input_schema/execute + JSON-schema-ish validation.
export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool.name || !tool.description || !tool.input_schema || typeof tool.execute !== 'function') {
      throw new Error(`Invalid tool definition: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list() {
    return [...this.tools.values()];
  }

  // Used by /mcp reconnect: drop the adapters bound to a stopped client before
  // re-registering, so no stale mcp__server__tool entry keeps pointing at the
  // dead transport.
  unregister(name) {
    return this.tools.delete(name);
  }

  get(name) {
    return this.tools.get(name);
  }

  // Validate input against a simplified JSON Schema subset (type/required/properties/items/enum).
  validate(name, input) {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    return validateSchema(tool.input_schema, input, name);
  }
}

export function validateSchema(schema, value, path = 'input') {
  if (!schema || Object.keys(schema).length === 0) return { ok: true };
  if (value === undefined || value === null) {
    return schema.type && schema.type !== 'null'
      ? { ok: false, error: `${path} is required (${schema.type})` }
      : { ok: true };
  }
  const t = schema.type;
  if (t === 'string' && typeof value !== 'string') return { ok: false, error: `${path} must be a string` };
  if (t === 'number' && typeof value !== 'number') return { ok: false, error: `${path} must be a number` };
  if (t === 'boolean' && typeof value !== 'boolean') return { ok: false, error: `${path} must be a boolean` };
  if (t === 'array' && !Array.isArray(value)) return { ok: false, error: `${path} must be an array` };
  if (t === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
    return { ok: false, error: `${path} must be an object` };
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return { ok: false, error: `${path} must be one of ${schema.enum.join(', ')}` };
  }
  if (t === 'object') {
    for (const req of schema.required || []) {
      if (value[req] === undefined) return { ok: false, error: `${path}.${req} is required` };
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (value[k] !== undefined) {
        const r = validateSchema(sub, value[k], `${path}.${k}`);
        if (!r.ok) return r;
      }
    }
  }
  if (t === 'array' && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const r = validateSchema(schema.items, value[i], `${path}[${i}]`);
      if (!r.ok) return r;
    }
    if (schema.minItems != null && value.length < schema.minItems) {
      return { ok: false, error: `${path} needs at least ${schema.minItems} items` };
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      return { ok: false, error: `${path} allows at most ${schema.maxItems} items` };
    }
  }
  return { ok: true };
}
