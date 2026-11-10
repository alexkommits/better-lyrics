/**
 * The Song metadata model (STANDALONE-WEB-PLAN.md §5) — a normalized, source-agnostic description
 * of *what song this is*, built from any audio file's tags. It is the single input to the built-in
 * per-word / per-syllable providers.
 *
 * Everything in this module is pure and browser/node safe — no I/O, no node APIs. The scan-time
 * CLI (tooling/build-library.ts) and the in-browser drag-drop path both build on it so a tag set
 * that produces good output from `music-metadata` produces the same output from
 * `music-metadata-browser`.
 */

export type SongSource = "file-tags" | "filename" | "sidecar" | "backend-metadata" | "manual-edit";

export interface SongMetadata {
  /** Raw (unmodified) values as read from tags — kept for display and debugging. */
  readonly raw: {
    title?: string;
    artists?: string[];
    artistText?: string;
    album?: string;
    albumArtist?: string;
    year?: number;
    trackNumber?: number;
    discNumber?: number;
    durationMs?: number;
    isrc?: string[];
    genres?: string[];
    comment?: string[];
    urls?: string[];
  };

  /** Canonical, query-ready values. Never destroys `raw`. */
  title: string;
  artists: string[];
  album?: string;
  albumArtist?: string;
  durationMs: number;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  genres?: string[];
  isrc?: string;
  musicBrainzRecordingId?: string;

  /** Presentation-only, not sent to providers. */
  displayTitle: string;
  displayArtist: string;

  /**
   * YouTube video ID, resolved per §7 or embedded in tags. Reported to the built-in providers,
   * Unison, and the submit/request affordances. NEVER an identity key locally.
   */
  youtubeId?: string;
  youtubeIdSource?: "embedded-tag" | "innertube" | "data-api" | "manual" | "unison";

  /** Provenance + enrichment trail, for the debug overlay and "why is this wrong" UX. */
  sources: SongSource[];
}

/** Shape aligned to music-metadata's `common.*` tags (plus container duration). */
interface RawTags {
  title?: string;
  artists?: string[];
  artistText?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  durationMs?: number;
  isrc?: string[];
  musicBrainzRecordingId?: string[];
  genres?: string[];
  comment?: string[];
}

// -- Text primitives (§5.2 step 1) --------------------------------

/** Unicode → NFC; trims and collapses internal whitespace. */
function normalizeNfc(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Unifies dash-like characters to ASCII hyphen for *parsing* (query fields only). */
function unifyDashes(value: string): string {
  return value.replace(/[–—−‐‑]/g, "-");
}

/** Normalizes " ."/" ," spacing and removes spaces before closing punctuation. */
function normalizePunctuationSpacing(value: string): string {
  return value
    .replace(/\s+([.,;:!?)}\]])/g, "$1")
    .replace(/([({[])\s+/g, "$1")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// -- Feature extraction (§5.2 step 2) ------------------------------

const FEATURE_MARKER = String.raw`(?:feat\.?|ft\.?|featuring|with)`;
// Matches both bracketed features — "Title (feat. A, B)" — and trailing dash features — "Title - feat. A".
const BRACKET_FEATURE_REGEX = new RegExp(String.raw`[(\[]\s*${FEATURE_MARKER}\s+([^)\]]*)[)\]]`, "gi");
const TRAILING_FEATURE_REGEX = new RegExp(
  String.raw`(?:^|\s[-–—])\s*${FEATURE_MARKER}\s+([^()\[\]]+?)\s*$`,
  "i"
);
// Bare trailing features — "Title feat. A & B" (no brackets, no dash).
const BARE_TRAILING_FEATURE_REGEX = new RegExp(String.raw`\s+${FEATURE_MARKER}\s+([^()\[\]]+?)\s*$`, "i");

/**
 * Pulls featured-artist clauses out of a title. Returns the title without the clause and the
 * featured artist text in order of appearance. The raw display title is unaffected; this feeds
 * only the canonical artist list.
 */
export function extractFeaturedArtists(title: string): { title: string; featured: string } {
  const featured: string[] = [];
  let working = title;

  working = working.replace(BRACKET_FEATURE_REGEX, (_match, artists: string) => {
    featured.push(artists);
    return " ";
  });

  for (const regex of [TRAILING_FEATURE_REGEX, BARE_TRAILING_FEATURE_REGEX]) {
    const match = working.match(regex);
    if (match) {
      featured.push(match[1]);
      working = working.slice(0, match.index).trim();
      break;
    }
  }

  return { title: normalizeWhitespace(working), featured: featured.join(", ") };
}

// -- Artist list splitting (§5.2 step 2) ---------------------------

const ARTIST_SPLIT_REGEX = new RegExp(
  [
    String.raw`[,，&＆;；/／∕·•×\\]`, // commas, ampersands, semicolons, slashes (incl. fullwidth), middots, multiplication sign
    String.raw`\b(?:feat|ft|featuring|vs|versus)\.?(?=\s|$|[,，&＆;；/／∕·•×])`, // feature markers absorb the dot
    String.raw`\s[xX+]\s`, // "A x B", "A + B"
    String.raw`\b(?:and|und|y|e)\b`, // and in en/de/es/pt/it — best effort, matches plan's "and"
  ].join("|"),
  "gi"
);

/**
 * Splits an artist field into individual artists: separators are `, & ; / feat. ft. featuring
 * x × vs. and` plus ideographic commas and middots. NFC-normalized, trimmed, de-duplicated
 * case-insensitively (first occurrence wins).
 */
export function splitArtistList(text: string): string[] {
  const seen = new Set<string>();
  const artists: string[] = [];
  for (const piece of text.split(ARTIST_SPLIT_REGEX)) {
    const artist = normalizeNfc(piece);
    if (!artist) continue;
    const key = artist.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    artists.push(artist);
  }
  return artists;
}

// -- Qualifier stripping (§5.2 step 3) -----------------------------

const QUALIFIER = [
  String.raw`remaster(?:ed)?(?:\s*(?:19|20)\d{2})?`, // (Remaster), (Remastered 2011)
  String.raw`live(?:\s+at\s+[^)\]]*)?`, // (Live), (Live at …)
  String.raw`deluxe(?:\s+edition)?`, // (Deluxe), (Deluxe Edition)
  String.raw`expanded\s+edition`, // (Expanded Edition)
  String.raw`anniversary\s+edition`, // (Anniversary Edition)
  String.raw`bonus\s+tracks?`, // (Bonus Track), (Bonus Tracks)
  String.raw`radio\s+edit`, // (Radio Edit)
  String.raw`single\s+version`, // (Single Version)
  String.raw`clean(?:\s+version)?`, // (Clean), (Clean Version)
  String.raw`explicit`, // (Explicit)
  String.raw`edit`, // (Edit)
  String.raw`version`, // (Version)
  String.raw`acoustic`, // (Acoustic)
  String.raw`remix`, // (Remix)
  String.raw`mono|stereo`, // (Mono), (Stereo)
].join("|")
const BRACKET_QUALIFIER_REGEX = new RegExp(String.raw`[(\[]\s*(?:${QUALIFIER})\s*[)\]]`, "gi");
const DASH_QUALIFIER_REGEX = new RegExp(String.raw`\s-\s*(?:${QUALIFIER})\s*$`, "gi");
// NOTE: QUALIFIER is intentionally ungrouped; call sites wrap it in (?:…).

/**
 * Strips query-only qualifiers — bracketed or dash-suffixed — from a title: "(Remaster 2011)",
 * "- Live", "(Deluxe Edition)", "(Acoustic)", "(Remix)"… Essentials are stripped too (the backend
 * metadata provider re-adds sanity; the raw display title is untouched).
 */
export function stripQualifiers(title: string): string {
  let working = title;
  let previous: string;
  do {
    previous = working;
    working = working.replace(BRACKET_QUALIFIER_REGEX, " ");
    working = working.replace(DASH_QUALIFIER_REGEX, "");
    working = normalizeWhitespace(working);
  } while (working !== previous);
  return working.replace(/[\s\-–—]+$/g, "").trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// -- ISRC (§5.2 step 6) -----------------------------------------

const ISRC_REGEX = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** Uppercases, strips separators, and validates; returns undefined when invalid. */
export function normalizeIsrc(input: string | undefined | null): string | undefined {
  if (!input) return undefined;
  const candidate = input.replace(/[-\s.]/g, "").toUpperCase();
  return ISRC_REGEX.test(candidate) ? candidate : undefined;
}

// -- URL scan (§7.2 step 1 pre-scan) ------------------------------

const URL_REGEX = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Extracts URLs from free-text fields (comments), de-duplicated, order preserved. */
export function extractUrls(texts: readonly string[] | undefined): string[] {
  if (!texts) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(URL_REGEX)) {
      const url = match[0].replace(/[.,;]+$/g, "");
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url);
    }
  }
  return urls;
}

// -- Canonicalization (§5.2 steps 1–6) -----------------------------

function normalizeYear(year: number | undefined): number | undefined {
  if (year === undefined) return undefined;
  const y = Math.trunc(year);
  return Number.isFinite(y) && y >= 1000 && y <= 9999 ? y : undefined;
}

function normalizeCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Math.trunc(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function cleanQueryText(value: string): string {
  return normalizePunctuationSpacing(unifyDashes(normalizeNfc(value)));
}

/**
 * Builds the canonical SongMetadata from raw tags. `raw` is never mutated; every canonical field
 * is derived from it. Missing title falls back to "Unknown title"; `durationMs` defaults to 0
 * (providers treat 0 as unknown).
 */
export function rawTagsToSongMetadata(raw: RawTags, { sources }: { sources: SongSource[] }): SongMetadata {
  const rawArtistJoined = raw.artistText ?? raw.artists?.join(", ");

  // Feature clauses can appear in either the title or the artist field; both feed the canonical list.
  const titleSeed = raw.title ? cleanQueryText(raw.title) : "";
  const { title: titleWithoutFeatures, featured } = titleSeed
    ? extractFeaturedArtists(titleSeed)
    : { title: "", featured: "" };
  const titleFeatured = [featured, ...(raw.artists ?? []).map(a => extractFeaturedArtists(cleanQueryText(a)).featured)]
    .filter(Boolean)
    .join(", ");

  const canonicalTitle = titleWithoutFeatures ? normalizeWhitespace(stripQualifiers(titleWithoutFeatures)) : "";

  const artistSeed = raw.artists && raw.artists.length > 0 ? raw.artists.join(", ") : rawArtistJoined ?? "";
  const artistTextClean = artistSeed ? cleanQueryText(artistSeed) : "";
  const artists = dedupeCaseInsensitive([
    ...splitArtistList(artistTextClean),
    ...(titleFeatured ? splitArtistList(titleFeatured) : []),
  ]);

  const isrc = raw.isrc?.map(normalizeIsrc).find((value): value is string => value !== undefined);
  const genres = raw.genres
    ?.map(genre => normalizeNfc(genre))
    .filter(genre => genre.length > 0);

  const urls = extractUrls(raw.comment);

  const durationMs = raw.durationMs && Number.isFinite(raw.durationMs) && raw.durationMs > 0 ? Math.round(raw.durationMs) : 0;

  const displayTitle = raw.title ? normalizeNfc(raw.title) : canonicalTitle || "Unknown title";
  const displayArtist = artists.length > 0 ? artists.join(", ") : rawArtistJoined ? normalizeNfc(rawArtistJoined) : "";

  const metadata: SongMetadata = {
    raw: {
      ...raw,
      urls: urls.length > 0 ? urls : undefined,
    },
    title: canonicalTitle || "Unknown title",
    artists,
    durationMs,
    displayTitle,
    displayArtist,
    sources: [...new Set(sources)],
  };

  const album = raw.album ? normalizeNfc(cleanQueryText(raw.album)) : undefined;
  if (album) metadata.album = album;
  const albumArtist = raw.albumArtist ? normalizeNfc(raw.albumArtist) : undefined;
  if (albumArtist) metadata.albumArtist = albumArtist;
  const year = normalizeYear(raw.year);
  if (year !== undefined) metadata.year = year;
  const trackNumber = normalizeCount(raw.trackNumber);
  if (trackNumber !== undefined) metadata.trackNumber = trackNumber;
  const discNumber = normalizeCount(raw.discNumber);
  if (discNumber !== undefined) metadata.discNumber = discNumber;
  if (genres && genres.length > 0) metadata.genres = genres;
  if (isrc) metadata.isrc = isrc;
  const musicBrainzRecordingId = raw.musicBrainzRecordingId?.map(id => id.trim()).find(id => id.length > 0);
  if (musicBrainzRecordingId) metadata.musicBrainzRecordingId = musicBrainzRecordingId;

  return metadata;
}

function dedupeCaseInsensitive(artists: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const artist of artists) {
    const key = artist.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(artist);
  }
  return out;
}

/**
 * Filename fallback (§5.1): `01 - Artist - Title (Remaster).mp3` → { artists, title } with the
 * same cleaning pipeline. Leading track numbers, dots/underscores, and `NN. ` prefixes are
 * handled. Returns empty artists when no split is possible.
 */
export function parseFilename(basename: string): { title?: string; artists: string[] } {
  const withoutExtension = basename.replace(/\.[^.]+$/, "");
  const separated = normalizePunctuationSpacing(unifyDashes(normalizeNfc(withoutExtension)))
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip leading track numbering: "01 - ", "01. ", "01 ", "1 - 02 - " (disc-track)
  const withoutNumbering = separated.replace(/^(\d{1,3}\s*[-.]?\s+)+/, "").trim();

  const segments = withoutNumbering.split(" - ").map(segment => segment.trim()).filter(Boolean);
  if (segments.length >= 3) {
    // "Artist - Album - Title" or "Artist - Title - Extra"; treat first as artist, last as title.
    const [first, ...rest] = segments;
    const title = rest.pop() as string;
    return { title: normalizeWhitespace(title), artists: splitArtistList(first) };
  }
  if (segments.length === 2) {
    const [first, second] = segments;
    return { title: normalizeWhitespace(second), artists: splitArtistList(first) };
  }
  return { title: withoutNumbering || undefined, artists: [] };
}

/**
 * Builds a SongMetadata from a filename alone — used when tags are missing or unreadable.
 * `durationMs` comes from the container (0 when unknown).
 */
export function filenameToSongMetadata(basename: string, durationMs: number): SongMetadata {
  const parsed = parseFilename(basename);
  const titleSource = parsed.title ? cleanQueryText(parsed.title) : "";
  const title = titleSource ? normalizeWhitespace(stripQualifiers(titleSource)) : "Unknown title";
  const displayTitle = parsed.title ? normalizeNfc(parsed.title) : "Unknown title";
  const displayArtist = parsed.artists.join(", ");
  return {
    raw: {},
    title: title || "Unknown title",
    artists: parsed.artists,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
    displayTitle,
    displayArtist,
    sources: ["filename"],
  };
}

/**
 * Fills gaps in a tag-derived metadata object from the filename: title only when the tags carry
 * none, artists only when the tags split into none. Tags always win — the filename is a hint, not
 * a source of truth. Adds "filename" to `sources` when it contributed anything.
 */
export function applyFilenameFallback(metadata: SongMetadata, basename: string): SongMetadata {
  const needsTitle = metadata.title === "Unknown title";
  const needsArtists = metadata.artists.length === 0;
  if (!needsTitle && !needsArtists) return metadata;

  const parsed = parseFilename(basename);
  const fallbackTitleSource = parsed.title ? cleanQueryText(parsed.title) : "";
  const fallbackTitle = fallbackTitleSource
    ? normalizeWhitespace(stripQualifiers(fallbackTitleSource))
    : undefined;
  const fallbackDisplayTitle = parsed.title ? normalizeNfc(parsed.title) : undefined;

  const next = { ...metadata };
  let contributed = false;

  if (needsTitle && fallbackTitle) {
    next.title = fallbackTitle;
    next.displayTitle = fallbackDisplayTitle ?? fallbackTitle;
    contributed = true;
  }
  if (needsArtists && parsed.artists.length > 0) {
    next.artists = parsed.artists;
    next.displayArtist = parsed.artists.join(", ");
    contributed = true;
  }

  if (contributed && !next.sources.includes("filename")) {
    next.sources = [...next.sources, "filename"];
  }
  return next;
}

/**
 * Maps music-metadata's `common` tag object (plus container duration) into RawTags. Shared by
 * the node scanner and the browser drag-drop path — both libraries expose the same shape.
 */
export function commonToRawTags(common: {
  title?: unknown;
  artists?: unknown;
  artist?: unknown;
  album?: unknown;
  albumartist?: unknown;
  year?: unknown;
  track?: { no?: unknown } | null;
  disk?: { no?: unknown } | null;
  genre?: unknown;
  isrc?: unknown;
  musicbrainz_recordingid?: unknown;
  comment?: unknown;
}, durationMs: number | undefined): RawTags {
  const raw: RawTags = {};

  if (typeof common.title === "string" && common.title.trim()) raw.title = common.title;
  const artists = asStringArray(common.artists);
  if (artists) raw.artists = artists;
  if (typeof common.artist === "string" && common.artist.trim()) raw.artistText = common.artist;
  if (typeof common.album === "string" && common.album.trim()) raw.album = common.album;
  if (typeof common.albumartist === "string" && common.albumartist.trim()) raw.albumArtist = common.albumartist;
  if (typeof common.year === "number") raw.year = common.year;
  const trackNo = common.track?.no;
  if (typeof trackNo === "number") raw.trackNumber = trackNo;
  const diskNo = common.disk?.no;
  if (typeof diskNo === "number") raw.discNumber = diskNo;
  if (durationMs !== undefined && Number.isFinite(durationMs)) raw.durationMs = durationMs;
  const isrc = asStringArray(common.isrc);
  if (isrc) raw.isrc = isrc;
  const mbid = asStringArray(common.musicbrainz_recordingid);
  if (mbid) raw.musicBrainzRecordingId = mbid;
  const genre = asStringArray(common.genre);
  if (genre) raw.genres = genre;
  const comment = asTextArray(common.comment);
  if (comment) raw.comment = comment;

  return raw;
}

/**
 * Comments come as strings in some readers and `{ language, descriptor, text }` objects in
 * music-metadata ≥ 10. Accept both.
 */
function asTextArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const strings = list
    .map(item => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        return (item as { text: string }).text;
      }
      return undefined;
    })
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const strings = list.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}
