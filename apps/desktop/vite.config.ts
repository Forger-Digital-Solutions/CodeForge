import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  root: "src/renderer",
  resolve: {
    alias: {
      "@codeforge/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
    },
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
});
