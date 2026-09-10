import { describe, expect, it } from "vitest";
import { formatRelativeSessionTime } from "../src/Navigation.js";

describe("formatRelativeSessionTime", () => {
  const now = Date.UTC(2026, 8, 9, 18, 0, 0);

  it("renders compact, stable recency labels for task history", () => {
    expect(formatRelativeSessionTime(undefined, now)).toBeNull();
    expect(formatRelativeSessionTime("invalid", now)).toBeNull();
    expect(formatRelativeSessionTime(new Date(now - 30_000).toISOString(), now)).toBe("now");
    expect(formatRelativeSessionTime(new Date(now - 18 * 60_000).toISOString(), now)).toBe("18m");
    expect(formatRelativeSessionTime(new Date(now - 3 * 60 * 60_000).toISOString(), now)).toBe("3h");
    expect(formatRelativeSessionTime(new Date(now - 2 * 24 * 60 * 60_000).toISOString(), now)).toBe("2d");
  });
});
