import { afterEach, describe, expect, it, vi } from "vitest";
import { createQualificationScheduler } from "../src/qualification-scheduler.js";

afterEach(() => vi.useRealTimers());

describe("desktop qualification scheduling", () => {
  it("waits for initial provider discovery so all independent lanes can join the first cycle", async () => {
    vi.useFakeTimers();
    let ready = false;
    const run = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const scheduler = createQualificationScheduler(run, 250, () => ready);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("coalesces discovery and retains requests arriving during a running suite", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const run = vi.fn<() => Promise<void>>().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const scheduler = createQualificationScheduler(run);
    scheduler.schedule();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.schedule();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("preserves later discovery after an unsuccessful suite", async () => {
    vi.useFakeTimers();
    const run = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValue(undefined);
    const scheduler = createQualificationScheduler(run);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(250);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("does not start pending qualification after shutdown", async () => {
    vi.useFakeTimers();
    const run = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const scheduler = createQualificationScheduler(run);
    scheduler.schedule();
    scheduler.dispose();
    scheduler.schedule();
    await vi.runAllTimersAsync();
    expect(run).not.toHaveBeenCalled();
  });
});
