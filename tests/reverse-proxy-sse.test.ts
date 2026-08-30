import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CloudDatabase } from "@codeforge/cloud-db";
import { CodeForgeCloudServer } from "codeforge-cloud-api";
import { createGenericFreeRecord } from "@codeforge/forge-zero";
import type { ProviderAdapter, StreamEvent } from "@codeforge/providers";
import { loginToCloud, createMockGitHubFetch } from "./helpers/cloud-login.js";

/**
 * LOCAL REVERSE-PROXY SSE CERTIFICATION.
 *
 * Every real deployment puts an edge in front of the Cloud, and the single most common way hosted
 * streaming breaks is response buffering at that edge: the user waits, sees nothing, then the whole
 * answer lands at once. A test that only streams in-process cannot catch it.
 *
 * So this suite runs the real shape:
 *
 *     test client -> reverse proxy (separate OS process) -> Cloud server -> provider fixture
 *
 * It measures the arrival time of the FIRST event and of the TERMINAL event and requires a genuine
 * gap between them. And it proves the measurement is meaningful by running the same assertions
 * against a deliberately BUFFERING proxy, which must fail them — otherwise the "streaming" evidence
 * would be unfalsifiable.
 *
 * Scope note: this certifies the deployment SHAPE locally. It does not replace certifying the actual
 * remote host's edge, which requires the deployed environment.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PROXY_SCRIPT = resolve(here, "helpers/reverse-proxy.cjs");

/** Emits deltas with real gaps, so buffering is observable rather than theoretical. */
class SlowStreamingProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  aborted = false;
  /** Resolves when the provider observes cancellation. */
  cancellationObserved!: Promise<void>;
  private markCancelled!: () => void;

  constructor(providerId: string, private readonly delayMs = 120, private readonly chunkCount = 5) {
    this.providerId = providerId;
    this.cancellationObserved = new Promise<void>((r) => (this.markCancelled = r));
  }

  async *streamChat(_req: unknown, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    // The observer lives in `finally` on purpose. When the consumer abandons the stream, `for await`
    // calls `.return()` on this generator, which resumes it at the suspended `yield` and runs only
    // its finally blocks — any check at the top of the loop would never execute.
    try {
      for (let i = 0; i < this.chunkCount; i++) {
        if (signal?.aborted) return;
        yield { type: "text_delta", delta: `chunk${i} ` };
        await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (signal?.aborted) return;
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 20 } };
      yield { type: "finish", finishReason: "stop" };
    } finally {
      if (signal?.aborted) {
        this.aborted = true;
        this.markCancelled();
      }
    }
  }
  async healthCheck() {
    return { status: "available" as const };
  }
  async listModels() {
    return [];
  }
  async chat() {
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 10, outputTokens: 20 } };
  }
}

interface ProxyHandle {
  url: string;
  stop: () => Promise<void>;
}

async function startProxy(targetUrl: string, mode: "streaming" | "buffering"): Promise<ProxyHandle> {
  const child: ChildProcess = spawn(process.execPath, [PROXY_SCRIPT, "--target", targetUrl, "--mode", mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("reverse proxy did not start in time")), 15000);
    let buffered = "";
    child.stdout!.on("data", (chunk) => {
      buffered += String(chunk);
      const match = buffered.match(/LISTENING (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`reverse proxy exited early with code ${code}`));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolveStop) => {
        child.once("exit", () => resolveStop());
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
          resolveStop();
        }, 3000);
      }),
  };
}

interface StreamTiming {
  requestAtMs: number;
  firstEventAtMs: number;
  terminalEventAtMs: number;
  eventCount: number;
  sawTerminal: boolean;
  raw: string;
}

/** Consume an SSE response, timestamping the first and terminal events as they actually arrive. */
async function measureStream(res: Response, requestAtMs: number): Promise<StreamTiming> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let firstEventAtMs = -1;
  let terminalEventAtMs = -1;
  let eventCount = 0;
  let sawTerminal = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    const text = decoder.decode(value, { stream: true });
    raw += text;

    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      eventCount++;
      if (firstEventAtMs === -1) firstEventAtMs = now;
      if (line.includes("turn.completed") || line.includes("turn.failed")) {
        terminalEventAtMs = now;
        sawTerminal = true;
      }
    }
  }

  return { requestAtMs, firstEventAtMs, terminalEventAtMs, eventCount, sawTerminal, raw };
}

describe("Local reverse-proxy SSE certification", () => {
  let server: CodeForgeCloudServer;
  let cloudUrl: string;
  let accessToken: string;
  let provider: SlowStreamingProvider;

  beforeAll(async () => {
    const model = createGenericFreeRecord({ providerId: "sse-cert", modelId: "sse-stream" });
    provider = new SlowStreamingProvider("sse-cert", 120, 5);

    server = new CodeForgeCloudServer({
      db: new CloudDatabase({ dbPath: ":memory:" }),
      jwtSecret: "reverse-proxy-sse-cert-jwt-secret-32-chars",
      fetchFn: createMockGitHubFetch({ id: 515151, login: "sse_user", name: "SSE User" }),
      // Generous per-request timeout: the point is streaming, not timeout behavior.
      requestTimeoutMs: 30_000,
    });
    server.firewallManager.registerModel(model);
    server.firewallManager.registerProvider(provider);

    const port = await server.start(0);
    cloudUrl = `http://127.0.0.1:${port}`;
    accessToken = (await loginToCloud(cloudUrl)).accessToken;
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  function inferenceRequest(baseUrl: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${baseUrl}/v1/hosted/inference`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), messages: [{ role: "user", content: "stream please" }], modelId: "auto" }),
      signal,
    });
  }

  it("streams progressively through a real out-of-process reverse proxy", async () => {
    const proxy = await startProxy(cloudUrl, "streaming");
    try {
      const requestAt = Date.now();
      const res = await inferenceRequest(proxy.url);

      expect(res.status).toBe(200);
      // Headers survive the proxy hop — including the anti-buffering hint edges look for.
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("x-accel-buffering")).toBe("no");
      expect(res.headers.get("cache-control")).toContain("no-cache");

      const timing = await measureStream(res, requestAt);

      expect(timing.sawTerminal).toBe(true);
      expect(timing.raw).toContain("assistant.message.started");
      expect(timing.raw).toContain("turn.completed");
      expect(timing.eventCount).toBeGreaterThan(2);

      // THE certification assertion: the first event genuinely precedes the terminal event.
      expect(timing.firstEventAtMs).toBeGreaterThan(0);
      expect(timing.firstEventAtMs).toBeLessThan(timing.terminalEventAtMs);

      // And the gap reflects the provider's real emission cadence (5 chunks x 120ms), which a single
      // buffered payload could not produce.
      const spreadMs = timing.terminalEventAtMs - timing.firstEventAtMs;
      expect(spreadMs).toBeGreaterThanOrEqual(200);

      // The first event arrived well before the response finished — no head-of-line buffering.
      expect(timing.firstEventAtMs - timing.requestAtMs).toBeLessThan(timing.terminalEventAtMs - timing.requestAtMs);
    } finally {
      await proxy.stop();
    }
  }, 60_000);

  it("NEGATIVE CONTROL: a buffering proxy fails the same progressive-streaming assertion", async () => {
    // If this test ever passes the streaming assertions, the certification above proves nothing.
    const proxy = await startProxy(cloudUrl, "buffering");
    try {
      const requestAt = Date.now();
      const res = await inferenceRequest(proxy.url);
      const timing = await measureStream(res, requestAt);

      // The content is all there — buffering is not a content bug, it is a timing bug.
      expect(timing.raw).toContain("turn.completed");

      // Everything landed in one shot: first and terminal events are effectively simultaneous.
      const spreadMs = timing.terminalEventAtMs - timing.firstEventAtMs;
      expect(spreadMs).toBeLessThan(200);
    } finally {
      await proxy.stop();
    }
  }, 60_000);

  it("propagates client cancellation through the proxy to the origin", async () => {
    const cancelProvider = new SlowStreamingProvider("sse-cancel", 150, 40);
    server.firewallManager.registerModel(createGenericFreeRecord({ providerId: "sse-cancel", modelId: "sse-cancel-model" }));
    server.firewallManager.registerProvider(cancelProvider);

    const proxy = await startProxy(cloudUrl, "streaming");
    try {
      const controller = new AbortController();
      const res = await fetch(`${proxy.url}/v1/hosted/inference`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: randomUUID(),
          messages: [{ role: "user", content: "long stream" }],
          providerId: "sse-cancel",
          modelId: "sse-cancel-model",
        }),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      await reader.read(); // confirm the stream is genuinely flowing
      controller.abort();
      await reader.cancel().catch(() => {});

      // The origin observes the disconnect rather than continuing to burn provider capacity.
      await expect(
        Promise.race([
          cancelProvider.cancellationObserved,
          new Promise((_, reject) => setTimeout(() => reject(new Error("cancellation did not reach the origin")), 10_000)),
        ]),
      ).resolves.toBeUndefined();
      expect(cancelProvider.aborted).toBe(true);
    } finally {
      await proxy.stop();
    }
  }, 60_000);

  it("surfaces an upstream disconnect as a clean gateway error, not a hang", async () => {
    // A proxy pointed at a dead origin: the edge must answer, not stall the client forever.
    const deadProxy = await startProxy("http://127.0.0.1:1", "streaming");
    try {
      const started = Date.now();
      const res = await fetch(`${deadProxy.url}/health/live`);
      expect(res.status).toBe(502);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await deadProxy.stop();
    }
  }, 60_000);

  it("emits a terminal failure event through the proxy when the origin times out the inference", async () => {
    // A separate Cloud whose inference timeout is short, so the timeout path is deterministic.
    const slowProvider = new SlowStreamingProvider("sse-timeout", 400, 50);
    const timeoutServer = new CodeForgeCloudServer({
      db: new CloudDatabase({ dbPath: ":memory:" }),
      jwtSecret: "reverse-proxy-timeout-jwt-secret-32-chars!",
      fetchFn: createMockGitHubFetch({ id: 424243, login: "timeout_user", name: "Timeout User" }),
      requestTimeoutMs: 600,
    });
    timeoutServer.firewallManager.registerModel(createGenericFreeRecord({ providerId: "sse-timeout", modelId: "sse-timeout-model" }));
    timeoutServer.firewallManager.registerProvider(slowProvider);
    const timeoutPort = await timeoutServer.start(0);
    const timeoutCloudUrl = `http://127.0.0.1:${timeoutPort}`;
    const timeoutToken = (await loginToCloud(timeoutCloudUrl)).accessToken;

    const proxy = await startProxy(timeoutCloudUrl, "streaming");
    try {
      const requestAt = Date.now();
      const res = await fetch(`${proxy.url}/v1/hosted/inference`, {
        method: "POST",
        headers: { Authorization: `Bearer ${timeoutToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: randomUUID(),
          messages: [{ role: "user", content: "will time out" }],
          providerId: "sse-timeout",
          modelId: "sse-timeout-model",
        }),
      });
      const timing = await measureStream(res, requestAt);

      expect(timing.sawTerminal).toBe(true);
      expect(timing.raw).toContain("turn.failed");
      expect(timing.raw).toMatch(/timed out|abort/i);
      // Partial output still reached the client before the timeout fired — genuinely streaming.
      expect(timing.firstEventAtMs).toBeLessThan(timing.terminalEventAtMs);
    } finally {
      await proxy.stop();
      await timeoutServer.stop();
    }
  }, 60_000);
});
