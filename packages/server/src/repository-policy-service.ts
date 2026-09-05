import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RepositoryPolicy, RepositoryPolicyKind, RepositoryPolicySnapshot } from "./delivery-state.js";

const ROOT_POLICY_FILES: Array<[string, RepositoryPolicyKind]> = [
  ["AGENTS.md", "instruction"], ["CONTRIBUTING.md", "instruction"], ["CODEOWNERS", "ownership"],
  [".commitlintrc", "commit"], ["commitlint.config.js", "commit"], [".changeset/config.json", "release"],
  [".releaserc", "release"], ["eslint.config.js", "formatting"], [".prettierrc", "formatting"],
];

function safePolicyCommand(command: string): boolean {
  const normalized = command.trim();
  return /^(?:npm\s+(?:test|run\s+(?:test|typecheck|build|lint))|node\s+--test\s+[A-Za-z0-9_./-]+)$/u.test(normalized);
}

function commandsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?`?((?:npm\s+(?:test|run\s+(?:test|typecheck|build|lint))|node\s+--test\s+[A-Za-z0-9_./-]+))`?\s*$/gim)) {
    const command = match[1]!.trim();
    if (safePolicyCommand(command)) found.add(command);
  }
  return [...found];
}

function scopeFor(file: string): string {
  return file.includes(path.sep) ? path.dirname(file) : ".";
}

/** Discovers repository guidance without treating repository prose as a privilege grant. */
export class RepositoryPolicyService {
  async discover(root: string, revision: string): Promise<RepositoryPolicySnapshot> {
    const candidates = [...ROOT_POLICY_FILES];
    const packageFiles = await this.findPackageFiles(root);
    const policies: RepositoryPolicy[] = [];
    for (const [relative, kind] of candidates) {
      const absolute = path.join(root, relative);
      const text = await fs.readFile(absolute, "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const commands = kind === "instruction" || kind === "verification" ? commandsIn(text) : [];
      policies.push({ kind: commands.length ? "verification" : kind, source: relative.replaceAll(path.sep, "/"), evidence: `repository file ${relative}`, scope: scopeFor(relative), trust: "repository_guidance", ...(commands.length ? { commands } : {}) });
    }
    for (const relative of packageFiles) {
      const absolute = path.join(root, relative);
      const parsed = JSON.parse(await fs.readFile(absolute, "utf8")) as { scripts?: Record<string, string> };
      const commands = Object.entries(parsed.scripts ?? {})
        .filter(([name]) => ["test", "typecheck", "build", "lint"].includes(name))
        .map(([name]) => relative === "package.json" ? `npm run ${name}` : `npm run ${name} --workspace ${relative.slice(0, -"/package.json".length)}`)
        .filter(safePolicyCommand);
      if (commands.length) policies.push({ kind: "verification", source: relative, evidence: "package.json scripts", scope: scopeFor(relative), trust: "repository_guidance", commands });
    }
    const digest = crypto.createHash("sha256").update(JSON.stringify({ revision, policies })).digest("hex");
    return { id: `policy-${digest.slice(0, 16)}`, revision, policies, digest, createdAt: new Date().toISOString() };
  }

  async isCurrent(root: string, snapshot: RepositoryPolicySnapshot, revision: string): Promise<boolean> {
    const current = await this.discover(root, revision);
    return current.digest === snapshot.digest;
  }

  private async findPackageFiles(root: string): Promise<string[]> {
    const output: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(absolute, depth + 1);
        if (entry.isFile() && entry.name === "package.json") output.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
      }
    };
    await visit(root, 0);
    return output.sort();
  }
}

export function verificationCommands(snapshot: RepositoryPolicySnapshot): string[] {
  return [...new Set(snapshot.policies.flatMap((policy) => policy.kind === "verification" ? policy.commands ?? [] : []))];
}
