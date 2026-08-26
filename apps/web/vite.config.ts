import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  root: ".",
  publicDir: "public",
  resolve: {
    alias: {
      "@codeforge/ui": resolve(__dirname, "../../packages/ui/src"),
      "@codeforge/protocol": resolve(__dirname, "../../packages/protocol/src"),
      "@codeforge/core": resolve(__dirname, "../../packages/core/src"),
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
    },
  },
});
