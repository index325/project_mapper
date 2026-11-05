const REDACTED = "[REDACTED]";

/** Formats that are unambiguous wherever they appear. */
const HIGH_CONFIDENCE: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+):([^\s/@'"]+)@/gi;

/**
 * Only applied to configuration files: in source code, `password: string` is a type declaration
 * and hiding it would make the analysis worse without protecting anything.
 */
const CONFIG_ASSIGNMENT =
  /((?:[\w.-]*)(?:password|passwd|pwd|secret|api[_-]?key|apikey|token|access[_-]?key|private[_-]?key|credential)[\w.-]*["']?[ \t]*[:=][ \t]*["']?)([^\s"',;#]+)/gi;

const CONFIG_FILE = /\.(ya?ml|properties|ini|toml|conf|cfg|env|json|xml|tf|tfvars)$|(^|\/)\.env[^/]*$/i;

function isPlaceholder(value: string): boolean {
  return /^(\$\{|\{\{|<|%|\[REDACTED\]|true$|false$|null$|changeme$)/i.test(value);
}

export interface RedactionResult {
  text: string;
  count: number;
}

export function redact(text: string, path?: string): RedactionResult {
  let count = 0;
  let result = text;

  for (const pattern of HIGH_CONFIDENCE) {
    result = result.replace(pattern, () => {
      count += 1;
      return REDACTED;
    });
  }

  result = result.replace(URL_CREDENTIALS, (_match, prefix: string, password: string) => {
    if (isPlaceholder(password)) return _match;
    count += 1;
    return `${prefix}:${REDACTED}@`;
  });

  if (path && CONFIG_FILE.test(path)) {
    result = result.replace(CONFIG_ASSIGNMENT, (match, key: string, value: string) => {
      if (isPlaceholder(value)) return match;
      count += 1;
      return `${key}${REDACTED}`;
    });
  }

  return { text: result, count };
}
