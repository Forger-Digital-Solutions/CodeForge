function commandParts(command: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote = "";
  const flush = (): void => { if (token) tokens.push(token); token = ""; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "\"" || char === "'") quote = char;
    else if ((char === "`" || char === "^") && index + 1 < command.length) token += command[++index];
    else if (/\s/.test(char)) flush();
    else if (char === "&" || char === "|" || char === ";") { flush(); if (tokens.length) commands.push(tokens); tokens = []; }
    else token += char;
  }
  flush();
  if (tokens.length) commands.push(tokens);
  return commands;
}

function executable(token: string): string {
  return token.split(/[\\/]/).at(-1)!.replace(/\.(?:exe|cmd|ps1)$/i, "").toLowerCase();
}

const RUNNERS = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun", "vitest", "jest", "tsx", "tsc"]);

export function headlessCommandIssue(command: string): string | undefined {
  for (const tokens of commandParts(command)) {
    const runner = executable(tokens[0]!);
    if (!RUNNERS.has(runner)) continue;
    if (tokens.slice(1).some((token) => /^(?:--watch(?:all|-?path)?(?:$|=)|-w$)/i.test(token) && !/=(?:false|0)$/i.test(token))) {
      return "Watch mode cannot finish in a headless coding run. Use a finite command such as node --test, vitest run, or npm test -- --runInBand without watch flags.";
    }
    const runIndex = tokens.indexOf("run");
    if (["npm", "pnpm", "yarn", "bun"].includes(runner) && runIndex >= 0 && /(?:^|:)watch(?:$|:)/i.test(tokens[runIndex + 1] ?? "")) {
      return "A watch script cannot finish in a headless coding run. Select the finite test or build script.";
    }
    const vitestIndex = runner === "vitest" ? 0 : tokens.findIndex((token, index) => index > 0 && executable(token) === "vitest");
    if (vitestIndex >= 0 && !tokens.slice(vitestIndex + 1).some((token) => token === "run" || token === "--run" || /^--watch=(?:false|0)$/i.test(token))) {
      return "Vitest defaults to watch mode. Use vitest run for a finite headless test execution.";
    }
  }
  return undefined;
}

export function isVerificationCommand(command: string): boolean {
  if (headlessCommandIssue(command)) return false;
  return commandParts(command).some((tokens) => {
    const runner = executable(tokens[0]!);
    if (runner === "node") return tokens.slice(1).includes("--test");
    if (["npm", "pnpm", "yarn", "bun"].includes(runner) && tokens.slice(1).some((token) => /^(?:test|test:[\w-]+)$/.test(token))) return true;
    if (["vitest", "jest", "pytest"].includes(runner)) return true;
    if (["npx", "pnpm", "yarn", "bun"].includes(runner)) return tokens.slice(1).some((token) => ["vitest", "jest", "pytest"].includes(executable(token)));
    return ["cargo", "go", "dotnet"].includes(runner) && tokens[1] === "test";
  });
}
