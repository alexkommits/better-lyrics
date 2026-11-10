#!/usr/bin/env node
/**
 * Production static + proxy server for the Better Lyrics standalone web app.
 *
 * Serves the built app from `dist/` (run `npm run build` first), the local music folder at
 * `/music/*` (HTTP Range requests supported), and the two CORS-hostile upstreams the app needs,
 * which the dev server normally proxies for you:
 *
 *   /youtubei/v1/*     -> https://www.youtube.com/youtubei/v1/*      (InnerTube; the resolver)
 *   /translate-proxy/* -> https://translate.googleapis.com/*          (Google Translate)
 *   /lyrics-api/*      -> https://lyrics.api.dacubeking.com/*         (unified lyrics stream, SSE)
 *
 * Everything else is local static content — the app works offline against your library
 * without the proxies; the resolver simply falls back to inert when they are absent.
 *
 * Environment:
 *   PORT              Port to listen on (default 8080)
 *   HOST              Bind address (default 0.0.0.0)
 *   MUSIC_DIR         Path to the local music folder (default ./music)
 *   YOUTUBEI_TARGET   Override the InnerTube upstream origin (testing/staging)
 *   TRANSLATE_TARGET  Override the Translate upstream origin (testing/staging)
 *   LYRICS_API_TARGET Override the lyrics API upstream origin (testing/staging)
 *
 * No dependencies beyond Node >= 22.12.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createMusicMiddleware } from "./tooling/musicStatic.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(root, "dist");
const MUSIC_DIR = process.env.MUSIC_DIR ?? path.join(root, "music");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

const YOUTUBEI_TARGET = (process.env.YOUTUBEI_TARGET ?? "https://www.youtube.com").replace(/\/+$/, "");
const TRANSLATE_TARGET = (process.env.TRANSLATE_TARGET ?? "https://translate.googleapis.com").replace(/\/+$/, "");
const LYRICS_API_TARGET = (process.env.LYRICS_API_TARGET ?? "https://lyrics.api.dacubeking.com").replace(/\/+$/, "");

const music = createMusicMiddleware(MUSIC_DIR);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttml": "application/ttml+xml; charset=utf-8",
  ".lrc": "text/plain; charset=utf-8",
};

/** Hop-by-hop headers must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

/**
 * Forwards `req` to `${targetOrigin}${remainder}` preserving method, query string and a safe set
 * of headers, then pipes status, safe headers and body back (streaming — SSE must arrive
 * incrementally). Fixed upstreams only; this is not an open proxy.
 */
async function proxy(req, res, prefix, targetOrigin, stripPrefix) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404).end("Not found");
    return;
  }

  const upstreamPath = stripPrefix ? url.pathname.slice(stripPrefix.length) : url.pathname;
  const upstreamUrl = new URL(upstreamPath + url.search, targetOrigin);
  if (upstreamUrl.origin !== new URL(targetOrigin).origin) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "host" || lower === "content-length" || lower === "accept-encoding") continue;
    if (value !== undefined) headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  // The upstream must see its own host; some services reject foreign Host headers.
  headers.host = new URL(targetOrigin).host;

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readRequestBody(req);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "upstream unreachable", detail: String(error) }));
    return;
  }

  const responseHeaders = {};
  for (const [name, value] of upstream.headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "content-length" || lower === "content-encoding") continue;
    responseHeaders[lower] = value;
  }
  res.writeHead(upstream.status, responseHeaders);
  if (req.method === "HEAD" || !upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(/** @type {import("node:stream/web").ReadableStream} */ (upstream.body)).pipe(res);
}

function send404(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
}

function serveStatic(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Bad request");
    return;
  }

  if (pathname.endsWith("/")) pathname += "index.html";

  const resolved = path.resolve(DIST, "." + pathname);
  if (resolved !== DIST && !resolved.startsWith(DIST + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden");
    return;
  }

  let file = resolved;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // Let extension-less URLs resolve to .html (MPA has no client-side routing).
    if (!path.extname(resolved) && fs.existsSync(`${resolved}.html`)) {
      file = `${resolved}.html`;
    } else {
      send404(res);
      return;
    }
  }

  const ext = path.extname(file).toLowerCase();
  const headers = {
    "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
    "content-length": String(fs.statSync(file).size),
    // Vite emits content-hashed assets; HTML must always be revalidated.
    "cache-control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (url.startsWith("/youtubei/v1/")) {
    void proxy(req, res, "/youtubei/v1/", YOUTUBEI_TARGET, undefined);
    return;
  }
  if (url.startsWith("/translate-proxy/")) {
    void proxy(req, res, "/translate-proxy/", TRANSLATE_TARGET, "/translate-proxy");
    return;
  }
  if (url.startsWith("/lyrics-api/")) {
    void proxy(req, res, "/lyrics-api/", LYRICS_API_TARGET, "/lyrics-api");
    return;
  }
  if (url.startsWith("/music/")) {
    music(req, res, () => send404(res));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Better Lyrics listening on http://${HOST}:${PORT}`);
  console.log(`Serving ${DIST}`);
  console.log(`Music directory: ${MUSIC_DIR}`);
});
