import fs from "fs"
import { type PluginOption, defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { resolve } from "path"
import { copyMonacoPublicAssets } from "./scripts/monaco-public-assets.js"

const uiPackageJson = JSON.parse(
  fs.readFileSync(resolve(__dirname, "package.json"), "utf-8"),
) as { version?: string }
const uiVersion = uiPackageJson.version ?? "0.0.0"

function monacoPublicAssetsPlugin(): PluginOption {
  return {
    name: "prepare-monaco-public-assets",
    configureServer(server) {
      copyMonacoPublicAssets({
        uiRendererRoot: resolve(__dirname, "src/renderer"),
        warn: (msg) => server.config.logger.warn(msg),
        sourceRoots: [
          resolve(__dirname, "../../node_modules/monaco-editor/min/vs"),
          resolve(__dirname, "node_modules/monaco-editor/min/vs"),
        ],
      })
    },
    buildStart() {
      copyMonacoPublicAssets({
        uiRendererRoot: resolve(__dirname, "src/renderer"),
        warn: (msg) => this.warn(msg),
        sourceRoots: [
          resolve(__dirname, "../../node_modules/monaco-editor/min/vs"),
          resolve(__dirname, "node_modules/monaco-editor/min/vs"),
        ],
      })
    },
  }
}

function uiVersionPlugin(): PluginOption {
  return {
    name: "emit-ui-version",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "ui-version.json",
        source: JSON.stringify({ uiVersion }, null, 2),
      })
    },
  }
}

/** PWA plugins — only loaded when vite-plugin-pwa is installed (standalone / Electron UI builds). */
export async function pwaPlugins(): Promise<PluginOption[]> {
  const { VitePWA } = await import("vite-plugin-pwa")

  return [
    {
      name: "prepare-pwa-source-icon",
      apply: "build",
      buildStart() {
        const source = resolve(__dirname, "src/images/CodeNomad-Icon.png")
        const publicDir = resolve(__dirname, "src/renderer/public")
        const dest = resolve(publicDir, "logo.png")
        fs.mkdirSync(publicDir, { recursive: true })
        fs.copyFileSync(source, dest)
      },
    },
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      pwaAssets: {
        preset: "minimal-2023",
        image: "public/logo.png",
      },
      manifest: {
        name: "CodeNomad",
        short_name: "CodeNomad",
        id: "/",
        start_url: "/",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        background_color: "#1a1a1a",
        theme_color: "#1a1a1a",
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: null,
        globPatterns: ["**/*.{js,css,png,jpg,jpeg,svg,webp,ico,woff,woff2,ttf,eot,json,webmanifest}"],
        globIgnores: [
          "**/*.html",
          "**/assets/*worker-*.js",
          "**/assets/editor.api-*.js",
          "**/monaco/vs/**/*",
        ],
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) => {
              if (url.pathname.startsWith("/api/")) return false
              if (request.destination === "document") return false
              return ["script", "style", "image", "font"].includes(request.destination)
            },
            handler: "CacheFirst",
            options: {
              cacheName: "asset-cache",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ]
}

export function createCodeNomadUiConfig(enablePwa: boolean) {
  return defineConfig(async () => ({
    root: "./src/renderer",
    plugins: [solid(), monacoPublicAssetsPlugin(), uiVersionPlugin(), ...(enablePwa ? await pwaPlugins() : [])],
    css: {
      postcss: "./postcss.config.js",
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
      },
    },
    esbuild: {
      jsx: "automatic",
      jsxImportSource: "solid-js",
    },
    optimizeDeps: {
      exclude: ["lucide-solid"],
      esbuildOptions: {
        jsx: "automatic",
        jsxImportSource: "solid-js",
      },
    },
    ssr: {
      noExternal: ["lucide-solid"],
    },
    server: {
      port: 3000,
    },
    build: {
      outDir: "dist",
      rollupOptions: {
        input: {
          main: resolve(__dirname, "./src/renderer/index.html"),
          loading: resolve(__dirname, "./src/renderer/loading.html"),
        },
        output: {
          manualChunks(id: string) {
            const normalizedId = id.replace(/\\/g, "/")

            if (normalizedId.includes("/node_modules/@git-diff-view/")) {
              return "git-diff-vendor"
            }

            if (normalizedId.includes("/node_modules/highlight.js/") || normalizedId.includes("/node_modules/lowlight/")) {
              return "highlight-vendor"
            }

            if (normalizedId.includes("/node_modules/fast-diff/")) {
              return "fast-diff-vendor"
            }

            if (normalizedId.includes("/node_modules/monaco-editor/")) {
              return "monaco-vendor"
            }

            if (
              normalizedId.includes("/src/components/file-viewer/") ||
              normalizedId.includes("/src/lib/monaco/")
            ) {
              return "monaco-viewer"
            }
          },
        },
      },
    },
  }))
}
