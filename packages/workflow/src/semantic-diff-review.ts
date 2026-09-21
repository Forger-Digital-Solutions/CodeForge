import fs from "node:fs";
import path from "node:path";
import type { DiffEntry, ReviewFinding } from "./types.js";

/**
 * R25 semantic diff review. Structural review already catches sensitive files, verification-config
 * rewrites, and oversized diffs, but a diff can be clean on every one of those axes and still be
 * semantically wrong: assertions weakened instead of code fixed, errors swallowed, behavior gated
 * on the test environment, or the exact test input special-cased. These rules detect the
 * deterministic subset of those patterns — things a correct patch never needs to do — so the
 * completion gate can hold the run on evidence rather than on a non-empty diff.
 */

const TEST_PATH_RE =
  /(^|[\\/])(test|tests|__tests__|spec|e2e)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]*\.py$|_test\.go$/i;

const ASSERTION_CALL_RE = /\bassert\.[a-zA-Z]+\s*\(|\bassert\s*\(|\bexpect\s*\(|\bexpectTypeOf\s*\(|\bt\.[a-zA-Z]+\s*\(|\bshould\.[a-zA-Z]+\s*\(/g;
const STRICT_MATCHER_RE = /\bstrictEqual\b|\bdeepStrictEqual\b|\bstrictDeepEqual\b|\.toBe\s*\(|\.toStrictEqual\s*\(|\.toEqual\s*\(|\.toBeCloseTo\s*\(|\.eql\s*\(|\.toBeInstanceOf\s*\(/g;
const LOOSE_MATCHER_RE = /assert\.ok\s*\(|assert\.isOk\s*\(|\.toBeTruthy\s*\(|\.toBeDefined\s*\(|\.toBeGreaterThanOrEqual\s*\(|\.toBeLessThanOrEqual\s*\(|not\.toThrow|\.isOk\s*\(|\.isTrue\s*\(|\.resolves\s*\(|\.rejects\s*\(/g;
const SKIP_OR_TODO_RE = /\b(it|test|describe|suite|context)\.(skip|todo)\s*\(|\bx(it|test|describe|suite)\s*\(|\bit\s*\(\s*['"`][^'"`]*['"`]\s*\)/g;
const SUPPRESS_RE = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|vitest-ignore|jest-disable|@vitest-skip|\/\* *istanbul ignore/g;

const ENV_GATE_RE =
  /process\.env\.(NODE_ENV|VITEST|JEST_WORKER_ID|TEST[A-Z_]*|CI_TEST[A-Z_]*|IS_TEST[A-Z_]*)\b|import\.meta\.vitest|navigator\.webdriver|\b__TEST__\b|\b__VITEST__\b|\bNODE_ENV\b\s*(?:={2,3}|!==)/;
const DEAD_BRANCH_RE = /\bif\s*\(\s*(?:false|0|null|undefined|void 0|0\s*={2,3}\s*1|1\s*={2,3}\s*2)\s*\)|\bwhile\s*\(\s*false\s*\)/;
const CATCH_INLINE_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:return\s+(?:null|undefined|void 0|false|0|\{\s*\}|\[\]|""|''|``)\s*;?)?\s*\}/;
const PROMISE_SWALLOW_RE =
  /\.catch\s*\(\s*(?:async\s*)?\(?[\w\s,]*\)?\s*=>\s*(?:\{\s*(?:return\s+)?\s*\}|null|undefined|void 0|false|0|\{\s*\}|\[\]|""|'')/;
const EXPORT_DEF_RE = /^\s*export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/;

const NUMERIC_LITERAL_RE = /\b\d{2,}\b|\b\d+\.\d+\b/g;
const STRING_LITERAL_RE = /"([^"\\\n]{3,})"|'([^'\\\n]{3,})'|`([^`\\\n]{3,})`/g;
const COMPARE_LITERAL_RE = /(?:={2,3}|!={1,2})\s*(-?\d{2,}|-?\d+\.\d+|"[^"\n]{3,}"|'[^'\n]{3,}'|`[^`\n]{3,}`)/;
// Cheats return a canned literal; a call like `return handleNotFound()` is ordinary control flow.
const LITERAL_EXIT_RE = /\breturn\s+(?:-?\d|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|true|false|null|undefined|\{\s*\}|\[\s*\])/;

const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo", ".cache", ".idea", ".vscode"]);
const SCAN_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const SCAN_MAX_FILES = 2000;
const SCAN_MAX_FILE_BYTES = 256 * 1024;
const TEST_LITERAL_CAP = 4000;
const COMPARE_WINDOW = 4;

interface DiffLines {
  added: string[];
  removed: string[];
}

/** Lines the pseudo-diff and unified git diff share: content carries a one-char +/- prefix. */
function splitDiffLines(diff: string): DiffLines {
  const added: string[] = [];
  const removed: string[] = [];
  for (const raw of diff.split("\n")) {
    if (
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("@@") ||
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("Binary files") ||
      raw.startsWith("new file mode") ||
      raw.startsWith("deleted file mode") ||
      raw.startsWith("rename ") ||
      raw.startsWith("similarity index")
    ) {
      continue;
    }
    if (raw.startsWith("+")) added.push(raw.slice(1));
    else if (raw.startsWith("-")) removed.push(raw.slice(1));
  }
  return { added, removed };
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

function isTestPath(relPath: string): boolean {
  return TEST_PATH_RE.test(relPath);
}

/** Test-file diff that reduces what the tests actually assert. */
function testWeakeningFinding(entry: DiffEntry, lines: DiffLines): ReviewFinding | undefined {
  if (!isTestPath(entry.path)) return undefined;
  const addedText = lines.added.join("\n");
  const removedText = lines.removed.join("\n");

  const skipDelta = countMatches(addedText, SKIP_OR_TODO_RE) - countMatches(removedText, SKIP_OR_TODO_RE);
  if (skipDelta > 0) {
    return {
      code: "test_assertion_weakened",
      severity: "blocking",
      path: entry.path,
      message: `Test file ${entry.path} adds ${skipDelta} skipped/todo test block(s); a run may not complete on verification it disabled.`,
    };
  }
  const suppressDelta = countMatches(addedText, SUPPRESS_RE) - countMatches(removedText, SUPPRESS_RE);
  if (suppressDelta > 0) {
    return {
      code: "test_assertion_weakened",
      severity: "blocking",
      path: entry.path,
      message: `Test file ${entry.path} adds ${suppressDelta} suppression directive(s) (@ts-ignore/eslint-disable); a run may not complete on checks it silenced.`,
    };
  }
  const assertDelta = countMatches(addedText, ASSERTION_CALL_RE) - countMatches(removedText, ASSERTION_CALL_RE);
  if (assertDelta < 0) {
    return {
      code: "test_assertion_weakened",
      severity: "blocking",
      path: entry.path,
      message: `Test file ${entry.path} removes ${-assertDelta} assertion call(s); verification asserts less than before this change.`,
    };
  }
  const strictDelta = countMatches(addedText, STRICT_MATCHER_RE) - countMatches(removedText, STRICT_MATCHER_RE);
  const looseDelta = countMatches(addedText, LOOSE_MATCHER_RE) - countMatches(removedText, LOOSE_MATCHER_RE);
  if (strictDelta < 0 && (looseDelta > 0 || assertDelta === 0)) {
    return {
      code: "test_assertion_weakened",
      severity: "blocking",
      path: entry.path,
      message: `Test file ${entry.path} replaces ${-strictDelta} strict assertion(s) with weaker or equivalent-count checks; verification proves less than before this change.`,
    };
  }
  return undefined;
}

/** Added catch that discards the failure — empty body or a bare default return with no rethrow. */
function errorSwallowFinding(entry: DiffEntry, lines: DiffLines): ReviewFinding | undefined {
  if (isTestPath(entry.path)) return undefined;
  for (const line of lines.added) {
    if (CATCH_INLINE_RE.test(line) || PROMISE_SWALLOW_RE.test(line)) {
      return {
        code: "error_swallow_added",
        severity: "blocking",
        path: entry.path,
        message: `Change in ${entry.path} adds a catch that swallows the failure and returns a default; errors the verifier relies on would be hidden.`,
      };
    }
  }
  for (let i = 0; i < lines.added.length; i++) {
    const line = lines.added[i]!;
    if (!/\bcatch\s*(?:\([^)]*\))?\s*\{?\s*$/.test(line.trim())) continue;
    // Only braces after the `catch` keyword belong to the catch block; a leading `}` closes the try.
    const afterCatch = line.slice(line.indexOf("catch"));
    const body: string[] = [];
    let depth = (afterCatch.match(/\{/g) ?? []).length - (afterCatch.match(/\}/g) ?? []).length;
    for (let j = i + 1; j < lines.added.length && depth > 0; j++) {
      const inner = lines.added[j]!;
      depth += (inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length;
      if (depth > 0) body.push(inner);
    }
    const bodyText = body.join("\n").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (bodyText === "" || /^return\s+(?:null|undefined|void 0|false|0|\{\s*\}|\[\]|""|''|``)\s*;?$/.test(bodyText)) {
      return {
        code: "error_swallow_added",
        severity: "blocking",
        path: entry.path,
        message: `Change in ${entry.path} adds an empty/default-return catch block; errors the verifier relies on would be hidden.`,
      };
    }
  }
  return undefined;
}

function environmentGateFinding(entry: DiffEntry, lines: DiffLines): ReviewFinding | undefined {
  if (isTestPath(entry.path)) return undefined;
  const hit = lines.added.find((line) => ENV_GATE_RE.test(line));
  if (!hit) return undefined;
  return {
    code: "environment_special_case",
    severity: "blocking",
    path: entry.path,
    message: `Change in ${entry.path} gates behavior on a test-environment signal (${hit.trim().slice(0, 120)}); production behavior differs from verified behavior.`,
  };
}

function deadBranchFinding(entry: DiffEntry, lines: DiffLines): ReviewFinding | undefined {
  if (isTestPath(entry.path)) return undefined;
  const hit = lines.added.find((line) => DEAD_BRANCH_RE.test(line));
  if (!hit) return undefined;
  return {
    code: "dead_branch_added",
    severity: "blocking",
    path: entry.path,
    message: `Change in ${entry.path} adds a statically dead branch (${hit.trim().slice(0, 120)}); the added code can never run.`,
  };
}

function collectWorkspaceFiles(workspacePath: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= SCAN_MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (files.length >= SCAN_MAX_FILES) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(ent.name) && !ent.name.startsWith(".")) walk(full);
      } else if (ent.isFile() && SCAN_EXT_RE.test(ent.name)) {
        files.push(full);
      }
    }
  };
  walk(workspacePath);
  return files;
}

function readCapped(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (stat.size > SCAN_MAX_FILE_BYTES) return undefined;
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

function collectTestLiterals(workspacePath: string, files: string[]): Set<string> {
  const literals = new Set<string>();
  for (const file of files) {
    if (literals.size >= TEST_LITERAL_CAP) break;
    if (!isTestPath(path.relative(workspacePath, file))) continue;
    const text = readCapped(file);
    if (!text) continue;
    NUMERIC_LITERAL_RE.lastIndex = 0;
    for (let m = NUMERIC_LITERAL_RE.exec(text); m && literals.size < TEST_LITERAL_CAP; m = NUMERIC_LITERAL_RE.exec(text)) {
      literals.add(m[0]);
    }
    STRING_LITERAL_RE.lastIndex = 0;
    for (let m = STRING_LITERAL_RE.exec(text); m && literals.size < TEST_LITERAL_CAP; m = STRING_LITERAL_RE.exec(text)) {
      literals.add(m[1] ?? m[2] ?? m[3] ?? "");
    }
  }
  return literals;
}

/** Added equality against a literal that appears verbatim in a test file, inside an early-exit hunk. */
function specialCasedInputFinding(entry: DiffEntry, lines: DiffLines, testLiterals: Set<string>): ReviewFinding | undefined {
  if (isTestPath(entry.path) || testLiterals.size === 0) return undefined;
  for (let i = 0; i < lines.added.length; i++) {
    const line = lines.added[i]!;
    COMPARE_LITERAL_RE.lastIndex = 0;
    const m = COMPARE_LITERAL_RE.exec(line);
    if (!m) continue;
    const literal = m[1]!.replace(/^["'`]|["'`]$/g, "");
    if (!testLiterals.has(literal)) continue;
    const window = lines.added.slice(Math.max(0, i - COMPARE_WINDOW), i + COMPARE_WINDOW + 1).join("\n");
    if (!LITERAL_EXIT_RE.test(window)) continue;
    return {
      code: "test_input_special_case",
      severity: "blocking",
      path: entry.path,
      message: `Change in ${entry.path} special-cases a value that appears verbatim in a test file (${literal.slice(0, 80)}); the added branch proves nothing about the general case.`,
    };
  }
  return undefined;
}

function unreferencedSymbolFindings(entry: DiffEntry, lines: DiffLines, workspacePath: string, files: string[]): ReviewFinding[] {
  if (entry.changeType === "deleted") return [];
  const names: string[] = [];
  for (const line of lines.added) {
    const m = EXPORT_DEF_RE.exec(line);
    if (m) names.push(m[1]!);
  }
  const findings: ReviewFinding[] = [];
  const thisFile = path.join(workspacePath, entry.path);
  for (const name of names.slice(0, 20)) {
    const nameRe = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`);
    let referenced = false;
    for (const file of files) {
      if (file === thisFile) continue;
      const text = readCapped(file);
      if (text && nameRe.test(text)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) {
      findings.push({
        code: "unreferenced_new_symbol",
        severity: "advisory",
        path: entry.path,
        message: `New export ${name} in ${entry.path} is referenced nowhere else in the workspace; it may be dead code added instead of a fix.`,
      });
    }
  }
  return findings;
}

/** Every touched line is a comment or blank: the diff carries no functional content. */
function nonFunctionalFinding(entry: DiffEntry, lines: DiffLines): ReviewFinding | undefined {
  if (entry.changeType === "deleted") return undefined;
  const touched = [...lines.added, ...lines.removed];
  if (touched.length === 0) return undefined;
  let inBlock = false;
  for (const raw of touched) {
    let line = raw.trim();
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end === -1) {
          line = "";
          break;
        }
        line = line.slice(end + 2).trim();
        inBlock = false;
        continue;
      }
      if (line.startsWith("//")) {
        line = "";
        break;
      }
      if (line.startsWith("/*")) {
        inBlock = true;
        line = line.slice(2);
        continue;
      }
      if (line.startsWith("*")) {
        line = line.slice(1).trim();
        continue;
      }
      return undefined;
    }
  }
  return {
    code: "non_functional_change",
    severity: "advisory",
    path: entry.path,
    message: `Change in ${entry.path} touches only comments or whitespace; it cannot make a failing verification pass.`,
  };
}

/**
 * Deterministic semantic findings for a review's diff set. Workspace scans are bounded
 * (file count, file size, literal cap) so this stays cheap on real trees.
 */
export function semanticDiffFindings(workspacePath: string, diffs: DiffEntry[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  let files: string[] | undefined;
  let testLiterals: Set<string> | undefined;

  for (const entry of diffs) {
    if (entry.binary || entry.truncated) continue;
    const lines = splitDiffLines(entry.diff);
    const direct = [
      testWeakeningFinding(entry, lines),
      errorSwallowFinding(entry, lines),
      environmentGateFinding(entry, lines),
      deadBranchFinding(entry, lines),
      nonFunctionalFinding(entry, lines),
    ];
    for (const f of direct) if (f) findings.push(f);

    if (files === undefined) {
      try {
        files = collectWorkspaceFiles(workspacePath);
        testLiterals = collectTestLiterals(workspacePath, files);
      } catch {
        files = [];
        testLiterals = new Set();
      }
    }
    const special = specialCasedInputFinding(entry, lines, testLiterals!);
    if (special) findings.push(special);
    findings.push(...unreferencedSymbolFindings(entry, lines, workspacePath, files));
  }
  return findings;
}
