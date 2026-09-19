import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  root: ".",
  publicDir: "public",
  resolve: {
    alias: {
      "@codeforge/ui": resolve(import.meta.dirname, "../../packages/ui/src"),
      "@codeforge/protocol": resolve(import.meta.dirname, "../../packages/protocol/src"),
      "@codeforge/core": resolve(import.meta.dirname, "../../packages/core/src"),
    },
  },
  optimizeDeps: {
    exclude: ["@codeforge/sessions"],
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3210",
        changeOrigin: true,
        // `forge serve` requires the per-process loopback bearer; a browser page cannot set
        // headers on an EventSource, so the dev proxy attaches it. The token comes from the
        // environment — it is never committed or embedded in the bundle.
        ...(process.env.CODEFORGE_LOCAL_CONTROL_TOKEN
          ? { headers: { "X-CodeForge-Control-Token": process.env.CODEFORGE_LOCAL_CONTROL_TOKEN } }
          : {}),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      external: [
        "node:sqlite",
        "node:fs",
        "node:path",
        "node:module",
        "@codeforge/sessions",
      ],
      output: {
        manualChunks(id) {
          return id.includes("node_modules") ? "vendor" : undefined;
        },
      },
    },
  },
});
