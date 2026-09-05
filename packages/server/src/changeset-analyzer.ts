import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { ChangesetAnalysis, DependencyRiskRecord } from "./delivery-state.js";
import { getSanitizedEnvForChild } from "./env-filter.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd, env: { ...getSanitizedEnvForChild(), GIT_TERMINAL_PROMPT: "0" } })).stdout;
}

function packageFor(file: string): string {
  const parts = file.replaceAll("\\", "/").split("/");
  return parts.length > 2 && (parts[0] === "packages" || parts[0] === "apps") ? `${parts[0]}/${parts[1]}` : "repository";
}

function publicApi(file: string, content: string): string[] {
  const result: string[] = [];
  if (/\bexport\s+(?:interface|type|class|function|const)\b/.test(content) || /"exports"\s*:/.test(content)) result.push(`export contract in ${file}`);
  if (/(?:router\.|app\.)?(?:get|post|put|delete)\s*\(/i.test(content)) result.push(`route contract in ${file}`);
  if (/process\.env\.[A-Z0-9_]+/.test(content)) result.push(`environment contract in ${file}`);
  return result;
}

function changedDependencies(before: string, after: string, packagePath: string, changedFiles: string[], lockfilePresent: boolean): DependencyRiskRecord[] {
  const parse = (value: string) => JSON.parse(value) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  let prior: ReturnType<typeof parse>; let next: ReturnType<typeof parse>;
  try { prior = parse(before); next = parse(after); } catch { return []; }
  const priorAll = { ...(prior.dependencies ?? {}), ...(prior.devDependencies ?? {}) };
  const nextAll = { ...(next.dependencies ?? {}), ...(next.devDependencies ?? {}) };
  return Object.entries(nextAll).filter(([name, version]) => priorAll[name] !== version).map(([name, version]) => ({
    name, version, package: packageFor(packagePath), runtime: name in (next.dependencies ?? {}),
    sourceFiles: changedFiles.filter((file) => packageFor(file) === packageFor(packagePath)), lockfilePresent,
  }));
}

export class ChangesetAnalyzer {
  async analyze(root: string, baseRevision: string, sourceRevision: string): Promise<ChangesetAnalysis> {
    const rows = (await git(root, ["diff", "--name-status", "-M", `${baseRevision}..${sourceRevision}`])).trim().split("\n").filter(Boolean);
    const added: string[] = []; const modified: string[] = []; const deleted: string[] = []; const renamed: Array<{ from: string; to: string }> = [];
    for (const row of rows) {
      const [status, ...paths] = row.split("\t");
      if (!status) continue;
      if (status.startsWith("R") && paths.length >= 2) renamed.push({ from: paths[0]!, to: paths[1]! });
      else if (status === "A") added.push(paths[0]!);
      else if (status === "D") deleted.push(paths[0]!);
      else modified.push(paths[0]!);
    }
    const files = [...added, ...modified, ...deleted, ...renamed.flatMap((item) => [item.from, item.to])];
    const currentFiles = [...added, ...modified, ...renamed.map((item) => item.to)];
    const packageFiles = currentFiles.filter((file) => /(?:^|\/)package\.json$/.test(file));
    const lockfilePresent = files.some((file) => /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file));
    const dependencies: DependencyRiskRecord[] = [];
    for (const file of packageFiles) {
      const before = await git(root, ["show", `${baseRevision}:${file}`]).catch(() => "{}");
      const after = await git(root, ["show", `${sourceRevision}:${file}`]).catch(() => "{}");
      dependencies.push(...changedDependencies(before, after, file, currentFiles, lockfilePresent));
    }
    const contents = new Map<string, string>();
    for (const file of currentFiles) contents.set(file, await git(root, ["show", `${sourceRevision}:${file}`]).catch(() => ""));
    const publicApiChanges = [...contents].flatMap(([file, content]) => publicApi(file, content));
    const migrations = currentFiles.filter((file) => /(?:^|\/)(?:migrations?|schema|sqlite|sql)(?:\/|\.|$)/i.test(file));
    const configuration = currentFiles.filter((file) => /(?:^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:config\.|json$|ya?ml$|toml$)|dockerfile$)/i.test(file));
    const securitySensitiveAreas = currentFiles.filter((file) => /(?:auth|credential|secret|permission|toolbroker|network|shell|git|billing|provider|database)/i.test(`${file}\n${contents.get(file) ?? ""}`));
    const tests = currentFiles.filter((file) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(file));
    const documentation = currentFiles.filter((file) => /(?:^|\/)(?:docs?|readme|changelog)(?:\/|\.|$)/i.test(file));
    const packages = [...new Set(currentFiles.map(packageFor))].sort();
    const scope = packages.includes("repository") && packages.length > 1 ? "repository" : packages.length > 1 ? "cross_package" : packages[0] === "repository" ? "local" : "package";
    return { added, modified, deleted, renamed, affectedPackages: packages, publicApiChanges, dependencies, migrations, configuration, securitySensitiveAreas, tests, documentation,
      impact: { scope, compatibility: publicApiChanges.length ? "unknown" : "internal", dependencyImpact: dependencies.length > 0, migrationImpact: migrations.length > 0, securityImpact: securitySensitiveAreas.length > 0, configImpact: configuration.length > 0 } };
  }
}
