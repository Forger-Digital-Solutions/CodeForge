import { CodeForgeServer } from "@codeforge/server";
import http from "node:http";
import { Agent } from "node:https";

/**
 * Start a CodeForge server on an ephemeral port (0) to get a random available port.
 * Returns the server instance and the actual port it's listening on.
 */
export async function startTestServer(): Promise<{ server: CodeForgeServer; port: number }> {
  const server = new CodeForgeServer({ port: 0 });
  await server.start();
  const port = server.httpPort;
  return { server, port };
}

/**
 * Wait for the server to be ready by polling the /api/sessions endpoint.
 * Throws if the server doesn't become ready within the timeout.
 */
export async function waitForServerReady(port: number, timeoutMs: number = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/api/sessions`);
      if (response.ok) {
        return;
      }
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

/**
 * Send a POST request to the CodeForge server.
 */
export async function sendRequest(
  port: number,
  path: string,
  data?: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = `http://localhost:${port}${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  if (data !== undefined) {
    init.body = JSON.stringify(data);
  }
  const response = await fetch(url, init);
  
  // Always try to read the body
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // If JSON parsing fails, try to read as text
    try {
      const text = await response.text();
      body = {raw: text};
    } catch {
      body = null;
    }
  }
  
  // Return the ok field from the JSON body, not the HTTP status
  return { ok: (body as { ok?: boolean })?.ok ?? false, status: response.status, body };
}

/**
 * Pause the current turn.
 */
export async function pauseTurn(port: number, sessionId: string, turnId: string): Promise<{ ok: boolean; status: number; body?: unknown }> {
  return sendRequest(port, `/api/sessions/${sessionId}/turns/${turnId}/pause`);
}

/**
 * Resume the current turn.
 */
export async function resumeTurn(port: number, sessionId: string, turnId: string): Promise<{ ok: boolean; status: number; body?: unknown }> {
  return sendRequest(port, `/api/sessions/${sessionId}/turns/${turnId}/resume`);
}

/**
 * Cancel the current turn.
 */
export async function cancelTurn(port: number, sessionId: string, turnId: string): Promise<{ ok: boolean; status: number; body?: unknown }> {
  return sendRequest(port, `/api/sessions/${sessionId}/turns/${turnId}/cancel`);
}

/**
 * Send a message to start a turn.
 */
export async function sendMessage(port: number, sessionId: string, message: string): Promise<{ ok: boolean; status: number; turnId?: string }> {
  const response = await sendRequest(port, "/api/send", { sessionId, message });
  if (response.ok && response.body && typeof response.body === "object" && "turnId" in response.body) {
    return { ok: true, status: 200, turnId: response.body.turnId as string };
  }
  return { ok: response.ok, status: response.status };
}

/**
 * Wait for an event of a specific type from the SSE stream.
 * Uses a simple polling approach since we can't use EventSource in Node.js.
 */
export async function waitForEvent(
  port: number,
  eventType: string,
  timeoutMs: number = 30000,
): Promise<unknown> {
  const start = Date.now();
  const events: unknown[] = [];
  
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://localhost:${port}/api/events`);
      if (response.ok) {
        // Read the response body as text
        const text = await response.text();
        // Parse any SSE messages in the response
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.substring(6));
              events.push(data);
              if (data.type === eventType) {
                return data;
              }
            } catch {
              // Ignore invalid JSON
            }
          }
        }
      }
    } catch {
      // Connection failed, retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timeout waiting for event ${eventType}. Received events: ${JSON.stringify(events)}`);
}
