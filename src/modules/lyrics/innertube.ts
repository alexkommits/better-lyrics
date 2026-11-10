/**
 * @fileoverview Minimal InnerTube (YouTube Music) client, reached through the dev server's
 * `/youtubei/v1` proxy — InnerTube does not send CORS headers, so the browser cannot call it
 * directly. Used by the `yt-lyrics` provider (M0) and by the YouTube ID resolver (M3).
 *
 * Shapes were lifted from the extension's request sniffer and drift often; every failure mode
 * returns `null` so callers degrade to "no YouTube lyrics" rather than a broken view.
 */

interface InnertubeLyrics {
  text: string;
  sourceText: string;
}

const WEB_REMIX_CONTEXT = {
  client: {
    clientName: "WEB_REMIX",
    clientVersion: "1.20240923.00.00",
    hl: "en",
    gl: "US",
  },
} as const;

async function callInnertube(path: string, body: unknown, signal: AbortSignal): Promise<any | null> {
  try {
    const response = await fetch(`/youtubei/v1/${path}`, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: WEB_REMIX_CONTEXT, ...(body as Record<string, unknown>) }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

interface LyricsTab {
  endpoint?: { browseEndpoint?: { browseId?: string } };
  unselectable?: boolean;
}

/**
 * Fetches the plain-text YouTube Music lyrics for a video. Two calls: the /next response carries
 * the lyrics tab (including whether the video has one at all), the /browse response carries the
 * text. Returns null when there are no lyrics or the endpoints drift.
 */
export async function fetchInnertubeLyrics(videoId: string, signal: AbortSignal): Promise<InnertubeLyrics | null> {
  const next = await callInnertube("next", { videoId }, signal);

  const tab: LyricsTab | undefined =
    next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs
      ?.map((entry: any) => entry?.tabRenderer)
      ?.find((renderer: any) => renderer?.endpoint?.browseEndpoint?.browseId?.startsWith("MPLYt_"));

  // The sniffer found the lyrics tab at tabs[1]; match by browseId prefix as well, and treat an
  // `unselectable` tab as "YouTube says there are no lyrics".
  const lyricsTab = tab ?? next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
    ?.watchNextTabbedResultsRenderer?.tabs?.[1]?.tabRenderer;
  if (!lyricsTab || lyricsTab.unselectable) return null;

  const browseId: string | undefined = lyricsTab.endpoint?.browseEndpoint?.browseId;
  if (!browseId) return null;

  const browse = await callInnertube("browse", { browseId }, signal);
  const shelf = browse?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer;
  const text: string | undefined = shelf?.description?.runs?.[0]?.text;
  const sourceText: string | undefined = shelf?.footer?.runs?.[0]?.text;
  if (!text) return null;

  return { text, sourceText: sourceText ?? "YouTube Music" };
}
