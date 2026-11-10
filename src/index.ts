import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/stage.css";
import "@braccato/core/styles/instrumental.css";
import "@braccato/core/styles/image-highlights.css";
import "./styles/blyrics/index.css";
import { initI18n, t } from "@core/i18n";
import { initProviders } from "@modules/lyrics/providers/shared";
import { prewarmAuthenticationToken } from "@modules/lyrics/providers/unified";
import { subscribeToCustomStyles } from "@modules/ui/styleInjector";

/**
 * M0 scaffold entry. The real player shell (library, <audio> clock, renderer) replaces this in
 * milestones M1–M2 of STANDALONE-WEB-PLAN.md. Kept deliberately minimal: it exists so the MPA,
 * the style pipeline and the locale pipeline are verifiable end to end.
 */

async function main(): Promise<void> {
  await initI18n();

  // Provider bootstrap: read the preferred-provider order from storage and subscribe to changes,
  // apply any saved custom CSS, and warm the unified provider's JWT so the first lyric request
  // does not pay the auth round trip. Same calls the extension made at startup.
  initProviders();
  subscribeToCustomStyles();
  prewarmAuthenticationToken();

  const app = document.getElementById("app");
  if (!app) return;

  const main = document.createElement("main");
  main.className = "player-shell";
  main.innerHTML = `
    <section class="player-shell__hero">
      <h1 class="player-shell__title">Better Lyrics</h1>
      <p class="player-shell__tagline">Per-syllable synced lyrics for your local music library.</p>
      <p class="player-shell__hint">The standalone player is under construction. Watch this space.</p>
    </section>
  `;
  app.append(main);
}

void main();
