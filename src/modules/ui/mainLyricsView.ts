import { AppState } from "@core/appState";
import { standaloneHost } from "@modules/ui/lyricsHost";
import { createLyricsRenderer, type LyricsRenderer, type TickOptions } from "@braccato/core";

// -- The side panel's view --------------------------

/**
 * The side panel's lyrics view. Created at import time, long before YouTube Music has rendered a
 * lyrics tab, so it is given no mount: the injection names one once it has built the wrapper.
 *
 * Handed out without `destroy`, because destruction is final and there is no path back: this view
 * lives for as long as the tab does, and seven modules can reach it.
 */
export const mainView: Omit<LyricsRenderer, "destroy"> = createLyricsRenderer({ document, window, host: standaloneHost });

// -- Tick options --------------------------

/**
 * Reads the settings and player state the main window's view renders against. The engine holds none
 * of this itself: a second view in a second document would resolve its own.
 *
 * `eventCreationTime` stays at its -1 default ("not sampled from a live player") on purpose: the
 * standalone host has no player snapshot — the <audio> element's clock is already the absolute
 * media time, so the engine must not extrapolate it against Date.now(). Passing wall-clock-vs-page
 * mismatch epochs here (e.g. performance.now()) inflates the computed time by seconds-since-epoch
 * and pins every line as sung (verified 2026-11-10).
 */
export function currentTickOptions(isPlaying: boolean, smoothScroll = true): TickOptions {
  return {
    isPlaying,
    smoothScroll,
    globalLyricOffset: AppState.globalLyricOffset,
    lyricOffset: AppState.lyricOffset,
    richsyncOffsetTrim: AppState.richsyncOffsetTrim,
    lineOffsetTrim: AppState.lineOffsetTrim,
    passiveScrollEnabled: AppState.isPassiveScrollEnabled,
    playbackRate: AppState.playbackRate,
  };
}

// -- Re-sync on layout change --------------------------

/**
 * Renders the side panel again against the last player snapshot, without smooth scrolling. Used
 * whenever something other than the clock moved the lyrics: an offset change, a line arriving.
 */
export function retickMainView(): void {
  if (!AppState.areLyricsTicking) return;

  const status = mainView.retickFromPlaybackClock((_eventCreationTime, isPlaying) =>
    currentTickOptions(isPlaying, false)
  );
  if (status === "lyrics-missing") {
    AppState.areLyricsTicking = false;
  }
}

/**
 * Re-measures the lines and re-ticks after something was added to the lyrics DOM.
 */
export function lyricsElementAdded(): void {
  if (!AppState.areLyricsTicking) return;

  mainView.scheduleLyricPositionUpdate(() => AppState.areLyricsTicking, retickMainView);
}
