import { PlainParser } from "@braccato/parsers";
import { fetchInnertubeLyrics } from "@modules/lyrics/innertube";
import { type LyricSourceResult, type ProviderParameters } from "./shared";

export type YTLyricSourceResult = LyricSourceResult & {
  text: string;
};

/**
 * YouTube Music's own lyrics entry for the resolved video. Requires a YouTube ID (resolved by the
 * M3 resolver) and goes through the same InnerTube route the mismatch check in `lyrics.ts` uses.
 * No ID, no lyrics: the source settles empty and the priority list moves on.
 */
export default async function ytLyrics(providerParameters: ProviderParameters): Promise<void> {
  if (!providerParameters.videoId) {
    providerParameters.sourceMap["yt-lyrics"].filled = true;
    providerParameters.sourceMap["yt-lyrics"].lyricSourceResult = null;
    return;
  }

  const result = await fetchInnertubeLyrics(providerParameters.videoId, providerParameters.signal);
  if (!result) {
    providerParameters.sourceMap["yt-lyrics"].filled = true;
    return;
  }

  const lyricsArray = PlainParser.parse(result.text);
  providerParameters.sourceMap["yt-lyrics"].lyricSourceResult = {
    lyrics: lyricsArray,
    text: result.text,
    source: `${result.sourceText} (via YT)`,
    sourceHref: "",
    musicVideoSynced: false,
    cacheAllowed: false,
  };
  providerParameters.sourceMap["yt-lyrics"].filled = true;
}
