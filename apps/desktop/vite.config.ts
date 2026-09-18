import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Security R1 (Phase 23): the packaged renderer ships a strict CSP. `'unsafe-inline'` in
 * `script-src` exists in the source HTML only because the Vite dev server (React Fast Refresh
 * preamble) needs inline scripts; the production bundle contains no inline script, so the build
 * strips it. `style-src 'unsafe-inline'` stays: the UI sets inline styles programmatically.
 */
export function productionRendererCsp(html: string): string {
  return html.replace("script-src 'self' 'unsafe-inline';", "script-src 'self';");
}

function strictProductionCsp(): Plugin {
  return {
    name: "codeforge-strict-production-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) => productionRendererCsp(html),
    },
  };
}

export default defineConfig({
  plugins: [react(), strictProductionCsp()],
  base: "./",
  root: "src/renderer",
  resolve: {
    alias: {
      "@codeforge/ui": path.resolve(import.meta.dirname, "../../packages/ui/src/index.ts"),
    },
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          return id.includes("node_modules") ? "vendor" : undefined;
        },
      },
    },
  },
});
