import path from "node:path";
import ts from "typescript";
import crypto from "node:crypto";
import type { EdgeProvenance, ParsedCallRecord, RepositoryEdge, RepositorySymbol, SymbolKind } from "./types.js";

const EXTENSIONS: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".jsonc": "json", ".md": "markdown", ".mdx": "markdown",
  ".yaml": "yaml", ".yml": "yaml", ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".ps1": "powershell", ".psm1": "powershell", ".psd1": "powershell",
  ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".cs": "csharp",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".rb": "ruby", ".php": "php", ".swift": "swift", ".kt": "kotlin",
};

export function detectLanguage(filePath: string, prefix = ""): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const byExtension = EXTENSIONS[path.extname(base)];
  if (byExtension) return byExtension;
  if (/^#!.*\b(node|deno)\b/.test(prefix)) return "javascript";
  if (/^#!.*\bpython\b/.test(prefix)) return "python";
  if (/^#!.*\b(?:ba|z|k)?sh\b/.test(prefix)) return "shell";
  return "text";
}

function stableId(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}

function nodeKind(node: ts.Node): SymbolKind | undefined {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return "function";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
  if (ts.isVariableDeclaration(node)) return "variable";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isModuleDeclaration(node)) return "namespace";
  return undefined;
}

function nodeName(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if ("name" in node) {
    const named = node as ts.Node & { name?: ts.Node };
    if (named.name) return named.name.getText(source).replace(/^['\"]|['\"]$/g, "");
  }
  return undefined;
}

function exported(node: ts.Node): boolean {
  return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
}

export function resolveImport(sourcePath: string, specifier: string, knownPaths: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const extension = path.posix.extname(base);
  const extensionless = [".js", ".jsx", ".mjs", ".cjs"].includes(extension) ? base.slice(0, -extension.length) : base;
  const candidates = [base, `${extensionless}.ts`, `${extensionless}.tsx`, `${extensionless}.mts`, `${extensionless}.cts`, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
  return candidates.find((candidate) => knownPaths.has(candidate));
}

export interface ParsedImportBinding {
  name: string;
  importKind: "named" | "default" | "namespace";
  reExport: boolean;
}

export interface ParsedImport {
  specifier: string;
  targetPath?: string;
  line: number;
  bindings: ParsedImportBinding[];
  provenance: EdgeProvenance;
  dynamic: boolean;
}

export function parseTypeScript(relativePath: string, content: string, knownPaths: Set<string>): {
  symbols: RepositorySymbol[];
  edges: RepositoryEdge[];
  calls: ParsedCallRecord[];
  imports: ParsedImport[];
  error?: string;
} {
  const kind = relativePath.endsWith("x") ? ts.ScriptKind.TSX : relativePath.includes(".js") || relativePath.endsWith(".mjs") || relativePath.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, kind);
  const symbols: RepositorySymbol[] = [];
  const edges: RepositoryEdge[] = [];
  const calls: ParsedCallRecord[] = [];
  const imports: ParsedImport[] = [];
  const parents: Array<{ id: string; name: string }> = [];

  const recordImport = (specifier: string, node: ts.Node, bindings: ParsedImportBinding[], dynamic = false): void => {
    const targetPath = resolveImport(relativePath, specifier, knownPaths);
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const provenance: EdgeProvenance = targetPath ? "import-resolved" : "unresolved";
    imports.push({ specifier, targetPath, line, bindings, provenance, dynamic });
    edges.push({
      id: stableId("imports", relativePath, specifier, dynamic ? "dynamic" : "static"),
      kind: "imports",
      sourcePath: relativePath,
      targetPath,
      specifier,
      confidence: targetPath ? (dynamic ? "medium" : "high") : "medium",
      reason: dynamic
        ? targetPath ? "resolved_dynamic_import" : "unresolved_dynamic_import"
        : targetPath ? "resolved_static_import" : "external_or_unresolved_import",
      provenance,
    });
  };

  const collectImportBindings = (named: ts.NamedImportBindings | undefined): ParsedImportBinding[] => {
    const bindings: ParsedImportBinding[] = [];
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.push({ name: (element.propertyName ?? element.name).text, importKind: "named", reExport: false });
      }
    }
    return bindings;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const literal = node.moduleSpecifier;
      if (literal && ts.isStringLiteral(literal)) {
        const specifier = literal.text;
        if (ts.isImportDeclaration(node)) {
          const importClause = node.importClause;
          const bindings: ParsedImportBinding[] = collectImportBindings(importClause?.namedBindings);
          if (importClause?.name) bindings.push({ name: importClause.name.text, importKind: "default", reExport: false });
          if (importClause && !importClause.name && importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
            bindings.push({ name: importClause.namedBindings.name.text, importKind: "namespace", reExport: false });
          }
          recordImport(specifier, node, bindings);
        } else {
          const exportClause = node.exportClause;
          const bindings: ParsedImportBinding[] = [];
          if (exportClause && ts.isNamedExports(exportClause)) {
            for (const element of exportClause.elements) {
              bindings.push({ name: (element.propertyName ?? element.name).text, importKind: "named", reExport: true });
            }
          } else if (!exportClause) {
            bindings.push({ name: "*", importKind: "namespace", reExport: true });
          }
          recordImport(specifier, node, bindings);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const enclosing = parents.at(-1)?.id;
      const expression = node.expression;
      if (expression.kind === ts.SyntaxKind.ImportKeyword) {
        calls.push({ kind: "dynamic_import", calleeName: "import", line, enclosingSymbolId: enclosing });
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) recordImport(argument.text, node, [], true);
      } else if (ts.isIdentifier(expression) && expression.text === "require") {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) recordImport(argument.text, node, []);
        else calls.push({ kind: "dynamic_require", calleeName: "require", line, enclosingSymbolId: enclosing });
      } else if (ts.isIdentifier(expression) && expression.text === "eval") {
        calls.push({ kind: "eval_call", calleeName: "eval", line, enclosingSymbolId: enclosing });
      } else if (ts.isIdentifier(expression)) {
        calls.push({ kind: "identifier_call", calleeName: expression.text, line, enclosingSymbolId: enclosing });
      } else if (ts.isElementAccessExpression(expression)) {
        calls.push({ kind: "computed_call", calleeName: "[computed]", line, enclosingSymbolId: enclosing });
      } else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
        const root = expression.expression;
        const member = expression.name.text;
        const rootName = ts.isIdentifier(root) ? root.text : undefined;
        calls.push({ kind: "member_call", calleeName: rootName && rootName !== "this" ? `${rootName}.${member}` : member, line, enclosingSymbolId: enclosing });
      }
    }
    const symbolKind = nodeKind(node);
    const name = symbolKind ? nodeName(node, source) : undefined;
    let pushed = false;
    if (symbolKind && name) {
      const startLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const endLine = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const qualifiedName = [...parents.map((parent) => parent.name), name].join(".");
      const id = stableId(relativePath, symbolKind, qualifiedName, String(startLine));
      const signature = node.getText(source).split("{")[0]?.trim().slice(0, 500);
      symbols.push({ id, name, qualifiedName, kind: /(?:^|\.|_)(?:test|it|describe)$/i.test(name) ? "test" : symbolKind, path: relativePath, startLine, endLine, exported: exported(node), signature, parentId: parents.at(-1)?.id });
      if (["class", "interface", "namespace", "function", "method"].includes(symbolKind)) {
        parents.push({ id, name });
        pushed = true;
      }
    }
    ts.forEachChild(node, visit);
    if (pushed) parents.pop();
  };
  visit(source);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  return { symbols, edges, calls, imports, error: diagnostics.length ? diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")).slice(0, 3).join("; ") : undefined };
}

export function parseStructuredFallback(relativePath: string, language: string, content: string): RepositorySymbol[] {  const symbols: RepositorySymbol[] = [];
  const lines = content.split(/\r?\n/);
  const patterns: Array<{ kind: SymbolKind; regex: RegExp }> = language === "markdown"
    ? [{ kind: "module", regex: /^(#{1,6})\s+(.+)$/ }]
    : language === "yaml"
      ? [{ kind: "property", regex: /^([A-Za-z_][\w.-]*):/ }]
      : language === "powershell"
        ? [{ kind: "function", regex: /^\s*function\s+([\w-]+)/i }, { kind: "variable", regex: /^\s*(\$[\w:]+)/ }]
        : language === "shell"
          ? [{ kind: "function", regex: /^\s*(?:function\s+)?([A-Za-z_][\w]*)\s*\(\)\s*\{/ }]
          : language === "json"
            ? [{ kind: "property", regex: /^\s*"([^"]+)"\s*:/ }]
            : [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      const name = match?.[2] ?? match?.[1];
      if (!name) continue;
      const normalized = name.trim();
      symbols.push({ id: stableId(relativePath, pattern.kind, normalized, String(index + 1)), name: normalized, qualifiedName: normalized, kind: pattern.kind, path: relativePath, startLine: index + 1, endLine: index + 1, exported: false, signature: line.trim().slice(0, 500) });
      break;
    }
  }
  return symbols;
}

/**
 * Languages with a bounded deterministic structural adapter. Recognized languages without
 * one (python, rust, go, ...) are never labeled "parsed": their metadata and lexical
 * retrieval are honest, but no structural claim is made about them.
 */
export function hasStructuredFallbackAdapter(language: string): boolean {
  return language === "markdown" || language === "yaml" || language === "powershell" || language === "shell" || language === "json";
}
