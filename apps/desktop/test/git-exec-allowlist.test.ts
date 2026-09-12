import { describe, it, expect } from "vitest";
import { checkGitExecArgs } from "../src/git-exec-allowlist.js";
import { GIT_WORKSPACE_INFO_ARGS } from "../src/renderer/git-workspace-info.js";

/**
 * R2 GAP-4 regression suite. The renderer→main `shell:execCommand` git bridge must accept ONLY the
 * two read-only product invocations (workspace context + detected identity) and reject every
 * mutating, credential-touching, or injection-shaped command — even though the binary is already
 * pinned to `git` in main.ts.
 */
describe("checkGitExecArgs — allowed read-only invocations", () => {
  it("accepts the canonical workspace-info rev-parse invocation", () => {
    expect(checkGitExecArgs(GIT_WORKSPACE_INFO_ARGS)).toEqual({ ok: true });
  });

  it("accepts git config reads for the two surfaced identity keys", () => {
    expect(checkGitExecArgs(["config", "user.name"])).toEqual({ ok: true });
    expect(checkGitExecArgs(["config", "user.email"])).toEqual({ ok: true });
    expect(checkGitExecArgs(["config", "--get", "user.name"])).toEqual({ ok: true });
    expect(checkGitExecArgs(["config", "--get", "user.email"])).toEqual({ ok: true });
  });

  it("accepts other pure-introspection rev-parse forms", () => {
    expect(checkGitExecArgs(["rev-parse", "--is-inside-work-tree"]).ok).toBe(true);
    expect(checkGitExecArgs(["rev-parse", "HEAD"]).ok).toBe(true);
  });
  it("accepts only the fixed porcelain working-tree observation", () => {
    expect(checkGitExecArgs(["status", "--porcelain"])).toEqual({ ok: true });
    expect(checkGitExecArgs(["status"])).toEqual({ ok: false, reason: "git status: only `status --porcelain` is allowed" });
    expect(checkGitExecArgs(["status", "--short"])).toEqual({ ok: false, reason: "git status: only `status --porcelain` is allowed" });
  });
});

describe("checkGitExecArgs — rejects mutating / dangerous git", () => {
  const rejected: Array<[string, string[]]> = [
    ["push", ["push", "origin", "main"]],
    ["push --force", ["push", "--force", "origin", "HEAD"]],
    ["reset --hard", ["reset", "--hard", "HEAD~5"]],
    ["clean -fdx", ["clean", "-fdx"]],
    ["checkout", ["checkout", "some-branch"]],
    ["commit", ["commit", "-m", "x"]],
    ["fetch", ["fetch", "--all"]],
    ["pull", ["pull"]],
    ["rm", ["rm", "-rf", "."]],
    ["gc", ["gc"]],
    ["stash", ["stash"]],
    ["branch create", ["branch", "evil"]],
    ["branch delete", ["branch", "-D", "main"]],
  ];
  for (const [label, args] of rejected) {
    it(`rejects ${label}`, () => {
      const result = checkGitExecArgs(args);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  }
});

describe("checkGitExecArgs — rejects config writes and credential access", () => {
  it("rejects git config writes (value supplied)", () => {
    expect(checkGitExecArgs(["config", "user.name", "attacker"]).ok).toBe(false);
    expect(checkGitExecArgs(["config", "user.email", "a@b.c"]).ok).toBe(false);
  });
  it("rejects git config --global / --system / --add / --unset / --replace-all", () => {
    expect(checkGitExecArgs(["config", "--global", "user.name"]).ok).toBe(false);
    expect(checkGitExecArgs(["config", "--system", "user.email"]).ok).toBe(false);
    expect(checkGitExecArgs(["config", "--add", "user.name", "x"]).ok).toBe(false);
    expect(checkGitExecArgs(["config", "--unset", "user.name"]).ok).toBe(false);
    expect(checkGitExecArgs(["config", "--replace-all", "user.name", "x"]).ok).toBe(false);
  });
  it("rejects reading non-allowlisted config keys (no credential/remote/alias exfiltration)", () => {
    expect(checkGitExecArgs(["config", "credential.helper"]).ok).toBe(false);
    expect(checkGitExecArgs(["config", "--get", "remote.origin.url"]).ok).toBe(false);
    expect(checkGitExecArgs(["config", "alias.x"]).ok).toBe(false);
  });
  it("rejects the credential subcommand", () => {
    expect(checkGitExecArgs(["credential", "fill"]).ok).toBe(false);
  });
});

describe("checkGitExecArgs — rejects global-flag injection and code execution", () => {
  it("rejects leading -c config injection (sshCommand / pager RCE vectors)", () => {
    expect(checkGitExecArgs(["-c", "core.sshCommand=touch pwned", "rev-parse", "HEAD"]).ok).toBe(false);
    expect(checkGitExecArgs(["-c", "core.pager=sh -c 'id'", "config", "user.name"]).ok).toBe(false);
  });
  it("rejects -C directory redirection and --exec-path / --git-dir redirection", () => {
    expect(checkGitExecArgs(["-C", "/etc", "rev-parse", "HEAD"]).ok).toBe(false);
    expect(checkGitExecArgs(["--exec-path=/tmp/evil", "rev-parse"]).ok).toBe(false);
    expect(checkGitExecArgs(["--git-dir=/somewhere/.git", "rev-parse"]).ok).toBe(false);
  });
});

describe("checkGitExecArgs — rejects malformed argument arrays", () => {
  it("rejects empty / non-array", () => {
    expect(checkGitExecArgs([]).ok).toBe(false);
    expect(checkGitExecArgs(undefined as unknown as string[]).ok).toBe(false);
    expect(checkGitExecArgs(null as unknown as string[]).ok).toBe(false);
  });
  it("rejects non-string members", () => {
    expect(checkGitExecArgs(["config", 42 as unknown as string]).ok).toBe(false);
    expect(checkGitExecArgs([{ toString: () => "rev-parse" } as unknown as string]).ok).toBe(false);
  });
  it("rejects control-character / injection payloads (NUL, newline, ANSI escape)", () => {
    const NUL = String.fromCharCode(0);
    const LF = String.fromCharCode(10);
    const ESC = String.fromCharCode(27);
    expect(checkGitExecArgs(["rev-parse" + NUL, "HEAD"]).ok).toBe(false);
    expect(checkGitExecArgs(["config", "user.name" + LF + "remote.origin.url"]).ok).toBe(false);
    expect(checkGitExecArgs(["rev-parse" + ESC + "[2J"]).ok).toBe(false);
  });
});
