/**
 * Dev/preview middleware that serves the local music folder at `/music/*`.
 * The implementation lives in tooling/musicStatic.mjs (plain JS, shared with server.mjs).
 */

import type { Plugin } from "vite";
import { createMusicMiddleware } from "./musicStatic.mjs";

export { createMusicMiddleware };

export function musicMiddlewarePlugin(musicRoot: string): Plugin {
  const middleware = createMusicMiddleware(musicRoot);
  return {
    name: "better-lyrics:music-middleware",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
