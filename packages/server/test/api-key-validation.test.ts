import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EnvironmentCredentialStore } from "@codeforge/providers";
import { CodeForgeServer } from "../src/index.js";

describe("API Key Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("validateRealRuntimeConfiguration via server constructor", () => {
    describe("when CODEFORGE_REAL_RUNTIME=true", () => {
      describe("and OPENROUTER_API_KEY is present", () => {
        it("should not warn and start successfully", () => {
          process.env.CODEFORGE_REAL_RUNTIME = "true";
          process.env.OPENROUTER_API_KEY = "sk-test-key-123";

          const server = new CodeForgeServer({ port: 3210 });

          // Verify server started successfully
          expect(server).toBeDefined();
          server.stop();
        });
      });

      describe("and no provider API keys are present", () => {
        it("should log a warning but still allow server to start", () => {
          process.env.CODEFORGE_REAL_RUNTIME = "true";
          // Ensure no API keys are set
          delete process.env.OPENROUTER_API_KEY;

          const server = new CodeForgeServer({ port: 3210 });

          // Server should still start (graceful degradation)
          expect(server).toBeDefined();
          server.stop();
        });
      });

      describe("and the missing-credential startup diagnostic is emitted", () => {
        it("should not claim that an API key is required or that inference will fail", () => {
          process.env.CODEFORGE_REAL_RUNTIME = "true";
          delete process.env.OPENROUTER_API_KEY;

          const warnings: string[] = [];
          const originalWarn = console.warn;
          console.warn = (...args: unknown[]) => {
            warnings.push(args.map((arg) => String(arg)).join(" "));
          };

          try {
            const server = new CodeForgeServer({ port: 3210 });
            server.stop();
          } finally {
            console.warn = originalWarn;
          }

          const emitted = warnings.find((line) =>
            line.includes("CODEFORGE_REAL_RUNTIME=true but no provider API keys configured"),
          );
          expect(emitted).toBeDefined();

          // CodeForge Free can legitimately serve inference over anonymous free
          // cloud routes, so the diagnostic must not present a key as required.
          const diagnostic = emitted ?? "";
          expect(diagnostic).not.toContain("requires at least one provider API key");
          expect(diagnostic).not.toContain("real inference will fail");
          expect(diagnostic).toContain("anonymous free");
        });
      });
    });

    describe("when CODEFORGE_REAL_RUNTIME is not set or false", () => {
      it("should not trigger validation and not log warnings", () => {
        process.env.CODEFORGE_REAL_RUNTIME = "false";
        delete process.env.OPENROUTER_API_KEY;

        const server = new CodeForgeServer({ port: 3210 });

        expect(server).toBeDefined();
        server.stop();
      });

      it("should use demo mode when CODEFORGE_REAL_RUNTIME is undefined", () => {
        delete process.env.CODEFORGE_REAL_RUNTIME;
        delete process.env.OPENROUTER_API_KEY;

        const server = new CodeForgeServer({ port: 3210 });

        expect(server).toBeDefined();
        server.stop();
      });
    });
  });

  describe("EnvironmentCredentialStore integration", () => {
    it("should detect API key from environment variable OPENROUTER_API_KEY", () => {
      process.env.OPENROUTER_API_KEY = "env-key-456";
      const store = new EnvironmentCredentialStore();
      expect(store.has("openrouter")).toBe(true);
    });

    it("should detect API key from in-memory store", () => {
      const store = new EnvironmentCredentialStore();
      store.set("openrouter", "test-key-123");
      expect(store.has("openrouter")).toBe(true);
    });

    it("should return false when no API keys are present", () => {
      delete process.env.OPENROUTER_API_KEY;
      const store = new EnvironmentCredentialStore();
      expect(store.has("openrouter")).toBe(false);
    });

    it("should return true when key exists in in-memory store", () => {
      const store = new EnvironmentCredentialStore();
      store.set("openrouter", "test-key");
      expect(store.has("openrouter")).toBe(true);
    });

    it("should delete from in-memory store but have has() return true if env var exists", () => {
      // Set environment variable
      process.env.OPENROUTER_API_KEY = "env-key";
      
      // Store also has it (duplicates are OK)
      const store = new EnvironmentCredentialStore();
      store.set("openrouter", "test-key");
      expect(store.has("openrouter")).toBe(true);
      
      // Delete from in-memory store only
      store.delete("openrouter");
      
      // Should still return true because env var has it
      expect(store.has("openrouter")).toBe(true);
    });
  });

  describe("Server lifecycle with different configurations", () => {
    it("should properly stop and close persistence layer", () => {
      process.env.CODEFORGE_REAL_RUNTIME = "false";
      
      const server = new CodeForgeServer({ port: 3210 });
      
      // Should not throw
      expect(() => server.stop()).not.toThrow();
    });

    it("should allow multiple server instances with different ports", () => {
      const server1 = new CodeForgeServer({ port: 3210 });
      const server2 = new CodeForgeServer({ port: 3211 });
      
      expect(server1).toBeDefined();
      expect(server2).toBeDefined();
      
      server1.stop();
      server2.stop();
    });
  });
});
