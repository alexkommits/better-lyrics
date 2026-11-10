import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/stage.css";
import "@braccato/core/styles/instrumental.css";
import "@braccato/core/styles/image-highlights.css";
import "./styles/app.css";
import "./styles/blyrics/index.css";
import { initI18n } from "@core/i18n";
import { initProviders } from "@modules/lyrics/providers/shared";
import { subscribeToCustomStyles } from "@modules/ui/styleInjector";
import { mountPlayer } from "@app/player";
import { logCore, errorCore } from "@core/logger";

/**
 * Standalone entry. Deliberately no unified-provider token warm-up here: unison is deferred
 * (see STANDALONE-WEB-PLAN.md) and the player must boot offline against the local library.
 */

async function main(): Promise<void> {
  await initI18n();

  // Provider bootstrap: read the preferred-provider order from storage and subscribe to changes,
  // apply any saved custom CSS. Same calls the extension made at startup.
  initProviders();
  subscribeToCustomStyles();

  mountPlayer();
  logCore("Application ready");
}

main().catch(error => {
  errorCore("Fatal startup error:", error);
});
