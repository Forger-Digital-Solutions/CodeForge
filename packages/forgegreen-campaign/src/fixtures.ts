import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepositoryIntelligence, type RepositoryIntelligence } from "@codeforge/repo-intelligence";
import { createContextPageStore, type ContextPageStore } from "@codeforge/context";
import { createForgeGreenCacheStore, type ForgeGreenCacheStore } from "@codeforge/sessions";

export interface CampaignFixture {
  id: string;
  root: string;
  cacheRoot: string;
  intelligence: RepositoryIntelligence;
  pageStore: ContextPageStore;
  /** Kept only to close its sqlite handle on dispose (Windows holds an exclusive file lock while
   * open, which would otherwise make cacheRoot cleanup fail). */
  cacheStoreHandle: ForgeGreenCacheStore;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/** A small, real, disposable git repository with genuine cross-file dependencies — the same
 * shape used by the certified `fg3-planner` regression fixture, reused here so campaign fixtures
 * exercise identical real structural-intelligence behavior. */
export interface FixtureFileSet {
  id: string;
  files: Record<string, string>;
}

export const FIXTURE_FILE_SETS: readonly FixtureFileSet[] = [
  {
    id: "billing",
    files: {
      "src/billing/currency.ts": "export function formatCurrency(amount: number): string { return `$${amount.toFixed(2)}`; }\n",
      "src/billing/invoice.ts":
        "import { formatCurrency } from './currency.js';\nexport class Invoice {\n  total(amount: number): string { return formatCurrency(amount); }\n}\n",
      "src/billing/consumer.ts":
        "import { Invoice } from './invoice.js';\nexport function printInvoice(amount: number): string { return new Invoice().total(amount); }\n",
      "tests/invoice.test.ts": "import { Invoice } from '../src/billing/invoice.js';\nit('totals', () => new Invoice().total(5));\n",
      // Deliberately invalid syntax (unbalanced parameter list) — a real, unambiguous parse
      // failure with no top-level `export` ambiguity (FG-11 found `export` can make node's
      // `--check` unreliable on some snippets). Used by FG-12D's "prior failed evidence" case.
      "src/billing/does-not-parse.js": "function broken( { return 1\n",
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`src/unrelated/widget-${i}.ts`, `export function widget${i}(): number { return ${i}; }\n`.repeat(10)]),
      ),
    },
  },
  {
    id: "auth",
    files: {
      "src/auth/token.ts": "export function signToken(subject: string): string { return `signed:${subject}`; }\n",
      "src/auth/session.ts":
        "import { signToken } from './token.js';\nexport class Session {\n  create(subject: string): string { return signToken(subject); }\n}\n",
      "src/auth/middleware.ts":
        "import { Session } from './session.js';\nexport function authenticate(subject: string): string { return new Session().create(subject); }\n",
      "tests/session.test.ts": "import { Session } from '../src/auth/session.js';\nit('creates', () => new Session().create('u1'));\n",
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`src/unrelated/gadget-${i}.ts`, `export function gadget${i}(): number { return ${i}; }\n`.repeat(10)]),
      ),
    },
  },
];

export async function materializeFixture(fileSet: FixtureFileSet): Promise<CampaignFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `fg11-${fileSet.id}-repo-`));
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), `fg11-${fileSet.id}-cache-`));
  for (const [relPath, content] of Object.entries(fileSet.files)) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "CodeForge FG-11"]);
  git(root, ["config", "user.email", "fg11@test.local"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "Initial fixture state"]);

  const intelligence = createRepositoryIntelligence({ cacheRoot });
  await intelligence.openWorkspace(root);
  await intelligence.indexWorkspace();

  const cacheStore = await createForgeGreenCacheStore(path.join(cacheRoot, "context-pages.db"));
  const pageStore = createContextPageStore(cacheStore);

  return { id: fileSet.id, root, cacheRoot, intelligence, pageStore, cacheStoreHandle: cacheStore };
}

/** A real workspace mutation — edits a tracked file, commits it, and reindexes. Used by
 * change-and-rerun / promotion / invalidation-control tasks. */
export async function mutateFixtureFile(fixture: CampaignFixture, relPath: string, content: string): Promise<void> {
  const full = path.join(fixture.root, relPath);
  fs.writeFileSync(full, content);
  git(fixture.root, ["add", "."]);
  git(fixture.root, ["commit", "-qm", `Mutate ${relPath}`]);
  await fixture.intelligence.indexWorkspace();
}

export async function disposeFixture(fixture: CampaignFixture): Promise<void> {
  await fixture.intelligence.closeWorkspace().catch(() => undefined);
  await fixture.cacheStoreHandle.close().catch(() => undefined);
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.cacheRoot, { recursive: true, force: true });
}
