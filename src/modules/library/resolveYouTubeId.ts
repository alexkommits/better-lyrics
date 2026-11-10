/**
 * YouTube ID resolution (STANDALONE-WEB-PLAN.md §7). Local files rarely carry one, but Unison and
 * the YouTube-backed providers key off it, so the resolver tries, in order:
 *
 *   1. **Manual override** — `blyricsYtIdManual_<trackId>`, wins over everything.
 *   2. **Embedded in tags** — deterministic. Every string tag value we hold (comment URLs, the
 *      model's `raw.urls`, embedded lyric text) is scanned for YouTube URL shapes. Zero network.
 *   3. **Per-track cache** — `blyricsYtId_<trackId>` ({id, via, confidence, resolvedAt}), 90 days
 *      (§6.7). Stores positive network answers so they are not re-searched every play.
 *   4. **InnerTube search via the dev proxy** — `POST /youtubei/v1/search` (WEB_REMIX), gated to
 *      the dev server (`import.meta.env.DEV`) where the proxy exists. Candidates must agree on
 *      duration (±2 s), title (≥ 0.85) and artist (≥ 0.6); anything weaker is a miss, not a guess.
 *   5. **YouTube Data API v3** — only when `blyrics-youtube-data-api-key` is set (empty by
 *      default; the settings page wires it in M5). CORS-open, no proxy.
 *
 * ISRC is never used to synthesize an ID. Nothing is ever written to YouTube. The sibling privacy
 * toggle is `blyrics-resolve-youtube-ids` (default on); off disables the resolver entirely.
 *
 * Network legs fail inert: any error, timeout or unrecognized response yields `null` and playback
 * continues with local lyrics and the metadata-only provider path (§6.3).
 */

import { getTransientStorage, setTransientStorage, setPersistentStorage } from "@core/storage";
import { logCore } from "@core/logger";
import { registerThemeSetting } from "@braccato/core/themeSettings";
import { stringSimilarity } from "@modules/lyrics/lyricParseUtils";
import type { SongMetadata } from "@modules/library/songMetadata";

interface ResolvedYouTubeId {
  id: string;
  via: "embedded-tag" | "innertube" | "data-api" | "manual";
  confidence: "exact" | "fuzzy";
}

interface CachedYouTubeId extends ResolvedYouTubeId {
  resolvedAt: number;
}

interface ResolveYouTubeIdOptions {
  signal: AbortSignal;
  /** Local track identity — the cache/manual keys are `<prefix><trackId>`, never a bare video id. */
  trackId: string;
  /** Extra raw tag/lyric text to scan (e.g. the embedded lyric body), in addition to the model's raw strings. */
  extraScanTexts?: readonly string[];
}

const RESOLVE_SETTING_KEY = "blyrics-resolve-youtube-ids";
const DATA_API_KEY_SETTING_KEY = "blyrics-youtube-data-api-key";
const resolveEnabled = registerThemeSetting(RESOLVE_SETTING_KEY, true, true);
const dataApiKey = registerThemeSetting(DATA_API_KEY_SETTING_KEY, "");

const YT_ID_PATTERN = /(?:youtube\.com\/(?:watch\?[^"'\s]*[?&]?v=|shorts\/|embed\/)|youtu\.be\/|music\.youtube\.com\/watch\?[^"'\s]*[?&]?v=)([A-Za-z0-9_-]{11})/;
const ID_STRICT = /^[A-Za-z0-9_-]{11}$/;
const CACHE_PREFIX = "blyricsYtId_";
const MANUAL_PREFIX = "blyricsYtIdManual_";
/** §6.7: the YT-ID cache lives 90 days. */
export const YTID_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function isValidYouTubeId(id: string): boolean {
  return ID_STRICT.test(id);
}

/**
 * Deterministically scans raw text for a YouTube ID. Returns the first match in input order, or
 * null. Pure — the self-checks exercise it directly; `resolveYouTubeId` feeds it the model.
 */
export function findEmbeddedYouTubeId(texts: readonly string[]): string | null {
  for (const text of texts) {
    if (!text) continue;
    const match = YT_ID_PATTERN.exec(text);
    if (match) return match[1];
  }
  return null;
}

interface SearchCandidate {
  videoId: string;
  title: string;
  artists: string;
  /** Candidate length in milliseconds, when the renderer carries it. */
  durationMs: number | null;
}

function textOfRuns(runs: unknown): string {
  if (!Array.isArray(runs)) return "";
  return runs
    .map(run => (run && typeof run === "object" && typeof (run as { text?: unknown }).text === "string" ? (run as { text: string }).text : ""))
    .join("")
    .trim();
}

function parseDurationText(text: string): number | null {
  const match = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const [, a, b, c] = match;
  const seconds = c !== undefined ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Pulls the search candidates out of a WEB_REMIX search response. Pure — fed a canned payload by
 * the self-checks. Any unrecognized shape yields an empty list, never an exception.
 */
export function innertubeSearchCandidates(payload: unknown): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    const renderer = record.musicResponsiveListItemRenderer as Record<string, unknown> | undefined;
    if (renderer) {
      const candidate = candidateFromRenderer(renderer);
      if (candidate && !seen.has(candidate.videoId)) {
        seen.add(candidate.videoId);
        candidates.push(candidate);
      }
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };

  const candidateFromRenderer = (renderer: Record<string, unknown>): SearchCandidate | null => {
    const overlay = renderer.overlay as Record<string, unknown> | undefined;
    const playNav = (
      overlay?.musicItemThumbnailOverlayRenderer as Record<string, unknown> | undefined
    )?.content as Record<string, unknown> | undefined;
    const playButton = playNav?.musicPlayButtonRenderer as Record<string, unknown> | undefined;
    const playEndpoint = playButton?.playNavigationEndpoint as Record<string, unknown> | undefined;

    const videoId =
      (playEndpoint?.watchEndpoint as Record<string, unknown> | undefined)?.videoId ??
      (renderer.playlistItemData as Record<string, unknown> | undefined)?.videoId ??
      ((renderer.navigationEndpoint as Record<string, unknown> | undefined)?.watchEndpoint as Record<string, unknown> | undefined)?.videoId;
    if (typeof videoId !== "string" || !isValidYouTubeId(videoId)) return null;

    const flexColumns = Array.isArray(renderer.flexColumns) ? renderer.flexColumns : [];
    const columnText = (index: number): string => {
      const column = flexColumns[index] as Record<string, unknown> | undefined;
      const text = (column?.musicResponsiveListItemFlexColumnRenderer as Record<string, unknown> | undefined)?.text as
        | Record<string, unknown>
        | undefined;
      if (!text) return "";
      if (Array.isArray(text.runs)) return textOfRuns(text.runs);
      return typeof text.simpleText === "string" ? text.simpleText.trim() : "";
    };
    const title = columnText(0);
    if (!title) return null;
    const artists = columnText(1);

    let durationMs: number | null = null;
    const fixedColumns = Array.isArray(renderer.fixedColumns) ? renderer.fixedColumns : [];
    for (const column of fixedColumns) {
      const text = (column as Record<string, unknown>)?.musicResponsiveListItemFixedColumnRenderer as
        | Record<string, unknown>
        | undefined;
      const simpleText = (text?.text as Record<string, unknown> | undefined)?.simpleText;
      const parsed = parseDurationText(typeof simpleText === "string" ? simpleText : "");
      if (parsed !== null) {
        durationMs = parsed;
        break;
      }
    }

    return { videoId, title, artists, durationMs };
  };

  try {
    visit(payload);
  } catch {
    return [];
  }
  return candidates;
}

/**
 * Scores candidates against the model: nearest duration (±2 s), title ≥ 0.85, artist ≥ 0.6.
 * Returns the best acceptable candidate or null. Pure.
 */
export function pickBestCandidate(
  candidates: readonly SearchCandidate[],
  meta: Pick<SongMetadata, "title" | "artists" | "albumArtist" | "durationMs">
): SearchCandidate | null {
  const title = meta.title;
  const artist = meta.albumArtist ?? meta.artists[0] ?? "";
  const durationMs = meta.durationMs;

  let best: SearchCandidate | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (durationMs > 0 && candidate.durationMs !== null && Math.abs(candidate.durationMs - durationMs) > 2000) continue;
    const titleScore = stringSimilarity(title, candidate.title);
    if (titleScore < 0.85) continue;
    const artistScore = artist && candidate.artists ? stringSimilarity(artist, candidate.artists) : 0;
    if (artist && artistScore < 0.6) continue;
    const score = titleScore + artistScore;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function cacheKey(trackId: string): string {
  return `${CACHE_PREFIX}${trackId}`;
}

function manualKey(trackId: string): string {
  return `${MANUAL_PREFIX}${trackId}`;
}

/** Reads the manual override; null when unset/invalid. Manual wins over everything (§7). */
export async function loadManualYouTubeId(trackId: string): Promise<ResolvedYouTubeId | null> {
  // Persistent storage uses the same localStorage area with expiry 0.
  const raw = await getTransientStorage(manualKey(trackId));
  const id = typeof raw === "string" ? raw : "";
  if (isValidYouTubeId(id)) return { id, via: "manual", confidence: "exact" };
  return null;
}

/** Stores or clears the manual override. Persistent, not cached; wins over auto resolution. */
export async function saveManualYouTubeId(trackId: string, id: string | null): Promise<void> {
  const trimmed = id?.trim() ?? "";
  if (trimmed && !isValidYouTubeId(trimmed)) throw new Error(`"${trimmed}" is not a YouTube video ID`);
  if (trimmed) {
    await setPersistentStorage(manualKey(trackId), trimmed);
  } else {
    // Empty string tombstone: reads back as falsy and invalid, so auto behaviour resumes.
    await setPersistentStorage(manualKey(trackId), "");
  }
}

async function readCache(trackId: string): Promise<CachedYouTubeId | null> {
  const raw = await getTransientStorage(cacheKey(trackId));
  if (typeof raw !== "string") return null;
  let entry: Partial<CachedYouTubeId>;
  try {
    entry = JSON.parse(raw) as Partial<CachedYouTubeId>;
  } catch {
    return null;
  }
  const via = entry.via;
  const confidence = entry.confidence;
  if (
    typeof entry.id === "string" &&
    isValidYouTubeId(entry.id) &&
    typeof entry.resolvedAt === "number" &&
    Date.now() - entry.resolvedAt < YTID_CACHE_TTL_MS &&
    (via === "innertube" || via === "data-api" || via === "embedded-tag" || via === "manual") &&
    (confidence === "exact" || confidence === "fuzzy")
  ) {
    return { id: entry.id, via, confidence, resolvedAt: entry.resolvedAt };
  }
  return null;
}

async function writeCache(trackId: string, resolved: ResolvedYouTubeId): Promise<void> {
  const entry: CachedYouTubeId = { ...resolved, resolvedAt: Date.now() };
  await setTransientStorage(cacheKey(trackId), JSON.stringify(entry), YTID_CACHE_TTL_MS);
}

async function innertubeLeg(meta: SongMetadata, signal: AbortSignal): Promise<ResolvedYouTubeId | null> {
  // The InnerTube route only exists behind the dev proxy; static previews/production skip this leg.
  if (!import.meta.env?.DEV) return null;

  const artist = meta.albumArtist ?? meta.artists[0] ?? "";
  const queries = [`"${meta.title}" "${artist}"`];
  if (artist && meta.artists[0] && artist !== meta.artists[0]) queries.push(`"${meta.title}" "${meta.artists[0]}"`);

  for (const query of queries) {
    try {
      const response = await fetch("/youtubei/v1/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-YouTube-Client-Name": "WEB_REMIX",
          "X-YouTube-Client-Version": "1.20240826.00.00",
        },
        body: JSON.stringify({
          context: { client: { clientName: "WEB_REMIX", clientVersion: "1.20240826.00.00", hl: "en" } },
          query,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const best = pickBestCandidate(innertubeSearchCandidates(payload), meta);
      if (best) return { id: best.videoId, via: "innertube", confidence: "fuzzy" };
    } catch {
      return null; // network/parse failure — inert, §7
    }
  }
  return null;
}

async function dataApiLeg(meta: SongMetadata, signal: AbortSignal): Promise<ResolvedYouTubeId | null> {
  const key = String(dataApiKey.getStringValue() ?? "").trim();
  if (!key) return null;

  const query = `${meta.title} ${meta.albumArtist ?? meta.artists[0] ?? ""}`.trim();
  try {
    const search = new URL("https://www.googleapis.com/youtube/v3/search");
    search.searchParams.set("part", "snippet");
    search.searchParams.set("type", "video");
    search.searchParams.set("videoCategoryId", "10");
    search.searchParams.set("maxResults", "5");
    search.searchParams.set("key", key);
    search.searchParams.set("q", query);
    const response = await fetch(search, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
    if (!response.ok) return null;
    const payload = await response.json();
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const candidates: SearchCandidate[] = items
      .map((item: { id?: { videoId?: unknown }; snippet?: { title?: unknown } }) => ({
        videoId: typeof item?.id?.videoId === "string" ? item.id.videoId : "",
        title: typeof item?.snippet?.title === "string" ? item.snippet.title : "",
        artists: "",
        durationMs: null,
      }))
      .filter((candidate: SearchCandidate) => isValidYouTubeId(candidate.videoId));
    const best = pickBestCandidate(candidates, meta);
    return best ? { id: best.videoId, via: "data-api", confidence: "fuzzy" } : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the track's YouTube ID per §7. Never throws; `null` means "no ID, carry on with the
 * metadata-only provider path". The caller decides what to do with the result.
 */
export async function resolveYouTubeId(meta: SongMetadata, opts: ResolveYouTubeIdOptions): Promise<ResolvedYouTubeId | null> {
  const { signal, trackId } = opts;
  if (!resolveEnabled.getBooleanValue()) return null;
  if (signal.aborted) return null;

  // 1. Manual override wins over everything.
  const manual = await loadManualYouTubeId(trackId);
  if (manual) return manual;

  // 2. Embedded in tags — deterministic, zero network.
  const tagTexts = [
    ...(meta.raw.urls ?? []),
    ...(meta.raw.comment ?? []),
    ...(opts.extraScanTexts ?? []),
  ];
  const embedded = findEmbeddedYouTubeId(tagTexts);
  if (embedded) return { id: embedded, via: "embedded-tag", confidence: "exact" };

  // 3. Positive cache (network answers only; embedded is re-derived each time).
  const cached = await readCache(trackId);
  if (cached) return { id: cached.id, via: cached.via, confidence: cached.confidence };

  if (signal.aborted) return null;

  // 4. InnerTube search via the dev proxy (skipped where no proxy exists).
  const viaInnertube = await innertubeLeg(meta, signal);
  if (viaInnertube) {
    await writeCache(trackId, viaInnertube);
    return viaInnertube;
  }

  // 5. YouTube Data API v3 (only when a key is configured).
  const viaDataApi = await dataApiLeg(meta, signal);
  if (viaDataApi) {
    await writeCache(trackId, viaDataApi);
    return viaDataApi;
  }

  return null;
}
