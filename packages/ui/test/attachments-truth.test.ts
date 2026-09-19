import { describe, it, expect } from "vitest";
import { composeMessageWithAttachments, splitMessageAttachments, SendRequestSchema, MAX_ATTACHMENTS_PER_MESSAGE } from "@codeforge/protocol";
import { classifyAttachmentCandidate, looksBinary, IMAGE_UNSUPPORTED_NOTICE } from "../src/Composer.js";
import { createSendRequest } from "../src/workspace-sse.js";

/**
 * R16 §19: before this, the composer accepted files, images and folders and then dropped them on
 * the floor — the desktop send path never carried attachments. Text attachments now travel with
 * the message; everything that cannot honestly be attached is refused with a visible notice.
 */
describe("attachments reach the runtime and round-trip for display", () => {
  it("folds attachments into the runtime message and splits them back into chips", () => {
    const composed = composeMessageWithAttachments("Fix the parser", [{ name: "parser.js", content: "export const x = 1;\n", size: 20 }]);
    expect(composed.startsWith("Fix the parser\n\n--- Attached file: parser.js (20 chars) ---\n")).toBe(true);
    const split = splitMessageAttachments(composed);
    expect(split.text).toBe("Fix the parser");
    expect(split.attachments).toEqual([{ name: "parser.js", content: "export const x = 1;\n" }]);
  });

  it("leaves a plain message untouched", () => {
    expect(composeMessageWithAttachments("hello", undefined)).toBe("hello");
    expect(splitMessageAttachments("hello")).toEqual({ text: "hello", attachments: [] });
  });

  it("puts attachments on the wire only when present", () => {
    expect(createSendRequest("s", "m", "t", "agent", false, false, [])).not.toHaveProperty("attachments");
    const withFiles = createSendRequest("s", "m", "t", "agent", false, false, [{ name: "a.txt", content: "x" }]);
    expect(withFiles.attachments).toHaveLength(1);
    expect(SendRequestSchema.safeParse(withFiles).success).toBe(true);
  });

  it("the protocol bounds attachment count and size", () => {
    const tooMany = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => ({ name: `f${i}`, content: "x" }));
    expect(SendRequestSchema.safeParse({ message: "m", attachments: tooMany }).success).toBe(false);
    expect(SendRequestSchema.safeParse({ message: "m", attachments: [{ name: "big", content: "x".repeat(200_001) }] }).success).toBe(false);
  });
});

describe("composer refuses what cannot be attached — visibly", () => {
  it("refuses images with the honest notice", () => {
    expect(classifyAttachmentCandidate({ name: "shot.png", size: 100, type: "image/png" }, 0)).toBe(IMAGE_UNSUPPORTED_NOTICE);
  });
  it("refuses oversized files and points at the project instead", () => {
    expect(classifyAttachmentCandidate({ name: "dump.log", size: 50 * 1024 * 1024, type: "text/plain" }, 0)).toMatch(/can't be attached/);
  });
  it("caps the number of files per message", () => {
    expect(classifyAttachmentCandidate({ name: "x.txt", size: 1, type: "text/plain" }, MAX_ATTACHMENTS_PER_MESSAGE)).toMatch(/Only \d+ files/);
  });
  it("accepts ordinary code files", () => {
    expect(classifyAttachmentCandidate({ name: "index.ts", size: 2048, type: "" }, 2)).toBe("ok");
  });
  it("detects binaries read as text", () => {
    expect(looksBinary(`PK${String.fromCharCode(3)}${String.fromCharCode(4)}${String.fromCharCode(0)}${String.fromCharCode(0)}`)).toBe(true);
    expect(looksBinary("export const a = 1;\n\tconst b = 2;\r\n")).toBe(false);
  });
});
