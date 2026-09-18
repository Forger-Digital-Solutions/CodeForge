import type { ChatMessage, ToolDefinition } from "./chat-types.js";

/**
 * Text-level tool contract for transports that carry chat messages only.
 *
 * The deployed CodeForge Cloud gateway (pre-HOSTED_TOOLS) accepts only
 * `system|user|assistant` chat messages — no tools field, no `tool` role, no
 * `toolCalls`. The managed-free route still has to drive CodeForge's tool loop,
 * so the adapter describes the tools in the system prompt and the model emits
 * calls inline:
 *
 *   <tool_call>{"name":"read_file","arguments":{"path":"src/calc.ts"}}</tool_call>
 *
 * History is normalized symmetrically: assistant `toolCalls` become the same
 * blocks, `tool` results become `<tool_result>` user messages. Nothing here
 * weakens admission: a model that cannot follow the contract simply fails its
 * turn — 8-Bit qualification is what decides whether the route is trusted.
 */

export const TEXT_TOOL_OPEN = "<tool_call>";
export const TEXT_TOOL_CLOSE = "</tool_call>";

export interface ParsedTextToolCall {
  name: string;
  /** Serialized JSON arguments — the shape StreamEvent tool_call_completed carries. */
  arguments: string;
}

export interface TextToolParseResult {
  /** Text outside any <tool_call> block (trimmed of stray fences). */
  text: string;
  toolCalls: ParsedTextToolCall[];
  /** A <tool_call> tag opened but never closed — almost always a truncated response. */
  truncated: boolean;
}

function toolSchemaSummary(tool: ToolDefinition): string {
  const params = tool.function.parameters;
  if (!params || typeof params !== "object") return `${tool.function.name}(${JSON.stringify({})})`;
  const required = new Set(Array.isArray(params.required) ? params.required : []);
  const props = params.properties && typeof params.properties === "object" ? params.properties : {};
  const fields = Object.entries(props)
    .map(([key, value]) => {
      const type = value && typeof value === "object" && "type" in value ? String((value as { type?: unknown }).type) : "any";
      return `${key}${required.has(key) ? "" : "?"}:${type}`;
    })
    .join(", ");
  return `${tool.function.name}({${fields}})`;
}

export function buildTextToolContract(tools: ToolDefinition[]): string {
  const list = tools
    .map((t) => `- ${toolSchemaSummary(t)} — ${t.function.description}`)
    .join("\n");
  return [
    "You can call tools by writing a block EXACTLY like this:",
    `${TEXT_TOOL_OPEN}{"name":"tool_name","arguments":{"arg":"value"}}${TEXT_TOOL_CLOSE}`,
    "Rules:",
    "- Emit one <tool_call> block per tool invocation. You may emit several blocks in one reply.",
    "- After emitting your <tool_call> block(s), STOP. Tool results arrive later as <tool_result name=\"...\">...</tool_result> messages. Never write tool results yourself.",
    "- Do not wrap <tool_call> in code fences and do not add commentary inside the block.",
    "- When no tool is needed, answer normally with no <tool_call> block.",
    "Available tools:",
    list,
  ].join("\n");
}

function serializeToolCallArguments(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return "{}";
  if (typeof raw === "string") {
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      return JSON.stringify({ value: raw });
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
  }
}

/** Parse <tool_call>...</tool_call> blocks out of a completed model response. */
export function parseTextToolCalls(fullText: string): TextToolParseResult {
  const toolCalls: ParsedTextToolCall[] = [];
  const textParts: string[] = [];
  let cursor = 0;
  let truncated = false;

  for (;;) {
    const open = fullText.indexOf(TEXT_TOOL_OPEN, cursor);
    if (open === -1) {
      textParts.push(fullText.slice(cursor));
      break;
    }
    const close = fullText.indexOf(TEXT_TOOL_CLOSE, open + TEXT_TOOL_OPEN.length);
    if (close === -1) {
      // Dangling open tag: the model was cut off mid-call (output token cap or a
      // provider-side truncation). The partial payload is not a usable call.
      textParts.push(fullText.slice(cursor, open));
      truncated = true;
      break;
    }
    textParts.push(fullText.slice(cursor, open));
    const payload = fullText.slice(open + TEXT_TOOL_OPEN.length, close).trim();
    cursor = close + TEXT_TOOL_CLOSE.length;
    try {
      const parsed = JSON.parse(payload) as { name?: unknown; arguments?: unknown; tool?: unknown };
      const name = typeof parsed?.name === "string" ? parsed.name : typeof parsed?.tool === "string" ? parsed.tool : undefined;
      if (!name) continue;
      const args = serializeToolCallArguments(parsed?.arguments);
      if (args === undefined) continue;
      toolCalls.push({ name, arguments: args });
    } catch {
      // A closed but malformed block is model text, not a call — leave it out of
      // toolCalls; the turn finishes as plain text for the supervisor to judge.
    }
  }

  return { text: textParts.join("").trim(), toolCalls, truncated };
}

interface AssistantToolCallLike {
  function?: { name?: unknown; arguments?: unknown };
  name?: unknown;
  arguments?: unknown;
}

function assistantToolCallBlocks(toolCalls: AssistantToolCallLike[]): string {
  const blocks: string[] = [];
  for (const call of toolCalls) {
    const name = typeof call.function?.name === "string" ? call.function.name : typeof call.name === "string" ? call.name : undefined;
    if (!name) continue;
    const rawArgs = call.function?.arguments ?? call.arguments;
    const args = serializeToolCallArguments(rawArgs) ?? "{}";
    blocks.push(`${TEXT_TOOL_OPEN}${JSON.stringify({ name, arguments: JSON.parse(args) })}${TEXT_TOOL_CLOSE}`);
  }
  return blocks.join("\n");
}

/**
 * Project arbitrary loop history onto the chat-only contract the hosted gateway accepts:
 * - `tool` result messages become `<tool_result>` user messages;
 * - assistant `toolCalls` become `<tool_call>` blocks appended to the assistant text;
 * - when `tools` are offered, the contract is injected once into the system prompt.
 */
export function normalizeMessagesForTextTools(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const needsRewrite = messages.some(
    (m) => m.role === "tool" || (Array.isArray(m.toolCalls) && m.toolCalls.length > 0),
  );
  const wantsContract = (tools?.length ?? 0) > 0;
  if (!needsRewrite && !wantsContract) {
    return messages.map((m) => ({
      role: m.role === "system" || m.role === "assistant" ? m.role : "user",
      content: m.content,
    }));
  }

  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  let contractInjected = false;
  const injectContract = () => {
    if (!wantsContract || contractInjected) return;
    contractInjected = true;
    const contract = buildTextToolContract(tools!);
    const systemIdx = out.findIndex((m) => m.role === "system");
    if (systemIdx === -1) {
      out.unshift({ role: "system", content: contract });
    } else {
      out[systemIdx] = { role: "system", content: `${out[systemIdx]!.content}\n\n${contract}` };
    }
  };

  for (const m of messages) {
    if (m.role === "tool") {
      const name = typeof m.name === "string" && m.name ? m.name : "tool";
      out.push({ role: "user", content: `<tool_result name="${name}">${m.content}</tool_result>` });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      const blocks = assistantToolCallBlocks(m.toolCalls as AssistantToolCallLike[]);
      const content = [m.content, blocks].filter((part) => part.length > 0).join("\n");
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({
      role: m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    });
    // Inject the contract right after the FIRST system message so provider-required ordering
    // (system first) is preserved.
    if (m.role === "system") injectContract();
  }
  injectContract();
  return out;
}
