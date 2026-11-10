/**
 * Plain-JS static handler for the local music folder, shared by the Vite
 * dev/preview middleware (tooling/serveMusic.ts) and the production server
 * (server.mjs). Serves files under `musicRoot` at `/music/*` with HTTP Range
 * support (required for <audio> seeking).
 */

import fs from "node:fs";
import path from "node:path";

const MIME_TYPES = {
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".mp4": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".wma": "audio/x-ms-wma",
  ".ape": "audio/ape",
  ".wv": "audio/wavpack",
  ".lrc": "text/plain; charset=utf-8",
};

/**
 * @param {string} musicRoot absolute or relative path to the local music folder
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, next: () => void) => void}
 */
export function createMusicMiddleware(musicRoot) {
  const resolvedRoot = path.resolve(musicRoot);

  return (req, res, next) => {
    const url = req.url ?? "";
    if (!url.startsWith("/music/")) {
      next();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.split("?")[0] ?? "");
    } catch {
      res.statusCode = 400;
      res.end("Bad request");
      return;
    }

    const relative = pathname.slice("/music/".length);
    const resolved = path.resolve(resolvedRoot, relative);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (!stat.isFile()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const size = stat.size;
    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", contentType);

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }

      let start;
      let end;
      const startRaw = match[1] ?? "";
      const endRaw = match[2] ?? "";
      if (startRaw === "" && endRaw === "") {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      } else if (startRaw === "") {
        // Suffix range: last N bytes.
        const suffix = Number(endRaw);
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = Number(startRaw);
        end = endRaw === "" ? size - 1 : Math.min(Number(endRaw), size - 1);
      }

      if (start >= size || start > end) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }

      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      fs.createReadStream(resolved, { start, end }).pipe(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Length", String(size));
    fs.createReadStream(resolved).pipe(res);
  };
}
