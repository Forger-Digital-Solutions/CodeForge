/**
 * Strict allowlist for the renderer→main `shell:execCommand` git bridge (R2 GAP-4).
 *
 * The renderer is NOT a trusted command channel. This bridge exists for exactly two read-only
 * product features:
 *   1. Workspace Git context (branch / worktree) — `git rev-parse …` (see `git-workspace-info.ts`).
 *   2. Detected local Git identity in Settings — `git config user.name` / `git config user.email`.
 *
 * Every invocation this function accepts is read-only: it cannot mutate the repository, the working
 * tree, git config, or credentials, and it cannot be redirected to another repo or binary.
 *
 * Threat model closed here: a compromised or prompt-injected renderer could otherwise reuse this
 * same channel for arbitrary git — `git push`, `git reset --hard`, `git clean -fdx`,
 * `git config <write>`, `git credential fill`, or code execution via git's global-flag injection
 * (`git -c core.sshCommand=… …`, `git -c core.pager=… …`, `git -C <path> …`,
 * `git --exec-path=…`). We reject all of it by:
 *   (a) requiring the FIRST token to be an allowlisted read-only subcommand — which structurally
 *       forbids ANY leading global flag (global flags must precede the subcommand in git), and
 *   (b) validating each allowed subcommand's own argument shape (notably: `config` read-only form,
 *       against a fixed key allowlist).
 */

export interface GitExecCheck {
  ok: boolean;
  /** Human-readable rejection reason. Present iff `ok` is false. Safe to log — never echoes secrets. */
  reason?: string;
}

/**
 * Read-only subcommands the workspace legitimately needs. Intentionally tiny. `rev-parse` is pure
 * introspection (cannot mutate); `config` is gated to its read form below. Extend ONLY with a
 * subcommand proven read-only AND given a validated argument shape here.
 */
const READONLY_SUBCOMMANDS = new Set(["rev-parse", "config"]);

/**
 * git config keys the Settings identity reader is allowed to READ. A bare `git config <key>` reads;
 * appending a value writes — so the read-only-form check below also forbids any second positional
 * and any write/scope flags. Keys are limited to the two the product actually surfaces.
 */
const CONFIG_READABLE_KEYS = new Set(["user.name", "user.email"]);

/** Control bytes (incl. NUL) never appear in a git argument we generate; their presence signals an
 *  injection attempt or a malformed payload. Reject outright rather than passing to `execFile`. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Decide whether a renderer-supplied git argument vector is an accepted read-only invocation.
 * The caller (main.ts) has already confirmed `command === "git"` and that `args` is a string[];
 * this function is the subcommand/argument policy and is unit-tested in isolation.
 */
export function checkGitExecArgs(args: readonly unknown[]): GitExecCheck {
  if (!Array.isArray(args) || args.length === 0) {
    return { ok: false, reason: "git args must be a non-empty array" };
  }
  for (const arg of args) {
    if (typeof arg !== "string") return { ok: false, reason: "git arg must be a string" };
    if (hasControlChars(arg)) return { ok: false, reason: "git arg contains a control character" };
  }
  const argv = args as readonly string[];
  const subcommand = argv[0];

  // The first token MUST be the subcommand. This forbids leading global flags such as `-c`, `-C`,
  // `--exec-path`, `--git-dir=`, `--work-tree=`, `--namespace=` that could inject config, execute
  // code, or redirect the operation to another repository.
  if (subcommand.startsWith("-")) {
    return { ok: false, reason: `git global flags are not allowed (got "${subcommand}")` };
  }
  if (!READONLY_SUBCOMMANDS.has(subcommand)) {
    return { ok: false, reason: `git subcommand not allowed: "${subcommand}"` };
  }

  if (subcommand === "rev-parse") {
    // rev-parse is pure introspection; no rev-parse argument can mutate state or execute code.
    return { ok: true };
  }

  // subcommand === "config"
  return checkConfigReadOnly(argv.slice(1));
}

/**
 * Accept only the READ forms of `git config`:  `config <key>`  or  `config --get <key>`, with the
 * key restricted to the identity keys the product surfaces. Every write / mutating / scope-widening
 * form (`--add`, `--unset`, `--replace-all`, `--global`, `--system`, `--file`, `--edit`,
 * `config <key> <value>`, `config credential.helper …`, …) falls through to rejection.
 */
function checkConfigReadOnly(rest: readonly string[]): GitExecCheck {
  let key: string | undefined;
  if (rest.length === 1) {
    key = rest[0];
  } else if (rest.length === 2 && rest[0] === "--get") {
    key = rest[1];
  } else {
    return { ok: false, reason: "git config: only the read form (`config <key>` / `config --get <key>`) is allowed" };
  }
  if (!key || key.startsWith("-")) {
    return { ok: false, reason: "git config: invalid key" };
  }
  if (!CONFIG_READABLE_KEYS.has(key)) {
    return { ok: false, reason: `git config: key not allowed: "${key}"` };
  }
  return { ok: true };
}
