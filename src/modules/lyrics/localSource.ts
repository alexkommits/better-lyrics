/**
 * The local lyrics tier (STANDALONE-WEB-PLAN.md §6.6): same-basename sidecar files and embedded
 * lyric tags become a `local` source — never a member of `providerPriority`, no new provider key,
 * no setting.
 *
 * The tier test is the renderer's own part-based rule: at least one non-instrumental line carrying
 * a part whose `durationMs !== 0` makes the file richsync, and richsync files are preferred — the
 * effective order becomes `["local", …providerPriority]`. Line-synced or plain files rank last:
 * built-ins govern, the local file shows only when nothing built in lands lyrics (a manual pin on
 * `local` always wins regardless of tier).
 *
 * Parse failures degrade silently to "no local source" plus one log line.
 */

import { detectParser } from "@braccato/parsers";
import type { Lyric, LyricSourceResult } from "@modules/lyrics/providers/shared";
import { logCore } from "@core/logger";
import { expandNestedTimedSpans } from "@modules/lyrics/ttmlSyllables";

export interface LocalLyrics {
  result: LyricSourceResult;
  tier: "richsync" | "synced" | "none";
}

/** Normative §6.6 preference test — mirrors the renderer's `deriveSyncType`. */
export function hasRichsyncParts(lyrics: Lyric[]): boolean {
  return lyrics.some(item => !item.isInstrumental && item.parts?.some(part => part.durationMs !== 0) === true);
}

export function localTierOf(lyrics: Lyric[]): LocalLyrics["tier"] {
  if (hasRichsyncParts(lyrics)) return "richsync";
  return lyrics.every(item => item.startTimeMs === 0) ? "none" : "synced";
}

/**
 * Parses raw local lyric text (enhanced/plain LRC, SRT, TTML, QRC, or plain text — whatever
 * `detectParser` recognizes, which also covers embedded USLT/LYRICS content). `songDurationMs`
 * bounds instrumental gaps. Returns null when the text holds no lines or cannot be parsed.
 */
export function parseLocalLyrics(text: string, songDurationMs: number, sourceHref = ""): LocalLyrics | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    // §8.1: nested Apple-style timed syllables expand before parsing; no-op for other formats.
    const prepared = trimmed.includes("<tt") ? expandNestedTimedSpans(trimmed) : trimmed;
    const parser = detectParser(prepared);
    const lyrics = parser.parse(prepared, songDurationMs);
    if (!lyrics || lyrics.length === 0) {
      logCore("Local lyric source held no lines; ignoring it.");
      return null;
    }
    const tier = localTierOf(lyrics);
    return {
      tier,
      result: {
        lyrics,
        source: "Local file",
        sourceHref,
        musicVideoSynced: false,
        // The local file is the user's own data; nothing to cache server-side, and it changes on disk.
        cacheAllowed: false,
        language: null,
      },
    };
  } catch (error) {
    logCore("Local lyric source failed to parse; ignoring it:", error);
    return null;
  }
}
