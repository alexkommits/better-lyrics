/**
 * Standalone logging toggle, extracted so the settings page can flip it without pulling in the
 * player/karaoke module graph.
 */

import { configureLogging } from "@core/logger";
import { getStorage } from "@core/storage";

/** Reads `isLogsEnabled` (default true) and applies it to the logger. */
export function applyLoggingSetting(): void {
  getStorage({ isLogsEnabled: true }, items => {
    configureLogging(items.isLogsEnabled !== false);
  });
}
