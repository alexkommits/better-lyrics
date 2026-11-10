/**
 * Nested timed-span expansion (STANDALONE-WEB-PLAN.md §8.1).
 *
 * Apple-style TTML nests timed syllable `<span>`s inside a timed word `<span>`. The lyric parser
 *
 *   <span begin="1s" end="2s"><span begin="1.0s" end="1.4s">我</span>…</span>
 *
 * flattens such a word into a single part — the children's timing is silently dropped and the
 * track renders word-synced when the source actually carried syllables. The walker in
 * @braccato/parsers only sees `<p>`-level spans (foreground) and direct children of `role="x-bg"`
 * spans (background), so nested timed spans are invisible to it at any depth ≥ 2.
 *
 * This pre-pass rewrites the document so every timed span the walker can see is where it lives:
 * a non-`x-bg` span with at least one direct timed-`<span>` child is *spliced away*, replaced by
 * its children (source order; untimed text rides along as untimed text). `role="x-bg"` spans are
 * never spliced — they are the background grouping boundary — but their interiors are expanded the
 * same way, so a background word containing timed syllables still emits per-syllable background
 * parts inside one background group.
 *
 * No timing is invented: child spans keep their own `begin`/`end`. Documents with nothing to
 * expand are returned byte-identical; any parse/serialize failure returns the input unchanged
 * (fail toward inert — the parser still gets a document it already knows how to handle, §6.5).
 */

import { XMLBuilder, XMLParser } from "fast-xml-parser";

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  attributesGroupName: false,
  textNodeName: "#text",
  trimValues: false,
  removeNSPrefix: true,
  preserveOrder: true,
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  htmlEntities: true,
} as const;

const BUILDER_OPTIONS = { ...PARSER_OPTIONS, format: false } as const;

type Attrs = Record<string, string>;
/** preserveOrder node shape: `{ tag: [...children] | string, ":@"?: attrs }` or `{ "#text": … }`. */
type Node = Record<string, unknown> & { ":@"?: Attrs };

function isTextNode(node: Node): boolean {
  return typeof node["#text"] === "string";
}

function elementTag(node: Node): string | null {
  if (isTextNode(node)) return null;
  for (const key of Object.keys(node)) {
    if (key !== ":@" && key !== "#text") return key;
  }
  return null;
}

function childrenOf(node: Node): Node[] | null {
  const tag = elementTag(node);
  if (!tag) return null;
  const value = node[tag];
  return Array.isArray(value) ? (value as Node[]) : null;
}

function attrsOf(node: Node): Attrs {
  return node[":@"] ?? {};
}

function isTimedSpan(node: Node): boolean {
  if (elementTag(node) !== "span") return false;
  const attrs = attrsOf(node);
  return attrs["@_begin"] !== undefined && attrs["@_begin"] !== "";
}

function isBackgroundSpan(node: Node): boolean {
  return elementTag(node) === "span" && attrsOf(node)["@_role"] === "x-bg";
}

/** Bottom-up rewrite of a children array. Sets `changed` when a splice happened. Mutates `children`. */
function expandInPlace(children: Node[], changed: { value: boolean }): void {
  // Recurse first so grandchildren timed spans are already spliced up before we inspect children.
  for (const child of children) {
    const inner = childrenOf(child);
    if (inner) expandInPlace(inner, changed);
  }

  const spliced: Node[] = [];
  for (const child of children) {
    if (elementTag(child) !== "span") {
      spliced.push(child);
      continue;
    }
    const inner = childrenOf(child) ?? [];
    const hasTimedSpanChild = inner.some(isTimedSpan);
    if (hasTimedSpanChild && !isBackgroundSpan(child)) {
      // The walker cannot reach past one level of nesting; drop the wrapper and promote its
      // children (source order). Untimed text nodes ride along as untimed text.
      changed.value = true;
      spliced.push(...inner);
      continue;
    }
    spliced.push(child);
  }
  children.length = 0;
  children.push(...spliced);
}

/**
 * Rewrites `ttml` so nested timed spans are visible to the lyric parser. Returns the input
 * byte-identical when there is nothing to expand or anything goes wrong.
 */
export function expandNestedTimedSpans(ttml: string): string {
  if (!ttml.includes("<tt") || !ttml.includes("</tt>") || !ttml.includes("<span")) return ttml;

  try {
    const parser = new XMLParser({ ...PARSER_OPTIONS });
    const parsed = parser.parse(ttml) as Node[];
    if (!Array.isArray(parsed)) return ttml;

    const changed = { value: false };
    expandInPlace(parsed, changed);
    if (!changed.value) return ttml;

    const builder = new XMLBuilder({ ...BUILDER_OPTIONS });
    const out = builder.build(parsed);
    // Paranoia: never hand the parser a document worse than what we were given.
    if (typeof out !== "string" || !out.includes("</tt>")) return ttml;
    return out;
  } catch {
    return ttml;
  }
}
