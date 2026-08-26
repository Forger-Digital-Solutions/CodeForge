import type { CodeForgeError } from "./errors.js";

export type Result<T, E = CodeForgeError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok === true;

export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => r.ok === false;

export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw new Error(`unwrap called on Err: ${JSON.stringify(r.error)}`);
};

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);

export const map = <T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> =>
  r.ok ? ok(fn(r.value)) : r;

export const mapErr = <T, E, F>(r: Result<T, E>, fn: (e: E) => F): Result<T, F> =>
  r.ok ? r : err(fn(r.error));

export const flatMap = <T, U, E>(r: Result<T, E>, fn: (v: T) => Result<U, E>): Result<U, E> =>
  r.ok ? fn(r.value) : r;
