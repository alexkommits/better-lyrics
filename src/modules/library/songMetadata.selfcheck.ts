/**
 * Self-check for the §5.2 normalization pipeline. Covers the load-bearing, pure parts:
 * feature extraction, artist splitting, qualifier stripping, ISRC validation, filename parsing,
 * and the filename fallback merge. Run: tsx src/modules/library/songMetadata.selfcheck.ts
 */

import assert from "node:assert/strict";
import {
  applyFilenameFallback,
  commonToRawTags,
  extractFeaturedArtists,
  extractUrls,
  filenameToSongMetadata,
  normalizeIsrc,
  parseFilename,
  rawTagsToSongMetadata,
  splitArtistList,
  stripQualifiers,
} from "./songMetadata";

// -- Feature extraction ---------------------------------

{
  const { title, featured } = extractFeaturedArtists("Song (feat. Alice & Bob)");
  assert.equal(title, "Song");
  assert.equal(featured, "Alice & Bob");
}
{
  const { title, featured } = extractFeaturedArtists("Song - feat. Carol");
  assert.equal(title, "Song");
  assert.equal(featured, "Carol");
}
{
  const { title, featured } = extractFeaturedArtists("Song featuring Dana");
  assert.equal(title, "Song");
  assert.equal(featured, "Dana");
}
{
  const { title, featured } = extractFeaturedArtists("Song [ft. Eve]");
  assert.equal(title, "Song");
  assert.equal(featured, "Eve");
}
{
  const { title, featured } = extractFeaturedArtists("(feat. Nobody)");
  assert.equal(title, "");
  assert.equal(featured, "Nobody");
}
{
  // No feature clause — untouched.
  const { title, featured } = extractFeaturedArtists("Plain Song Title");
  assert.equal(title, "Plain Song Title");
  assert.equal(featured, "");
}

// -- Artist splitting ------------------------------------

assert.deepEqual(splitArtistList("A & B"), ["A", "B"]);
assert.deepEqual(splitArtistList("A, B and C"), ["A", "B", "C"]);
assert.deepEqual(splitArtistList("A feat. B & C"), ["A", "B", "C"]);
assert.deepEqual(splitArtistList("A／B，C ＆ D"), ["A", "B", "C", "D"]); // ideographic separators
assert.deepEqual(splitArtistList("A · B"), ["A", "B"]); // middot
assert.deepEqual(splitArtistList("A vs. B"), ["A", "B"]);
assert.deepEqual(splitArtistList("Simon and Garfunkel"), ["Simon", "Garfunkel"]);
// De-dup is case-insensitive, first occurrence wins.
assert.deepEqual(splitArtistList("Daft Punk & daft punk"), ["Daft Punk"]);
// "x" only splits as a standalone token.
assert.deepEqual(splitArtistList("Axl & Rolling"), ["Axl", "Rolling"]);
assert.deepEqual(splitArtistList("A x B"), ["A", "B"]);

// -- Qualifier stripping ---------------------------------

assert.equal(stripQualifiers("Song (Remastered 2011)"), "Song");
assert.equal(stripQualifiers("Song (Remaster)"), "Song");
assert.equal(stripQualifiers("Song - Remastered 1999"), "Song");
assert.equal(stripQualifiers("Song (Live at Wembley)"), "Song");
assert.equal(stripQualifiers("Song - Live"), "Song");
assert.equal(stripQualifiers("Song (Deluxe Edition)"), "Song");
assert.equal(stripQualifiers("Song (Radio Edit)"), "Song");
assert.equal(stripQualifiers("Song (Explicit)"), "Song");
assert.equal(stripQualifiers("Song (Acoustic)"), "Song");
assert.equal(stripQualifiers("Song (Remix)"), "Song");
assert.equal(stripQualifiers("Song (Anniversary Edition) (Remaster 2020)"), "Song");
// Non-qualifier parenthesized text survives.
assert.equal(stripQualifiers("Song (Part 2)"), "Song (Part 2)");
assert.equal(stripQualifiers("Song (Original Motion Picture Soundtrack)"), "Song (Original Motion Picture Soundtrack)");
// Trailing dash with non-qualifier survives.
assert.equal(stripQualifiers("Song - Part 2"), "Song - Part 2");

// -- ISRC ------------------------------------------------

assert.equal(normalizeIsrc("us-abc-12-34567"), "USABC1234567");
assert.equal(normalizeIsrc("USABC1234567"), "USABC1234567");
assert.equal(normalizeIsrc("USABC123456"), undefined); // too short
assert.equal(normalizeIsrc("1SABC1234567"), undefined); // must start with letters
assert.equal(normalizeIsrc(undefined), undefined);

// -- URL extraction ---------------------------------------

assert.deepEqual(extractUrls(["check https://www.youtube.com/watch?v=abc123 out"]), [
  "https://www.youtube.com/watch?v=abc123",
]);
assert.deepEqual(extractUrls(["trailing dot https://example.com/foo."]), ["https://example.com/foo"]);
assert.deepEqual(extractUrls(["https://a.com/x", "https://a.com/x"]), ["https://a.com/x"]);

// -- Filename parsing --------------------------------------

assert.deepEqual(parseFilename("01 - Artist - Song (Remaster).mp3"), {
  title: "Song (Remaster)",
  artists: ["Artist"],
});
assert.deepEqual(parseFilename("Artist - Song.flac"), { title: "Song", artists: ["Artist"] });
assert.deepEqual(parseFilename("02. Artist - Album - Song.m4a"), { title: "Song", artists: ["Artist"] });
assert.deepEqual(parseFilename("Song.mp3"), { title: "Song", artists: [] });
assert.deepEqual(parseFilename("A & B - C & D - Song.ogg"), { title: "Song", artists: ["A", "B"] });

// -- rawTagsToSongMetadata ---------------------------------

{
  const meta = rawTagsToSongMetadata(
    {
      title: "Song (feat. Alice) - Remastered 2011",
      artistText: "The Artist & Bob",
      album: "  The Album ",
      year: 2011,
      trackNumber: 3,
      discNumber: 1,
      durationMs: 245000.4,
      isrc: ["us-abc-12-34567"],
      genres: [" Rock "],
      comment: ["https://www.youtube.com/watch?v=deadbeef"],
    },
    { sources: ["file-tags"] }
  );
  assert.equal(meta.title, "Song");
  assert.deepEqual(meta.artists, ["The Artist", "Bob", "Alice"]);
  assert.equal(meta.album, "The Album");
  assert.equal(meta.year, 2011);
  assert.equal(meta.trackNumber, 3);
  assert.equal(meta.durationMs, 245000);
  assert.equal(meta.isrc, "USABC1234567");
  assert.deepEqual(meta.genres, ["Rock"]);
  assert.deepEqual(meta.raw.urls, ["https://www.youtube.com/watch?v=deadbeef"]);
  assert.equal(meta.displayTitle, "Song (feat. Alice) - Remastered 2011");
  assert.deepEqual(meta.sources, ["file-tags"]);
}
{
  // Invalid ISRC is dropped, missing duration becomes 0.
  const meta = rawTagsToSongMetadata({ title: "X", isrc: ["bad"] }, { sources: ["file-tags"] });
  assert.equal(meta.isrc, undefined);
  assert.equal(meta.durationMs, 0);
}
{
  // No title at all → "Unknown title".
  const meta = rawTagsToSongMetadata({}, { sources: ["file-tags"] });
  assert.equal(meta.title, "Unknown title");
  assert.equal(meta.displayTitle, "Unknown title");
}

// -- Filename fallback merge --------------------------------

{
  const fromFile = filenameToSongMetadata("03 - Some Artist - Some Song.mp3", 123000);
  assert.equal(fromFile.title, "Some Song");
  assert.deepEqual(fromFile.artists, ["Some Artist"]);
  assert.equal(fromFile.durationMs, 123000);
  assert.deepEqual(fromFile.sources, ["filename"]);
}
{
  // Tags win; filename only fills gaps.
  const tagged = rawTagsToSongMetadata({ title: "Real Title", artistText: "Real Artist" }, { sources: ["file-tags"] });
  const merged = applyFilenameFallback(tagged, "01 - Other - Other Song.mp3");
  assert.equal(merged.title, "Real Title");
  assert.deepEqual(merged.artists, ["Real Artist"]);
  assert.deepEqual(merged.sources, ["file-tags"]);
}
{
  // Missing artist filled from filename.
  const tagged = rawTagsToSongMetadata({ title: "Real Title" }, { sources: ["file-tags"] });
  const merged = applyFilenameFallback(tagged, "Some Artist - Some Song.mp3");
  assert.equal(merged.title, "Real Title");
  assert.deepEqual(merged.artists, ["Some Artist"]);
  assert.deepEqual(merged.sources, ["file-tags", "filename"]);
}

// -- commonToRawTags ----------------------------------------

{
  const raw = commonToRawTags(
    {
      title: "Tagged Title",
      artists: ["A", "B"],
      artist: "A, B",
      album: "Al",
      albumartist: "AA",
      year: 1999,
      track: { no: 2 },
      disk: { no: 1 },
      genre: ["Trip Hop"],
      isrc: ["USABC1234567"],
      musicbrainz_recordingid: ["mbid-1"],
      comment: ["note https://t.co/x end"],
    },
    181000
  );
  assert.equal(raw.title, "Tagged Title");
  assert.deepEqual(raw.artists, ["A", "B"]);
  assert.equal(raw.artistText, "A, B");
  assert.equal(raw.trackNumber, 2);
  assert.equal(raw.discNumber, 1);
  assert.equal(raw.durationMs, 181000);
  assert.equal(raw.isrc?.[0], "USABC1234567");
}

console.log("songMetadata self-check passed");
