import { AppState, currentTrackIdentity, reloadLyrics } from "@core/appState";
import { pinForPick, saveProviderPin } from "@modules/lyrics/providerPin";
import type { LyricSourceKey } from "@modules/lyrics/providers/shared";

export function selectProvider(key: LyricSourceKey): void {
  const pinned = pinForPick(key, AppState.availableProviderKeys);
  // Held for this song even when no pin is saved, so the pick still overrides the checks on reload.
  AppState.manualProviderKey = key;
  const identity = currentTrackIdentity();
  const saved = identity
    ? saveProviderPin(identity, pinned && { key: pinned, unisonLyricsId: AppState.availableUnisonLyricsId })
    : Promise.resolve();
  if (pinned) reloadLyrics();
  else void saved.then(reloadLyrics);
}

export function cycleProvider(direction: 1 | -1): void {
  const list = AppState.availableProviderKeys;
  if (list.length < 2) return;

  const basis = AppState.manualProviderKey ?? AppState.currentProviderKey;
  const basisIndex = list.findIndex(key => key === basis);
  const start = basisIndex === -1 ? 0 : basisIndex;
  const next = (start + direction + list.length) % list.length;

  selectProvider(list[next]);
}
