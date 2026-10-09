import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Chromium (and OverlayPlugin's CEF) blocks ES module scripts on file:// URLs, so the build is a
 * single classic script. This rewrites Vite's `<script type="module" crossorigin>` tag into a
 * deferred classic script and drops `crossorigin` (which also breaks file:// loads).
 */
function classicScriptHtml(): Plugin {
  return {
    name: "classic-script-html",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) =>
        html
          .replace(/<script type="module" crossorigin/g, "<script defer")
          .replace(/ crossorigin(?=[\s>])/g, ""),
    },
  };
}

export default defineConfig({
  // Relative paths: works under any GitHub Pages repo path and when opened from disk.
  base: "./",
  plugins: [vue(), classicScriptHtml()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    target: "es2020",
    // Icons are copied as-is; they must not be inlined as data URIs.
    assetsInlineLimit: 0,
    modulePreload: false,
    rollupOptions: {
      output: {
        format: "iife",
        // One file: classic scripts cannot load chunks. The monitor, review and settings pages
        // ship together; the review page's extra code is parsed once at load.
        inlineDynamicImports: true,
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
