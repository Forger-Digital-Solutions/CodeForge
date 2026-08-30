import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real, local, OpenAI-compatible provider endpoint used as a deterministic transport in
 * certification tests.
 *
 * It is a genuine HTTP server speaking the real Chat Completions SSE wire format over a real socket
 * — not an in-process stub — so an adapter under test performs an actual network round trip and its
 * streaming, header, and credential behavior is exercised for real. It costs nothing and never
 * reaches the internet, which is exactly what makes it usable as $0 certification capacity.
 */
export interface FixtureProviderServer {
  url: string;
  port: number;
  /** Every request the fixture received, in order. Used to assert credential and payload behavior. */
  requests: Array<{ path: string; authorization?: string; body: unknown }>;
  /** Number of chat completions actually executed. The provider-call counter for ordering proofs. */
  invocationCount: () => number;
  close: () => Promise<void>;
}

export interface FixtureProviderOptions {
  /** Text chunks streamed back, in order. */
  chunks?: string[];
  /** Delay between chunks, in ms. A non-zero value is what makes progressive streaming observable. */
  chunkDelayMs?: number;
  /** Delay before the FIRST chunk. */
  firstChunkDelayMs?: number;
  /** Force an HTTP status instead of streaming (fault injection). */
  failWithStatus?: number;
  /** Hang without responding, to exercise client timeouts. */
  hang?: boolean;
  /** Model ids reported by /models. */
  models?: string[];
}

export async function startFixtureProviderServer(options: FixtureProviderOptions = {}): Promise<FixtureProviderServer> {
  const chunks = options.chunks ?? ["Hello", " from", " the", " fixture", " provider."];
  const chunkDelayMs = options.chunkDelayMs ?? 0;
  const firstChunkDelayMs = options.firstChunkDelayMs ?? 0;
  const requests: FixtureProviderServer["requests"] = [];
  let invocations = 0;

  const server = http.createServer(async (req, res) => {
    const chunksOfBody: Buffer[] = [];
    for await (const chunk of req) chunksOfBody.push(chunk as Buffer);
    const raw = Buffer.concat(chunksOfBody).toString("utf8");
    let parsedBody: unknown = undefined;
    try {
      parsedBody = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsedBody = raw;
    }
    requests.push({ path: req.url ?? "/", authorization: req.headers.authorization, body: parsedBody });

    if (options.hang) {
      // Deliberately never respond: the client's own timeout must fire.
      return;
    }

    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: (options.models ?? ["fixture-model"]).map((id) => ({ id })) }));
      return;
    }

    if (options.failWithStatus) {
      res.writeHead(options.failWithStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `fixture provider failure ${options.failWithStatus}` } }));
      return;
    }

    invocations++;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    if (firstChunkDelayMs > 0) await sleep(firstChunkDelayMs);

    for (const [index, text] of chunks.entries()) {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
      if (index < chunks.length - 1 && chunkDelayMs > 0) await sleep(chunkDelayMs);
    }
    if (res.writableEnded) return;
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    server.on("error", reject);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    invocationCount: () => invocations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
