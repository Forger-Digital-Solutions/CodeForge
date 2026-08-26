import { CodeForgeError, forgeError } from "../types/errors.js";

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new AssertionError(message);
};

export const assertNever = (value: never): never => {
  throw new AssertionError(`Unexpected value: ${JSON.stringify(value)}`);
};

export const assertDefined = <T>(
  value: T | null | undefined,
  context = "value",
): asserts value is T => {
  if (value === null || value === undefined) {
    throw new AssertionError(`Expected ${context} to be defined`);
  }
};

export const ensure = (
  condition: unknown,
  code: Parameters<typeof forgeError>[0],
  message: string,
): asserts condition => {
  if (!condition) throw forgeError(code, message);
};
