import { isKaraokeWanted } from "@modules/karaoke/state";
import { syncKaraoke } from "@modules/karaoke/karaokeView";

/**
 * Tells every view other than the main stage that what it shows may have changed: an injection, a
 * cleanup, a theme change, an offset nudge, or a translation or romanization batch landing.
 *
 * Document Picture-in-Picture was deferred in the plan, so the karaoke stage is the only secondary
 * view left.
 */
export function publishSecondaryViews(): void {
  syncKaraoke();
}

/** Whether a view other than the stage needs lyrics loaded while lyrics are not shown. */
export function isLyricsWantedOffTab(): boolean {
  return isKaraokeWanted();
}
