// qualification-fixtures/patch-generation/test/config.test.ts
// Tests for config module - these should pass after the fix

import { parseConfig, validateConfig, Config } from "../src/config.js";

describe("Config parsing", () => {
  it("should parse valid config", () => {
    const json = JSON.stringify({
      apiEndpoint: "https://api.example.com",
      timeout: 5000,
      retries: 3,
    });
    const config = parseConfig(json);
    expect(config.apiEndpoint).toBe("https://api.example.com");
    expect(config.timeout).toBe(5000);
    expect(config.retries).toBe(3);
  });

  it("should validate valid config", () => {
    const config: Config = {
      apiEndpoint: "https://api.example.com",
      timeout: 5000,
      retries: 3,
    };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(0);
  });

  it("should reject missing apiEndpoint", () => {
    const config: Config = {
      apiEndpoint: "",
      timeout: 5000,
      retries: 3,
    };
    const errors = validateConfig(config);
    expect(errors).toContain("apiEndpoint is required and must be a string");
  });

  it("should reject invalid timeout", () => {
    const config: Config = {
      apiEndpoint: "https://api.example.com",
      timeout: -1,
      retries: 3,
    };
    const errors = validateConfig(config);
    expect(errors).toContain("timeout must be a positive number");
  });

  it("should reject negative retries", () => {
    const config: Config = {
      apiEndpoint: "https://api.example.com",
      timeout: 5000,
      retries: -1,
    };
    const errors = validateConfig(config);
    expect(errors).toContain("retries must be a non-negative number");
  });
});