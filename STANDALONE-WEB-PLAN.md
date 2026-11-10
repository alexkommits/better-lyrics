# Better Lyrics → standalone web app: port plan

**Date:** 2026-11-10
**Status:** Proposal / for review (rev. 3 — local sidecars/embedded lyrics preferred only with per-word/per-syllable timings; rev. 2 — Song metadata model + YouTube ID resolution)
**Scope:** Rebase this repository from a YouTube/YouTube Music browser extension onto a locally served TypeScript site (Vite), keeping its richsync (word- and syllable-level) highlighted lyrics from the **built-in providers in their default order**, dropping every YouTube *player* dependency, and adding a **Song metadata model** that any audio file maps into — usable with the per-word and per-syllable providers — plus a **resolver to get YouTube IDs from that model** when one is available.

---

## 1. The one-sentence version

Everything that makes Better Lyrics *Better Lyrics* — the sweeping word/syllable highlight, the built-in providers (their TTML/LRC/QRC sources and their default priority), the themes, translation/romanization, the karaoke stage — already lives in framework-free npm packages (`@braccato/*`) and platform-agnostic modules in this repo; YouTube only ever supplied a **clock**, **metadata**, and a **mount point**. A locally served Vite app with a `<audio>` element replaces the clock, a **Song metadata model built from the audio files themselves** replaces the player-response metadata (and is exactly what the built-in word/syllable providers consume), a locally generated library index replaces the queue, and one host-object implementation replaces the mount point. **YouTube IDs are still resolved and reported wherever they're needed** — to the built-in providers, to Unison, and to the "submit / request synced lyrics" affordances — but they are no longer required for playback or for lyrics.

## 2. What this repo actually is today

```
music.youtube.com page
  ├─ MAIN world      public/script.js        polls ytmusic player (getCurrentTime, getPlayerResponse) 1×/s
  │                   public/earlyInject.js   hides native lyrics early
  │                   src/pageWorld.ts        PiP page host
  ├─ ISOLATED world   src/index.ts            content-script entry, wires everything
  │     ├─ ui/observer.ts                     rAF loop → mainView.tick(t, …) every ≤20 ms
  │     ├─ ui/mainLyricsView.ts               createLyricsRenderer({ document, window, host: ytmHost })
  │     ├─ ui/lyricsHost.ts                   ytmHost: the LyricsRendererHost YouTube-flavoured impl
  │     ├─ lyrics/*                           providers, selection/voting, cache, translation, romanization
  │     ├─ karaoke/*                          createKaraokeStage — a SECOND createLyricsRenderer(layout:"stage")
  │     └─ options/*                          popup settings, theme editor, marketplace, unison pages
  └─ background      src/options/background.ts service worker (theme/auth relay)
```

Key facts that make the port tractable:

- **The renderer is not in this repo.** It is `@braccato/core` 1.20.0 (`createLyricsRenderer`), described as *"Synchronized lyrics renderer with word-by-word animations"*. It owns line building, word-group/`--letters` grapheme wrapping, the highlight sweep, scroll management, layout measurement, themes (`setTheme`), and the stage layout for karaoke. It asks its **host** nothing about YouTube — 11 small members, all replaceable.
- **The lyric data model already carries sub-line timing.** `LyricPart { startTimeMs, durationMs, words, isBackground? }`. The engine's timed unit *is* the part; word vs syllable is a property of the source file, handled per part (§8).
- **Every YouTube touch-point is an adapter, not a foundation.** `requestSniffer`, `pageWorld`, the page bridge, `ytCaptions`/`yt-lyrics` (both keyed on videoId), segment maps, video quality, thumbnail injection, fullscreen-player-bar reveal — all of it exists because the extension can't ask YT directly.
- **The built-in providers don't care where metadata comes from.** `ProviderParameters` is `{ song, artist, duration, videoId, album, audioTrackData, sourceMap, alwaysFetchMetadata, signal }`; today every field except `videoId` is already available from audio tags. The `videoId` is the only player-derived field — and it becomes *optional* under this plan (§6–§7).

## 3. Target architecture

```
┌────────────────────────── project root ──────────────────────────┐
│ music/                     # user's audio files (git-ignored)    │
│ tools/build-library.mjs    # node CLI: scan → SongMetadata → idx │
│ public/library.json        # generated library index             │
│ index.html                 # /            player + lyrics        │
│ settings.html              # /settings.html  (reuse options UI)  │
│ editor.html                # /editor.html    (reuse editor pages)│
│ src/core/*                 # storage adapter, i18n, logger…      │
│ src/modules/library/*      # SongMetadata model, normalization,  │
│                            # build-time index reader, YT resolver│
│ src/app/*                  # player shell: library, deck, clock  │
│ src/modules/…              # ported Better Lyrics modules        │
│ vite.config.ts             # MPA inputs, dev proxy, aliases      │
└──────────────────────────────────────────────────┘
        npm run dev  → vite dev server on 0.0.0.0:5173
        npm run build && npm run preview → static production build
```

Runtime data flow:

```
audio element ──timeupdate/play/pause──▶ Clock (rAF, ≤20 ms, wall-clock extrapolation
        │                                like runAnimationEngine in ui/observer.ts)
        │                                        │
        ▼                                        ▼
 library.json ──▶ LibraryStore ──▶ createLyrics() (ported) ──▶ providers in DEFAULT ORDER
  SongMetadata    (queue, next-up)   builds song/artist/…        (unified cubey SSE stream:
  per track       │                 feeds ProviderParameters      TTML/LRC/QRC sources)
                  │                                             │
                  │     Local sidecar/embedded tier, richsync-gated (§6.6) ▼
                  │                                   LyricsRendererHost (ours, §4.3)
                  ▼                                             │
        resolveYouTubeId(meta) ──▶ optional videoId ──▶ reported to providers / Unison / buttons (§7)
```

## 4. The three replacements in detail

### 4.1 The clock — `<audio>` + the existing engine loop shape

`ui/observer.ts` already solves this: a snapshot (`latestPlayerTime`, `latestPlayerSnapshotTime`, `latestPlayerPlaying`, `playbackRate`) extrapolated on each rAF at ≤20 ms calling `mainView.tick(currentTime, tickOptions)`. Replace the snapshot source:

- `play`/`playing`/`pause`/`ended`/`seeked`/`ratechange`/`durationchange` on the `<audio>` element write the snapshot directly (no DOM CustomEvent bus, no page/isolated bridge).
- `seeked` resets the extrapolation base and calls the same `resumeAllAutoscroll()` the extension uses.
- Line click → `seekPlayer(t)` → `audio.currentTime = t` (the host's `seek` member).
- `visibilitychange` keeps calling `noteVisibilityChange()` + a forced `runAnimationEngine(…, force=true)`.

Deletes: `public/script.js`, `public/earlyInject.js`, `src/pageWorld.ts`, `src/videoQualityPage.ts`, `src/modules/lyrics/requestSniffer/*` (~1,450 LOC), `segmentMap.ts`, the `blyrics-send-player-time` event bus.

### 4.2 Metadata — the Song model, generated from local files (YouTube IDs optional, still reported)

YouTube's `getSongMetadata()` (via the intercepted player response) carried title/artist/album/duration/videoId and could not be replaced by a single file tag — this is the *one* genuinely new data structure in the port, and it is deliberately a first-class model rather than a bag of strings. It is specified in **§5**, consumed by the provider pipeline in **§6**, and extended with a YouTube ID in **§7**.

- `tools/build-library.mjs` scans `music/**`, reads every tag format via [`music-metadata`](https://www.npmjs.com/package/music-metadata) (ID3v1/v2, Vorbis comments, MP4 atoms, APEv2, ASF/WMA, AIFF/MP4), normalizes to `SongMetadata`, finds same-basename sidecars and embedded lyric tags, and writes `public/library.json`. Audio is served as-is; the CLI never copies it.
- Stable **track id** = normalized relative path + short content hash. This replaces `videoId` as the local identity everywhere (cache keys, offsets, pins, `AppState.lastLoadedTrackId`). The YouTube ID becomes an *optional property* of the same model (§7), never an identity key.
- In-browser drops (user drags files onto the page) use [`music-metadata-browser`](https://www.npmjs.com/package/music-metadata-browser) through the same normalizer — phase 2 (§10 M1).
- Pre-fetch of the next queued track (`preFetchLyrics`) carries over unchanged — it already takes `Partial<PlayerDetails>`; it takes `SongMetadata` instead.
- Artwork: embedded cover (base64 in `library.json`, or extracted to `library-art/<hash>.jpg`); never ytimg.

### 4.3 The host object — reimplement 11 members, delete the YouTube flavour

`src/modules/ui/lyricsHost.ts` (`ytmHost`) exists almost entirely to answer "is the YouTube lyrics tab selected?" and is the template for the port. The standalone host:

| `LyricsRendererHost` member | Standalone implementation |
|---|---|
| `isViewVisible()` | `true` while the player pane is mounted (optionally `!document.hidden` to skip ticking hidden tabs) — the app *is* the lyrics view |
| `isLoaderActive()` | our `isLoaderActive()` from `ui/dom.ts`, kept as-is (it's state, not YT DOM) |
| `syncAdState()` | constant `false`; the ad overlay is deleted |
| `getScrollElement()` | our `.lyrics-scroll` container |
| `setResumeAffordanceVisible(v)` | toggles our resume-autoscroll button (markup from `resumeScrollButton.ts`) |
| `seek(t)` | `audio.currentTime = t` + reset highlight base |
| `get log()` | `logCore` (its `chrome.storage` read moves to the storage adapter) |
| `onStageLayout?(box)` | forwarded to the karaoke overlay, unchanged semantics |
| `debug` | drop |

The karaoke stage (`karaoke/karaokeView.ts` + `stage.ts`) is already document-agnostic; its only YT coupling is the fullscreen bar (`player-fullscreened`, `getPlayerBar`), which becomes our fullscreen control bar, and `isAdPlaying`, constant `false`.

## 5. The Song metadata model

A normalized, source-agnostic description of *what song this is*, built from any audio file's tags, optionally enriched by the backend, optionally extended with a YouTube ID. It is the single input to the built-in per-word / per-syllable providers.

```ts
// src/modules/library/songMetadata.ts
export interface SongMetadata {
  /** Raw (unmodified) values as read from tags — kept for display and debugging. */
  readonly raw: {
    title?: string; artists?: string[]; artistText?: string; album?: string;
    albumArtist?: string; year?: number; trackNumber?: number; discNumber?: number;
    durationMs?: number; isrc?: string; genres?: string[]; comment?: string[];
    urls?: string[];
  };

  /** Canonical, query-ready values. Never destroys raw. */
  title: string;              // cleaned: no "(Remastered)", no "- Live", no "feat. …", NFC, collapsed spaces
  artists: string[];          // split: "A feat. B & C" → ["A", "B", "C"]; NFC; de-duplicated
  album?: string;             // cleaned the same way; omitted for compilations w/o albumartist match
  albumArtist?: string;
  durationMs: number;         // required; falls back to container duration, then 0 (providers treat 0 as unknown)
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  genres?: string[];
  isrc?: string;              // normalized: uppercase, must match ^[A-Z]{2}[A-Z0-9]{3}\d{7}$ (regex already in providers/unified.ts)
  musicBrainzRecordingId?: string;

  /** Presentation-only, not sent to providers. */
  displayTitle: string;       // raw title, trimmed, or cleaned if no raw title
  displayArtist: string;      // artists.join(", ") or raw

  /**
   * YouTube video ID, resolved per §7 or embedded in tags. Reported to the built-in providers,
   * Unison, and the submit/request affordances. NEVER an identity key locally.
   */
  youtubeId?: string;
  youtubeIdSource?: "embedded-tag" | "innertube" | "data-api" | "manual" | "unison";

  /** Provenance + enrichment trail, for the debug overlay and "why is this wrong" UX. */
  sources: Array<"file-tags" | "filename" | "sidecar" | "backend-metadata" | "manual-edit">;
}
```

### 5.1 Sources and readers

| Source | When | Reader | Produces |
|---|---|---|---|
| Scan-time tags (any format) | `build-library.mjs` | `music-metadata` (node) | `raw.*` → `SongMetadata`; cover art; embedded lyric tags (`USLT`, Vorbis `LYRICS`/`UNSYNCEDLYRICS`, MP4 `©lyr`) |
| Drag-and-drop files | player runtime | `music-metadata-browser` | same model |
| Filename fallback | tags missing/broken | pure function | `title` from basename (strip `NN - `, `NN. `, `Artist - Title` split on ` - `), `artists: []`, `durationMs` from container |
| Sidecar lyric file | present next to audio | TTML head `<tt:metadata>` (`<songwriters>`, `xml:lang`), LRC `[ti:]/[ar:]/[al:]/[au:]/[length:]` | enrichment *only* (never overrides audio tags), recorded in `sources` |
| Backend `metadata` provider (already built in) | first stream call | existing SSE `metadata` event → `{song, artist, album, duration}` | enrichment: written back to the in-memory model (flagged `backend-metadata`); the *displayed* title updates, the file is untouched |
| Manual edit | user, via "Edit track info" | form → `sources: ["manual-edit"]` | highest precedence, persisted per track id in `localStorage` |

Tag-field mapping (music-metadata `common.*` → model): `title→title`, `artists[]→artists[]` (fallback: split `artist` ourselves), `album→album`, `albumartist→albumArtist`, `year→year`, `track.no→trackNumber`, `disk.no→discNumber`, `genre[]→genres`, `isrc[]→isrc[0]` (normalized), `musicbrainz_recordingid[]→musicBrainzRecordingId`, `comment[]→raw.comment` (scanned for embedded YT URLs — §7.2 step 1), all formats covered by the library's format detection, incl. ID3v1 (best-effort), Vorbis, MP4/M4A, APEv2, ASF.

### 5.2 Normalization pipeline (pure functions, self-checkable)

Applied to produce the canonical fields from raw (never mutating `raw`):

1. Unicode → NFC; trim; collapse whitespace; normalize ` .`/` ,` spacing; unify dashes (`–—`→`-` for parsing).
2. **Feature extraction:** pull `feat./ft./featuring/with/…` clauses (bracketed or bare) out of the title into the artist list; split the artist field on `, & ; / feat. ft. featuring x × vs. & and` + ideographic commas (`，`) + middots (`·`); NFC; de-dup (case-insensitive).
3. **Qualifier stripping (query title only):** remove bracketed/trailing `(Remaster(ed)?( 19| 20)?\d*)`, `(Live( at .*)?)`, `(Deluxe|Deluxe Edition|Bonus Track(s)?|Radio Edit|Explicit|Clean( Version)?|Single Version|Edit|Version|Anniversary Edition|Expanded Edition)`; collapse ` " - "`-separated qualifiers the same way; keep `(Acoustic|Remix|Live)`-style essentials? No — strip those too from the *query* title; the raw display is untouched and the backend metadata provider re-adds sanity.
4. **Artist canonicalization for queries:** strip leading "The "? **No** (breaks real matches); instead both the raw-cleaned and a "lite" variant (no leading "The ") are passed to functions that want them — in practice the cubey stream tries the strong variant and AI-side matching copes; local fuzzy scoring (§7.2) uses the same arrays.
5. **Duration:** `durationMs` from tags; missing → container duration; `0` means unknown; providers receive `Math.round(durationMs/1000)`.
6. **ISRC:** uppercase + regex; drop if invalid.

The library CLI runs 1–6 at scan time and writes the result into `library.json`; the browser never re-normalizes.

### 5.3 Mapping into `ProviderParameters` (per-word / per-syllable providers)

```ts
// src/modules/lyrics/lyrics.ts (ported)
function toProviderParameters(m: SongMetadata, sourceMap: SourceMapType, signal: AbortSignal): ProviderParameters {
  return {
    song: m.title,
    artist: m.artists.join(", "),
    duration: Math.round(m.durationMs / 1000),
    videoId: m.youtubeId ?? "",          // §6.3 / §7 — reported when present, never required
    album: m.album ?? "",
    audioTrackData: null,                // §6.5: only for yt-captions, synthesized from InnerTube player response when a proxy exists
    sourceMap,
    alwaysFetchMetadata: m.sources.includes("filename") || m.title !== m.raw.title, // let the backend fix dirty tags
    signal,
  };
}
```

`isrc` is appended to the unified stream body by a one-line change to `providers/unified.ts`: `findIsrc(meta.isrc) ?? findIsrc(audioTrackData)` (the existing `findIsrc` walker stays unused for files).

### 5.4 Enrichment loop (unchanged semantics, new input)

`preFetchLyrics` already calls the `metadata` provider first and merges `{song, artist, album, duration}` into its parameters. Identical flow with a `SongMetadata`: the `metadata` SSE event patches the in-memory model (`sources += "backend-metadata"` per patched field), the display title updates, `albumArtist` from the response fills `album`. Nothing writes back to the user's files.

## 6. Lyrics providers — built-in only, default order

### 6.1 The default provider order is kept verbatim

`PROVIDER_CONFIGS` in `src/core/constants.ts` is the default order and is **not** reordered, filtered, or extended by this plan (the richsynced "syllable"-labelled tiers stay first, exactly as shipped):

| # | Key | Label | Sync tier |
|---|---|---|---|
| 0 | `bLyrics-richsynced` | Better Lyrics | syllable |
| 1 | `unison-richsynced` | Unison | syllable |
| 2 | `spicy-richsynced` | Spicy Lyrics | syllable |
| 3 | `binimum-richsynced` | BiniLyrics | syllable |
| 4 | `unison-wordsynced` | Unison | word |
| 5 | `portato-richsynced` | Better Lyrics Portato | word |
| 6 | `musixmatch-richsync` | Musixmatch | word |
| 7 | `bLyrics-synced` | Better Lyrics | line |
| 8 | `unison-synced` | Unison | line |
| 9 | `spicy-synced` | Spicy Lyrics | line |
| 10 | `yt-captions` | YouTube Captions | line |
| 11 | `binimum-synced` | BiniLyrics | line |
| 12 | `lrclib-synced` | LRCLib | line |
| 13 | `legato-synced` | Better Lyrics Legato | line |
| 14 | `musixmatch-synced` | Musixmatch | line |
| 15 | `yt-lyrics` | YouTube | unsynced |
| 16 | `unison-plain` | Unison | unsynced |
| 17 | `lrclib-plain` | LRCLib | unsynced |

User customization keeps working exactly as in the extension (disable/reorder via the `d_` prefix in the stored `preferredProviderList`, merged over defaults by `mergePreferredProviders`). The standalone app simply ships with the default list; the dock's source cycler and pins are unchanged (pin/offset storage re-keyed to track id, §6.7).

### 6.2 Why the metadata model is enough for the word/syllable providers

Every built-in network provider is reached through one transport — the cubey SSE stream (`POST https://lyrics.api.dacubeking.com/v2/lyrics`, `unified.ts`) — whose body already carries `videoId, song, artist, duration, album, alwaysFetchMetadata, isrc, unison, token`:

| Provider tier | Formats parsed by the extension | Granularity | Driven by |
|---|---|---|---|
| `bLyrics/binimum/spicy-{richsynced,synced}` | TTML (`fillTtml`) | **syllable** (or word, per file) | song/artist/duration (+ videoId when known) |
| `portato-richsynced` | QRC (QQ) | **syllable** | same |
| `musixmatch-richsync` | enhanced LRC via `parseLRC` + `lrcFixers` | **word** | same |
| `musixmatch/legato/lrclib-synced`, `-plain`, `bLyrics-synced` | LRC / plain | line / unsynced | same |
| `unison-*` | Unison API (its own transport) | syllable/word/line/plain | **videoId required** → skipped when unresolvable (§6.4) |
| `yt-captions`, `yt-lyrics` | YT caption tracks / YT native lyrics | line / unsynced | **videoId required** (+ proxy for captions) → conditional (§6.5) |

No provider-side changes are needed to say "this is the same song, different metadata source". The change is confined to *where `song/artist/duration/…` come from* (§5), and *whether `videoId` is present* (§7).

### 6.3 `videoId` in the unified stream body — the one integration unknown

Today `startStream` appends `videoId` unconditionally, and the backend evidently matches primarily on it. Whether it matches on `song/artist/duration/album/isrc` alone is **the #1 thing to verify during M0** (one manual test against the endpoint with an empty `videoId` and a known track — no code needed). Three-case decision ladder, in order:

- **(a) Metadata-only matching works** → stream is called exactly as today minus `videoId`; nothing else in this section is forced. Add an integration note with the tested payload to the README.
- **(b) Metadata-only matching fails but ISRC helps** (e.g. only `isrc` is accepted as an alternate key) → always resolve ISRC (§5) and include it; additionally trigger the YT-ID resolver *lazily on first provider call* for unresolved tracks (§7) so the stream gets an ID whenever that's achievable. Users can disable the resolver for privacy (§7.5) — then built-ins are local-cache + sidecar/embedded only, honestly surfaced in the UI ("remote lookup requires YouTube ID resolution — enable in settings").
- **(c) The backend hard-requires `videoId` and rejects everything else** → the resolver becomes a hard precondition for built-ins: resolve per track (cached), fall back to local sources + clear UI state when resolution fails. The rest of the app is unaffected.

All three keep playback, local parsing, themes, editor, and the word/syllable renderer fully functional offline; only the remote lyric lookup degrades, and it does so loudly and legibly, never silently.

### 6.4 Unison without a player

`providers/unison.ts` and the stream's `unison=1` flag key everything on `videoId` (stream body, its own SSE events from cubey, cache, request/submit buttons). Under standalone:

- Resolved ID present → Unison works exactly as in the extension (lookup, pin precedence, vote, submit/request buttons — `pages/unison.html` becomes the `unison.html` MPA entry with the same query params).
- No ID → Unison keys are skipped silently (one log line), the pin logic ignores Unison keys, and the dock/footer/no-lyrics UI hide the Unison-only affordances (submit, request-synced). `recordAvailableProviders` unchanged.
- `yes` — the "Request Synced" button currently calls `getRequest(videoId)`/`requestLyrics({…thumbnailUrl})`; `thumbnailUrl` switches from `resolveArtworkUrl(videoId)` (img.youtube.com) to a local data-URL of the embedded artwork. Same for `buildUnisonSubmitUrl`.

### 6.5 `yt-captions` / `yt-lyrics` — conditional built-ins at their default positions

These two stay in the default order (positions 10 and 15) and are simply **inert until a YouTube ID resolves**:

- `yt-captions` today reads `audioTrackData.captionTracks` (sniffed from the player response) and `fetch(captionTrack.url&fmt=json3)`. Standalone, with a proxy (`vite dev` middleware, or the tiny production `server.mjs` from §9):
  1. `POST https://music.youtube.com/youtubei/v1/player` (InnerTube, `WEB_REMIX` client context, no auth/cookies) → `captions.playerCaptionsTracklistRenderer.captionTracks` → same `pickCaptionTrack` → same conversion loop. No player response sniffing; same code from `pickCaptionTrack` down unchanged. The synthesized object is assigned to `audioTrackData` solely for this provider.
  2. timedtext JSON is fetched via the same proxy (CORS).
  - No proxy available → provider no-ops exactly as it does today when `audioTrackData` is null.
- `yt-lyrics` uses the request-sniffer's `/youtubei/v1/browse` lyrics-tab responses. Standalone: `POST …/v1/browse` with the browseId scraped from the player response (§6.5.1) via proxy; the *parsing* half of `requestSniffer.ts` (lyrics tab extraction) is portable as-is. M3 includes a half-day spike; if the InnerTube shapes drift, `yt-lyrics` no-ops — it never blocks anything (it's only the comparison baseline for vote-withdrawal, and `reinstateAgreeingSources` already tolerates its absence).

### 6.6 Local sidecar files & embedded tags — local tier, not a new provider, **richsync-gated**

Per the brief, **no new providers are added and no built-in is reordered**. Local `.ttml/.lrc/.qrc/.srt` files (same basename as the audio) and embedded lyric tags (`USLT`/`LYRICS`/MP4 `©lyr`) therefore do **not** enter `PROVIDER_CONFIGS`. They are consumed by a separate `local` source (`providerKey: "local"`, `source: "Local file"`) handled like today's provisional/early-inject paths, and they are **preferred only when they contain per-word or per-syllable timings**:

- **Preference test (normative).** After parsing, the local file's tier is the same part-based test the renderer already uses for `deriveSyncType`: *≥1 non-instrumental `LyricPart` with `durationMs !== 0`* → **richsync** (word or syllable parts — e.g. TTML word/syllable spans, QRC, enhanced LRC). Otherwise the local file is **line-synced** (timed lines, no parts) or **plain** (everything-zero start times).
- **If the local file is richsync** → it is **preferred**: the selection pipeline runs with effective order `["local", …providerPriority]`, i.e. the local file wins the initial display — applied immediately, before the stream's first answer (provisional/early-inject style), while the built-in providers still run underneath in default order so the dock cycles to them and the user can switch. Precedence shape mirrors a manual pin, but is not a pin: a later manual choice always sticks, and re-loads keep the same rule.
- **If the local file is line-synced or plain** → it is **not preferred**: effective order `[…providerPriority, "local"]`. The built-in providers run in their default order and win whenever any of them lands lyrics; the local file is shown only when no built-in returns lyrics (or when the user pins it manually, which always wins).
- The built-in provider order relative to **each other is identical in both cases** — the tier only decides whether `local` sits before or after `providerPriority`. `local` is never a member of `providerPriority`, so disabling/reordering built-ins in settings is unaffected.
- **No "prefer local files" toggle.** The rule is fixed, per product decision: richsync local wins, otherwise default order governs. Manual selection/pinning is the escape hatch. (Embedded USLT plain text lands in the line-synced/plain case via `detectFormat` → `PlainParser` or `LRCParser`; embedded enhanced LRC/TTML with parts lands in the richsync case and is preferred.)
- **Why not prefer line-synced local too?** A built-in syllable/word result is strictly richer for highlighting; the local file wins on *timing quality*, not on *being local*.
- Edge cases: a file whose parts are all `durationMs === 0` counts as line-synced/plain by this test (consistent with the engine); sidecar parse failure degrades silently to "no local source" with one log line; a manual pin on `local` always wins regardless of tier.
- There is intentionally no path by which a line-synced local file displaces a remote syllable result on the default path — that is the user's stated preference rule, not a default we chose.

### 6.7 Cache, offsets, pins — re-keyed to track id

| Key | Today | Standalone |
|---|---|---|
| Lyrics cache | `blyrics_<videoId>_<provider>` | `blyrics_<trackId>_<provider>` (`LYRIC_CACHE_VERSION` kept; `usesPerKeyCache` unchanged) |
| Lyric offsets | `blyricsOffset_<videoId>_<source>` | `blyricsOffset_<trackId>_<source>` |
| Provider pins | `blyricsProviderPin_<videoId>` | `blyricsProviderPin_<trackId>` |
| Unison cache | `unison:<videoId>` (per `unison.ts`) | unchanged — keyed by videoId, only when resolved |
| YT-ID resolution cache | — | `blyricsYtId_<trackId>` → `{id, via, confidence, resolvedAt}`, TTL 90 days |
| Manual YT-ID override | — | `blyricsYtIdManual_<trackId>` |

Old videoId keys become inert orphans (no migration needed — nothing carries over from the extension by design).

### 6.8 "YouTube IDs should still be reported" — full inventory

1. **To the built-in providers** — `videoId` in the `v2/lyrics` body, and as the unison lookup key (§6.2–6.4).
2. **To Unison submissions** — "Submit to Unison" carries `song/artist/album/duration + videoId` (URL built from the `unison.html` route); "Request Synced" posts `{videoId, song, artist, thumbnailUrl}` to Unison's requests API and polls `getRequest(videoId)`; footer shows/hides both on ID availability (§6.4).
3. **In the no-lyrics UI** — Genius search link (song/artist) stays; the Unison actions require a resolved ID and hide otherwise.
4. **As attribution metadata** — `LyricSourceResultWithMeta` keeps the `videoId` field populated from the model (`meta.youtubeId`), so anything that displayed or logged it still does.
5. **NOT as an identity/cache key** — deliberately (§6.7); IDs can be wrong and get re-resolved.

## 7. Getting a YouTube ID from the Song metadata model (when available)

`src/modules/library/resolveYouTubeId.ts`:

```ts
export interface ResolvedYouTubeId {
  id: string;
  via: "embedded-tag" | "innertube" | "data-api" | "manual";
  confidence: "exact" | "fuzzy";
}
export function resolveYouTubeId(meta: SongMetadata, opts: { signal: AbortSignal }): Promise<ResolvedYouTubeId | null>
```

Strategies, tried in order, first hit wins:

1. **Embedded in tags** — deterministic. Scan every string tag value (`comment[]`, `lyrics`, `unsyncedlyrics`, custom frames, URLs array from music-metadata) for `(?:youtube\.com/(?:watch\?[^"'\s]*v=|shorts/)|youtu\.be/|music\.youtube\.com/watch\?[^"'\s]*v=)([A-Za-z0-9_-]{11})`. Cost: zero network. This alone covers libraries whose files were ripped with YT URLs in comments.
2. **InnerTube search via the local proxy** — default search path, no API key, no auth:
   - `POST https://music.youtube.com/youtubei/v1/search` with client `WEB_REMIX` (music-first results) via the same dev/preview proxy used for captions (§6.5). If you run the production `server.mjs`, the route exists there too; behind no proxy → skip this strategy (offline).
   - Query: `"{title}" "{albumArtist ?? artists[0]}"` plus fallback `"{title}" "{artists[0]}"`. Parse `musicResponsiveListItemRenderer` items: `videoId`, `title`, byline runs (artists), `lengthText` (mm:ss).
   - Score with the repo's existing `stringSimilarity` (`src/core/utils.ts`) over title and artist strings; **accept** the top candidate iff `|candidateDuration − meta.durationMs| ≤ 2 s` AND `titleScore ≥ 0.85` AND `artistScore ≥ 0.6`; else record as `fuzzy` and surface for one-click confirm (small chip in the "…" menu: "Matched YT: <title> — wrong match?").
   - Cost: one HTTP POST per uncached track; result cached 90 days.
3. **YouTube Data API v3** (optional, settings: paste API key): `search.list?part=snippet&type=video&videoCategoryId=10&q=…` → `videos.list` for durations → identical scoring. Officially ToS-clean, CORS-open (no proxy needed), ~100 quota units/search against a 10 k/day free quota.
4. **Manual override** — paste a URL or 11-char ID; stored `blyricsYtIdManual_<trackId>`; wins over everything; "Clear" restores auto behaviour.

Behavior:

- **Trigger:** lazily on the first provider call for a track (or on "Edit track info" → Save), never at library boot; tied to the existing per-song `AbortController` so track changes cancel in-flight resolution.
- **Failure:** `null` → §6.3 ladder applies; playback and local lyrics unaffected; one log line; footer/Unison affordances render from ID availability.
- **Privacy:** a single settings toggle — *"Resolve YouTube IDs for remote lyrics (sends song/artist to YouTube search)"* — default **on**, but when **off** the resolver is fully disabled and §6.3 cases (b)/(c) apply. Disclosed on the settings page. Nothing is ever written to YouTube.
- **ISRC is not an ID oracle** — there is no public ISRC→videoId mapping; ISRC is sent to cubey (where it may match server-side) and is the right signal for any future official integration. Never synthesized, never scraped.
- **`AppState.lastLoadedVideoId`** survives as the "current track's ID" slot (now possibly null), holding `meta.youtubeId`; session identity (`reloadLyrics` triggers, `currentInjectionId`) keys off `trackId`.

## 8. Per-syllable / per-word highlighted lyrics

(Unchanged from rev. 1 — the data path is identical once lyrics arrive; summarized.) "Syllable vs word" is a property of the source data, not a new renderer. Timed `LyricPart`s drive the engine's sweep; spacing is `splitPartIntoTokens`; grouping is `groupTokensByWord`; `Intl.Segmenter` handles graphemes.

| Format | Parts emitted | Granularity |
|---|---|---|
| QRC (portato) | one part per syllable | ✅ syllable |
| TTML, flat timed syllable `<span>`s (AMLL-style) | one part per span | ✅ syllable |
| TTML, word spans containing timed syllable spans (Apple-style nested) | flattened to one word part (nested timing dropped) | ⚠️ word only today |
| TTML, word spans (bLyrics/spicy/binimum typical) | one part per word | ✅ word |
| Enhanced LRC / Musixmatch WB | one part per word (pro-rated) | ✅ word |
| Plain LRC / SRT / plain | zero-duration rebuilt words | line |

Work items:

1. **Nested-syllable TTML expansion** — patch `Z()` in `@braccato/parsers` (or local pre-pass in `src/lyrics/ttmlSyllables.ts` until merged) so a timed word span with timed children emits per-child parts. Upstreamable, MIT.
2. **Granularity setting** `blyrics-sync-granularity: auto | syllable | word | line`; `auto` = finest present. UI labels the mode from the provider's configured tier and the file's actual parts; no fake syllable timing from pro-rating by default (optional opt-in approximation, off by default).
3. **Renderer/theme verification at syllable density** (CJK no-space runs, `--letters` per syllable, letter-wave on 1-grapheme parts, `x-bg` groups, long-word wrapping).
4. **Fixture corpus + `?demo=` mode** (QRC, AMLL syllable TTML, Apple word TTML, enhanced LRC, Musixmatch WB, one Japanese + one Korean line each; all 18 built-ins documented with the format they return).

No forced alignment from audio; timing comes from files, as today.

## 9. Module-by-module disposition

Sizes are `wc -l` of the current tree.

| Module | ~LOC | Action | Notes |
|---|---|---|---|
| `@braccato/core`, `/parsers`, `/highlight`, `/types` (npm) | — | **Keep** | The highlight engine itself. |
| `src/modules/ui/mainLyricsView.ts` | 70 | **Port, small** | Drop `ytmHost` → standalone host. |
| `src/modules/ui/lyricsHost.ts` | 100 | **Rewrite** | §4.3. |
| `src/modules/ui/observer.ts` | 650 | **Rewrite slim** | Keep rAF/extrapolation + visibility/wake-lock; delete every YT selector/observer. |
| `src/modules/library/songMetadata.ts` **(new)** | ~350 | **New** | §5: model + normalizer (pure; self-check candidate). |
| `src/modules/library/resolveYouTubeId.ts` **(new)** | ~250 | **New** | §7; lazy, cached, privacy-togged. |
| `tools/build-library.mjs` **(new)** | ~250 | **New** | tags → `SongMetadata` → `library.json` (+art, sidecars, embedded lyrics). |
| `src/modules/lyrics/lyrics.ts` | 660 | **Port, medium** | `LibraryStore` replaces `getSongMetadata/getSongAlbum`; segment-map branch removed; `videoId`→`trackId` for identity, `youtubeId` optional on the model. |
| `src/modules/lyrics/injectLyrics.ts` | 480 | **Port, small** | Drop `NO_LYRICS_TEXT_SELECTOR`/`disableNativeLyricsFocus`. |
| `lyricParseUtils`, `nonLatinScript`, `sourceAgreement`, `providerPin`, `selection`, `contributorCredit`, `lyricDecorations`, `translation.ts` | ~1,700 | **Keep** (imports adjusted) | translation.ts: verify CORS / proxy. |
| `providers/shared.ts` | 250 | **Keep** | `chrome.storage` → adapter. |
| `providers/unified.ts` (cubey SSE) | 700 | **Port, small** | VideoId optional but sent when resolved; `isrc` from model; Turnstile/JWT flow **dropped** unless cubey confirms the web-origin deployment — until then built-ins ship disabled-by-default *for remote* behind the §6.3 ladder with a clear settings note. |
| `providers/yt.ts` (`yt-lyrics`) | 200 | **Keep, conditional** | §6.5; no-ops without resolved ID; browse-parsing reused, fed by InnerTube via proxy; M3 spike; inert if shapes drifted. |
| `providers/ytCaptions.ts` | 105 | **Keep, conditional** | §6.5; captionTracks via InnerTube player response through proxy; else inert. |
| `providers/unison.ts` | 460 | **Keep, conditional** | §6.4; no-ops without resolved ID. |
| `requestSniffer/*` | ~1,450 | **Delete** | Interception model gone; only its lyrics-tab *parser* is reused, via §6.5. |
| `segmentMap.ts` | 150 | **Delete** | Music-video re-sync. |
| `src/core/storage.ts` | 470 | **Rewrite adapter** | Same exported names; `localStorage` + TTL envelope; same-name events via own EventTarget. |
| `src/core/i18n.ts` | 140 | **Port** | `chrome.i18n.getMessage` → small resolver over `_locales/*`; `runtime.getURL` → bundled asset. |
| `src/core/constants.ts` | 500 | **Keep, prune** | Delete YT selectors/URLs; class names kept (theme contract). `PROVIDER_CONFIGS` kept **verbatim** (§6.1). |
| `src/core/{logger,utils,relativeTime,compression,customCss}.ts` | ~800 | **Keep** | customCss: one `chrome.runtime.getURL` → asset import. |
| `src/modules/karaoke/*` | 850 | **Port** | Fullscreen bar source swap; `isAdPlaying`→false. |
| `src/modules/settings/*` | 600 | **Partial** | `settings.ts` ports; delete `videoQuality*` (~310). |
| `src/modules/ui/dom.ts` | 1,800 | **Port, heavily pruned** | Keep wrapper/footer/loader/cleanup/resume; delete ad overlay, YT thumbnail injection, tab plumbing, player-bar reveal. → ~700 LOC. |
| `src/modules/ui/lyricsDock/*` | 1,200 | **Keep** | Keys → trackId; position/offset/prefetch logic untouched. |
| `src/modules/ui/playerControls/*` | 1,700 | **Delete/replace** | New `<audio>` scrubber ~200 LOC. |
| `src/modules/ui/pictureInPicture/*` | ~4,200 | **Delete** (v1) | Optional Document-PiP later. |
| `src/modules/ui/{navigation,themeSongCompat,queueAutoplay,nativeLyricsFocus,…}` | ~800 | **Delete** | YT shell concerns. |
| `src/options/*` | 16,500 | **Split** | Keep & port: theme editor + `standalone-editor` (CodeMirror, becomes `editor.html`), theme store client, `translationLanguages`, slimmed `options.ts` → `settings.html` (message-passing → imports + `BroadcastChannel`). Drop: `background.ts`, `updateNotice`, `videoQuality*`, unison auth plumbing. Theme marketplace + unison pages: **deferred** (CORS & backend-story dependent). |
| `public/css/**`, `public/fonts/**` | 181K | **Keep** | Replace `EmitRendererStyles` with plain Vite CSS imports; drop `?v=` hashing (Vite does it); Default/HDR themes loadable by URL for the editor. |
| `public/script.js`, `earlyInject.js`, `src/pageWorld.ts` | ~510 | **Delete** | §4.1. |
| `manifest.json`, `extension.config.js`, `extension-env.d.ts`, `pages/*.html` | — | **Delete** | New Vite MPA entries. |
| `.github/workflows/*` (extension publish) | — | **Delete/rework** | New `ci.yml`: install → generate-locales → typecheck → selfcheck → knip → `vite build`. |
| `tooling/*` | — | **Keep what applies** | generate-locales, run-selfchecks, i18n-brand/format/stale, knip (re-globbed). Publish/sourcemap tooling deleted. |

Net: **~18k LOC deleted**, options split as above, remainder ported mechanically, plus **~1.1k LOC new** (Song model ~350, YouTube resolver ~250, library CLI ~250, scrubber/shell ~250).

## 10. Milestones

- **M0 — Scaffold + backend probe (1 d).** Branch; extension files deleted per §9; Vite MPA shell; storage + i18n adapters; CI green. **Probe the v2/lyrics endpoint with an empty `videoId`** (§6.3) and with ISRC; record which matching keys the backend accepts — this decides §6.3 (a/b/c) and is a blocking input to M3. If the Turnstile/JWT gate blocks web-origin calls entirely, note it here too: unified stream ships behind the ladder, built-ins off by default remotely, local sources unaffected.
- **M1 — Library + playback shell + Song model (2–3 d).** `tools/build-library.mjs` emitting `SongMetadata` (all §5.2 rules, incl. ISRC + embedded-URL scan), drag-drop via `music-metadata-browser` (same normalizer), queue/next/prev, seek bar, media keys, blurred art.
  - *Done when:* arbitrary mp3/flac/m4a/ogg with pathological tags (featuring, remaster suffixes, multi-source) resolve to a correct canonical model, verified by a `library.json` dump; playback stable.
- **M2 — Renderer on screen (1–2 d).** Slim observer, standalone host, pruned `ui/dom.ts`, CSS imports, themes, click-to-seek, footer/dock.
- **M3 — Provider pipeline + YouTube ID resolution (2–3 d).** `resolveYouTubeId` (embedded → InnerTube-via-proxy → Data-API → manual), proxy routes (`/youtubei/v1/{search,player,browse}`), YT-captions/yt-lyrics conditional ports, Unison conditional enablement, trackId re-keying (cache/offsets/pins), the local sidecar/embedded tier with the richsync-gated preference rule (§6.6 — preferred only when the local file carries per-word/per-syllable parts, fixed rule, no toggle), `?demo=` with all-format fixtures, granularity setting wired (§8).
  - *Done when:* (i) a library track with no tags matches LRCLIB/Unison through the built-in default order; (ii) a track with a `youtube.com/watch?v=…` comment resolves its ID from tags alone; (iii) with the resolver disabled, playback + local + (metadata-only or nothing) remote behavior matches the §6.3 case chosen at M0, and the UI says which; (iv) syllable fixture sweeps per syllable; (v) a richsync local sidecar wins the default display while built-ins still run underneath, and a line-synced local sidecar does *not* displace a built-in result of any sync tier — verified with fixtures of both shapes.
- **M4 — Syllable granularity polish (1–2 d).** §8 items 1–4 (parser patch upstreaming decision here).
- **M5 — Settings, themes, i18n (1–2 d).** `settings.html` live-apply port, theme editor entry, offset/dock defaults for the web app, i18n end-to-end, privacy toggle ("Resolve YouTube IDs…") in Language section.
- **M6 — Packaging (1 d).** README (install/dev/build/preview, proxy note, resolver privacy note), `server.mjs` for production static+proxy, CI, v1.0 tag.
- **Deferred** — Document-PiP lyrics; marketplace/Unison pages; store CORS audit.

## 11. Removing the extension surface (`chrome.*`)

Unchanged from rev. 1 — see table there (`chrome.storage` → adapter; `chrome.i18n` → resolver; `chrome.runtime` messaging → imports + `BroadcastChannel`; popup → `settings.html`; service worker deleted; manifest CSP → meta tag, keep `trusted-types.d.ts` deleted). One addition: **`chrome.storage.sync` quota comments** around `options.ts:135` (write-per-minute) disappear with the adapter — keep debounced writes anyway.

## 12. Build: extension.js + rspack → Vite

Unchanged from rev. 1. Key points restated: Vite + TS, MPA (`index`/`settings`/`editor`), `host: true`, `server.proxy` (env-gated) for `youtubei/v1/*` + Google Translate (LRCLIB is reached through the built-in cubey stream, not direct), `@braccato/core` CSS imported directly, aliases mirror tsconfig paths, `generate:locales` first in every script, Biome/selfchecks/knip kept, `knip` re-globbed.

## 13. Risks & open questions

1. **M0 blocks on cubey's matching semantics** (§6.3). Highest-risk unknown; the app is designed to degrade to local-only gracefully if metadata-only matching is rejected. Sidebar: the JWT/Turnstile gate (`CUBEY_LYRICS_API_URL_TURNSTILE`) may require the challenge iframe to succeed on a website origin — the challenge page is served by cubey and framed by anyone today (the extension frames it), so it plausibly works; verify.
2. **Unison & yt-captions/yt-lyrics share the videoId dependency** — one resolver failure disables three built-ins; the UI must name the missing precondition ("needs YouTube ID") rather than show mysterious silence.
3. **Local tier vs. built-in order — settled.** Local sidecars/embedded tags are preferred only when they contain per-word/per-syllable timings (§6.6); otherwise the built-in default order governs and the local file is a fallback. Notably this means a line-synced local file never displaces a remote syllable/word result on the default path; users overrule per-track only by manual pinning.
4. **InnerTube drift** — `/youtubei/v1/*` shapes are undocumented; isolate parsing behind `resolveYouTubeId` + `requestSniffer`'s reused parser, fail toward inert (per §6.5), and prefer the official Data API path for users who can paste a key.
5. **CJK/syllable rendering density** — budget real fixture testing (§8).
6. **Storage quotas** — ~5 MB `localStorage`; keep compression + purge; artwork stored as small files, not base64, in normal libraries.
7. **File System Access API** — Firefox support is partial; drag-drop + scanned `library.json` is the baseline, directory-watching out of scope.
8. **Licensing** — GPL-3 derivative; keep LICENSE + attribute Better Lyrics & braccato.
9. **Privacy posture** — the resolver sends song/artist to YouTube (or Google) unless disabled; settings copy must say so plainly. Local files, playback, editing, and theming never depend on it.

## 14. Verification plan

CI: `generate:locales → tsc → selfcheck → knip → vite build`. Manual matrix: five fixtures × four granularity settings × {offline, resolver off, resolver on, proxyless}; settings live-apply; theme switch mid-playback; fullscreen; karaoke; 30-min soak for animation accumulation. Self-checks (per repo policy — only pure, load-bearing logic): the §5.2 normalizer (featuring/remaster/filename splits), and the §7.2 candidate scorer's accept/reject boundary. Nothing DOM-shaped.

## 15. Execution order

1. This plan → review (blocking questions: nothing — §11–13 capture them; M0's probe is a task, not a question).
2. Branch `feat/web-app`; delete-first per §9; vertical slice = M0→M1→M2 with one enhanced-LRC fixture.
3. M3 is the risk retirement milestone; schedule M4 after the endpoint probe results are known.

### Appendix A — unified stream body: field-by-field mapping

| Body field (`unified.ts`) | Source in standalone |
|---|---|
| `videoId` | `meta.youtubeId ?? ""` (§7); §6.3 ladder if empty |
| `song` | `SongMetadata.title` (§5.2) |
| `artist` | `artists.join(", ")` (§5.2) |
| `duration` | `Math.round(durationMs / 1000)` |
| `album` | `album` (cleaned) or `""` |
| `alwaysFetchMetadata` | `true` when `sources` includes `filename` or tags were dirty (§5.3) — backend fix-up for free |
| `isrc` | `SongMetadata.isrc` (normalized; `findIsrc` call unchanged) |
| `unison` + `unisonKeyId` | only when resolved ID present (§6.4) |
| `token` | **dropped** only if M0 confirms no Turnstile gate; otherwise kept with the iframe challenge flow verbatim |

### Appendix B — every videoId call site gets an explicit new semantic

`getLyrics/cache/offset/pin` keys → trackId (§6.7). Unison submit/request/`getRequest` → resolved ID (§6.4/§6.8). `AppState.lastLoadedVideoId` → nullable mirror of `meta.youtubeId`; `currentInjectionId`/reload flows key on trackId. `resolveArtworkUrl` (footer button) → local embedded artwork data URL. `addFooter(…, videoId, …)` signature kept; argument becomes optional. `karaoke`/`viewLyrics` receive `PreparedLyrics` unchanged. `preFetchLyrics` iterates the queue by trackId. Thumbnail preloads deleted. **No silent `String(videoId)` coercions anywhere** — `""` and `undefined` are handled at each call site.

### Appendix C — one-line answer to "why keep built-ins instead of direct LRCLIB/MusicBrainz?"

Because the brief says use them, because they carry the syllable-tier sources (QRC/TTML richsync) that LRCLIB and friends don't, and because the whole point is that a file's clean tags are *as good a query* as a YouTube player response — the model in §5 exists to prove that, field by field.
