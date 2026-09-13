/**
 * Renderer startup-chain marks.
 *
 * Each mark is recorded once, as `data-cf-lifecycle-<name>="<epoch ms>"` on the document element
 * and as a verbose-level console line (`[codeforge:lifecycle] <name> <epoch ms>`). The attributes
 * let a trusted observer (the packaged certification smoke, DevTools) read the exact chain from the
 * DOM; the console line lets the main process correlate it with its own window events. This is
 * observation only: nothing here reads state from, or grants anything to, the main process.
 */
export type RendererLifecycleMark =
  | "bootstrap"
  | "root-mounted"
  | "first-frame"
  | "workspace-root"
  | "runtime-connected"
  | "workspace-interactive";

const recorded = new Map<RendererLifecycleMark, number>();

export function markRendererLifecycle(name: RendererLifecycleMark): void {
  if (recorded.has(name)) return;
  const at = Date.now();
  recorded.set(name, at);
  try {
    document.documentElement.setAttribute(`data-cf-lifecycle-${name}`, String(at));
  } catch {
    // The attribute is diagnostic only.
  }
  try {
    console.debug(`[codeforge:lifecycle] ${name} ${at}`);
  } catch {
    // Never let diagnostics affect the application.
  }
}

/** The marks recorded so far (epoch milliseconds), for diagnostics surfaces. */
export function rendererLifecycleMarks(): Record<string, number> {
  return Object.fromEntries(recorded);
}

/**
 * The workspace counts as interactive once the runtime endpoint is known, the execution event
 * stream is connected, and the composer exists in the DOM. The composer is rendered by the UI
 * package, so its presence is checked directly rather than threaded through props.
 */
export function markWorkspaceInteractiveWhenReady(): void {
  if (recorded.has("workspace-interactive")) return;
  let attempts = 0;
  const check = () => {
    if (recorded.has("workspace-interactive")) return;
    if (document.querySelector("textarea.composer-input")) {
      markRendererLifecycle("workspace-interactive");
      return;
    }
    if (attempts++ < 600) requestAnimationFrame(check);
  };
  check();
}
