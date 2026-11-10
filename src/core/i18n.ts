import { warnCore } from "@core/logger";
import { getSyncStorage, subscribeStorageChanges } from "@core/storage";

// -- Display Code Mapping --------------------------

const DISPLAY_CODE_MAP: Record<string, string> = {
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
};

// -- Supported Locales --------------------------

const RETIRED_LOCALES: Record<string, string> = { pt: "pt_BR" };

function resolveUiLanguage(saved: string): string {
  return RETIRED_LOCALES[saved] ?? saved;
}

// -- Locale Resolution --------------------------

/**
 * Locale messages ship as static assets under `_locales/<code>/messages.json`. Only the resolved
 * locale (and English as the fallback) are fetched at runtime.
 */
// import.meta.glob is Vite-only; under the node-based self-checks it is absent, and locale
// loading simply resolves to null there (the checks exercise pure functions, not fetches).
const messageLoaders: Record<string, () => Promise<string>> =
  typeof import.meta.glob === "function"
    ? (import.meta.glob("../../_locales/*/messages.json", {
        query: "?url",
        import: "default",
      }) as Record<string, () => Promise<string>>)
    : {};

const FALLBACK_LOCALE = "en";

interface MessageEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

const localeMessageCache = new Map<string, Promise<Record<string, MessageEntry> | null>>();

function fetchFirstLocale(candidates: string[]): Promise<Record<string, MessageEntry> | null> {
  for (const candidate of candidates) {
    const loaderKey = Object.keys(messageLoaders).find(path => path.includes(`/${candidate}/`));
    if (!loaderKey) continue;
    let pending = localeMessageCache.get(candidate);
    if (!pending) {
      pending = (messageLoaders[loaderKey]() as Promise<string>)
        .then(url => fetch(url))
        .then(res => (res.ok ? (res.json() as Promise<Record<string, MessageEntry>>) : null))
        .catch(error => {
          warnCore(`Failed to load locale "${candidate}":`, error);
          return null;
        });
      localeMessageCache.set(candidate, pending);
    }
    return pending as Promise<Record<string, MessageEntry> | null>;
  }
  return Promise.resolve(null);
}

/** Candidate `_locales` directory names for a browser locale, best match first. */
function localeCandidates(locale: string): string[] {
  const normalized = locale.replace("-", "_");
  const [language] = normalized.split("_");
  const candidates = [normalized];
  if (language && language !== normalized) candidates.push(language);
  candidates.push(FALLBACK_LOCALE);
  return candidates;
}

function browserLocaleCandidates(): string[] {
  const language = typeof navigator !== "undefined" ? navigator.language : FALLBACK_LOCALE;
  return localeCandidates(language || FALLBACK_LOCALE);
}

/** The locale whose messages are active; English until `initI18n` resolves. */
let activeMessages: Record<string, MessageEntry> = {};
let resolvedLocale = FALLBACK_LOCALE;

/** Loads the messages for the active UI language ("auto" resolves against navigator.language). */
async function loadLocaleOverride(): Promise<void> {
  let saved = "auto";
  try {
    const items = await getSyncStorage<{ uiLanguage: string }>({ uiLanguage: "auto" });
    saved = items.uiLanguage;
  } catch (error) {
    warnCore("Failed to read the uiLanguage setting:", error);
  }

  const preferred = resolveUiLanguage(saved);
  const candidates = preferred && preferred !== "auto" ? localeCandidates(preferred) : browserLocaleCandidates();

  const fallbackMessages = (await fetchFirstLocale([FALLBACK_LOCALE])) ?? {};
  const locale = candidates.find(candidate => candidate !== FALLBACK_LOCALE) ?? FALLBACK_LOCALE;
  const ownMessages =
    locale === FALLBACK_LOCALE ? fallbackMessages : ((await fetchFirstLocale([locale])) ?? fallbackMessages);

  activeMessages = { ...fallbackMessages, ...ownMessages };
  resolvedLocale = locale;
}

function resolveMessage(entry: MessageEntry, substitutions?: string | string[]): string {
  let result = entry.message;

  if (!entry.placeholders && !substitutions) return result;

  const subs = substitutions ? (Array.isArray(substitutions) ? substitutions : [substitutions]) : [];

  if (entry.placeholders) {
    for (const [name, def] of Object.entries(entry.placeholders)) {
      const resolved = def.content.replace(/\$(\d+)/g, (_, idx) => subs[parseInt(idx, 10) - 1] ?? "");
      result = result.replace(new RegExp(`\\$${name}\\$`, "gi"), () => resolved);
    }
  }

  return result;
}

/**
 * Test-only hook: seeds the active messages so self-checks can assert against known strings.
 * Nothing in the app calls this; only *.selfcheck.ts entries do.
 */
export function seedI18nMessages(messages: Record<string, string>, locale = "en"): void {
  activeMessages = Object.fromEntries(Object.entries(messages).map(([key, message]) => [key, { message }]));
  resolvedLocale = locale;
}

export function t(key: string, substitutions?: string | string[]): string {
  const entry = activeMessages[key];
  return entry ? resolveMessage(entry, substitutions) : key;
}

export function getLanguageDisplayName(langCode: string): string {
  try {
    const displayCode = DISPLAY_CODE_MAP[langCode] ?? langCode;
    const displayNames = new Intl.DisplayNames([navigator.language], { type: "language", fallback: "none" });
    return displayNames.of(displayCode) ?? langCode;
  } catch (e) {
    warnCore(`Failed to get display name for "${langCode}":`, e);
    return langCode;
  }
}

/** Loads the active locale, then replaces `__MSG_key__` placeholders in the static markup. */
export async function initI18n(): Promise<void> {
  await loadLocaleOverride();

  document.documentElement.lang = resolvedLocale.replace("_", "-");

  const msgPattern = /__MSG_(\w+)__/g;

  const processNode = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      const newText = node.textContent.replace(msgPattern, (_, key) => t(key));
      if (newText !== node.textContent) {
        node.textContent = newText;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      for (const attr of Array.from(el.attributes)) {
        if (attr.value.includes("__MSG_")) {
          attr.value = attr.value.replace(msgPattern, (_, key) => t(key));
        }
      }
      for (const child of Array.from(node.childNodes)) {
        processNode(child);
      }
    }
  };

  processNode(document.body);
  document.title = document.title.replace(msgPattern, (_, key) => t(key));
  document.body.classList.add("i18n-ready");
}
