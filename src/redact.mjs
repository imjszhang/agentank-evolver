const SECRET_KEYS = [
  'authorization',
  'agentank_tank_key',
  'tank_key',
  'token',
  'secret',
  'api_key',
  'key',
];

export function redactText(value) {
  let text = String(value ?? '');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/(AGENTANK_TANK_KEY\s*=\s*)[^\s]+/gi, '$1[REDACTED]');
  return text;
}

export function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    out[key] = SECRET_KEYS.some((secretKey) => lower.includes(secretKey))
      ? '[REDACTED]'
      : redact(item);
  }
  return out;
}
