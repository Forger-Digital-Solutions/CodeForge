export interface SecretMatch {
  path: string;
  line: number;
  type: string;
}

export class SecretScanner {
  scan(text: string): SecretMatch[] {
    return [];
  }
  redact(text: string): string {
    return text;
  }
}

export function redactSecrets(text: string): string {
  return new SecretScanner().redact(text);
}
