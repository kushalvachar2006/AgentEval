// Server-side sanitation of untrusted trace/config payloads:
//  1. redact secrets (by key name and by value pattern)
//  2. truncate huge strings (protects MongoDB's 16 MB document limit)
//  3. rewrite keys MongoDB or operators could misinterpret ("$gt", "a.b", "__proto__")
const SENSITIVE_KEYS = new Set(['password', 'passwd', 'secret', 'token', 'apikey', 'authorization', 'cookie', 'setcookie', 'privatekey',
  'credential', 'credentials', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'bearertoken', 'sessiontoken', 'clientsecret',
  'secretkey', 'xapikey', 'openaiapikey', 'anthropicapikey']);
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
export const isSensitiveKey = (k) => { const n = normKey(k); return SENSITIVE_KEYS.has(n) || /(password|secret|apikey|privatekey)$/.test(n); };

const VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,                 // OpenAI / Anthropic style
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,                    // AWS access key id
  /\bghp_[A-Za-z0-9]{30,}/g,                  // GitHub token
  /\bAIza[0-9A-Za-z_-]{30,}/g,                // Google API key
  /\bae_live_[A-Za-z0-9_-]{20,}/g,            // AgentEval keys
  /\bae_(?:rt|inv|rst)_[A-Za-z0-9_-]{20,}/g,   // AgentEval refresh / invitation / reset tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

// Deliberately conservative: only explicit label=value / label: value forms with a value of 4+ characters.
const ASSIGNMENT = /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)(\s*[=:]\s*)["']?[^\s"',;)}\]]{4,}["']?/gi;

const safeKey = (k) => {
  if (k === '') return '_empty';
  if (k === '__proto__') return '_proto_';
  return k.replace(/\./g, '\uff0e').replace(/^\$/, '\uff04');
};

export function sanitize(value, { maxStringLen = 32768, maxDepth = 32 } = {}) {
  const stats = { redactions: 0, truncated: 0, keysRewritten: 0 };
  const cleanString = (v) => {
    let s = v;
    for (const p of VALUE_PATTERNS) s = s.replace(p, () => { stats.redactions++; return '[REDACTED]'; });
    // "password=hunter2", "api_key: abc123" written inside free text: keep the label, drop the value
    s = s.replace(ASSIGNMENT, (_m, label, sep) => { stats.redactions++; return `${label}${sep}[REDACTED]`; });
    if (s.length > maxStringLen) { stats.truncated++; s = `${s.slice(0, maxStringLen)}…[truncated ${s.length - maxStringLen} chars]`; }
    return s;
  };
  const walk = (v, depth) => {
    if (typeof v === 'string') return cleanString(v);
    if (v === null || typeof v !== 'object') return v;
    if (depth >= maxDepth) { stats.truncated++; return '[DEPTH_LIMIT]'; }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const nk = safeKey(k);
      if (nk !== k) stats.keysRewritten++;
      if (isSensitiveKey(k)) { stats.redactions++; out[nk] = '[REDACTED]'; } else out[nk] = walk(val, depth + 1);
    }
    return out;
  };
  return { value: walk(value, 0), ...stats };
}
