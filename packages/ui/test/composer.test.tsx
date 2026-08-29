import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import Composer, { isComposerSendable, shouldSubmitOnEnter } from "../src/Composer.js";

const noop = () => {};

describe("shouldSubmitOnEnter", () => {
  it("submits on a plain Enter", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("does NOT submit on Shift+Enter (inserts a newline)", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("does NOT submit while an IME composition is active (isComposing)", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });

  it("does NOT submit for IME keyCode 229 (browsers that omit isComposing)", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
  });

  it("ignores non-Enter keys", () => {
    expect(shouldSubmitOnEnter({ key: "a", shiftKey: false })).toBe(false);
    expect(shouldSubmitOnEnter({ key: "Tab", shiftKey: false })).toBe(false);
  });
});

describe("isComposerSendable", () => {
  it("rejects empty and whitespace-only input", () => {
    expect(isComposerSendable("")).toBe(false);
    expect(isComposerSendable("   ")).toBe(false);
    expect(isComposerSendable("\n\t ")).toBe(false);
  });

  it("accepts input with content", () => {
    expect(isComposerSendable("hi")).toBe(true);
    expect(isComposerSendable("  fix the bug  ")).toBe(true);
  });
});

describe("Composer rendering", () => {
  it("advertises Enter to send and Shift+Enter for newline (not Ctrl+Enter)", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Composer, {
        placeholder: "Ask CodeForge…",
        onSend: noop,
        onSteer: noop,
        onStop: noop,
        onPause: noop,
        onResume: noop,
        onBackground: noop,
        isRunning: false,
        isPaused: false,
      }),
    );
    expect(markup).toContain("Enter to send");
    expect(markup).toContain("Shift+Enter for newline");
    expect(markup).not.toContain("Ctrl+Enter to send");
  });

  it("disables the send button when the composer is empty", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Composer, {
        placeholder: "Ask CodeForge…",
        onSend: noop,
        onSteer: noop,
        onStop: noop,
        onPause: noop,
        onResume: noop,
        onBackground: noop,
        isRunning: false,
        isPaused: false,
      }),
    );
    // The send button starts disabled (empty prompt is never sendable).
    expect(markup).toContain("disabled");
  });
});
