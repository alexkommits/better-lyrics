import { AppState } from "@core/appState";
import { t } from "@core/i18n";
import { translateContributorCreditLabels } from "@modules/lyrics/contributorCredit";
import { type LogSink, logCore } from "@core/logger";
import type { LyricDecorations } from "@modules/lyrics/injectLyrics";
import { currentViewLyrics } from "@modules/lyrics/viewLyrics";
import { currentTickOptions, lyricsElementAdded } from "@modules/ui/mainLyricsView";
import { createKaraokeStage, type KaraokeStage } from "@modules/karaoke/stage";
import { isKaraokeActive, isKaraokeLayout, isKaraokeWanted, syncKaraokeAttribute } from "@modules/karaoke/state";

// -- The karaoke view --------------------------

function createMainPageStage(): KaraokeStage {
  return createKaraokeStage({
    doc: document,
    win: window,
    overlay: {
      doc: document,
      get mountParent(): HTMLElement {
        return document.body;
      },
      get writtenByLabel(): string {
        return t("lyrics_writtenBy");
      },
      bar: null,
    },
    get contributorLabels() {
      return translateContributorCreditLabels(key => t(key));
    },
    isVisible: isKaraokeActive,
    isAdPlaying: () => false,
    get log(): LogSink {
      return logCore;
    },
  });
}

let stage = createMainPageStage();

let builtFrom: object | null = null;
let builtLanguage: string | null | undefined;
let decorationSignature = "";
let wasActive = false;
let wasLayout = false;

function clearKaraokeLyrics(): void {
  stage.clear();
  builtFrom = null;
  decorationSignature = "";
}

function signatureOf(decorations: LyricDecorations): string {
  let signature = "";
  for (const [index, decoration] of Object.entries(decorations)) {
    signature += `${index}${decoration.romanization ? "r" : ""}${decoration.translation ? "t" : ""},`;
  }
  return signature;
}

function publishKaraokeLyrics(): void {
  const source = AppState.parsedLyrics;
  const lyricData = AppState.lyricData;
  if (!source || !lyricData || lyricData.isProvisional || lyricData.syncType === "none") {
    if (builtFrom !== null) clearKaraokeLyrics();
    return;
  }
  if (!isKaraokeWanted()) return;

  const view = currentViewLyrics();
  if (!view.lyrics || view.noLyrics) {
    if (builtFrom !== null) clearKaraokeLyrics();
    return;
  }

  const rebuilt = source !== builtFrom;
  if (rebuilt) {
    stage.build({
      lyrics: view.lyrics,
      language: view.language,
      songwriters: view.songwriters,
      contributors: view.contributors,
      title: lyricData.song,
      artist: lyricData.artist,
      providerKey: AppState.currentProviderKey,
    });
    builtFrom = source;
    builtLanguage = view.language;
    decorationSignature = "";
  } else if (view.language !== builtLanguage) {
    builtLanguage = view.language;
    stage.setLanguage(view.language);
  }

  const signature = signatureOf(view.decorations);
  if (!rebuilt && signature === decorationSignature) return;
  decorationSignature = signature;
  stage.applyDecorations(view.decorations, retickKaraoke);
}

// -- Ticking --------------------------

// Ticks before the side panel: on the shared clock only the first view to tick sees a seek as a jump.
// `wallTime` is accepted for call-site symmetry but unused — the engine reads no player snapshot.
export function tickKaraoke(timeS: number, wallTime: number, isPlaying: boolean): void {
  void wallTime;
  stage.tick(timeS, currentTickOptions(isPlaying));
}

function retickKaraoke(): void {
  stage.retick((_eventCreationTime, isPlaying) => currentTickOptions(isPlaying, false));
}

function relayoutKaraoke(): void {
  stage.relayout();
  retickKaraoke();
}

// -- Sync --------------------------

export function syncKaraoke(): void {
  const active = syncKaraokeAttribute();

  if (active) publishKaraokeLyrics();
  else if (!AppState.parsedLyrics && builtFrom !== null) clearKaraokeLyrics();
  stage.setVisible(active, relayoutKaraoke);

  // Each view was off the screen while the other one showed, so neither kept its measurements.
  if (active !== wasActive) {
    wasActive = active;
    if (active) relayoutKaraoke();
  }
  const layout = isKaraokeLayout();
  if (layout !== wasLayout) {
    wasLayout = layout;
    if (!layout) {
      lyricsElementAdded();
    }
  }
}

export function applyKaraokeTheme(css: string): void {
  stage.setTheme(css);
}

export function disposeKaraoke(): void {
  clearKaraokeLyrics();
  stage.destroy();
  stage = createMainPageStage();
  wasActive = false;
  wasLayout = false;
}
