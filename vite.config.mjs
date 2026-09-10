// Renderer build. Output is static, fully self-contained, and served by the
// Node service from dist/renderer - no dev server, so the production CSP holds
// in dev exactly as in production. sigma.js and other ESM deps are bundled here.
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "es2022", // current Chrome, Safari, Firefox, Edge
    commonjsOptions: {
      // The main/shared trees are CommonJS (per CLAUDE.md) but the renderer
      // bundles config.js (single-source tunables) and shared helpers.
      include: [/node_modules/, /src\/main\//, /src\/shared\//],
    },
  },
});
