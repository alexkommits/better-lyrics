import assert from "node:assert/strict";

const { applySyncGranularity, collapseToWords, currentSyncGranularity } = await import("@modules/lyrics/granularity");
import type { Lyric } from "@modules/lyrics/providers/shared";

const line = (words: string, parts: Lyric["parts"]): Lyric => ({
  startTimeMs: 1000,
  durationMs: 2000,
  words,
  parts,
});

const syllables = (parts: Array<[string, number, number]>): Lyric["parts"] =>
  parts.map(([words, startTimeMs, durationMs]) => ({ words, startTimeMs, durationMs }));

const hello = line("Hello world", [
  ...syllables([["Hel", 1000, 300], ["lo", 1300, 200], [" ", 1900, 200], ["world", 2100, 400]])!,
]);

// -- auto / syllable: content untouched (no timing is invented) --------

assert.equal(applySyncGranularity([hello], "auto")[0], hello, "auto returns the input lines untouched");
assert.equal(applySyncGranularity([hello], "syllable")[0], hello, "syllable returns the input lines untouched");
assert.equal(currentSyncGranularity(), "auto", "default registered granularity is auto");

// -- word: syllable parts collapse to word parts ------------------------

const [wordLine] = applySyncGranularity([hello], "word", "en");
assert.deepEqual(
  wordLine.parts?.map(part => [part.words, part.startTimeMs, part.durationMs]),
  [["Hello", 1000, 500], [" ", 1900, 200], ["world", 2100, 400]],
  "syllables merge into words; surrounding spaces survive as their own parts"
);
assert.equal(wordLine.words, "Hello world", "the line text is unchanged");

// -- word: Japanese segments via an explicit locale ----------------------

const ja = line("本当にありがとう", syllables([
  ["本", 0, 100], ["当", 100, 100], ["に", 200, 100],
  ["あ", 300, 100], ["り", 400, 100], ["が", 500, 100], ["と", 600, 100], ["う", 700, 100],
])!);
const [jaWord] = applySyncGranularity([ja], "word", "ja");
assert.deepEqual(
  jaWord.parts?.map(part => part.words),
  ["本当に", "ありがとう"],
  "locale-aware segmentation merges CJK character parts into words"
);
assert.equal(jaWord.parts?.[0].startTimeMs, 0);
assert.equal(jaWord.parts?.[0].durationMs, 300);
assert.equal(jaWord.parts?.[1].startTimeMs, 300);
assert.equal(jaWord.parts?.[1].durationMs, 500);

// -- word: explicit flags survive a merge --------------------------------

const profane = line("ab cd", [
  ...syllables([["ab", 0, 100], [" ", 100, 50], ["cd", 150, 100]])!,
]);
profane.parts![0].explicit = true;
const [profaneWord] = applySyncGranularity([profane], "word", "en");
assert.equal(profaneWord.parts?.[0].explicit, true, "an explicit constituent marks the merged word");

// -- word: background groups never merge into the foreground --------------

type TimedPart = NonNullable<Lyric["parts"]>[number] & { isBackground?: boolean; backgroundGroup?: number };
const bg = line("ab", [
  { words: "a", startTimeMs: 0, durationMs: 100, isBackground: true, backgroundGroup: 0 } as TimedPart,
  { words: "b", startTimeMs: 100, durationMs: 100, isBackground: true, backgroundGroup: 0 } as TimedPart,
]);
const fgOverBg = line("ab", [
  { words: "a", startTimeMs: 0, durationMs: 100 }, // foreground
  { words: "b", startTimeMs: 100, durationMs: 100, isBackground: true, backgroundGroup: 0 } as TimedPart,
]);
const [bgWord] = applySyncGranularity([bg], "word", "en");
const bgPart = bgWord.parts?.[0] as TimedPart | undefined;
assert.equal(bgWord.parts?.length, 1, "background syllables merge within their own group");
assert.equal(bgPart?.isBackground, true);
assert.equal(bgPart?.backgroundGroup, 0);
const [splitGroup] = applySyncGranularity([fgOverBg], "word", "en");
const split = splitGroup.parts as TimedPart[] | undefined;
assert.equal(split?.length, 2, "a foreground/background boundary is a hard boundary");
assert.equal(split?.[0].isBackground, undefined);
assert.equal(split?.[1].isBackground, true);

// -- word: instrumental/unknown content is left alone ---------------------

const instrumental: Lyric = { startTimeMs: 0, durationMs: 5000, words: "", isInstrumental: true };
assert.equal(applySyncGranularity([instrumental], "word", "en")[0], instrumental);

// -- line: parts are dropped, line timing and text stay -------------------

const [lineOnly] = applySyncGranularity([hello], "line");
assert.equal(lineOnly.parts, undefined, "line mode drops parts entirely");
assert.equal(lineOnly.words, "Hello world");
assert.equal(lineOnly.startTimeMs, 1000);
assert.equal(lineOnly.durationMs, 2000);

// -- the input is never mutated -------------------------------------------

const frozen = line("ab cd", syllables([["ab", 0, 100], [" ", 100, 20], ["cd", 120, 100]])!);
const frozenParts = frozen.parts;
applySyncGranularity([frozen], "word", "en");
applySyncGranularity([frozen], "line");
assert.equal(frozen.parts, frozenParts, "caller's part array object is untouched");

// -- collapseToWords is a no-op on empty text ------------------------------

const blank = line("", syllables([["", 0, 0]])!);
assert.deepEqual(collapseToWords([blank], "en")[0], blank, "empty text is returned as-is");
