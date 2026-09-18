/**
 * Stripe Checkout/Portal return URLs are supplied by the client, but Stripe will redirect a paying
 * user to whatever we pass along. Restricting them to trusted origins closes an open-redirect
 * through a legitimate Stripe-hosted page (phishing "your payment succeeded, sign in again here").
 *
 * Allowed: the configured CORS origins, the browser sign-in return origins, the deployment's own
 * public origin, and any loopback http origin (the desktop's ephemeral listener). Everything else,
 * including credentials, fragments, and non-http(s) schemes, is refused.
 */
export function isAllowedBillingReturnUrl(candidate: string, allowedOrigins: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !isLoopback) return false;
  if (isLoopback) return true;
  for (const allowed of allowedOrigins) {
    let allowedUrl: URL;
    try {
      allowedUrl = new URL(allowed);
    } catch {
      continue;
    }
    if (allowedUrl.origin === url.origin) return true;
  }
  return false;
}
