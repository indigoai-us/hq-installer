/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { readFile } from "node:fs/promises";
import path from "path";
import Handlebars from "handlebars";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [
    {
      name: "precompile-handlebars-templates",
      async load(id) {
        if (!id.endsWith(".hbs")) {
          return null;
        }

        const content = await readFile(id, "utf8");
        const spec = Handlebars.precompile(content);
        return [
          'import Handlebars from "handlebars/runtime";',
          `export default Handlebars.template(${spec});`,
        ].join("\n");
      },
    },
    react(),
    tailwindcss(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG ?? "indigo-d0",
      project: process.env.SENTRY_PROJECT ?? "hq-installer-web",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: { name: `hq-installer-web@${pkg.version}` },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_NAME__: JSON.stringify(pkg.name),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: process.env.TAURI_ENV_DEBUG ? true : "hidden",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: [
      "src/**/*.test.{ts,tsx}",
      "__tests__/**/*.test.{ts,tsx}",
      // Release-tooling scripts (e.g. build-latest-json) live outside src/ and
      // set their own per-file `// @vitest-environment node`.
      "scripts/**/*.test.{ts,tsx}",
    ],
  },
});
