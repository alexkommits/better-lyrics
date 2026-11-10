/**
 * Fullscreen state via the HTML Fullscreen API. Replaces the YouTube player-page attribute
 * tracking the extension used (`player-fullscreened` on #layout).
 */

export function isPlayerFullscreened(): boolean {
  return document.fullscreenElement != null;
}

/**
 * Registers callbacks for fullscreen changes. The HTML Fullscreen API has no enter/exit
 * distinction worth having here — the callers re-read isPlayerFullscreened().
 */
export function onFullscreenChange(...callbacks: (() => void)[]): void {
  const unique = [...new Set(callbacks)];
  for (const callback of unique) {
    document.addEventListener("fullscreenchange", callback);
  }
}
