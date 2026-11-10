# Demo fixtures & built-in provider formats

`?demo=<fixture-id>` boots the app with a synthetic session track whose embedded lyrics are one of
the fixtures in `public/demo/`. The track is session-only (never persisted), and audio is a silent
8-second WAV so the clock advances through the fixture timings. Run `npm run dev` and open
`http://localhost:5173/?demo=apple-nested`. In production builds the same query works — the fixtures
are copied into `dist/demo/` verbatim.

Demo playback goes through the **local tier**: every fixture parses as an embedded tag, richsync
fixtures (all the timed ones) win outright, plain ones demonstrate the fallback rule. That means the
demo doubles as the syllable-density render check (§8.3 of the port plan): switch themes or flip
`blyrics-sync-granularity` in the console with
`setThemeSettings(new Map([["blyrics-sync-granularity", "word"]]))` — a live settings UI ships in M5.

| Fixture id | File | Transport / format | What it proves |
|---|---|---|---|
| `apple-nested` | `public/demo/apple-nested.ttml` | Apple TTML, word span with timed syllable children (`itunes:timing="Syllable"`) | The §8.1 nested-timed-span pre-pass: parts come out per syllable, not flattened per word. |
| `apple-word` | `public/demo/apple-word.ttml` | Apple TTML, flat timed word spans (`itunes:timing="Word"`) | Word-tier TTML renders without any syllable inflation. |
| `amll-syllable` | `public/demo/amll-syllable.ttml` | AMLL TTML, one timed span per syllable, agent-tagged | Syllable TTML as AMLL emits it; also exercises `ttm:agent`. |
| `qrc` | `public/demo/qrc.qrc` | QQ QRC (`<QrcInfos LyricContent=…>`, timestamp **trailing** each syllable — Braccato's grammar) | QRC syllable parsing; Chinese text. |
| `musixmatch-wb` | `public/demo/musixmatch-wb.lrc` | Enhanced LRC / Musixmatch `wordByWord` (`<mm:ss.xx>` before each word) | Word-timed LRC via `parseLRC` + `lrcFixers`. |
| `japanese` | `public/demo/japanese.ttml` | TTML, per-character parts | CJK render density, Japanese. |
| `korean` | `public/demo/korean.ttml` | TTML, per-syllable Hangul parts | CJK render density, Korean. |
| `plain-lrc` | `public/demo/plain-lrc.lrc` | LRC, line timing only | Line-synced path; renderer rebuilds zero-duration word parts. |
| `srt` | `public/demo/srt.srt` | SRT subtitle format | SRT parser coverage. |

Everything is hand-authored and **within 8 seconds** — the silent WAV ends at 8 s.

## Formats the 18 built-ins actually return

Verified against `src/modules/lyrics/providers/unified.ts` (unified SSE parser) and
`src/modules/lyrics/providers/unison.ts` (Unison fill); QQ/Portato and Musixmatch share transports
with their line-synced twins. "Tier" is the `syncType` in `src/core/constants.ts` (`PROVIDER_CONFIGS`).

| # | Key | Display name | Tier | Wire format (per source comments) |
|---|---|---|---|---|
| 1 | `bLyrics-richsynced` | Better Lyrics | syllable | TTML (vendor "golyrics"); possibly double-encoded JSON — unpacked before `fillTtml` |
| 2 | `unison-richsynced` | Unison | syllable | TTML when the Unison entry's `format` is `ttml` |
| 3 | `spicy-richsynced` | Spicy Lyrics | syllable | TTML, community uploads (with uploader/maker attribution) |
| 4 | `binimum-richsynced` | BiniLyrics | syllable | TTML |
| 5 | `unison-wordsynced` | Unison | word | LRC with `syncType: richsync` from the Unison entry |
| 6 | `portato-richsynced` | Better Lyrics Portato | word | QQ QRC, JSON-wrapped (`{ lyrics }`), syllable timestamps trailing each syllable |
| 7 | `musixmatch-richsync` | Musixmatch | word | Enhanced LRC (`wordByWord` key of the Musixmatch result) |
| 8 | `bLyrics-synced` | Better Lyrics | line | Same TTML as #1, line view |
| 9 | `unison-synced` | Unison | line | TTML line view, or LRC when the entry's `syncType` is not `richsync` |
| 10 | `spicy-synced` | Spicy Lyrics | line | Same TTML as #3, line view |
| 11 | `yt-captions` | YouTube Captions | line | YouTube caption tracks (timed text); inert until caption tracks are produced (resolver adds none for local files) |
| 12 | `binimum-synced` | BiniLyrics | line | Same TTML as #4, line view |
| 13 | `lrclib-synced` | LRCLib | line | LRC (`synced` key) |
| 14 | `legato-synced` | Better Lyrics Legato | line | LRC, JSON-wrapped (`{ lyrics }`) |
| 15 | `musixmatch-synced` | Musixmatch | line | LRC (`synced` key) |
| 16 | `yt-lyrics` | YouTube | unsynced | YouTube Music's plain-text lyrics |
| 17 | `unison-plain` | Unison | unsynced | Plain text when the Unison entry's `format` is `plain` |
| 18 | `lrclib-plain` | LRCLib | unsynced | Plain text (`plain` key) |

Notes:

- TTML fans out to two keys (`unison-richsynced`/`unison-synced`, `bLyrics-*`, `spicy-*`,
  `binimum-*`) from **one** document; the renderer's `deriveSyncType` decides rich vs line display
  from whether timed parts exist.
- With §8.1's pre-pass, all TTML paths (providers and local files) now emit syllable parts for
  Apple-nested documents; flat documents are byte-identical untouched.
- The Granularity setting (`blyrics-sync-granularity`) can coerce any of these to word/line display.
