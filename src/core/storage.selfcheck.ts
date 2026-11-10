import assert from "node:assert/strict";

// In-memory localStorage stand-in; the module under test only uses the
// standard string API.
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

const readAll = (): Record<string, unknown> => {
  const items: Record<string, unknown> = {};
  for (let i = 0; i < localStorageFake.length; i++) {
    const key = localStorageFake.key(i)!;
    if (key.startsWith("sync:")) continue;
    try {
      items[key] = JSON.parse(localStorageFake.getItem(key)!);
    } catch {
      items[key] = localStorageFake.getItem(key);
    }
  }
  return items;
};

const {
  clearLyricCache,
  getStorageBreakdown,
  getUpdatedCacheInfo,
  refreshCacheInfo,
  storageCategoryForKey,
  summarizeLyricCache,
} = await import("@core/storage");
const { compressString } = await import("@core/compression");

const entry = { type: "transient", value: "x", expiry: 0 };
const seed = (items: Record<string, unknown>): void => {
  localStorageFake.clear();
  for (const [key, value] of Object.entries(items)) {
    localStorageFake.setItem(key, JSON.stringify(value));
  }
};

// -- Happy paths --------------------------
{
  seed({
    "blyrics_abcdefghijk_bLyrics-richsynced": entry,
    "blyrics_abcdefghijk_lrclib-synced": entry,
    "blyrics_zyxwvutsrqp_yt-lyrics": entry,
    blyrics_zyxwvutsrqp_unison: entry,
    blyrics_featured_themes: { themes: [] },
    blyrics_stableReleaseCheck: { checkedAt: 1 },
    userIdentity: { keyId: "k" },
  });
  const info = await getUpdatedCacheInfo();
  assert.equal(info.count, 2, "counts unique songs across lyric cache keys");
  assert.equal(info.size, JSON.stringify(entry).length * 4, "size covers only lyric cache keys");

  await clearLyricCache();
  assert.deepEqual(
    Object.keys(readAll()).sort(),
    ["blyrics_featured_themes", "blyrics_stableReleaseCheck", "userIdentity"],
    "clearing lyrics keeps featured themes, the release check and identity"
  );
  const storedStat = JSON.parse(localStorageFake.getItem("sync:cacheInfo")!);
  assert.deepEqual(storedStat, { count: 0, size: 0 }, "the stored stat is refreshed after clearing");
}

// -- Edge cases --------------------------
{
  seed({ blyrics_featured_themes: { themes: [] }, blyrics_stableReleaseCheck: { checkedAt: 1 } });
  assert.deepEqual(
    await getUpdatedCacheInfo(),
    { count: 0, size: 0 },
    "only non-lyric caches: the stat reads as empty, matching nothing to clear"
  );

  seed({ blyrics_abcdefghijk_metadata: entry });
  const metaOnly = await getUpdatedCacheInfo();
  assert.equal(metaOnly.count, 1, "cached song metadata counts as a cached song");
  await clearLyricCache();
  assert.deepEqual(Object.keys(readAll()), [], "cached song metadata is cleared with the lyrics");

  seed({ "blyrics__yt-lyrics": entry, "blyrics_yt-lyrics": entry });
  assert.deepEqual(await getUpdatedCacheInfo(), { count: 0, size: 0 }, "keys without a video id are not lyric caches");

  seed({ "other_abcdefghijk_yt-lyrics": entry });
  assert.deepEqual(await getUpdatedCacheInfo(), { count: 0, size: 0 }, "keys without the cache prefix are ignored");
}

// -- Invariants --------------------------
{
  seed({ "blyrics_abcdefghijk_yt-lyrics": entry, blyrics_featured_themes: {} });
  await clearLyricCache();
  await clearLyricCache();
  assert.deepEqual(Object.keys(readAll()).filter(k => k === "blyrics_featured_themes"), ["blyrics_featured_themes"], "clearing twice is idempotent");
}

// -- Error paths --------------------------
{
  seed({ "blyrics_abcdefghijk_yt-lyrics": entry, blyrics_featured_themes: {} });
  const cleared = await clearLyricCache();
  assert.deepEqual(
    Object.keys(readAll()),
    ["blyrics_featured_themes"],
    "clearing removes only the lyric keys"
  );
  assert.deepEqual(cleared, { count: 0, size: 0 }, "the clear returns the cleared stats");

  seed({ "blyrics_abcdefghijk_yt-lyrics": entry });
  const current = await refreshCacheInfo();
  assert.deepEqual(
    current,
    { count: 1, size: JSON.stringify(entry).length },
    "a refresh returns the computed stats"
  );
}

// -- Storage categories --------------------------
{
  assert.equal(storageCategoryForKey("blyrics_abcdefghijk_bLyrics-richsynced"), "lyrics");
  assert.equal(storageCategoryForKey("blyrics_abcdefghijk_metadata"), "lyrics", "metadata belongs to the lyric cache");
  assert.equal(
    storageCategoryForKey("blyrics_abcdefghijk_unison"),
    "lyrics",
    "Unison's per-song entry belongs to the lyric cache"
  );
  assert.equal(storageCategoryForKey("storeTheme:abc"), "themes");
  assert.equal(storageCategoryForKey("storeThemeIndex"), "themes");
  assert.equal(storageCategoryForKey("customThemes"), "themes");
  assert.equal(storageCategoryForKey("customCSS"), "themes");
  assert.equal(storageCategoryForKey("customCSS_chunk_3"), "themes");
  assert.equal(storageCategoryForKey("customCSS_chunked"), "themes", "regression: chunk bookkeeping is theme storage");
  assert.equal(storageCategoryForKey("customCSS_chunkCount"), "themes");
  assert.equal(storageCategoryForKey("cssCompressed"), "themes");
  assert.equal(storageCategoryForKey("userThemeRatings"), "themes");
  assert.equal(storageCategoryForKey("userThemeInstalls"), "themes");
  assert.equal(storageCategoryForKey("blyrics_featured_themes"), "themes");
  assert.equal(storageCategoryForKey("blyricsOffset_abc_bLyrics-synced"), "offsets");
  assert.equal(storageCategoryForKey("jwtToken"), "other");
  assert.equal(storageCategoryForKey("userIdentity"), "other");
  assert.equal(storageCategoryForKey("blyrics_stableReleaseCheck"), "other", "a blyrics_ prefix alone is not lyrics");
  assert.equal(storageCategoryForKey(""), "other");
}

// -- Lyric cache summary --------------------------
{
  const lyric = (body: object) => ({ type: "transient", value: compressString(JSON.stringify(body)), expiry: 0 });
  const missing = lyric({ version: 1, missing: true });
  const found = lyric({ version: 1, lyrics: [{ words: "hi", startTimeMs: 0, durationMs: 1 }] });
  const summary = summarizeLyricCache({
    "blyrics_aaaaaaaaaaa_bLyrics-richsynced": missing,
    "blyrics_aaaaaaaaaaa_lrclib-synced": found,
    blyrics_aaaaaaaaaaa_metadata: found,
    "blyrics_bbbbbbbbbbb_musixmatch-richsync": found,
    "blyrics_bbbbbbbbbbb_yt-lyrics": found,
    "blyrics_ccccccccccc_bLyrics-richsynced": missing,
    "blyrics_ddddddddddd_yt-lyrics": found,
    blyrics_eeeeeeeeeee_metadata: found,
    blyrics_featured_themes: { themes: [] },
  });
  assert.equal(summary.songs, 3, "counts songs with at least one real lyric entry");
  assert.deepEqual(
    summary.bySyncType,
    { syllable: 0, word: 1, line: 1, unsynced: 1 },
    "each song counts once, at its best sync type"
  );
}

// -- Lyric cache summary: edge cases --------------------------
{
  const body = JSON.stringify({ version: 1, lyrics: [] });
  assert.equal(
    summarizeLyricCache({
      "blyrics_aaaaaaaaaaa_lrclib-synced": { type: "transient", value: body, expiry: Date.now() - 1 },
    }).songs,
    0,
    "regression: expired entries waiting for the purge are not cached lyrics"
  );
  assert.equal(
    summarizeLyricCache({
      "blyrics_aaaaaaaaaaa_lrclib-synced": { type: "transient", value: body, expiry: Date.now() + 60_000 },
    }).songs,
    1,
    "unexpired entries count"
  );
  assert.deepEqual(summarizeLyricCache({}), { songs: 0, bySyncType: { syllable: 0, word: 0, line: 0, unsynced: 0 } });
  const legacy = { type: "transient", value: "not json", expiry: 0 };
  assert.equal(
    summarizeLyricCache({ "blyrics_aaaaaaaaaaa_lrclib-synced": legacy }).songs,
    1,
    "unreadable entries still count as lyrics"
  );
  const missingPlain = { type: "transient", value: JSON.stringify({ missing: true }), expiry: 0 };
  assert.equal(
    summarizeLyricCache({ "blyrics_aaaaaaaaaaa_lrclib-synced": missingPlain }).songs,
    0,
    "uncompressed misses are misses too"
  );
}

// -- Lyric cache summary: Unison --------------------------
{
  const unison = (lookup: object) => ({
    type: "transient",
    value: compressString(JSON.stringify({ version: 1, lookup, validatedAt: null })),
    expiry: 0,
  });
  const found = (syncType: string, format: string) =>
    unison({ found: true, data: { syncType, format, lyrics: "<tt></tt>" } });
  const lrc = { type: "transient", value: compressString(JSON.stringify({ version: 1, lyrics: [] })), expiry: 0 };
  const summary = summarizeLyricCache({
    blyrics_aaaaaaaaaaa_unison: found("richsync", "ttml"),
    "blyrics_aaaaaaaaaaa_musixmatch-richsync": lrc,
    "blyrics_aaaaaaaaaaa_lrclib-synced": lrc,
    blyrics_bbbbbbbbbbb_unison: found("richsync", "lrc"),
    blyrics_ccccccccccc_unison: unison({ found: false }),
  });
  assert.equal(summary.songs, 2, "a Unison-only song counts, a Unison miss does not");
  assert.deepEqual(
    summary.bySyncType,
    { syllable: 1, word: 1, line: 0, unsynced: 0 },
    "regression: a song's Unison TTML outranks its word and line entries"
  );
}

// -- Storage breakdown --------------------------
{
  seed({
    "blyrics_aaaaaaaaaaa_lrclib-synced": entry,
    "storeTheme:abc": { css: "a{}" },
    "blyricsOffset_aaaaaaaaaaa_lrclib-synced": entry,
    jwtToken: "t",
  });
  const breakdown = await getStorageBreakdown();
  const bytes = (key: string) => key.length + JSON.stringify(readAll()[key]).length;
  assert.equal(breakdown.lyrics.songs, 1);
  assert.deepEqual(breakdown.bytes, {
    lyrics: bytes("blyrics_aaaaaaaaaaa_lrclib-synced"),
    themes: bytes("storeTheme:abc"),
    offsets: bytes("blyricsOffset_aaaaaaaaaaa_lrclib-synced"),
    other: bytes("jwtToken"),
  });
  assert.equal(
    breakdown.totalBytes,
    Object.values(breakdown.bytes).reduce((a, b) => a + b, 0),
    "total is the sum of the categories"
  );

}
{
  seed({});
  const empty = await getStorageBreakdown();
  assert.equal(empty.totalBytes, 0);
  assert.equal(empty.lyrics.songs, 0);
}

console.log("storage self-check passed");
