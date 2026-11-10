import { strict as assert } from "node:assert";
import { hasRichsyncParts, localTierOf, parseLocalLyrics, type LocalLyrics } from "@modules/lyrics/localSource";
import type { Lyric } from "@modules/lyrics/providers/shared";

const line = (overrides: Partial<Lyric> = {}): Lyric => ({
  startTimeMs: 0,
  words: "words",
  durationMs: 0,
  ...overrides,
});

// -- The §6.6 normative preference test: ≥1 non-instrumental part with durationMs !== 0 → richsync.

assert.equal(hasRichsyncParts([line({ parts: [{ startTimeMs: 1000, words: "a", durationMs: 500 }] })]), true, "a timed part counts");
assert.equal(
  hasRichsyncParts([line({ parts: [{ startTimeMs: 1000, words: "a", durationMs: 0 }] })]),
  false,
  "an all-zero-duration part counts as line-synced"
);
assert.equal(
  hasRichsyncParts([line({ isInstrumental: true, parts: [{ startTimeMs: 1000, words: "a", durationMs: 500 }] })]),
  false,
  "an instrumental part never counts"
);
assert.equal(hasRichsyncParts([line()]), false, "no parts at all is not richsync");

// -- Tier ranking.

assert.equal(localTierOf([line(), line()]), "none", "all-zero start times are plain");
assert.equal(localTierOf([line({ startTimeMs: 1000 }), line({ startTimeMs: 5000 })]), "synced", "timed lines are line-synced");
assert.equal(
  localTierOf([line({ startTimeMs: 1000, parts: [{ startTimeMs: 1000, words: "a", durationMs: 500 }] })]),
  "richsync",
  "a timed part makes it richsync"
);

// -- parseLocalLyrics end to end (the same fixtures the player smoke uses).

const richsync: LocalLyrics | null = parseLocalLyrics(
  "[00:01.00]<00:01.00>local <00:01.60>richsync <00:02.20>line\n[00:05.00]<00:05.00>second <00:05.60>local <00:06.20>line",
  60_000
);
assert.ok(richsync, "enhanced LRC parses");
assert.equal(richsync?.tier, "richsync");
assert.equal(richsync?.result.source, "Local file");
assert.equal(richsync?.result.cacheAllowed, false, "local lyrics are never cached server-side");

const synced: LocalLyrics | null = parseLocalLyrics("[ti:Song]\n[00:01.00]hello\n[00:05.00]world", 60_000);
assert.ok(synced, "line-synced LRC parses");
assert.equal(synced?.tier, "synced");

const plain: LocalLyrics | null = parseLocalLyrics("just some words\nand more words", 60_000);
assert.ok(plain, "plain text parses");
assert.equal(plain?.tier, "none");

assert.equal(parseLocalLyrics("   ", 60_000), null, "whitespace is no source");
assert.equal(parseLocalLyrics("[00:01.00]", 60_000)?.result.lyrics?.length ?? 0, 0, "no lines is no source");
