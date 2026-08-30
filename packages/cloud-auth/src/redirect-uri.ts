/**
 * CodeForge Cloud has THREE distinct callback concepts. They are deliberately named apart here
 * because conflating them is the classic way a native-app OAuth deployment becomes an open redirector
 * — or simply fails to work against a real authorization server.
 *
 *   A. GitHub authorization-server callback — the single, fixed, public HTTPS URL registered in the
 *      GitHub OAuth App ("Authorization callback URL"). Built by {@link buildCloudGitHubCallbackUrl}.
 *      GitHub matches `redirect_uri` against this registration by scheme + host + PORT, which is
 *      precisely why an ephemeral desktop loopback port can never be the registered callback.
 *
 *   B. CodeForge Cloud OAuth callback endpoint — the server route that receives (A). It validates
 *      state, performs the confidential-client token exchange with the server-held client secret, and
 *      mints a single-use desktop authorization code.
 *
 *   C. Desktop loopback completion callback — `http://127.0.0.1:<ephemeral port>/auth/callback`, the
 *      listener the Electron app opens for one login attempt. This is NOT registered with GitHub and
 *      is never sent to GitHub; the Cloud redirects to it only after validating it against the policy
 *      in {@link normalizeDesktopLoopbackRedirectUri}.
 */

/** The Cloud route that GitHub redirects back to. Registered verbatim in the GitHub OAuth App. */
export const CLOUD_GITHUB_CALLBACK_PATH = "/v1/auth/github/callback";

/** The only path a desktop loopback listener may expose for OAuth completion. */
export const DESKTOP_LOOPBACK_CALLBACK_PATH = "/auth/callback";

/**
 * Lowest port a desktop loopback listener may bind. Privileged ports (< 1024) require elevation on
 * every supported platform, so a redirect target inside that range is never a genuine CodeForge
 * desktop listener — it is either a mistake or an attempt to aim the browser at a system service.
 */
export const MIN_DESKTOP_LOOPBACK_PORT = 1024;
export const MAX_DESKTOP_LOOPBACK_PORT = 65535;

/**
 * True when the string contains any C0 control character or DEL. Written as an explicit scan rather
 * than a regex literal so the check itself never embeds unprintable bytes in this source file.
 */
function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate and canonicalize a desktop loopback redirect target (concept C).
 *
 * Everything about the URL is pinned except the port: scheme `http`, host literal `127.0.0.1`, path
 * exactly `/auth/callback`, no credentials, no query, no fragment. Only the port varies, because the
 * desktop binds an ephemeral port per login attempt.
 *
 * `localhost` is refused on purpose: it is a DNS name, and resolving it is outside this process's
 * control (hosts-file entries, split-horizon DNS, IPv6-first resolution). `127.0.0.1` is an address
 * literal and cannot be redirected by name resolution. `[::1]` is refused for the same class of
 * reason — the desktop listener binds IPv4 loopback, so accepting an IPv6 target would authorize a
 * destination CodeForge never listens on.
 *
 * @throws if the URI is anything other than a canonical CodeForge desktop loopback callback.
 */
export function normalizeDesktopLoopbackRedirectUri(redirectUri: string): string {
  if (typeof redirectUri !== "string" || redirectUri.length === 0 || redirectUri.length > 2048) {
    throw new Error("OAuth redirect URI must be a valid CodeForge desktop loopback URL");
  }

  // Reject control characters (CR/LF/NUL and friends) before parsing. WHATWG URL silently strips
  // some of these, which is exactly how a header/redirect-splitting payload sneaks past a later check.
  if (containsControlCharacter(redirectUri)) {
    throw new Error("OAuth redirect URI must not contain control characters");
  }

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error("OAuth redirect URI must be a valid CodeForge desktop loopback URL");
  }

  const port = Number(url.port);
  const validPort = Number.isInteger(port) && port >= MIN_DESKTOP_LOOPBACK_PORT && port <= MAX_DESKTOP_LOOPBACK_PORT;

  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !validPort ||
    url.pathname !== DESKTOP_LOOPBACK_CALLBACK_PATH ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `OAuth redirect URI must be http://127.0.0.1:<port>${DESKTOP_LOOPBACK_CALLBACK_PATH} with a non-privileged port (${MIN_DESKTOP_LOOPBACK_PORT}-${MAX_DESKTOP_LOOPBACK_PORT})`,
    );
  }

  // Re-serialize from the parsed URL so the stored/compared value is canonical: any two spellings of
  // the same target normalize to one string, and nothing from the raw input survives verbatim.
  return `http://127.0.0.1:${port}${DESKTOP_LOOPBACK_CALLBACK_PATH}`;
}

/**
 * Build the Cloud's public GitHub callback URL (concept A/B) from the deployment's public base URL.
 *
 * This is the value that must be registered in the GitHub OAuth App and the only `redirect_uri` ever
 * sent to GitHub. Because it is derived from server configuration and never from request input, a
 * client cannot influence where GitHub redirects.
 *
 * @param publicUrl the deployment's public base URL (e.g. `https://cloud.example.com`)
 * @param opts.requireHttps enforce HTTPS — true for staging/production, relaxed only for loopback dev
 */
export function buildCloudGitHubCallbackUrl(publicUrl: string, opts: { requireHttps?: boolean } = {}): string {
  const requireHttps = opts.requireHttps ?? true;

  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error("CODEFORGE_PUBLIC_URL must be an absolute URL (e.g. https://cloud.example.com)");
  }

  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !requireHttps && isLoopback)) {
    throw new Error("CODEFORGE_PUBLIC_URL must use HTTPS (plain http is permitted only for loopback development)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CODEFORGE_PUBLIC_URL must not contain credentials, a query string, or a fragment");
  }

  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  return `${base}${CLOUD_GITHUB_CALLBACK_PATH}`;
}
