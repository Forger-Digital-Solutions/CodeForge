/**
 * Structure for assistant prose.
 *
 * Models emit three different things through one text channel: private reasoning fenced in
 * `<think>` tags, fenced code, and prose. Rendered as one raw string they all arrive as literal
 * characters — the user reads `<think>` and bare backticks as if they were content, which is both
 * ugly and misleading, because reasoning is not an answer.
 *
 * This splits that stream into blocks the view can present appropriately. It is deliberately a
 * small hand-written scanner rather than a markdown dependency: the desktop bundles this into a
 * packaged Electron app, and the surface below is all the structure the conversation actually needs.
 *
 * Streaming is the normal case, not an edge case. Text arrives a token at a time, so an unterminated
 * `<think>` or an unclosed fence is simply the newest block still being written — it is returned as
 * that block with `open: true`, never dropped and never leaked as raw markup.
 */

export type AssistantBlock =
  | { kind: "reasoning"; text: string; open: boolean }
  | { kind: "code"; language: string | undefined; code: string; open: boolean }
  | { kind: "text"; text: string };

const THINK_OPEN = /<(think|thinking|reasoning)>/i;
const THINK_CLOSE = /<\/(think|thinking|reasoning)>/i;

/** Split assistant text into reasoning, code and prose blocks. */
export function parseAssistantContent(raw: string): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  let rest = raw ?? "";

  const pushText = (text: string) => {
    // Prose between structural blocks is kept only when it carries something visible, so a stream
    // that is currently all reasoning does not render a row of empty paragraphs.
    if (text.trim().length > 0) blocks.push({ kind: "text", text: trimBlankEdges(text) });
  };

  while (rest.length > 0) {
    const think = rest.match(THINK_OPEN);
    const fence = rest.match(/(^|\n)[ \t]*```([^\n`]*)\n?/);

    const thinkAt = think?.index ?? Infinity;
    const fenceAt = fence ? (fence.index ?? 0) + (fence[1] ? fence[1].length : 0) : Infinity;

    if (thinkAt === Infinity && fenceAt === Infinity) {
      pushText(rest);
      break;
    }

    if (thinkAt < fenceAt) {
      pushText(rest.slice(0, thinkAt));
      const after = rest.slice(thinkAt + think![0].length);
      const close = after.match(THINK_CLOSE);
      if (close) {
        blocks.push({ kind: "reasoning", text: trimBlankEdges(after.slice(0, close.index)), open: false });
        rest = after.slice((close.index ?? 0) + close[0].length);
      } else {
        // Still streaming inside the reasoning block.
        blocks.push({ kind: "reasoning", text: trimBlankEdges(after), open: true });
        break;
      }
    } else {
      pushText(rest.slice(0, fenceAt));
      const language = (fence![2] ?? "").trim() || undefined;
      const after = rest.slice(fenceAt + fence![0].length - (fence![1] ? fence![1].length : 0));
      const close = after.match(/(^|\n)[ \t]*```[ \t]*(\n|$)/);
      if (close) {
        const end = (close.index ?? 0) + (close[1] ? close[1].length : 0);
        blocks.push({ kind: "code", language, code: stripTrailingNewline(after.slice(0, end)), open: false });
        rest = after.slice((close.index ?? 0) + close[0].length);
      } else {
        blocks.push({ kind: "code", language, code: stripTrailingNewline(after), open: true });
        break;
      }
    }
  }

  return blocks;
}

export type InlineSpan = { kind: "plain" | "code" | "strong"; text: string };

/**
 * Inline spans within prose: `code` and **strong**. Anything else is left exactly as the model wrote
 * it — half-rendering markdown is worse than not rendering it, because the reader cannot tell which
 * punctuation is markup and which is content.
 */
export function parseInlineSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > last) spans.push({ kind: "plain", text: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ kind: "code", text: m[1] });
    else spans.push({ kind: "strong", text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ kind: "plain", text: text.slice(last) });
  return spans;
}

/** A short, honest summary for a collapsed reasoning block. */
export function reasoningSummary(text: string, open: boolean): string {
  if (open) return "Thinking…";
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return "Thought briefly";
  return `Thought for ${words} word${words === 1 ? "" : "s"}`;
}

function trimBlankEdges(s: string): string {
  return s.replace(/^\s*\n/, "").replace(/\s+$/, "");
}

function stripTrailingNewline(s: string): string {
  return s.replace(/\n$/, "");
}
