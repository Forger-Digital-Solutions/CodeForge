const LOCAL_CONTROL_PLANE = "http://localhost:3210";

export function installAuthenticatedControlPlaneFetch(): void {
  const token = window.electronAPI?.controlPlaneToken;
  if (!token) return;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = input instanceof Request ? input.url : String(input);
    if (!target.startsWith(`${LOCAL_CONTROL_PLANE}/`)) return nativeFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("X-CodeForge-Control-Token", token);
    return nativeFetch(input, { ...init, headers });
  };
}

export function authenticatedEventStreamUrl(url: string): string {
  const token = window.electronAPI?.controlPlaneToken;
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}controlToken=${encodeURIComponent(token)}`;
}
