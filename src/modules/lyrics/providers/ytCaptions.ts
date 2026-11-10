import { MUSIC_NOTES } from "@constants";
import { findBestLanguageMatch, langCodesMatch } from "@utils";
import { captionTracksOf, type CaptionTrack, type LyricsArray, type ProviderParameters } from "./shared";
import { logCore } from "@core/logger";

export function pickCaptionTrack<T extends { languageCode: string; displayName: string }>(
  tracks: T[],
  langCode: string
): T | undefined {
  const manualTracks = tracks.filter(track => !track.displayName.includes("auto-generated"));
  const manualCodes = manualTracks.map(track => track.languageCode);
  const matchedCode =
    findBestLanguageMatch(langCode, manualCodes) ?? manualCodes.find(code => langCodesMatch(code, langCode));
  return manualTracks.find(track => track.languageCode === matchedCode);
}

export async function ytCaptions(providerParameters: ProviderParameters): Promise<void> {
  // Nothing produces caption tracks for local files until the resolver ports the player call
  // (M3), so this no-ops for audio-file playback.
  const tracks = captionTracksOf(providerParameters.audioTrackData);
  if (!tracks || tracks.length === 0) {
    return;
  }

  let langCode: string | null = null;
  if (tracks.length === 1) {
    langCode = tracks[0].languageCode;
  } else {
    // Try and determine the language by finding an auto generated track
    // TODO: This sucks as a method
    for (const data of tracks) {
      if (data.displayName.includes("auto-generated")) {
        langCode = data.languageCode;
        break;
      }
    }
  }

  if (!langCode) {
    logCore("Found Caption Tracks, but couldn't determine the default", tracks);
    providerParameters.sourceMap["yt-captions"].filled = true;
    providerParameters.sourceMap["yt-captions"].lyricSourceResult = null;
    return;
  }

  const captionTrack = pickCaptionTrack(tracks, langCode);
  if (!captionTrack) {
    logCore("Only found auto generated lyrics for youtube captions, not using", tracks);
    providerParameters.sourceMap["yt-captions"].filled = true;
    providerParameters.sourceMap["yt-captions"].lyricSourceResult = null;
    return;
  }

  const captionsUrl = new URL(captionTrack.url);
  captionsUrl.searchParams.set("fmt", "json3");

  let captionData = await fetch(captionsUrl.toString(), {
    method: "GET",
    signal: AbortSignal.any([providerParameters.signal, AbortSignal.timeout(10000)]),
  }).then(response => response.json());

  let lyricsArray: LyricsArray = [];

  captionData.events.forEach((event: { segs: { [x: string]: { utf8: string } }; tStartMs: any; dDurationMs: any }) => {
    let words = "";
    for (let segsKey in event.segs) {
      words += event.segs[segsKey].utf8;
    }
    words = words.replace(/\n/g, " ");
    for (let c of MUSIC_NOTES) {
      words = words.trim();
      if (words.startsWith(c)) {
        words = words.substring(1);
      }
      if (words.endsWith(c)) {
        words = words.substring(0, words.length - 1);
      }
    }
    words = words.trim();
    lyricsArray.push({
      startTimeMs: event.tStartMs,
      words: words,
      durationMs: event.dDurationMs,
    });
  });

  let allCaps = lyricsArray.every(lyric => {
    return lyric.words.toUpperCase() === lyric.words;
  });

  if (allCaps) {
    lyricsArray.every(lyric => {
      lyric.words = lyric.words.substring(0, 1).toUpperCase() + lyric.words.substring(1).toLowerCase();
      return true;
    });
  }

  providerParameters.sourceMap["yt-captions"].filled = true;
  providerParameters.sourceMap["yt-captions"].lyricSourceResult = {
    lyrics: lyricsArray,
    language: langCode,
    source: "YouTube Captions",
    sourceHref: "",
    musicVideoSynced: true,
  };
}
