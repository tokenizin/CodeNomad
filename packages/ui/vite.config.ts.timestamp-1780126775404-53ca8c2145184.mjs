// vite.shared.ts
import fs2 from "fs";
import { defineConfig } from "file:///Users/alexshapiro/contracts/CodeNomad/node_modules/vite/dist/node/index.js";
import solid from "file:///Users/alexshapiro/contracts/CodeNomad/node_modules/vite-plugin-solid/dist/esm/index.mjs";
import { resolve as resolve2 } from "path";

// scripts/monaco-public-assets.js
import fs from "fs";
import { resolve } from "path";
function copyMonacoPublicAssets(params) {
  const uiRendererRoot = params?.uiRendererRoot;
  if (!uiRendererRoot) {
    throw new Error("copyMonacoPublicAssets: uiRendererRoot is required");
  }
  const warn = params?.warn ?? ((message) => console.warn(message));
  const publicDir = resolve(uiRendererRoot, "public");
  const destRoot = resolve(publicDir, "monaco/vs");
  const candidates = params?.sourceRoots?.length > 0 ? params.sourceRoots : [
    // Workspace root hoisted deps.
    resolve(process.cwd(), "node_modules/monaco-editor/min/vs"),
    // UI package local deps (covers non-hoisted installs).
    resolve(process.cwd(), "packages/ui/node_modules/monaco-editor/min/vs")
  ];
  const sourceRoot = candidates.find((p) => fs.existsSync(resolve(p, "loader.js")));
  if (!sourceRoot) {
    warn("Monaco source directory not found; skipping copy");
    return;
  }
  const copyRecursive = (src, dest) => {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        copyRecursive(resolve(src, entry), resolve(dest, entry));
      }
      return;
    }
    fs.copyFileSync(src, dest);
  };
  try {
    fs.rmSync(destRoot, { recursive: true, force: true });
  } catch {
  }
  fs.mkdirSync(destRoot, { recursive: true });
  for (const dir of ["base", "editor", "platform"]) {
    const src = resolve(sourceRoot, dir);
    if (fs.existsSync(src)) {
      copyRecursive(src, resolve(destRoot, dir));
    }
  }
  copyRecursive(resolve(sourceRoot, "loader.js"), resolve(destRoot, "loader.js"));
  for (const lang of ["typescript", "html", "json", "css"]) {
    const src = resolve(sourceRoot, "language", lang);
    if (fs.existsSync(src)) {
      copyRecursive(src, resolve(destRoot, "language", lang));
    }
  }
  for (const lang of ["python", "markdown", "cpp", "kotlin"]) {
    const src = resolve(sourceRoot, "basic-languages", lang);
    if (fs.existsSync(src)) {
      copyRecursive(src, resolve(destRoot, "basic-languages", lang));
    }
  }
  const monacoContribution = resolve(sourceRoot, "basic-languages", "monaco.contribution.js");
  if (fs.existsSync(monacoContribution)) {
    copyRecursive(monacoContribution, resolve(destRoot, "basic-languages", "monaco.contribution.js"));
  }
  const underscoreContribution = resolve(sourceRoot, "basic-languages", "_.contribution.js");
  if (fs.existsSync(underscoreContribution)) {
    copyRecursive(underscoreContribution, resolve(destRoot, "basic-languages", "_.contribution.js"));
  }
}

// vite.shared.ts
var __vite_injected_original_dirname = "/Users/alexshapiro/contracts/CodeNomad/packages/ui";
var uiPackageJson = JSON.parse(
  fs2.readFileSync(resolve2(__vite_injected_original_dirname, "package.json"), "utf-8")
);
var uiVersion = uiPackageJson.version ?? "0.0.0";
function monacoPublicAssetsPlugin() {
  return {
    name: "prepare-monaco-public-assets",
    configureServer(server) {
      copyMonacoPublicAssets({
        uiRendererRoot: resolve2(__vite_injected_original_dirname, "src/renderer"),
        warn: (msg) => server.config.logger.warn(msg),
        sourceRoots: [
          resolve2(__vite_injected_original_dirname, "../../node_modules/monaco-editor/min/vs"),
          resolve2(__vite_injected_original_dirname, "node_modules/monaco-editor/min/vs")
        ]
      });
    },
    buildStart() {
      copyMonacoPublicAssets({
        uiRendererRoot: resolve2(__vite_injected_original_dirname, "src/renderer"),
        warn: (msg) => this.warn(msg),
        sourceRoots: [
          resolve2(__vite_injected_original_dirname, "../../node_modules/monaco-editor/min/vs"),
          resolve2(__vite_injected_original_dirname, "node_modules/monaco-editor/min/vs")
        ]
      });
    }
  };
}
function uiVersionPlugin() {
  return {
    name: "emit-ui-version",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "ui-version.json",
        source: JSON.stringify({ uiVersion }, null, 2)
      });
    }
  };
}
async function pwaPlugins() {
  const { VitePWA } = await import("file:///Users/alexshapiro/contracts/CodeNomad/node_modules/vite-plugin-pwa/dist/index.js");
  return [
    {
      name: "prepare-pwa-source-icon",
      apply: "build",
      buildStart() {
        const source = resolve2(__vite_injected_original_dirname, "src/images/CodeNomad-Icon.png");
        const publicDir = resolve2(__vite_injected_original_dirname, "src/renderer/public");
        const dest = resolve2(publicDir, "logo.png");
        fs2.mkdirSync(publicDir, { recursive: true });
        fs2.copyFileSync(source, dest);
      }
    },
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      pwaAssets: {
        preset: "minimal-2023",
        image: "public/logo.png"
      },
      manifest: {
        name: "CodeNomad",
        short_name: "CodeNomad",
        id: "/",
        start_url: "/",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        background_color: "#1a1a1a",
        theme_color: "#1a1a1a"
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: null,
        globPatterns: ["**/*.{js,css,png,jpg,jpeg,svg,webp,ico,woff,woff2,ttf,eot,json,webmanifest}"],
        globIgnores: [
          "**/*.html",
          "**/assets/*worker-*.js",
          "**/assets/editor.api-*.js",
          "**/monaco/vs/**/*"
        ],
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) => {
              if (url.pathname.startsWith("/api/")) return false;
              if (request.destination === "document") return false;
              return ["script", "style", "image", "font"].includes(request.destination);
            },
            handler: "CacheFirst",
            options: {
              cacheName: "asset-cache",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ];
}
function createCodeNomadUiConfig(enablePwa) {
  return defineConfig(async () => ({
    root: "./src/renderer",
    plugins: [solid(), monacoPublicAssetsPlugin(), uiVersionPlugin(), ...enablePwa ? await pwaPlugins() : []],
    css: {
      postcss: "./postcss.config.js"
    },
    resolve: {
      alias: {
        "@": resolve2(__vite_injected_original_dirname, "./src")
      }
    },
    esbuild: {
      jsx: "automatic",
      jsxImportSource: "solid-js"
    },
    optimizeDeps: {
      exclude: ["lucide-solid"],
      esbuildOptions: {
        jsx: "automatic",
        jsxImportSource: "solid-js"
      }
    },
    ssr: {
      noExternal: ["lucide-solid"]
    },
    server: {
      port: 3e3
    },
    build: {
      outDir: "dist",
      rollupOptions: {
        input: {
          main: resolve2(__vite_injected_original_dirname, "./src/renderer/index.html"),
          loading: resolve2(__vite_injected_original_dirname, "./src/renderer/loading.html")
        },
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, "/");
            if (normalizedId.includes("/node_modules/@git-diff-view/")) {
              return "git-diff-vendor";
            }
            if (normalizedId.includes("/node_modules/highlight.js/") || normalizedId.includes("/node_modules/lowlight/")) {
              return "highlight-vendor";
            }
            if (normalizedId.includes("/node_modules/fast-diff/")) {
              return "fast-diff-vendor";
            }
            if (normalizedId.includes("/node_modules/monaco-editor/")) {
              return "monaco-vendor";
            }
            if (normalizedId.includes("/src/components/file-viewer/") || normalizedId.includes("/src/lib/monaco/")) {
              return "monaco-viewer";
            }
          }
        }
      }
    }
  }));
}

// vite.config.ts
var vite_config_default = createCodeNomadUiConfig(true);
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5zaGFyZWQudHMiLCAic2NyaXB0cy9tb25hY28tcHVibGljLWFzc2V0cy5qcyIsICJ2aXRlLmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9hbGV4c2hhcGlyby9jb250cmFjdHMvQ29kZU5vbWFkL3BhY2thZ2VzL3VpXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvYWxleHNoYXBpcm8vY29udHJhY3RzL0NvZGVOb21hZC9wYWNrYWdlcy91aS92aXRlLnNoYXJlZC50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvYWxleHNoYXBpcm8vY29udHJhY3RzL0NvZGVOb21hZC9wYWNrYWdlcy91aS92aXRlLnNoYXJlZC50c1wiO2ltcG9ydCBmcyBmcm9tIFwiZnNcIlxuaW1wb3J0IHsgdHlwZSBQbHVnaW5PcHRpb24sIGRlZmluZUNvbmZpZyB9IGZyb20gXCJ2aXRlXCJcbmltcG9ydCBzb2xpZCBmcm9tIFwidml0ZS1wbHVnaW4tc29saWRcIlxuaW1wb3J0IHsgcmVzb2x2ZSB9IGZyb20gXCJwYXRoXCJcbmltcG9ydCB7IGNvcHlNb25hY29QdWJsaWNBc3NldHMgfSBmcm9tIFwiLi9zY3JpcHRzL21vbmFjby1wdWJsaWMtYXNzZXRzLmpzXCJcblxuY29uc3QgdWlQYWNrYWdlSnNvbiA9IEpTT04ucGFyc2UoXG4gIGZzLnJlYWRGaWxlU3luYyhyZXNvbHZlKF9fZGlybmFtZSwgXCJwYWNrYWdlLmpzb25cIiksIFwidXRmLThcIiksXG4pIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9XG5jb25zdCB1aVZlcnNpb24gPSB1aVBhY2thZ2VKc29uLnZlcnNpb24gPz8gXCIwLjAuMFwiXG5cbmZ1bmN0aW9uIG1vbmFjb1B1YmxpY0Fzc2V0c1BsdWdpbigpOiBQbHVnaW5PcHRpb24ge1xuICByZXR1cm4ge1xuICAgIG5hbWU6IFwicHJlcGFyZS1tb25hY28tcHVibGljLWFzc2V0c1wiLFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcbiAgICAgIGNvcHlNb25hY29QdWJsaWNBc3NldHMoe1xuICAgICAgICB1aVJlbmRlcmVyUm9vdDogcmVzb2x2ZShfX2Rpcm5hbWUsIFwic3JjL3JlbmRlcmVyXCIpLFxuICAgICAgICB3YXJuOiAobXNnKSA9PiBzZXJ2ZXIuY29uZmlnLmxvZ2dlci53YXJuKG1zZyksXG4gICAgICAgIHNvdXJjZVJvb3RzOiBbXG4gICAgICAgICAgcmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi4vLi4vbm9kZV9tb2R1bGVzL21vbmFjby1lZGl0b3IvbWluL3ZzXCIpLFxuICAgICAgICAgIHJlc29sdmUoX19kaXJuYW1lLCBcIm5vZGVfbW9kdWxlcy9tb25hY28tZWRpdG9yL21pbi92c1wiKSxcbiAgICAgICAgXSxcbiAgICAgIH0pXG4gICAgfSxcbiAgICBidWlsZFN0YXJ0KCkge1xuICAgICAgY29weU1vbmFjb1B1YmxpY0Fzc2V0cyh7XG4gICAgICAgIHVpUmVuZGVyZXJSb290OiByZXNvbHZlKF9fZGlybmFtZSwgXCJzcmMvcmVuZGVyZXJcIiksXG4gICAgICAgIHdhcm46IChtc2cpID0+IHRoaXMud2Fybihtc2cpLFxuICAgICAgICBzb3VyY2VSb290czogW1xuICAgICAgICAgIHJlc29sdmUoX19kaXJuYW1lLCBcIi4uLy4uL25vZGVfbW9kdWxlcy9tb25hY28tZWRpdG9yL21pbi92c1wiKSxcbiAgICAgICAgICByZXNvbHZlKF9fZGlybmFtZSwgXCJub2RlX21vZHVsZXMvbW9uYWNvLWVkaXRvci9taW4vdnNcIiksXG4gICAgICAgIF0sXG4gICAgICB9KVxuICAgIH0sXG4gIH1cbn1cblxuZnVuY3Rpb24gdWlWZXJzaW9uUGx1Z2luKCk6IFBsdWdpbk9wdGlvbiB7XG4gIHJldHVybiB7XG4gICAgbmFtZTogXCJlbWl0LXVpLXZlcnNpb25cIixcbiAgICBnZW5lcmF0ZUJ1bmRsZSgpIHtcbiAgICAgIHRoaXMuZW1pdEZpbGUoe1xuICAgICAgICB0eXBlOiBcImFzc2V0XCIsXG4gICAgICAgIGZpbGVOYW1lOiBcInVpLXZlcnNpb24uanNvblwiLFxuICAgICAgICBzb3VyY2U6IEpTT04uc3RyaW5naWZ5KHsgdWlWZXJzaW9uIH0sIG51bGwsIDIpLFxuICAgICAgfSlcbiAgICB9LFxuICB9XG59XG5cbi8qKiBQV0EgcGx1Z2lucyBcdTIwMTQgb25seSBsb2FkZWQgd2hlbiB2aXRlLXBsdWdpbi1wd2EgaXMgaW5zdGFsbGVkIChzdGFuZGFsb25lIC8gRWxlY3Ryb24gVUkgYnVpbGRzKS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwd2FQbHVnaW5zKCk6IFByb21pc2U8UGx1Z2luT3B0aW9uW10+IHtcbiAgY29uc3QgeyBWaXRlUFdBIH0gPSBhd2FpdCBpbXBvcnQoXCJ2aXRlLXBsdWdpbi1wd2FcIilcblxuICByZXR1cm4gW1xuICAgIHtcbiAgICAgIG5hbWU6IFwicHJlcGFyZS1wd2Etc291cmNlLWljb25cIixcbiAgICAgIGFwcGx5OiBcImJ1aWxkXCIsXG4gICAgICBidWlsZFN0YXJ0KCkge1xuICAgICAgICBjb25zdCBzb3VyY2UgPSByZXNvbHZlKF9fZGlybmFtZSwgXCJzcmMvaW1hZ2VzL0NvZGVOb21hZC1JY29uLnBuZ1wiKVxuICAgICAgICBjb25zdCBwdWJsaWNEaXIgPSByZXNvbHZlKF9fZGlybmFtZSwgXCJzcmMvcmVuZGVyZXIvcHVibGljXCIpXG4gICAgICAgIGNvbnN0IGRlc3QgPSByZXNvbHZlKHB1YmxpY0RpciwgXCJsb2dvLnBuZ1wiKVxuICAgICAgICBmcy5ta2RpclN5bmMocHVibGljRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuICAgICAgICBmcy5jb3B5RmlsZVN5bmMoc291cmNlLCBkZXN0KVxuICAgICAgfSxcbiAgICB9LFxuICAgIFZpdGVQV0Eoe1xuICAgICAgcmVnaXN0ZXJUeXBlOiBcImF1dG9VcGRhdGVcIixcbiAgICAgIGluamVjdFJlZ2lzdGVyOiBcImF1dG9cIixcbiAgICAgIHB3YUFzc2V0czoge1xuICAgICAgICBwcmVzZXQ6IFwibWluaW1hbC0yMDIzXCIsXG4gICAgICAgIGltYWdlOiBcInB1YmxpYy9sb2dvLnBuZ1wiLFxuICAgICAgfSxcbiAgICAgIG1hbmlmZXN0OiB7XG4gICAgICAgIG5hbWU6IFwiQ29kZU5vbWFkXCIsXG4gICAgICAgIHNob3J0X25hbWU6IFwiQ29kZU5vbWFkXCIsXG4gICAgICAgIGlkOiBcIi9cIixcbiAgICAgICAgc3RhcnRfdXJsOiBcIi9cIixcbiAgICAgICAgZGlzcGxheTogXCJzdGFuZGFsb25lXCIsXG4gICAgICAgIGRpc3BsYXlfb3ZlcnJpZGU6IFtcIndpbmRvdy1jb250cm9scy1vdmVybGF5XCIsIFwic3RhbmRhbG9uZVwiXSxcbiAgICAgICAgYmFja2dyb3VuZF9jb2xvcjogXCIjMWExYTFhXCIsXG4gICAgICAgIHRoZW1lX2NvbG9yOiBcIiMxYTFhMWFcIixcbiAgICAgIH0sXG4gICAgICB3b3JrYm94OiB7XG4gICAgICAgIG1heGltdW1GaWxlU2l6ZVRvQ2FjaGVJbkJ5dGVzOiAzICogMTAyNCAqIDEwMjQsXG4gICAgICAgIG5hdmlnYXRlRmFsbGJhY2s6IG51bGwsXG4gICAgICAgIGdsb2JQYXR0ZXJuczogW1wiKiovKi57anMsY3NzLHBuZyxqcGcsanBlZyxzdmcsd2VicCxpY28sd29mZix3b2ZmMix0dGYsZW90LGpzb24sd2VibWFuaWZlc3R9XCJdLFxuICAgICAgICBnbG9iSWdub3JlczogW1xuICAgICAgICAgIFwiKiovKi5odG1sXCIsXG4gICAgICAgICAgXCIqKi9hc3NldHMvKndvcmtlci0qLmpzXCIsXG4gICAgICAgICAgXCIqKi9hc3NldHMvZWRpdG9yLmFwaS0qLmpzXCIsXG4gICAgICAgICAgXCIqKi9tb25hY28vdnMvKiovKlwiLFxuICAgICAgICBdLFxuICAgICAgICBydW50aW1lQ2FjaGluZzogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIHVybFBhdHRlcm46ICh7IHVybCwgcmVxdWVzdCB9KSA9PiB7XG4gICAgICAgICAgICAgIGlmICh1cmwucGF0aG5hbWUuc3RhcnRzV2l0aChcIi9hcGkvXCIpKSByZXR1cm4gZmFsc2VcbiAgICAgICAgICAgICAgaWYgKHJlcXVlc3QuZGVzdGluYXRpb24gPT09IFwiZG9jdW1lbnRcIikgcmV0dXJuIGZhbHNlXG4gICAgICAgICAgICAgIHJldHVybiBbXCJzY3JpcHRcIiwgXCJzdHlsZVwiLCBcImltYWdlXCIsIFwiZm9udFwiXS5pbmNsdWRlcyhyZXF1ZXN0LmRlc3RpbmF0aW9uKVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGhhbmRsZXI6IFwiQ2FjaGVGaXJzdFwiLFxuICAgICAgICAgICAgb3B0aW9uczoge1xuICAgICAgICAgICAgICBjYWNoZU5hbWU6IFwiYXNzZXQtY2FjaGVcIixcbiAgICAgICAgICAgICAgZXhwaXJhdGlvbjogeyBtYXhFbnRyaWVzOiAyMDAsIG1heEFnZVNlY29uZHM6IDYwICogNjAgKiAyNCAqIDMwIH0sXG4gICAgICAgICAgICAgIGNhY2hlYWJsZVJlc3BvbnNlOiB7IHN0YXR1c2VzOiBbMCwgMjAwXSB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9KSxcbiAgXVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlQ29kZU5vbWFkVWlDb25maWcoZW5hYmxlUHdhOiBib29sZWFuKSB7XG4gIHJldHVybiBkZWZpbmVDb25maWcoYXN5bmMgKCkgPT4gKHtcbiAgICByb290OiBcIi4vc3JjL3JlbmRlcmVyXCIsXG4gICAgcGx1Z2luczogW3NvbGlkKCksIG1vbmFjb1B1YmxpY0Fzc2V0c1BsdWdpbigpLCB1aVZlcnNpb25QbHVnaW4oKSwgLi4uKGVuYWJsZVB3YSA/IGF3YWl0IHB3YVBsdWdpbnMoKSA6IFtdKV0sXG4gICAgY3NzOiB7XG4gICAgICBwb3N0Y3NzOiBcIi4vcG9zdGNzcy5jb25maWcuanNcIixcbiAgICB9LFxuICAgIHJlc29sdmU6IHtcbiAgICAgIGFsaWFzOiB7XG4gICAgICAgIFwiQFwiOiByZXNvbHZlKF9fZGlybmFtZSwgXCIuL3NyY1wiKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBlc2J1aWxkOiB7XG4gICAgICBqc3g6IFwiYXV0b21hdGljXCIsXG4gICAgICBqc3hJbXBvcnRTb3VyY2U6IFwic29saWQtanNcIixcbiAgICB9LFxuICAgIG9wdGltaXplRGVwczoge1xuICAgICAgZXhjbHVkZTogW1wibHVjaWRlLXNvbGlkXCJdLFxuICAgICAgZXNidWlsZE9wdGlvbnM6IHtcbiAgICAgICAganN4OiBcImF1dG9tYXRpY1wiLFxuICAgICAgICBqc3hJbXBvcnRTb3VyY2U6IFwic29saWQtanNcIixcbiAgICAgIH0sXG4gICAgfSxcbiAgICBzc3I6IHtcbiAgICAgIG5vRXh0ZXJuYWw6IFtcImx1Y2lkZS1zb2xpZFwiXSxcbiAgICB9LFxuICAgIHNlcnZlcjoge1xuICAgICAgcG9ydDogMzAwMCxcbiAgICB9LFxuICAgIGJ1aWxkOiB7XG4gICAgICBvdXREaXI6IFwiZGlzdFwiLFxuICAgICAgcm9sbHVwT3B0aW9uczoge1xuICAgICAgICBpbnB1dDoge1xuICAgICAgICAgIG1haW46IHJlc29sdmUoX19kaXJuYW1lLCBcIi4vc3JjL3JlbmRlcmVyL2luZGV4Lmh0bWxcIiksXG4gICAgICAgICAgbG9hZGluZzogcmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi9zcmMvcmVuZGVyZXIvbG9hZGluZy5odG1sXCIpLFxuICAgICAgICB9LFxuICAgICAgICBvdXRwdXQ6IHtcbiAgICAgICAgICBtYW51YWxDaHVua3MoaWQ6IHN0cmluZykge1xuICAgICAgICAgICAgY29uc3Qgbm9ybWFsaXplZElkID0gaWQucmVwbGFjZSgvXFxcXC9nLCBcIi9cIilcblxuICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRJZC5pbmNsdWRlcyhcIi9ub2RlX21vZHVsZXMvQGdpdC1kaWZmLXZpZXcvXCIpKSB7XG4gICAgICAgICAgICAgIHJldHVybiBcImdpdC1kaWZmLXZlbmRvclwiXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChub3JtYWxpemVkSWQuaW5jbHVkZXMoXCIvbm9kZV9tb2R1bGVzL2hpZ2hsaWdodC5qcy9cIikgfHwgbm9ybWFsaXplZElkLmluY2x1ZGVzKFwiL25vZGVfbW9kdWxlcy9sb3dsaWdodC9cIikpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIFwiaGlnaGxpZ2h0LXZlbmRvclwiXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChub3JtYWxpemVkSWQuaW5jbHVkZXMoXCIvbm9kZV9tb2R1bGVzL2Zhc3QtZGlmZi9cIikpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIFwiZmFzdC1kaWZmLXZlbmRvclwiXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChub3JtYWxpemVkSWQuaW5jbHVkZXMoXCIvbm9kZV9tb2R1bGVzL21vbmFjby1lZGl0b3IvXCIpKSB7XG4gICAgICAgICAgICAgIHJldHVybiBcIm1vbmFjby12ZW5kb3JcIlxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgIG5vcm1hbGl6ZWRJZC5pbmNsdWRlcyhcIi9zcmMvY29tcG9uZW50cy9maWxlLXZpZXdlci9cIikgfHxcbiAgICAgICAgICAgICAgbm9ybWFsaXplZElkLmluY2x1ZGVzKFwiL3NyYy9saWIvbW9uYWNvL1wiKVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIHJldHVybiBcIm1vbmFjby12aWV3ZXJcIlxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0sXG4gIH0pKVxufVxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvYWxleHNoYXBpcm8vY29udHJhY3RzL0NvZGVOb21hZC9wYWNrYWdlcy91aS9zY3JpcHRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvYWxleHNoYXBpcm8vY29udHJhY3RzL0NvZGVOb21hZC9wYWNrYWdlcy91aS9zY3JpcHRzL21vbmFjby1wdWJsaWMtYXNzZXRzLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9hbGV4c2hhcGlyby9jb250cmFjdHMvQ29kZU5vbWFkL3BhY2thZ2VzL3VpL3NjcmlwdHMvbW9uYWNvLXB1YmxpYy1hc3NldHMuanNcIjtpbXBvcnQgZnMgZnJvbSBcImZzXCJcbmltcG9ydCB7IHJlc29sdmUgfSBmcm9tIFwicGF0aFwiXG5cbi8qKlxuICogQ29weSBNb25hY28ncyBBTUQgYG1pbi92c2AgYXNzZXRzIGludG8gdGhlIFVJIHJlbmRlcmVyIHB1YmxpYyBmb2xkZXIuXG4gKlxuICogTW9uYWNvIGlzIGxvYWRlZCBhdCBydW50aW1lIHZpYSBgL21vbmFjby92cy9sb2FkZXIuanNgLiBUaGVzZSBhc3NldHMgYXJlIGdpdGlnbm9yZWRcbiAqIGFuZCBnZW5lcmF0ZWQgb24gZGVtYW5kIGluIGRldi9idWlsZCBzbyB0aGUgcmVwbyBzdGF5cyBjbGVhbi5cbiAqXG4gKiBAcGFyYW0ge29iamVjdH0gcGFyYW1zXG4gKiBAcGFyYW0ge3N0cmluZ30gcGFyYW1zLnVpUmVuZGVyZXJSb290IEFic29sdXRlIHBhdGggdG8gYHBhY2thZ2VzL3VpL3NyYy9yZW5kZXJlcmAuXG4gKiBAcGFyYW0geyhtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWR9IFtwYXJhbXMud2Fybl0gV2FybmluZyBsb2dnZXIuXG4gKiBAcGFyYW0ge3N0cmluZ1tdfSBbcGFyYW1zLnNvdXJjZVJvb3RzXSBPcHRpb25hbCBvdmVycmlkZSBsaXN0IG9mIGAuLi4vbW9uYWNvLWVkaXRvci9taW4vdnNgIHJvb3RzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29weU1vbmFjb1B1YmxpY0Fzc2V0cyhwYXJhbXMpIHtcbiAgY29uc3QgdWlSZW5kZXJlclJvb3QgPSBwYXJhbXM/LnVpUmVuZGVyZXJSb290XG4gIGlmICghdWlSZW5kZXJlclJvb3QpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJjb3B5TW9uYWNvUHVibGljQXNzZXRzOiB1aVJlbmRlcmVyUm9vdCBpcyByZXF1aXJlZFwiKVxuICB9XG5cbiAgY29uc3Qgd2FybiA9IHBhcmFtcz8ud2FybiA/PyAoKG1lc3NhZ2UpID0+IGNvbnNvbGUud2FybihtZXNzYWdlKSlcbiAgY29uc3QgcHVibGljRGlyID0gcmVzb2x2ZSh1aVJlbmRlcmVyUm9vdCwgXCJwdWJsaWNcIilcbiAgY29uc3QgZGVzdFJvb3QgPSByZXNvbHZlKHB1YmxpY0RpciwgXCJtb25hY28vdnNcIilcblxuICBjb25zdCBjYW5kaWRhdGVzID1cbiAgICBwYXJhbXM/LnNvdXJjZVJvb3RzPy5sZW5ndGggPiAwXG4gICAgICA/IHBhcmFtcy5zb3VyY2VSb290c1xuICAgICAgOiBbXG4gICAgICAgICAgLy8gV29ya3NwYWNlIHJvb3QgaG9pc3RlZCBkZXBzLlxuICAgICAgICAgIHJlc29sdmUocHJvY2Vzcy5jd2QoKSwgXCJub2RlX21vZHVsZXMvbW9uYWNvLWVkaXRvci9taW4vdnNcIiksXG4gICAgICAgICAgLy8gVUkgcGFja2FnZSBsb2NhbCBkZXBzIChjb3ZlcnMgbm9uLWhvaXN0ZWQgaW5zdGFsbHMpLlxuICAgICAgICAgIHJlc29sdmUocHJvY2Vzcy5jd2QoKSwgXCJwYWNrYWdlcy91aS9ub2RlX21vZHVsZXMvbW9uYWNvLWVkaXRvci9taW4vdnNcIiksXG4gICAgICAgIF1cblxuICBjb25zdCBzb3VyY2VSb290ID0gY2FuZGlkYXRlcy5maW5kKChwKSA9PiBmcy5leGlzdHNTeW5jKHJlc29sdmUocCwgXCJsb2FkZXIuanNcIikpKVxuICBpZiAoIXNvdXJjZVJvb3QpIHtcbiAgICB3YXJuKFwiTW9uYWNvIHNvdXJjZSBkaXJlY3Rvcnkgbm90IGZvdW5kOyBza2lwcGluZyBjb3B5XCIpXG4gICAgcmV0dXJuXG4gIH1cblxuICBjb25zdCBjb3B5UmVjdXJzaXZlID0gKHNyYywgZGVzdCkgPT4ge1xuICAgIGNvbnN0IHN0YXQgPSBmcy5zdGF0U3luYyhzcmMpXG4gICAgaWYgKHN0YXQuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgZnMubWtkaXJTeW5jKGRlc3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG4gICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGZzLnJlYWRkaXJTeW5jKHNyYykpIHtcbiAgICAgICAgY29weVJlY3Vyc2l2ZShyZXNvbHZlKHNyYywgZW50cnkpLCByZXNvbHZlKGRlc3QsIGVudHJ5KSlcbiAgICAgIH1cbiAgICAgIHJldHVyblxuICAgIH1cbiAgICBmcy5jb3B5RmlsZVN5bmMoc3JjLCBkZXN0KVxuICB9XG5cbiAgLy8gS2VlcCB0aGUgd29ya2luZyB0cmVlIGNsZWFuOyB0aGVzZSBhc3NldHMgYXJlIGdlbmVyYXRlZC5cbiAgdHJ5IHtcbiAgICBmcy5ybVN5bmMoZGVzdFJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KVxuICB9IGNhdGNoIHtcbiAgICAvLyBpZ25vcmVcbiAgfVxuICBmcy5ta2RpclN5bmMoZGVzdFJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG5cbiAgLy8gQ29weSBjb3JlIE1vbmFjbyBydW50aW1lLlxuICBmb3IgKGNvbnN0IGRpciBvZiBbXCJiYXNlXCIsIFwiZWRpdG9yXCIsIFwicGxhdGZvcm1cIl0pIHtcbiAgICBjb25zdCBzcmMgPSByZXNvbHZlKHNvdXJjZVJvb3QsIGRpcilcbiAgICBpZiAoZnMuZXhpc3RzU3luYyhzcmMpKSB7XG4gICAgICBjb3B5UmVjdXJzaXZlKHNyYywgcmVzb2x2ZShkZXN0Um9vdCwgZGlyKSlcbiAgICB9XG4gIH1cblxuICAvLyBsb2FkZXIuanMgaXMgcmVxdWlyZWQuXG4gIGNvcHlSZWN1cnNpdmUocmVzb2x2ZShzb3VyY2VSb290LCBcImxvYWRlci5qc1wiKSwgcmVzb2x2ZShkZXN0Um9vdCwgXCJsb2FkZXIuanNcIikpXG5cbiAgLy8gQ29weSBiYXNlbGluZSByaWNoIGxhbmd1YWdlIHBhY2thZ2VzICsgd29ya2Vycy5cbiAgZm9yIChjb25zdCBsYW5nIG9mIFtcInR5cGVzY3JpcHRcIiwgXCJodG1sXCIsIFwianNvblwiLCBcImNzc1wiXSkge1xuICAgIGNvbnN0IHNyYyA9IHJlc29sdmUoc291cmNlUm9vdCwgXCJsYW5ndWFnZVwiLCBsYW5nKVxuICAgIGlmIChmcy5leGlzdHNTeW5jKHNyYykpIHtcbiAgICAgIGNvcHlSZWN1cnNpdmUoc3JjLCByZXNvbHZlKGRlc3RSb290LCBcImxhbmd1YWdlXCIsIGxhbmcpKVxuICAgIH1cbiAgfVxuXG4gIC8vIENvcHkgYmFzZWxpbmUgYmFzaWMgdG9rZW5pemVycy5cbiAgZm9yIChjb25zdCBsYW5nIG9mIFtcInB5dGhvblwiLCBcIm1hcmtkb3duXCIsIFwiY3BwXCIsIFwia290bGluXCJdKSB7XG4gICAgY29uc3Qgc3JjID0gcmVzb2x2ZShzb3VyY2VSb290LCBcImJhc2ljLWxhbmd1YWdlc1wiLCBsYW5nKVxuICAgIGlmIChmcy5leGlzdHNTeW5jKHNyYykpIHtcbiAgICAgIGNvcHlSZWN1cnNpdmUoc3JjLCByZXNvbHZlKGRlc3RSb290LCBcImJhc2ljLWxhbmd1YWdlc1wiLCBsYW5nKSlcbiAgICB9XG4gIH1cblxuICAvLyBDb3B5IG1vbmFjby5jb250cmlidXRpb24uanMgZW50cnlwb2ludHMgKG5lZWRlZCBieSBzb21lIGxvYWRzKS5cbiAgY29uc3QgbW9uYWNvQ29udHJpYnV0aW9uID0gcmVzb2x2ZShzb3VyY2VSb290LCBcImJhc2ljLWxhbmd1YWdlc1wiLCBcIm1vbmFjby5jb250cmlidXRpb24uanNcIilcbiAgaWYgKGZzLmV4aXN0c1N5bmMobW9uYWNvQ29udHJpYnV0aW9uKSkge1xuICAgIGNvcHlSZWN1cnNpdmUobW9uYWNvQ29udHJpYnV0aW9uLCByZXNvbHZlKGRlc3RSb290LCBcImJhc2ljLWxhbmd1YWdlc1wiLCBcIm1vbmFjby5jb250cmlidXRpb24uanNcIikpXG4gIH1cbiAgY29uc3QgdW5kZXJzY29yZUNvbnRyaWJ1dGlvbiA9IHJlc29sdmUoc291cmNlUm9vdCwgXCJiYXNpYy1sYW5ndWFnZXNcIiwgXCJfLmNvbnRyaWJ1dGlvbi5qc1wiKVxuICBpZiAoZnMuZXhpc3RzU3luYyh1bmRlcnNjb3JlQ29udHJpYnV0aW9uKSkge1xuICAgIGNvcHlSZWN1cnNpdmUodW5kZXJzY29yZUNvbnRyaWJ1dGlvbiwgcmVzb2x2ZShkZXN0Um9vdCwgXCJiYXNpYy1sYW5ndWFnZXNcIiwgXCJfLmNvbnRyaWJ1dGlvbi5qc1wiKSlcbiAgfVxufVxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvYWxleHNoYXBpcm8vY29udHJhY3RzL0NvZGVOb21hZC9wYWNrYWdlcy91aVwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL2FsZXhzaGFwaXJvL2NvbnRyYWN0cy9Db2RlTm9tYWQvcGFja2FnZXMvdWkvdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1VzZXJzL2FsZXhzaGFwaXJvL2NvbnRyYWN0cy9Db2RlTm9tYWQvcGFja2FnZXMvdWkvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBjcmVhdGVDb2RlTm9tYWRVaUNvbmZpZyB9IGZyb20gXCIuL3ZpdGUuc2hhcmVkXCJcblxuZXhwb3J0IGRlZmF1bHQgY3JlYXRlQ29kZU5vbWFkVWlDb25maWcodHJ1ZSlcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBd1UsT0FBT0EsU0FBUTtBQUN2VixTQUE0QixvQkFBb0I7QUFDaEQsT0FBTyxXQUFXO0FBQ2xCLFNBQVMsV0FBQUMsZ0JBQWU7OztBQ0gwVixPQUFPLFFBQVE7QUFDalksU0FBUyxlQUFl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QWEsU0FBUywrQkFBK0IsR0FBRztBQUMxRCxxQkFBTztBQUFBLFlBQ1Q7QUFFQSxnQkFBSSxhQUFhLFNBQVMsNkJBQTZCLEtBQUssYUFBYSxTQUFTLHlCQUF5QixHQUFHO0FBQzVHLHFCQUFPO0FBQUEsWUFDVDtBQUVBLGdCQUFJLGFBQWEsU0FBUywwQkFBMEIsR0FBRztBQUNyRCxxQkFBTztBQUFBLFlBQ1Q7QUFFQSxnQkFBSSxhQUFhLFNBQVMsOEJBQThCLEdBQUc7QUFDekQscUJBQU87QUFBQSxZQUNUO0FBRUEsZ0JBQ0UsYUFBYSxTQUFTLDhCQUE4QixLQUNwRCxhQUFhLFNBQVMsa0JBQWtCLEdBQ3hDO0FBQ0EscUJBQU87QUFBQSxZQUNUO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0YsRUFBRTtBQUNKOzs7QUVsTEEsSUFBTyxzQkFBUSx3QkFBd0IsSUFBSTsiLAogICJuYW1lcyI6IFsiZnMiLCAicmVzb2x2ZSIsICJmcyIsICJyZXNvbHZlIl0KfQo=
