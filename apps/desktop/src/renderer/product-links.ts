/**
 * Public product URLs the desktop opens in the system browser.
 *
 * Every link here must resolve for a real user. The legal documents are still review drafts that
 * must not be published (docs/legal/unresolved-legal-facts.md), and the codeforge.dev domain
 * serves nothing yet, so the privacy/terms entries are deliberately empty: a sign-in screen that
 * links to a connection error is worse than one that shows no link. Set them once the owner
 * publishes the documents; the UI renders the links automatically.
 */
export const PRODUCT_LINKS = {
  privacyPolicy: "",
  termsOfService: "",
  help: "https://github.com/Forger-Digital-Solutions/CodeForge#readme",
} as const;

export function isConfiguredLink(url: string): boolean {
  return /^https:\/\/[^\s]+$/.test(url);
}
