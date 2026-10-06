export interface QualificationScheduler {
  schedule(): void;
  dispose(): void;
}

export function createQualificationScheduler(run: () => Promise<void>, delayMs = 250, ready: () => boolean = () => true): QualificationScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let disposed = false;

  const arm = (): void => {
    if (disposed || running || timer || !pending) return;
    timer = setTimeout(() => { void flush(); }, delayMs);
    timer.unref?.();
  };

  const flush = async (): Promise<void> => {
    timer = undefined;
    if (disposed) return;
    if (!ready()) { arm(); return; }
    pending = false;
    running = true;
    try {
      await run();
    } catch {
      // Discovery remains usable after a failed probe; eligibility still requires a receipt.
    } finally {
      running = false;
      arm();
    }
  };

  return {
    schedule(): void { if (!disposed) { pending = true; arm(); } },
    dispose(): void { disposed = true; pending = false; if (timer) clearTimeout(timer); timer = undefined; },
  };
}
