// Strict validator for the JSON Schema subset used by lab/schemas. An unsupported keyword throws instead of being
// ignored, so a schema can never silently validate less than it appears to.
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description']);
const KEYWORDS = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'enum',
    'const',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'pattern',
    'items',
    'minItems',
    'maxItems',
]);

const typeOf = value => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (Number.isInteger(value)) return 'integer';
    return typeof value;
};
const matchesType = (value, type) => {
    const actual = typeOf(value);
    return actual === type || (type === 'number' && actual === 'integer');
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function validate(schema, value, path = '$', errors = []) {
    for (const key of Object.keys(schema))
        if (!ANNOTATIONS.has(key) && !KEYWORDS.has(key))
            throw new Error(`Unsupported schema keyword ${key} at ${path}`);
    if (schema.type !== undefined) {
        const types = [schema.type].flat();
        if (!types.some(t => matchesType(value, t))) {
            errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
            return errors;
        }
    }
    if (schema.const !== undefined && !same(schema.const, value))
        errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.some(v => same(v, value))) errors.push(`${path}: must be one of ${schema.enum}`);
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
    }
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
        if (schema.pattern && !new RegExp(schema.pattern).test(value))
            errors.push(`${path}: does not match ${schema.pattern}`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
        if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
    }
    if (typeOf(value) === 'object') {
        for (const key of schema.required ?? [])
            if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
        const properties = schema.properties ?? {};
        for (const [key, child] of Object.entries(value)) {
            if (Object.hasOwn(properties, key)) validate(properties[key], child, `${path}.${key}`, errors);
            else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown field`);
            else if (schema.additionalProperties)
                validate(schema.additionalProperties, child, `${path}.${key}`, errors);
        }
    }
    return errors;
}

export function assertValid(schema, value, label = 'value') {
    const errors = validate(schema, value);
    if (errors.length)
        throw Object.assign(new Error(`Invalid ${label}:\n  ${errors.join('\n  ')}`), { code: 'INVALID', errors });
    return value;
}
