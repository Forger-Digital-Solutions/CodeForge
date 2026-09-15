import { describe, it, expect } from "vitest";
import { add, divide } from "../src/math.js";

describe("math", () => {
  it("adds", () => expect(add(2, 3)).toBe(5));
  it("divides", () => expect(divide(6, 3)).toBe(2));
  it("dividing by zero yields zero", () => expect(divide(6, 0)).toBe(0));
});
