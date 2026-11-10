/**
 * Builds the local library index (`public/library.json`) from a directory of audio files.
 *
 *   npm run library                     # scan ./music → ./public/library.json
 *   npm run library -- /path/to/music   # scan a different root
 *   npm run library -- --out x.json     # different index path
 *
 * Reads tags with music-metadata (all common formats), normalizes them through the shared Song
 * model pipeline (src/modules/library/songMetadata.ts), fingerprints the file for a stable track
 * id, finds same-basename sidecar lyric files, extracts embedded cover art to
 * `public/library-art/`, and writes the index. Audio is never copied — the dev/preview server
 * serves `music/` as-is.
 *
 * Generated artifacts (library.json, library-art/) are git-ignored.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { parseBuffer } from "music-metadata";
import { commonToRawTags, rawTagsToSongMetadata, applyFilenameFallback, type SongMetadata } from "../src/modules/library/songMetadata";
import { LIBRARY_INDEX_VERSION, type LibraryIndex, type LibraryTrack } from "../src/modules/library/libraryIndex";
import { trackIdFor } from "../src/modules/library/trackId";

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".m4a",
  ".mp4",
  ".m4b",
  ".ogg",
  ".opus",
  ".wav",
  ".aiff",
  ".aif",
  ".wma",
  ".ape",
  ".wv",
]);
const SIDECAR_EXTENSIONS = [".lrc", ".ttml", ".srt", ".vtt"] as const;
const ART_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

interface CliOptions {
  root: string;
  out: string;
  artDir: string;
  musicUrlPrefix: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  let out = "public/library.json";
  let artDir = "public/library-art";
  let musicUrlPrefix = "/music";
  let root = "music";

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--out") {
      out = args[++index];
    } else if (arg === "--art-dir") {
      artDir = args[++index];
    } else if (arg === "--url-prefix") {
      musicUrlPrefix = args[++index].replace(/\/$/, "");
    } else if (!arg.startsWith("--")) {
      root = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { root: resolve(root), out, artDir, musicUrlPrefix };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

function toWebPath(prefix: string, relativePath: string): string {
  return `${prefix}/${relativePath.split(sep).map(encodeURIComponent).join("/")}`;
}

function sha1HexSync(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

function parseLrcMetadata(text: string): { title?: string; artist?: string; album?: string; durationMs?: number } {
  const result: { title?: string; artist?: string; album?: string; durationMs?: number } = {};
  const patterns: Array<[RegExp, keyof typeof result]> = [
    [/^\[ti:\s*(.+?)\s*\]$/im, "title"],
    [/^\[ar:\s*(.+?)\s*\]$/im, "artist"],
    [/^\[al:\s*(.+?)\s*\]$/im, "album"],
  ];
  for (const [regex, key] of patterns) {
    const match = regex.exec(text);
    if (match?.[1]) (result[key] as string) = match[1];
  }
  const lengthMatch = /^\[length:\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s*\]$/im.exec(text);
  if (lengthMatch) {
    const minutes = Number(lengthMatch[1]);
    const seconds = Number(lengthMatch[2]);
    const fraction = lengthMatch[3] ? Number(`0.${lengthMatch[3]}`) : 0;
    result.durationMs = Math.round((minutes * 60 + seconds + fraction) * 1000);
  }
  return result;
}

interface ScanOutcome {
  track?: LibraryTrack;
  error?: string;
}

async function scanFile(filePath: string, options: CliOptions): Promise<ScanOutcome> {
  const relativePath = relative(options.root, filePath).split(sep).join("/");
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    return { error: `read: ${(error as Error).message}` };
  }
  const sizeBytes = bytes.byteLength;

  const id = await trackIdFor(relativePath, bytes);

  // -- Tags → SongMetadata
  let metadata: SongMetadata;
  let embeddedLyrics: string | undefined;
  let artBuffer: { data: Uint8Array; format: string } | undefined;
  let parseSucceeded = false;
  try {
    const parsed = await parseBuffer(bytes, { path: filePath }, { duration: true });
    parseSucceeded = true;
    const common = parsed.common as unknown as Record<string, unknown>;
    const durationMs =
      parsed.format.duration && Number.isFinite(parsed.format.duration)
        ? Math.round(parsed.format.duration * 1000)
        : undefined;

    const raw = commonToRawTags(common as Parameters<typeof commonToRawTags>[0], durationMs);
    const built = rawTagsToSongMetadata(raw, { sources: ["file-tags"] });
    metadata = applyFilenameFallback(built, basename(filePath));

    // Embedded lyrics: music-metadata v12 exposes common.lyrics as { text, description, … }[].
    const lyricsTags = (common as { lyrics?: Array<{ text?: string; lyrics?: string }> }).lyrics;
    const lyricsText = (Array.isArray(lyricsTags) ? lyricsTags : [])
      .map(entry => (typeof entry?.text === "string" ? entry.text : entry?.lyrics))
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
      .join("\n\n")
      .trim();
    if (lyricsText) embeddedLyrics = lyricsText;

    const pictures = (common as { picture?: Array<{ data: Uint8Array; format?: string }> }).picture;
    const picture = pictures?.[0];
    if (picture && picture.data && picture.data.byteLength > 0) {
      artBuffer = { data: new Uint8Array(picture.data), format: picture.format ?? "image/jpeg" };
    }
  } catch {
    // Unreadable/corrupt tags — fall back to the filename entirely (duration stays 0 = unknown).
    metadata = applyFilenameFallback(
      rawTagsToSongMetadata({ durationMs: 0 }, { sources: ["file-tags"] }),
      basename(filePath)
    );
  }

  // -- Sidecars (same basename)
  const sidecars: Record<string, string> = {};
  const baseNoExt = join(options.root, relativePath.slice(0, relativePath.length - extname(relativePath).length));
  for (const ext of SIDECAR_EXTENSIONS) {
    const candidate = baseNoExt + ext;
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      sidecars[ext.slice(1)] = toWebPath(options.musicUrlPrefix, `${relativePath.slice(0, relativePath.length - extname(relativePath).length)}${ext}`);
      // LRC heads can fill missing title/artist/album/duration — enrichment never overrides tags.
      if (ext === ".lrc") {
        const lrc = parseLrcMetadata(readFileSync(candidate, "utf8"));
        if (lrc.title && metadata.title === "Unknown title") {
          metadata = { ...metadata, title: lrc.title, displayTitle: lrc.title };
          if (!metadata.sources.includes("sidecar")) metadata.sources = [...metadata.sources, "sidecar"];
        }
        if (lrc.artist && metadata.artists.length === 0) {
          const names = lrc.artist.split(/[,，&/·•]/).map(s => s.trim()).filter(Boolean);
          if (names.length > 0) {
            metadata = { ...metadata, artists: names, displayArtist: names.join(", ") };
            if (!metadata.sources.includes("sidecar")) metadata.sources = [...metadata.sources, "sidecar"];
          }
        }
        if (lrc.album && !metadata.album) {
          metadata = { ...metadata, album: lrc.album };
          if (!metadata.sources.includes("sidecar")) metadata.sources = [...metadata.sources, "sidecar"];
        }
        if (lrc.durationMs && metadata.durationMs === 0) {
          metadata = { ...metadata, durationMs: lrc.durationMs };
          if (!metadata.sources.includes("sidecar")) metadata.sources = [...metadata.sources, "sidecar"];
        }
      }
    } catch {
      /* no sidecar at this extension */
    }
  }

  // -- Embedded artwork → public/library-art/<id>.<ext>
  let art: string | undefined;
  if (artBuffer) {
    const extension = ART_MIME_EXTENSIONS[artBuffer.format.toLowerCase()] ?? "bin";
    mkdirSync(options.artDir, { recursive: true });
    const artName = `${id}.${extension}`;
    writeFileSync(join(options.artDir, artName), artBuffer.data);
    art = `/library-art/${artName}`;
  }

  const track: LibraryTrack = {
    id,
    path: toWebPath(options.musicUrlPrefix, relativePath),
    metadata,
    sizeBytes,
  };
  if (art) track.art = art;
  if (Object.keys(sidecars).length > 0) track.sidecars = sidecars;
  if (embeddedLyrics) track.embeddedLyrics = embeddedLyrics;

  return { track };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  let stat;
  try {
    stat = statSync(options.root);
  } catch {
    console.error(`Music directory not found: ${options.root}`);
    console.error("Create it and drop audio files in, or pass a different root: npm run library -- /path/to/music");
    process.exitCode = 1;
    return;
  }
  if (!stat.isDirectory()) {
    console.error(`Not a directory: ${options.root}`);
    process.exitCode = 1;
    return;
  }

  const files = [...walk(options.root)].sort((a, b) => a.localeCompare(b));
  console.log(`Scanning ${files.length} audio file(s) in ${options.root} …`);

  const tracks: LibraryTrack[] = [];
  const failures: Array<{ file: string; error: string }> = [];
  let filenameFallbacks = 0;
  let withArt = 0;
  let withSidecars = 0;
  let withEmbeddedLyrics = 0;

  for (const file of files) {
    const relativePath = relative(options.root, file);
    const outcome = await scanFile(file, options);
    if (!outcome.track) {
      failures.push({ file: relativePath, error: outcome.error ?? "unknown" });
      continue;
    }
    if (outcome.track.metadata.sources.includes("filename")) filenameFallbacks++;
    if (outcome.track.art) withArt++;
    if (outcome.track.sidecars) withSidecars++;
    if (outcome.track.embeddedLyrics) withEmbeddedLyrics++;
    tracks.push(outcome.track);
  }

  const index: LibraryIndex = {
    version: LIBRARY_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    root: options.root,
    tracks,
  };

  const outPath = resolve(options.out);
  mkdirSync(join(outPath, ".."), { recursive: true });
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(index));
  renameSync(tmpPath, outPath);

  const durationMs = Date.now() - startedAt;
  console.log(`\nLibrary index written to ${options.out} in ${durationMs} ms`);
  console.log(`  tracks:             ${tracks.length}`);
  console.log(`  filename fallback:  ${filenameFallbacks}`);
  console.log(`  with artwork:       ${withArt}`);
  console.log(`  with sidecars:      ${withSidecars}`);
  console.log(`  embedded lyrics:    ${withEmbeddedLyrics}`);
  if (failures.length > 0) {
    console.log(`  failures:           ${failures.length}`);
    for (const failure of failures) console.log(`    - ${failure.file}: ${failure.error}`);
  }
}

void main();
