import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  appType: "mpa",
  server: {
    // Bind all interfaces so the preview environment can reach the dev server.
    host: true,
    port: 5173,
    proxy: {
      // InnerTube is undocumented and CORS-hostile; the app calls it through this path.
      // Shapes drift often — see STANDALONE-WEB-PLAN.md section 6.5.
      "/youtubei/v1": {
        target: "https://www.youtube.com",
        changeOrigin: true,
      },
      // translate.googleapis.com does not send CORS headers; route through the dev server.
      "/translate-proxy": {
        target: "https://translate.googleapis.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/translate-proxy/, ""),
      },
    },
  },
  preview: {
    host: true,
    port: 4173,
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
      "@tooling": fileURLToPath(new URL("./tooling", import.meta.url)),
      "@constants": src("core/constants.ts"),
      "@utils": src("core/utils.ts"),
    },
  },
});
