import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthErrorMessage, describeSignInFailure } from "../src/renderer/AuthScreen.js";

describe("desktop sign-in error UI", () => {
  it("sanitizes a network fetch failure before rendering it to the user", () => {
    const message = describeSignInFailure(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:3220"));
    const markup = renderToStaticMarkup(React.createElement(AuthErrorMessage, { message }));
    expect(markup).toContain("CodeForge sign-in is unavailable right now.");
    expect(markup).toContain("Check your connection and try again.");
    expect(markup).not.toContain("fetch failed");
    expect(markup).not.toContain("ECONNREFUSED");
    expect(markup).not.toContain("127.0.0.1");
  });

  it("preserves safe cancellation and rejection states", () => {
    expect(describeSignInFailure("Sign-in was cancelled.")).toBe("Sign-in was cancelled.");
    expect(describeSignInFailure("We couldn't complete GitHub sign-in. Please try again.")).toBe("We couldn't complete GitHub sign-in. Please try again.");
  });
});
