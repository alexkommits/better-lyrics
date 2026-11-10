import assert from "node:assert/strict";

// In-memory localStorage stand-in (same shape as storage.selfcheck.ts). The module under test only
// uses the standard string API.
class FakeLocalStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}
const localStorageFake = new FakeLocalStorage();
Object.defineProperty(globalThis, "localStorage", { value: localStorageFake, configurable: true });

const {
  isValidYouTubeId,
  findEmbeddedYouTubeId,
  innertubeSearchCandidates,
  pickBestCandidate,
  resolveYouTubeId,
  saveManualYouTubeId,
  loadManualYouTubeId,
  YTID_CACHE_TTL_MS,
} = await import("@modules/library/resolveYouTubeId");
const { setTransientStorage } = await import("@core/storage");

import type { SongMetadata } from "@modules/library/songMetadata";

const SIGNAL = new AbortController().signal;
const baseMeta = (): SongMetadata => ({
  title: "Richsync Song",
  artists: ["Local Artist"],
  durationMs: 60_000,
  displayTitle: "Richsync Song",
  displayArtist: "Local Artist",
  raw: {},
  sources: ["file-tags"],
});
const embeddedMeta = (): SongMetadata => ({
  ...baseMeta(),
  raw: { urls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"], comment: ["ripped from youtube"] },
});

// -- ID validation -------------------------------------------------

assert.equal(isValidYouTubeId("dQw4w9WgXcQ"), true);
assert.equal(isValidYouTubeId("abc-DEF_123"), true);
assert.equal(isValidYouTubeId("dQw4w9WgXc"), false, "10 chars is not an id");
assert.equal(isValidYouTubeId("dQw4w9WgXcQQ"), false, "12 chars is not an id");
assert.equal(isValidYouTubeId("dQw4w9Wg!cQ"), false, "invalid character");

// -- Embedded-tag scan (§7.2 step 1) --------------------------------

assert.equal(findEmbeddedYouTubeId(["nothing here"]), null);
assert.equal(findEmbeddedYouTubeId(["see https://www.youtube.com/watch?v=dQw4w9WgXcQ"]), "dQw4w9WgXcQ");
assert.equal(findEmbeddedYouTubeId(["https://music.youtube.com/watch?list=PLxyz&v=dQw4w9WgXcQ"]), "dQw4w9WgXcQ");
assert.equal(findEmbeddedYouTubeId(["https://youtu.be/dQw4w9WgXcQ?si=abc"]), "dQw4w9WgXcQ");
assert.equal(findEmbeddedYouTubeId(["https://www.youtube.com/shorts/dQw4w9WgXcQ"]), "dQw4w9WgXcQ");
assert.equal(findEmbeddedYouTubeId(["https://www.youtube.com/embed/dQw4w9WgXcQ"]), "dQw4w9WgXcQ");
assert.equal(findEmbeddedYouTubeId(["https://www.youtube.com/watch?v=tooshort"]), null);
assert.equal(findEmbeddedYouTubeId(["first https://youtu.be/aaaaaaaaaaa then https://youtu.be/bbbbbbbbbbb"]), "aaaaaaaaaaa", "first match wins");

// -- InnerTube candidate extraction (canned WEB_REMIX payload) --------

const canned = {
  contents: {
    tabbedSearchResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    musicShelfRenderer: {
                      contents: [
                        {
                          musicResponsiveListItemRenderer: {
                            playlistItemData: { videoId: "dQw4w9WgXcQ" },
                            flexColumns: [
                              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Richsync Song" }] } } },
                              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Local Artist" }] } } },
                            ],
                            fixedColumns: [
                              { musicResponsiveListItemFixedColumnRenderer: { text: { simpleText: "1:00" } } },
                            ],
                          },
                        },
                        {
                          musicResponsiveListItemRenderer: {
                            navigationEndpoint: { watchEndpoint: { videoId: "bXbXbXbXbXb" } },
                            flexColumns: [
                              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Some other track" }] } } },
                              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Someone Else" }] } } },
                            ],
                            fixedColumns: [
                              { musicResponsiveListItemFixedColumnRenderer: { text: { simpleText: "45" } } },
                            ],
                          },
                        },
                        { musicResponsiveListItemRenderer: { flexColumns: [] } }, // no id — dropped
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

const candidates = innertubeSearchCandidates(canned);
assert.equal(candidates.length, 2, "malformed renderers are dropped");
assert.deepEqual(candidates[0], { videoId: "dQw4w9WgXcQ", title: "Richsync Song", artists: "Local Artist", durationMs: 60_000 });
assert.equal(candidates[1].durationMs, null, "unparseable duration stays unknown");
assert.deepEqual(innertubeSearchCandidates(null), []);
assert.deepEqual(innertubeSearchCandidates({ contents: "junk" }), []);

// -- Candidate scoring (§7.2 accept boundary) --------------------------

const meta = baseMeta();
assert.equal(pickBestCandidate(candidates, meta)?.videoId, "dQw4w9WgXcQ", "the duration-matched candidate wins");
assert.equal(
  pickBestCandidate([{ ...candidates[0], durationMs: 66_500 }], meta),
  null,
  "more than 2 s off is rejected"
);
assert.equal(
  pickBestCandidate([{ ...candidates[0], title: "Entirely different words" }], meta),
  null,
  "a title below 0.85 is rejected"
);
assert.equal(
  pickBestCandidate([{ ...candidates[0], artists: "Someone Else" }], meta),
  null,
  "an artist below 0.6 is rejected"
);
assert.equal(pickBestCandidate([], meta), null);

// -- The ladder, end to end against the storage adapter -----------------

localStorageFake.clear();

// Embedded tag beats the cache and needs no network.
await setTransientStorage(
  "blyricsYtId_t-embedded",
  JSON.stringify({ id: "cXcXcXcXcXc", via: "innertube", confidence: "fuzzy", resolvedAt: Date.now() }),
  YTID_CACHE_TTL_MS
);
const viaEmbedded = await resolveYouTubeId(embeddedMeta(), { signal: SIGNAL, trackId: "t-embedded" });
assert.deepEqual(viaEmbedded, { id: "dQw4w9WgXcQ", via: "embedded-tag", confidence: "exact" });

// Cache serves positive network answers when tags carry nothing.
const viaCache = await resolveYouTubeId(baseMeta(), { signal: SIGNAL, trackId: "t-embedded" });
assert.deepEqual(viaCache, { id: "cXcXcXcXcXc", via: "innertube", confidence: "fuzzy" });

// Manual override wins over everything, including the embedded tag.
await saveManualYouTubeId("t-manual", "eYeYeYeYeYe");
assert.deepEqual(await loadManualYouTubeId("t-manual"), { id: "eYeYeYeYeYe", via: "manual", confidence: "exact" });
const viaManual = await resolveYouTubeId(embeddedMeta(), { signal: SIGNAL, trackId: "t-manual" });
assert.deepEqual(viaManual, { id: "eYeYeYeYeYe", via: "manual", confidence: "exact" });

// Clearing the manual override restores automatic resolution.
await saveManualYouTubeId("t-manual", null);
assert.equal(await loadManualYouTubeId("t-manual"), null);
const viaAuto = await resolveYouTubeId(embeddedMeta(), { signal: SIGNAL, trackId: "t-manual" });
assert.deepEqual(viaAuto, { id: "dQw4w9WgXcQ", via: "embedded-tag", confidence: "exact" });

// Garbage in tags yields null (network legs are inert without a proxy/key).
const nothing = await resolveYouTubeId(baseMeta(), { signal: SIGNAL, trackId: "t-nothing" });
assert.equal(nothing, null);

// A malformed manual value is ignored rather than trusted.
await saveManualYouTubeId("t-bad", "eYeYeYeYeYe").catch(() => assert.fail("valid id should not throw"));
await assert.rejects(saveManualYouTubeId("t-bad", "not-an-id"), "an invalid id is refused");

// -- Privacy toggle off disables the ladder entirely ----------------------

const { setThemeSettings } = await import("@braccato/core/themeSettings");
const flip = flag => setThemeSettings(new Map([["blyrics-resolve-youtube-ids", String(flag)]]));

await flip(false);
assert.equal(
  await resolveYouTubeId(embeddedMeta(), { signal: SIGNAL, trackId: "t-embedded" }),
  null,
  "toggle off suppresses even the deterministic embedded-tag leg"
);
await saveManualYouTubeId("t-toggle", "eYeYeYeYeYe");
assert.equal(
  (await loadManualYouTubeId("t-toggle"))?.id ?? null,
  "eYeYeYeYeYe",
  "manual overrides persist regardless of the toggle"
);

await flip(true);
const back = await resolveYouTubeId(embeddedMeta(), { signal: SIGNAL, trackId: "t-embedded" });
assert.deepEqual(back, { id: "dQw4w9WgXcQ", via: "embedded-tag", confidence: "exact" });
