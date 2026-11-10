import { isLoaderActive } from "@modules/ui/dom";
import { seekPlayer } from "@modules/lyrics/lyrics";
import { getResumeScrollElement } from "@modules/ui/resumeScrollButton";
import type { LyricsRendererHost } from "@braccato/core";
import { type LogSink, logCore } from "@core/logger";

/**
 * The standalone player's answers to what a lyrics view cannot work out on its own. The view is
 * always visible (the player page *is* the lyrics view), there are no ads to sync against, and
 * seeking goes through the shared seek event the <audio> clock listens to.
 */
export const standaloneHost: LyricsRendererHost = {
  isViewVisible(): boolean {
    return true;
  },
  isLoaderActive,
  syncAdState(): boolean {
    return false;
  },
  setResumeAffordanceVisible(visible: boolean): void {
    const resumeButton = getResumeScrollElement();
    if (visible) {
      resumeButton.removeAttribute("autoscroll-hidden");
    } else {
      resumeButton.setAttribute("autoscroll-hidden", "true");
    }
  },
  /**
   * Resolved per call: the stage is mounted by the player shell after this module is imported.
   */
  getScrollElement(): HTMLElement | null {
    return document.getElementById("blyrics-stage");
  },
  seek: seekPlayer,
  get log(): LogSink {
    return logCore;
  },
};

