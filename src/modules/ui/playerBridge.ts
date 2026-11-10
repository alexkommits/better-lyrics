/**
 * The standalone clock: drives the lyrics renderer from the `<audio>` element and kicks off the
 * provider pipeline on track changes. This is the slim replacement for the extension's observer —
 * no YouTube selectors, no navigation detection, just an audio element and a library track.
 *
 * Seeking arrives through SEEK_EVENT (dispatched by the renderer's host when a lyric line is
 * clicked) so the click-to-seek path travels the same route as the extension's page world.
 */

import { SEEK_EVENT } from "@constants";
import { AppState, type PlayerDetails } from "@core/appState";
import { createLyrics } from "@modules/lyrics/lyrics";
import { resolveYouTubeId } from "@modules/library/resolveYouTubeId";
import { currentTickOptions, mainView } from "@modules/ui/mainLyricsView";
import type { SongMetadata } from "@modules/library/songMetadata";
import { logCore, warnCore } from "@core/logger";

interface BridgeTrack {
  id: string;
  metadata: SongMetadata;
  /** Same-basename sidecar web paths, when the library found any. */
  sidecars?: Record<string, string>;
  /** Embedded lyric text (USLT / Vorbis LYRICS / ©lyr), when present. */
  embeddedLyrics?: string;
}

/** Reads the raw local lyric source for a track, if any. Sidecar wins over embedded tags. */
async function readLocalLyrics(track: BridgeTrack): Promise<{ text: string; sourceHref: string } | null> {
  const sidecarUrl = track.sidecars?.lrc;
  if (sidecarUrl) {
    try {
      const response = await fetch(sidecarUrl);
      if (response.ok) {
        const text = await response.text();
        if (text.trim()) return { text, sourceHref: sidecarUrl };
      } else {
        warnCore("Local lyric sidecar fetch failed:", sidecarUrl, response.status);
      }
    } catch (error) {
      warnCore("Local lyric sidecar fetch failed:", sidecarUrl, error);
    }
  }
  const embedded = track.embeddedLyrics?.trim();
  if (embedded) return { text: embedded, sourceHref: "" };
  return null;
}

let audioElement: HTMLAudioElement | null = null;
let trackController: AbortController | null = null;
let clockStarted = false;

/** Builds the provider input for a library track. YouTube IDs stay unresolved until M3. */
function playerDetailsFor(track: BridgeTrack): PlayerDetails {
  const { metadata } = track;
  return {
    song: metadata.title,
    artist: metadata.artists.join(", ") || "Unknown artist",
    album: metadata.album ?? "",
    duration: metadata.durationMs / 1000,
    videoId: metadata.youtubeId ?? "",
    // Filename-derived metadata is what the backend metadata pass exists to fix up.
    alwaysFetchMetadata: metadata.sources.includes("filename"),
    trackId: track.id,
  };
}

/**
 * Wires SEEK_EVENT to the audio clock, mirrors playbackRate into AppState, and starts the rAF
 * loop. Call once, at boot, with the app's audio element.
 */
export function attachLyricsBridge(audio: HTMLAudioElement): void {
  audioElement = audio;

  document.addEventListener(SEEK_EVENT, event => {
    const timeS = (event as CustomEvent<number>).detail;
    if (typeof timeS === "number" && Number.isFinite(timeS)) {
      audio.currentTime = Math.max(0, timeS);
    }
  });

  audio.addEventListener("ratechange", () => {
    if (audio.playbackRate > 0) AppState.playbackRate = audio.playbackRate;
  });

  if (!clockStarted) {
    clockStarted = true;
    const loop = (): void => {
      requestAnimationFrame(loop);
      if (!AppState.areLyricsTicking) return;
      const status = mainView.tick(audio.currentTime, currentTickOptions(performance.now(), !audio.paused));
      if (status === "lyrics-missing") {
        AppState.areLyricsTicking = false;
      }
    };
    requestAnimationFrame(loop);
  }
}

/**
 * Starts the lyrics pipeline for a newly selected track. Aborts whatever was in flight.
 * Safe to call before any lyrics exist; the loader is the user-visible feedback meanwhile.
 */
export async function notifyTrackChanged(track: BridgeTrack): Promise<void> {
  const audio = audioElement;
  if (!audio) {
    warnCore("Lyrics bridge attached after a track was selected; attach at boot instead.");
    return;
  }

  trackController?.abort("Track changed");
  const controller = new AbortController();
  trackController = controller;

  const detail = playerDetailsFor(track);
  // The resolver never throws by contract; keep the lyrics pipeline safe regardless.
  const [local, resolvedId] = await Promise.all([
    readLocalLyrics(track),
    resolveYouTubeId(track.metadata, {
      signal: controller.signal,
      trackId: track.id,
      extraScanTexts: track.embeddedLyrics ? [track.embeddedLyrics] : undefined,
    }).catch(() => null),
  ]);
  if (controller.signal.aborted) return;
  if (resolvedId) {
    track.metadata.youtubeId = resolvedId.id;
    track.metadata.youtubeIdSource = resolvedId.via;
    detail.videoId = resolvedId.id;
    logCore(`Resolved a YouTube ID for track ${track.id} via ${resolvedId.via} (${resolvedId.confidence}).`);
  }
  if (local) {
    detail.localLyrics = local.text;
    detail.localSourceHref = local.sourceHref;
  }

  logCore(
    "Loading lyrics for track",
    track.id,
    detail.song,
    "—",
    detail.artist,
    resolvedId ? `(yt id ${resolvedId.id})` : "",
    local ? "(local source)" : ""
  );
  createLyrics(detail, controller.signal).catch(error => {
    if (controller.signal.aborted) return;
    warnCore("Lyrics pipeline failed:", error);
  });
}
