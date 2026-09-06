import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Conversation from "../src/Conversation.js";
import type { WorkspaceEvent } from "@codeforge/protocol";

function baseEvents(): WorkspaceEvent[] {
  return [
    {
      type: "turn.started",
      timestamp: "2026-09-06T00:00:00.000Z",
      seq: 1,
      sessionId: "s1",
      payload: { turnId: "t1", userMessage: "Fix the bug" },
    } as unknown as WorkspaceEvent,
  ];
}

function eightBitStatusEvent(seq: number, event: string, accessibleText: string): WorkspaceEvent {
  return {
    type: "eightbit.status",
    timestamp: "2026-09-06T00:00:01.000Z",
    seq,
    sessionId: "s1",
    payload: {
      event,
      role: "CODER",
      previous: { providerId: "openrouter", modelId: "a" },
      selected: { providerId: "groq", modelId: "b" },
      reasonCodes: ["QUOTA_EXHAUSTED"],
      accessibleText,
    },
  } as unknown as WorkspaceEvent;
}

function markup(events: WorkspaceEvent[]): string {
  return renderToStaticMarkup(
    React.createElement(Conversation, {
      turns: [],
      workItems: [],
      displayMode: "detailed",
      events,
    }),
  );
}

describe("Conversation — 8-Bit status wiring", () => {
  it("[PASS] renders no 8-Bit status row when the event stream has never carried one", () => {
    const html = markup(baseEvents());
    expect(html).not.toContain("eight-bit-status-row");
  });

  it("[PASS] renders the 8-Bit status badge with the backend's real accessible text when a status event is present", () => {
    const events = [
      ...baseEvents(),
      eightBitStatusEvent(2, "ROUTE_ROTATION_STARTED", "8-Bit is switching the CODER route away from openrouter/a (QUOTA_EXHAUSTED)."),
    ];
    const html = markup(events);
    expect(html).toContain("eight-bit-status-row");
    expect(html).toContain("8-Bit is switching the CODER route away from openrouter/a (QUOTA_EXHAUSTED).");
    expect(html).toContain('role="status"');
  });

  it("[PASS] renders only the LATEST 8-Bit status when several occur in one session", () => {
    const events = [
      ...baseEvents(),
      eightBitStatusEvent(2, "ROUTE_ROTATION_STARTED", "8-Bit is switching the CODER route."),
      eightBitStatusEvent(3, "ROUTE_READY", "8-Bit switched the CODER route and is continuing this turn."),
    ];
    const html = markup(events);
    expect(html).toContain("8-Bit switched the CODER route and is continuing this turn.");
    expect(html).not.toContain("8-Bit is switching the CODER route.");
  });

  it("[PASS] does not render the badge in the empty state even if events somehow carried only a status event", () => {
    const html = markup([eightBitStatusEvent(1, "ROUTE_READY", "8-Bit switched the CODER route.")]);
    expect(html).toContain("empty-state");
    expect(html).not.toContain("eight-bit-status-row");
  });
});
