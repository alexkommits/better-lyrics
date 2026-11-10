/**
 * `?demo=<fixtureId>` — boots the app with a synthetic session track whose embedded lyrics are one
 * of the fixtures in `public/demo/` (STANDALONE-WEB-PLAN.md §8.4). Nothing here persists: the track
 * is prepended to the in-memory queue, never written into the library or storage. Audio is a silent
 * 8-second WAV so the <audio> clock really advances through the fixture timings; the embedded text
 * flows through the local tier like any embedded tag, which means richsync fixtures win outright and
 * plain ones fall back to the built-ins.
 */

import type { LibraryTrack } from "@modules/library/libraryIndex";
import type { SongMetadata } from "@modules/library/songMetadata";
import { warnCore } from "@core/logger";

interface DemoManifestEntry {
  id: string;
  title: string;
  artist: string;
  file: string;
  format: string;
  granularity: string;
  note?: string;
}

interface DemoTrack extends LibraryTrack {
  embeddedLyrics: string;
}

const DEMO_DURATION_MS = 8000;
const SILENCE_BYTES = 128_044;

/** Returns the demo track for `?demo=<id>`, or null for normal boot / unknown fixtures. */
export async function loadDemoTrack(): Promise<DemoTrack | null> {
  let demoId: string | null = null;
  try {
    demoId = new URLSearchParams(window.location.search).get("demo");
  } catch {
    return null;
  }
  if (!demoId) return null;

  try {
    const manifestResponse = await fetch("/demo/index.json");
    if (!manifestResponse.ok) {
      warnCore("Demo: could not load the fixture manifest (/demo/index.json):", manifestResponse.status);
      return null;
    }
    const manifest = (await manifestResponse.json()) as DemoManifestEntry[];
    const entry = manifest.find(item => item.id === demoId);
    if (!entry) {
      warnCore(`Demo: unknown fixture "${demoId}" (available: ${manifest.map(item => item.id).join(", ")})`);
      return null;
    }

    const fixtureResponse = await fetch(`/demo/${encodeURIComponent(entry.file)}`);
    if (!fixtureResponse.ok) {
      warnCore("Demo: could not load fixture", entry.file, fixtureResponse.status);
      return null;
    }
    const embeddedLyrics = await fixtureResponse.text();

    const metadata: SongMetadata = {
      raw: { title: entry.title, artists: [entry.artist], durationMs: DEMO_DURATION_MS },
      title: entry.title,
      artists: [entry.artist],
      durationMs: DEMO_DURATION_MS,
      displayTitle: entry.title,
      displayArtist: entry.artist,
      sources: ["file-tags"],
    };
    return {
      id: `demo-${entry.id}`,
      path: "/demo/silence.wav",
      metadata,
      embeddedLyrics,
      sizeBytes: SILENCE_BYTES,
    };
  } catch (error) {
    warnCore("Demo: failed to load fixture", error);
    return null;
  }
}
