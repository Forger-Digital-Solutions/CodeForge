export interface SecretMatch {
  path: string;
  line: number;
  type: string;
}

const SECRET_PATTERNS: Array<{ re: RegExp; type: string }> = [
  { re: /OPENCODE_API_KEY\s*[:=]\s*['"]?[^'"\s]+/gi, type: "opencode_key" },
  { re: /OPENROUTER_API_KEY\s*[:=]\s*['"]?[^'"\s]+/gi, type: "openrouter_key" },
  { re: /ANTHROPIC_API_KEY\s*[:=]\s*['"]?[^'"\s]+/gi, type: "anthropic_key" },
  { re: /GROQ_API_KEY\s*[:=]\s*['"]?[^'"\s]+/gi, type: "groq_key_env" },
  { re: /Bearer\s+[A-Za-z0-9._\-]+/g, type: "bearer" },
  { re: /sk-[A-Za-z0-9\-_]{10,}/g, type: "sk_key" },
  { re: /sk-proj-[A-Za-z0-9\-_]{10,}/g, type: "openai_proj" },
  { re: /gsk_[A-Za-z0-9]{10,}/g, type: "groq_key" },
  { re: /AIza[0-9A-Za-z\-_]{20,}/g, type: "google_key" },
  { re: /gh[pousr]_[A-Za-z0-9_]{20,}/g, type: "github_pat" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, type: "github_fine_grained" },
  { re: /AKIA[0-9A-Z]{16}/g, type: "aws_access_key" },
  { re: /aws_secret_access_key\s*[:=]\s*['"]?[^'"\s]+/gi, type: "aws_secret" },
  { re: /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/g, type: "private_key" },
  { re: /password\s*[:=]\s*['"]?[^'"\s]+/gi, type: "password" },
  { re: /mongodb(\+srv)?:\/\/[^\s]+/gi, type: "mongodb_uri" },
  { re: /postgres(?:ql)?:\/\/[^\s]+/gi, type: "postgres_uri" },
];

export class SecretScanner {
  scan(text: string): SecretMatch[] {
    const matches: SecretMatch[] = [];
    for (const { re, type } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const before = text.slice(0, m.index);
        const line = before.split("\n").length;
        matches.push({ path: "", line, type });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    return matches;
  }
  redact(text: string): string {
    let out = text;
    for (const { re } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      out = out.replace(re, "[REDACTED]");
    }
    return out;
  }
}

export function redactSecrets(text: string): string {
  return new SecretScanner().redact(text);
}

export function containsSecret(text: string): boolean {
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}
