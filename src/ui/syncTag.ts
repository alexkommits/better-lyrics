import { type SyncType } from "@constants";
import { t } from "@core/i18n";

// -- Labels --------------------------

const SYNC_TYPE_KEYS: Record<SyncType, { label: string; tooltip: string }> = {
  syllable: { label: "options_syncType_syllable", tooltip: "options_syncType_syllable_tooltip" },
  word: { label: "options_syncType_word", tooltip: "options_syncType_word_tooltip" },
  line: { label: "options_syncType_line", tooltip: "options_syncType_line_tooltip" },
  unsynced: { label: "options_syncType_unsynced", tooltip: "options_syncType_unsynced_tooltip" },
};

export function syncTypeLabel(type: SyncType): string {
  return t(SYNC_TYPE_KEYS[type].label);
}

export function syncTypeTooltip(type: SyncType): string {
  return t(SYNC_TYPE_KEYS[type].tooltip);
}

// -- Element --------------------------


