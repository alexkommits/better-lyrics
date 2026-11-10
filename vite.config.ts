import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { musicMiddlewarePlugin } from "./tooling/serveMusic";

const root = fileURLToPath(new URL(".", import.meta.url));
const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  appType: "mpa",
  plugins: [musicMiddlewarePlugin(fileURLToPath(new URL("./music", import.meta.url)))],
  server: {
    // Bind all interfaces so the preview environment can reach the dev server.
    host: true,
    port: 5173,
    // Arena preview hosts are dynamic subdomains; allow them all.
    allowedHosts: true,
    proxy: {
      // InnerTube is undocumented and CORS-hostile; the app calls it through this path.
      // Shapes drift often — see STANDALONE-WEB-PLAN.md section 6.5.
      "/youtubei/v1": {
        target: process.env.YOUTUBEI_TARGET ?? "https://www.youtube.com",
        changeOrigin: true,
      },
      // translate.googleapis.com does not send CORS headers; route through the dev server.
      "/translate-proxy": {
        target: process.env.TRANSLATE_TARGET ?? "https://translate.googleapis.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/translate-proxy/, ""),
      },
      // The unified lyrics API (Turnstile verification + SSE stream) sends no CORS headers;
      // route through the dev server. Streams SSE — see STANDALONE-WEB-PLAN.md §13 note.
      "/lyrics-api": {
        target: process.env.LYRICS_API_TARGET ?? "https://lyrics.api.dacubeking.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/lyrics-api/, ""),
      },
    },
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
    // Mirror the dev proxies so `npm run preview` is fully functional, not just a static shell.
    proxy: {
      "/youtubei/v1": {
        target: process.env.YOUTUBEI_TARGET ?? "https://www.youtube.com",
        changeOrigin: true,
      },
      "/translate-proxy": {
        target: process.env.TRANSLATE_TARGET ?? "https://translate.googleapis.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/translate-proxy/, ""),
      },
      "/lyrics-api": {
        target: process.env.LYRICS_API_TARGET ?? "https://lyrics.api.dacubeking.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/lyrics-api/, ""),
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        settings: fileURLToPath(new URL("./settings.html", import.meta.url)),
        editor: fileURLToPath(new URL("./editor.html", import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      "@": src(""),
      "@core": src("core"),
      "@modules": src("modules"),
      "@options": src("options"),
      "@app": src("app"),
      "@tooling": fileURLToPath(new URL("./tooling", import.meta.url)),
      "@constants": src("core/constants.ts"),
      "@utils": src("core/utils.ts"),
    },
  },
});
