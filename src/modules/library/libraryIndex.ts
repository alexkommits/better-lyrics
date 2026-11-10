/**
 * Library index format — `public/library.json` as written by `npm run library`
 * (tooling/build-library.ts) and read by the player shell.
 *
 * Audio files are served as-is from the `music/` directory; the index only references them. The
 * index itself and the extracted artwork directory are generated artifacts and are git-ignored.
 */

import type { SongMetadata } from "./songMetadata";

export const LIBRARY_INDEX_VERSION = 1;

export interface LibraryTrack {
  /** Stable id (see trackId.ts). */
  id: string;
  /** URL path the dev/preview server (and production server.mjs) serves this file from. */
  path: string;
  metadata: SongMetadata;
  /** Web path to the extracted embedded cover art, when present. */
  art?: string;
  /** Same-basename sidecar lyric files found next to the audio, by extension. */
  sidecars?: Record<string, string>;
  /** Embedded lyric text (USLT / Vorbis LYRICS / MP4 ©lyr), when present. */
  embeddedLyrics?: string;
  /** File size in bytes — lets the UI show library stats without HEAD requests. */
  sizeBytes: number;
}

export interface LibraryIndex {
  version: typeof LIBRARY_INDEX_VERSION;
  generatedAt: string;
  /** Absolute path of the scanned root, for debugging (never sent to providers). */
  root: string;
  tracks: LibraryTrack[];
}

/** Fetches and validates `library.json`; returns null when the library has not been built yet. */
export async function fetchLibraryIndex(signal?: AbortSignal): Promise<LibraryIndex | null> {
  const response = await fetch("/library.json", signal ? { signal } : undefined);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to load library.json: ${response.status}`);
  const json = (await response.json()) as LibraryIndex;
  if (json.version !== LIBRARY_INDEX_VERSION) {
    throw new Error(`library.json has unsupported version ${String(json.version)}`);
  }
  return json;
}
