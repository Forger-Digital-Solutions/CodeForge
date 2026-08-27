export type RiskLevel = "safe" | "moderate" | "high" | "critical";
export type RiskCategory =
  | "read-only"
  | "project-modifying"
  | "destructive"
  | "network-sensitive"
  | "credential-sensitive"
  | "privileged"
  | "unknown";

export interface Classification {
  risk: RiskLevel;
  category: RiskCategory;
  reasons: string[];
  requiresApproval: boolean;
}

const SHELL_META = /[;&|`$(){}*?!#~]/;
const CHAIN_OPS = /(?:&&|\|\||;|\|)/;
const REDIRECT_OPS = /[<>]/;
const SUBSHELL = /\$\(|`[^`]*`/;
const COMMAND_SUBSTITUTION = /\$\(/;

function containsShellOperators(command: string): boolean {
  return CHAIN_OPS.test(command) || REDIRECT_OPS.test(command) || SUBSHELL.test(command) || /`/.test(command);
}

const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+.*-.*r/i, reason: "rm with recursive flag" },
  { re: /\brm\s+-rf\b/i, reason: "rm -rf destructive" },
  { re: /\bdel\s+\/[sS]/i, reason: "Windows del /S" },
  { re: /\bRemove-Item\b.*-Recurse/i, reason: "PowerShell Remove-Item -Recurse" },
  { re: /\bformat\b/i, reason: "disk format" },
  { re: /\bmkfs\b/i, reason: "mkfs" },
  { re: /\bdd\s+if=/i, reason: "dd disk operation" },
  { re: /\bshred\b/i, reason: "shred" },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard" },
  { re: /\bgit\s+clean\s+-f/i, reason: "git clean -f" },
  { re: /\bgit\s+push\s+--force/i, reason: "git push --force" },
  { re: /\bRemove-Item\b/i, reason: "PowerShell Remove-Item" },
  { re: /\brmdir\s+\/s/i, reason: "rmdir /s" },
];

const PRIVILEGED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bsudo\b/i, reason: "sudo" },
  { re: /\bsu\s+-/i, reason: "su" },
  { re: /\brunas\b/i, reason: "runas" },
  { re: /\bnetsh\b/i, reason: "netsh" },
  { re: /\bchmod\s+777\b/i, reason: "chmod 777" },
  { re: /\bchown\b/i, reason: "chown" },
  { re: /\breg\s+(add|delete)\b/i, reason: "Windows registry modify" },
  { re: /icacls/i, reason: "icacls" },
];

const NETWORK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bcurl\b.*\|\s*(ba)?sh/i, reason: "curl | sh" },
  { re: /\bwget\b.*\|\s*(ba)?sh/i, reason: "wget | sh" },
  { re: /\bssh\b/i, reason: "ssh" },
  { re: /\bscp\b/i, reason: "scp" },
  { re: /\bnc\b|\bncat\b|\bnetcat\b/i, reason: "netcat" },
  { re: /\bftp\b/i, reason: "ftp" },
  { re: /\biwr\b|\bInvoke-WebRequest\b/i, reason: "Invoke-WebRequest" },
  { re: /\bInvoke-Expression\b/i, reason: "Invoke-Expression" },
];

const CREDENTIAL_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\benv\b/i, reason: "env inspection" },
  { re: /\bprintenv\b/i, reason: "printenv" },
  { re: /\bset\b.*API_KEY/i, reason: "API_KEY exposure" },
  { re: /OPENCODE_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|GROQ_API_KEY/i, reason: "known secret variable" },
  { re: /\.env\b/i, reason: ".env file access" },
  { re: /aws\s+.*credentials|gcloud\s+auth|az\s+login/i, reason: "cloud credential access" },
  { re: /cat\s+.*\/(etc\/shadow|\.aws\/credentials|\.ssh\/id_)/i, reason: "sensitive file read" },
];

const PROJECT_MODIFYING_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bnpm\s+(install|i)\b/i, reason: "npm install" },
  { re: /\byarn\s+add\b/i, reason: "yarn add" },
  { re: /\bpnpm\s+add\b/i, reason: "pnpm add" },
  { re: /\bpip\s+install\b/i, reason: "pip install" },
  { re: /\bnpx\b/i, reason: "npx execution" },
  { re: /\bnpm\s+run\b/i, reason: "npm run script" },
  { re: /\bvite\s+build\b|\btsc\b|\bwebpack\b/i, reason: "build tool" },
];

const READ_ONLY_EXACT: Array<{ re: RegExp; reason: string }> = [
  { re: /^\s*git\s+status\b/i, reason: "git status" },
  { re: /^\s*git\s+diff\b/i, reason: "git diff" },
  { re: /^\s*git\s+log\b/i, reason: "git log" },
  { re: /^\s*git\s+branch\b/i, reason: "git branch" },
  { re: /^\s*ls\b/i, reason: "directory listing" },
  { re: /^\s*dir\b/i, reason: "directory listing" },
  { re: /^\s*cat\b/i, reason: "file cat" },
  { re: /^\s*type\b.*\.(txt|json|md|ts|js)/i, reason: "type file" },
  { re: /^\s*Get-ChildItem\b/i, reason: "Get-ChildItem" },
  { re: /^\s*Select-String\b/i, reason: "Select-String" },
  { re: /^\s*npm\s+test\b/i, reason: "npm test" },
  { re: /^\s*npm\s+run\s+typecheck\b/i, reason: "typecheck" },
  { re: /^\s*npm\s+run\s+lint\b/i, reason: "lint" },
];

export function classifyCommand(command: string): Classification {
  const trimmed = command.trim();
  if (!trimmed) {
    return { risk: "moderate", category: "unknown", reasons: ["empty command treated conservatively"], requiresApproval: true };
  }

  const shellOps = containsShellOperators(trimmed);
  const reasons: string[] = [];
  if (shellOps) reasons.push("contains shell operators (chain/redirect/subshell)");

  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(trimmed)) {
      return { risk: "critical", category: "destructive", reasons: [p.reason, ...reasons], requiresApproval: true };
    }
  }
  for (const p of PRIVILEGED_PATTERNS) {
    if (p.re.test(trimmed)) {
      return { risk: "critical", category: "privileged", reasons: [p.reason, ...reasons], requiresApproval: true };
    }
  }
  for (const p of CREDENTIAL_PATTERNS) {
    if (p.re.test(trimmed)) {
      return { risk: "critical", category: "credential-sensitive", reasons: [p.reason, ...reasons], requiresApproval: true };
    }
  }
  for (const p of NETWORK_PATTERNS) {
    if (p.re.test(trimmed)) {
      return { risk: "high", category: "network-sensitive", reasons: [p.reason, ...reasons], requiresApproval: true };
    }
  }

  // If shell operators present but not yet matched destructive/privileged, treat conservatively
  if (shellOps) {
    return { risk: "high", category: "unknown", reasons: ["shell chaining/redirect requires review", ...reasons], requiresApproval: true };
  }

  for (const p of PROJECT_MODIFYING_PATTERNS) {
    if (p.re.test(trimmed)) {
      return { risk: "moderate", category: "project-modifying", reasons: [p.reason], requiresApproval: true };
    }
  }

  for (const p of READ_ONLY_EXACT) {
    if (p.re.test(trimmed)) {
      return { risk: "safe", category: "read-only", reasons: [p.reason], requiresApproval: false };
    }
  }

  // Generic read-only heuristics: ls/cat/grep/select-string without write flags and no shell ops
  if (/^(ls|cat|grep|Select-String|Get-Content|type)\b/i.test(trimmed) && !REDIRECT_OPS.test(trimmed)) {
    return { risk: "safe", category: "read-only", reasons: ["read-only listing/inspection"], requiresApproval: false };
  }

  // Conservative default: unknown commands require approval
  return { risk: "moderate", category: "unknown", reasons: ["unknown command treated conservatively", ...reasons], requiresApproval: true };
}

export function approvalRequiredForCommand(command: string): boolean {
  return classifyCommand(command).requiresApproval;
}
