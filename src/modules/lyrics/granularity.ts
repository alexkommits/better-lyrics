/**
 * Sync granularity (STANDALONE-WEB-PLAN.md §8.2): `blyrics-sync-granularity` —
 * `auto | syllable | word | line`, default `auto`.
 *
 * `auto` renders the finest granularity the source carries, which is the only honest behaviour:
 * no timing is ever invented. `syllable` is currently identical in content — the mode exists so
 * the settings surface (M5) and themes can key off it; an opt-in pro-rated approximation remains
 * an explicit future extension, off by default. `word` re-times nothing but collapses
 * syllable-scale parts into word-scale parts (boundaries from `Intl.Segmenter`, locale-aware),
 * which is the right granularity for users who find per-syllable sweeps too frantic. `line` drops
 * parts entirely — the renderer rebuilds zero-duration word parts and sweeps per line.
 *
 * The transform creates new line/part objects and never mutates the source result (it is reused
 * across rebuilds); timing collisions are impossible because parts are merged by intersection.
 */

import { registerThemeSetting } from "@braccato/core/themeSettings";
import type { Lyric, LyricPart } from "@modules/lyrics/providers/shared";

type SyncGranularity = "auto" | "syllable" | "word" | "line";

const granularitySetting = registerThemeSetting("blyrics-sync-granularity", "auto", true);

export function currentSyncGranularity(): SyncGranularity {
  const raw = String(granularitySetting.getStringValue() ?? "auto");
  return raw === "syllable" || raw === "word" || raw === "line" ? raw : "auto";
}

interface TimedPart extends LyricPart {
  /** Emitted by the TTML parser for `role="x-bg"` spans; foreground parts have neither field. */
  isBackground?: boolean;
  backgroundGroup?: number;
}

function groupKeyOf(part: TimedPart): string {
  return part.isBackground === true ? `bg:${part.backgroundGroup ?? 0}` : "fg";
}

function collapseRunToWords(parts: TimedPart[], locale?: string): TimedPart[] {
  const text = parts.map(part => part.words).join("");
  if (!text) return parts;

  let segments: Array<{ segment: string }>;
  try {
    segments = [...new Intl.Segmenter(locale, { granularity: "word" }).segment(text)];
  } catch {
    // No segmenter (or a locale it rejects): leave the run untouched rather than guess boundaries.
    return parts;
  }

  const offsets: number[] = [];
  let offset = 0;
  for (const part of parts) {
    offsets.push(offset);
    offset += part.words.length;
  }

  const out: TimedPart[] = [];
  let cursor = 0;
  let partIndex = 0;
  for (const { segment } of segments) {
    const segStart = cursor;
    const segEnd = cursor + segment.length;
    cursor = segEnd;

    // Parts overlapping the segment, each claimed once, in order. Parts are finer than or equal
    // to words, but overlap is the only assumption worth making.
    let first = -1;
    let last = -1;
    while (partIndex < parts.length && offsets[partIndex] + parts[partIndex].words.length <= segStart) partIndex++;
    for (let j = partIndex; j < parts.length && offsets[j] < segEnd; j++) {
      if (first === -1) first = j;
      last = j;
    }
    if (first === -1) {
      // A whitespace segment with no intersecting parts (parser gap) — keep timing local to the line.
      out.push({ startTimeMs: 0, durationMs: 0, words: segment, isBackground: parts[0]?.isBackground, backgroundGroup: parts[0]?.backgroundGroup });
      continue;
    }
    const start = parts[first].startTimeMs;
    const end = Math.max(parts[last].startTimeMs + parts[last].durationMs, start);
    const explicit = parts.slice(first, last + 1).some(part => part.explicit === true);
    const merged: TimedPart = {
      startTimeMs: start,
      durationMs: end - start,
      words: segment,
    };
    if (parts[0].isBackground === true) {
      merged.isBackground = true;
      merged.backgroundGroup = parts[0].backgroundGroup;
    }
    if (explicit) merged.explicit = true;
    out.push(merged);
  }
  return out;
}

/**
 * Collapses every syllable/character part in each line to word scale. Foreground and each distinct
 * background group are collapsed independently so background spans never merge into sung words.
 */
export function collapseToWords(lyrics: Lyric[], locale?: string): Lyric[] {
  return lyrics.map(line => {
    const parts = line.parts as TimedPart[] | undefined;
    if (!parts || parts.length === 0) return line;

    // Maximal runs of one grouping key (foreground, or one background group each), in order.
    const runs: TimedPart[][] = [];
    for (const part of parts) {
      const key = groupKeyOf(part);
      const current = runs[runs.length - 1];
      if (current && groupKeyOf(current[0]) === key) current.push(part);
      else runs.push([part]);
    }

    return { ...line, parts: runs.flatMap(run => collapseRunToWords(run, locale)) };
  });
}

/**
 * Applies the display granularity to a lyric array. `locale` is used only for Segmenter word
 * boundaries (pass the source's language when known). Returns the input array unchanged for
 * `auto`/`syllable`.
 */
export function applySyncGranularity(
  lyrics: Lyric[],
  mode: SyncGranularity = currentSyncGranularity(),
  locale?: string
): Lyric[] {
  switch (mode) {
    case "line":
      return lyrics.map(({ parts: _parts, timedRomanization: _timedRomanization, ...rest }) => rest);
    case "word":
      return collapseToWords(lyrics, locale);
    case "syllable":
    case "auto":
    default:
      return lyrics;
  }
}
