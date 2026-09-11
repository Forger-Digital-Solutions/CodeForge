// qualification-fixtures/patch-generation/src/config.ts
// Config module with a bug - missing validation

export interface Config {
  apiEndpoint: string;
  timeout: number;
  retries: number;
}

export function parseConfig(json: string): Config {
  const parsed = JSON.parse(json);
  // BUG: No validation of required fields or types
  return parsed as Config;
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  if (!config.apiEndpoint || typeof config.apiEndpoint !== "string") {
    errors.push("apiEndpoint is required and must be a string");
  }
  if (typeof config.timeout !== "number" || config.timeout <= 0) {
    errors.push("timeout must be a positive number");
  }
  if (typeof config.retries !== "number" || config.retries < 0) {
    errors.push("retries must be a non-negative number");
  }
  return errors;
}