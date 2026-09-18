/**
 * RFC 9116 `security.txt`. Rendered only when a deployment operator has configured a real
 * security contact (CODEFORGE_SECURITY_CONTACT); CodeForge never publishes a placeholder.
 * The policy link points at the repository SECURITY.md, which is the canonical disclosure policy.
 */
export interface SecurityTxtOptions {
  /** `mailto:` address or `https://` URL, already validated by config. */
  contact: string;
  /** Public HTTPS base URL of this deployment; used for the Canonical field. */
  canonicalBase?: string;
  policyUrl?: string;
  /** ISO timestamp after which the file should be considered stale. Defaults to +1 year. */
  expires?: string;
  preferredLanguages?: string;
}

export function buildSecurityTxt(options: SecurityTxtOptions): string {
  const expires = options.expires ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const lines = [
    `Contact: ${options.contact}`,
    `Expires: ${expires}`,
    `Policy: ${options.policyUrl ?? "https://github.com/Forger-Digital-Solutions/CodeForge/blob/master/SECURITY.md"}`,
    `Preferred-Languages: ${options.preferredLanguages ?? "en"}`,
  ];
  if (options.canonicalBase?.startsWith("https://")) {
    lines.push(`Canonical: ${options.canonicalBase.replace(/\/+$/, "")}/.well-known/security.txt`);
  }
  return `${lines.join("\n")}\n`;
}
