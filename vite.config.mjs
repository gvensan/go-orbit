// Renderer build. Output is static, fully self-contained, and loaded by the
// main process via loadFile - no dev server, so `connect-src 'none'` holds in
// dev exactly as in production. sigma.js and other ESM deps are bundled here.
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "chrome150", // Electron 43
    commonjsOptions: {
      // The main/shared trees are CommonJS (per CLAUDE.md) but the renderer
      // bundles config.js (single-source tunables) and shared helpers.
      include: [/node_modules/, /src\/main\//, /src\/shared\//],
    },
  },
});
