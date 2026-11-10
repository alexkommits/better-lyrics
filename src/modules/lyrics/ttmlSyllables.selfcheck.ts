import assert from "node:assert/strict";

const { expandNestedTimedSpans } = await import("@modules/lyrics/ttmlSyllables");
const { parseTTMLContent } = await import("@braccato/parsers");

// -- No-op cases ---------------------------------------------------

const flat = "<tt><body><div><p begin=\"1s\" end=\"2s\"><span begin=\"1s\" end=\"2s\">word</span></p></div></body></tt>";
assert.equal(expandNestedTimedSpans(flat), flat, "nothing nested: returned byte-identical");

const notTtml = "plain text, not xml";
assert.equal(expandNestedTimedSpans(notTtml), notTtml, "not TTML: unchanged");
assert.equal(expandNestedTimedSpans("<tt><body>"), "<tt><body>", "unparseable: returns input unchanged");
assert.equal(expandNestedTimedSpans(""), "");

// -- Apple-style nesting: timed syllables inside a timed word --------

// One line: pretty-printed whitespace inside <p> would ride into the line text (parser behaviour, not the pre-pass).
const apple = `<tt xml:lang="en"><body><div><p begin="1.0s" end="3.5s"><span begin="1.0s" end="1.8s"><span begin="1.0s" end="1.3s">Hel</span><span begin="1.3s" end="1.5s">lo</span></span><span begin="1.9s" end="2.1s"> </span><span begin="2.1s" end="3.0s"><span begin="2.1s" end="2.5s">world</span></span></p></div></body></tt>`;

const expanded = expandNestedTimedSpans(apple);
assert.notEqual(expanded, apple, "nested timed spans are expanded");
assert.equal((expanded.match(/<span/g) ?? []).length, 4, "word wrappers are spliced away; syllable spans survive");

const parsed = parseTTMLContent(expanded, { songDurationMs: 60_000 });
const sungLines = parsed.lyrics.filter(line => !line.isInstrumental);
assert.equal(sungLines.length, 1);
const line = sungLines[0];
assert.equal(line.words, "Hello world");
const partTexts = (line.parts ?? []).map(part => part.words);
assert.deepEqual(partTexts, ["Hel", "lo", " ", "world"], "parts are the syllables, in source order");
const hel = line.parts![0];
const lo = line.parts![1];
assert.equal(hel.startTimeMs, 1000);
assert.equal(lo.startTimeMs, 1300);
assert.equal(lo.durationMs, 200);
assert.equal(line.parts![3].startTimeMs, 2100);

// Without the pre-pass the same document collapses to word parts (the bug being fixed).
const unexpanded = parseTTMLContent(apple, { songDurationMs: 60_000 });
assert.deepEqual(
  (unexpanded.lyrics.find(line => !line.isInstrumental)?.parts ?? []).map(part => part.words),
  ["Hello", " ", "world"],
  "baseline: the parser flattens nested syllables into word parts"
);

// -- Mixed content: direct text survives alongside promoted syllables ---

const mixed = `<tt><body><div><p begin="1s" end="3s"><span begin="1s" end="2s">x<span begin="1.0s" end="1.4s">ab</span><span begin="1.4s" end="1.8s">cd</span></span></p></div></body></tt>`;
const mixedOut = expandNestedTimedSpans(mixed);
const mixedParsed = parseTTMLContent(mixedOut, { songDurationMs: 60_000 });
const mixedParts = (mixedParsed.lyrics.find(line => !line.isInstrumental)?.parts ?? []).map(part => part.words);
assert.deepEqual(mixedParts, ["x", "ab", "cd"], "direct text is kept, syllables are promoted");

// -- x-bg: the grouping boundary is never spliced ----------------------

const background = `<tt><body><div><p begin="1s" end="4s"><span role="x-bg" begin="1s" end="2.5s"><span begin="1s" end="1.7s"><span begin="1.0s" end="1.3s">ba</span><span begin="1.3s" end="1.6s">na</span></span><span begin="1.8s" end="2.5s">na</span></span></p></div></body></tt>`;
const backgroundOut = expandNestedTimedSpans(background);
assert.ok(backgroundOut.includes('role="x-bg"'), "the background group wrapper survives");
const backgroundParsed = parseTTMLContent(backgroundOut, { songDurationMs: 60_000 });
const bgParts = backgroundParsed.lyrics.find(line => !line.isInstrumental)?.parts ?? [];
assert.deepEqual(
  bgParts.map(part => part.words),
  ["ba", "na", "na"],
  "nested syllables expand inside the background group; the flat sibling is untouched"
);
assert.ok(bgParts.every(part => part.isBackground === true), "all background parts carry the background flag");
assert.equal(
  new Set(bgParts.map(part => part.backgroundGroup)).size,
  1,
  "one background group for the whole x-bg span, not one per promoted syllable"
);

// -- Double-nested (word > syllable > grapheme) flattens completely -----

const deep = `<tt><body><div><p begin="1s" end="3s"><span begin="1s" end="2s"><span begin="1.0s" end="1.8s"><span begin="1.0s" end="1.4s">a</span><span begin="1.4s" end="1.8s">b</span></span></span></p></div></body></tt>`;
const deepOut = expandNestedTimedSpans(deep);
const deepParsed = parseTTMLContent(deepOut, { songDurationMs: 60_000 });
assert.deepEqual(
  (deepParsed.lyrics.find(line => !line.isInstrumental)?.parts ?? []).map(part => part.words),
  ["a", "b"],
  "both levels of wrappers are removed"
);
