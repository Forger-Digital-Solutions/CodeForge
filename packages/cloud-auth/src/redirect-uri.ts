/**
 * CodeForge Cloud authenticates native desktop clients through a loopback listener. Keeping the
 * callback shape fixed prevents the API from becoming an arbitrary OAuth redirector while still
 * allowing Electron to choose an ephemeral local port.
 */
export function normalizeDesktopLoopbackRedirectUri(redirectUri: string): string {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error("OAuth redirect URI must be a valid CodeForge desktop loopback URL");
  }

  const port = Number(url.port);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !validPort ||
    url.pathname !== "/auth/callback" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("OAuth redirect URI must be http://127.0.0.1:<port>/auth/callback");
  }

  return url.toString();
}
