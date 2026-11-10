/**
 * The M1 player shell: library list, <audio> clock, queue (next/prev/shuffle/repeat), seek bar,
 * media keys, drag-drop ingestion. Lyrics rendering lands in M2 — this milestone is playback.
 *
 * Library data comes from `/library.json` (built by `npm run library`); in-memory tracks added
 * via drag-drop are session-only. The two paths share the Song metadata model and the track id
 * fingerprint so identity is stable for both.
 */

import {
  applyFilenameFallback,
  commonToRawTags,
  rawTagsToSongMetadata,
  type SongMetadata,
} from "@modules/library/songMetadata";
import { fetchLibraryIndex, type LibraryTrack } from "@modules/library/libraryIndex";
import { trackIdFor } from "@modules/library/trackId";
import { logCore, warnCore } from "@core/logger";

const VOLUME_STORAGE_KEY = "blyrics:volume";

// -- Formatting -----------------------------------------------------------

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

// -- Player state ----------------------------------------------------------

interface PlayableTrack extends LibraryTrack {
  /** Object URL for drag-dropped local files; library tracks use their web path. */
  objectUrl?: string;
}

interface PlayerElements {
  audio: HTMLAudioElement;
  list: HTMLOListElement;
  filter: HTMLInputElement;
  status: HTMLElement;
  emptyState: HTMLElement;
  art: HTMLImageElement;
  artPlaceholder: HTMLElement;
  artBackdrop: HTMLElement;
  title: HTMLElement;
  artist: HTMLElement;
  albumLine: HTMLElement;
  nowTitle: HTMLElement;
  nowArtist: HTMLElement;
  timeCurrent: HTMLElement;
  timeTotal: HTMLElement;
  seek: HTMLInputElement;
  play: HTMLButtonElement;
  iconPlay: HTMLElement;
  iconPause: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  shuffle: HTMLButtonElement;
  repeat: HTMLButtonElement;
  repeatBadge: HTMLElement;
  mute: HTMLButtonElement;
  iconVolume: HTMLElement;
  iconMuted: HTMLElement;
  volume: HTMLInputElement;
  dropOverlay: HTMLElement;
}

function mustGetElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in index.html`);
  return element as T;
}

function collectElements(): PlayerElements {
  return {
    audio: mustGetElement<HTMLAudioElement>("audio"),
    list: mustGetElement<HTMLOListElement>("track-list"),
    filter: mustGetElement<HTMLInputElement>("filter-input"),
    status: mustGetElement("library-status"),
    emptyState: mustGetElement("empty-state"),
    art: mustGetElement<HTMLImageElement>("art"),
    artPlaceholder: mustGetElement("art-placeholder"),
    artBackdrop: mustGetElement("art-backdrop"),
    title: mustGetElement("title"),
    artist: mustGetElement("artist"),
    albumLine: mustGetElement("album-line"),
    nowTitle: mustGetElement("now-title"),
    nowArtist: mustGetElement("now-artist"),
    timeCurrent: mustGetElement("time-current"),
    timeTotal: mustGetElement("time-total"),
    seek: mustGetElement<HTMLInputElement>("seek"),
    play: mustGetElement<HTMLButtonElement>("btn-play"),
    iconPlay: mustGetElement("icon-play"),
    iconPause: mustGetElement("icon-pause"),
    prev: mustGetElement<HTMLButtonElement>("btn-prev"),
    next: mustGetElement<HTMLButtonElement>("btn-next"),
    shuffle: mustGetElement<HTMLButtonElement>("btn-shuffle"),
    repeat: mustGetElement<HTMLButtonElement>("btn-repeat"),
    repeatBadge: mustGetElement("repeat-one-badge"),
    mute: mustGetElement<HTMLButtonElement>("btn-mute"),
    iconVolume: mustGetElement("icon-volume"),
    iconMuted: mustGetElement("icon-muted"),
    volume: mustGetElement<HTMLInputElement>("volume"),
    dropOverlay: mustGetElement("drop-overlay"),
  };
}

// -- Player -----------------------------------------------------------------

export function mountPlayer(): void {
  const el = collectElements();

  let tracks: PlayableTrack[] = [];
  let currentIndex = -1;
  let current: PlayableTrack | null = null;
  let shuffle = false;
  let repeatMode: "off" | "all" | "one" = "off";
  let seeking = false;
  let lastVolume = 0.9;

  // Restore persisted volume (plain localStorage — intentionally outside the sync storage adapter).
  try {
    const stored = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    const parsed = stored === null ? Number.NaN : Number(stored);
    if (Number.isFinite(parsed)) {
      lastVolume = Math.min(1, Math.max(0, parsed));
      el.volume.value = String(lastVolume);
    }
  } catch {
    /* storage unavailable — defaults apply */
  }
  el.audio.volume = Number(el.volume.value);

  // -- Rendering

  const visibleTracks = (): number[] => {
    const query = el.filter.value.trim().toLowerCase();
    if (!query) return tracks.map((_, index) => index);
    return tracks
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => {
        const { title, artists, album } = track.metadata;
        const haystack = `${title} ${artists.join(" ")} ${album ?? ""} ${track.metadata.displayTitle} ${track.metadata.displayArtist}`.toLowerCase();
        return haystack.includes(query);
      })
      .map(({ index }) => index);
  };

  const renderList = (): void => {
    el.list.replaceChildren();
    for (const index of visibleTracks()) {
      const track = tracks[index];
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "track-row";
      button.dataset.trackId = track.id;
      button.setAttribute("aria-current", String(index === currentIndex));

      const art = document.createElement("span");
      art.className = "track-row__art";
      if (track.art) {
        const img = document.createElement("img");
        img.src = track.art;
        img.alt = "";
        img.loading = "lazy";
        art.appendChild(img);
      } else {
        art.textContent = "♪";
      }

      const meta = document.createElement("span");
      meta.className = "track-row__meta";
      const title = document.createElement("span");
      title.className = "track-row__title";
      title.textContent = track.metadata.displayTitle;
      const artist = document.createElement("span");
      artist.className = "track-row__artist";
      artist.textContent = track.metadata.displayArtist || "Unknown artist";
      meta.append(title, artist);

      const duration = document.createElement("span");
      duration.className = "track-row__duration";
      duration.textContent = formatTime(track.metadata.durationMs / 1000);

      button.append(art, meta, duration);
      button.addEventListener("click", () => playAt(index));
      row.appendChild(button);
      el.list.appendChild(row);
    }
    el.status.textContent = tracks.length === 0 ? "" : `${tracks.length} track${tracks.length === 1 ? "" : "s"}`;
  };

  const setCurrentRow = (): void => {
    for (const button of el.list.querySelectorAll<HTMLButtonElement>(".track-row")) {
      button.setAttribute("aria-current", String(button.dataset.trackId === current?.id));
    }
  };

  const renderNowPlaying = (track: PlayableTrack): void => {
    const { displayTitle, displayArtist, album, albumArtist, year } = track.metadata;
    el.title.textContent = displayTitle;
    el.artist.textContent = displayArtist || "Unknown artist";
    const albumBits = [album, albumArtist, year].filter(value => value !== undefined && value !== "").join(" · ");
    el.albumLine.textContent = albumBits;
    el.nowTitle.textContent = displayTitle;
    el.nowArtist.textContent = displayArtist;
    document.title = `${displayTitle} — ${displayArtist} · Better Lyrics`;

    if (track.art) {
      el.art.src = track.art;
      el.art.hidden = false;
      el.artPlaceholder.hidden = true;
      el.artBackdrop.style.backgroundImage = `url("${track.art}")`;
    } else {
      el.art.hidden = true;
      el.art.removeAttribute("src");
      el.artPlaceholder.hidden = false;
      el.artBackdrop.style.backgroundImage = "";
    }
  };

  // -- Playback

  const audioUrl = (track: PlayableTrack): string => track.objectUrl ?? track.path;

  const playAt = (index: number): void => {
    const track = tracks[index];
    if (!track) return;
    currentIndex = index;
    current = track;

    el.audio.src = audioUrl(track);
    el.audio.currentTime = 0;
    void el.audio.play().catch(error => warnCore("Playback failed:", error));

    renderNowPlaying(track);
    setCurrentRow();
    updateMediaSession(track);
  };

  const playIndex = (index: number): void => playAt(index);

  const nextIndex = (direction: 1 | -1): number => {
    if (tracks.length === 0) return -1;
    if (shuffle && tracks.length > 1) {
      let candidate = currentIndex;
      while (candidate === currentIndex) {
        candidate = Math.floor(Math.random() * tracks.length);
      }
      return candidate;
    }
    const raw = currentIndex + direction;
    if (raw >= tracks.length) return repeatMode === "all" ? 0 : tracks.length - 1;
    if (raw < 0) return repeatMode === "all" ? tracks.length - 1 : 0;
    return raw;
  };

  const playNext = (): void => {
    if (tracks.length === 0) return;
    playIndex(nextIndex(1));
  };

  const playPrevious = (): void => {
    // Restart the track when we're past the opening seconds, like standard players.
    if (el.audio.currentTime > 3) {
      el.audio.currentTime = 0;
      return;
    }
    if (tracks.length === 0) return;
    playIndex(nextIndex(-1));
  };

  const updatePlayButton = (): void => {
    const playing = !el.audio.paused;
    el.iconPlay.hidden = playing;
    el.iconPause.hidden = !playing;
    el.play.setAttribute("aria-label", playing ? "Pause" : "Play");
  };

  const updateMediaSession = (track: PlayableTrack): void => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.metadata.displayTitle,
      artist: track.metadata.displayArtist,
      album: track.metadata.album ?? "",
      artwork: track.art ? [{ src: new URL(track.art, window.location.origin).href }] : [],
    });
  };

  const wireMediaSession = (): void => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    session.setActionHandler("play", () => void el.audio.play());
    session.setActionHandler("pause", () => el.audio.pause());
    session.setActionHandler("previoustrack", playPrevious);
    session.setActionHandler("nexttrack", playNext);
    session.setActionHandler("seekto", details => {
      if (details.seekTime !== undefined && Number.isFinite(el.audio.duration)) {
        el.audio.currentTime = details.seekTime;
      }
    });
    session.setActionHandler("seekbackward", details => {
      el.audio.currentTime = Math.max(0, el.audio.currentTime - (details.seekOffset ?? 10));
    });
    session.setActionHandler("seekforward", details => {
      el.audio.currentTime = Math.min(el.audio.duration || 0, el.audio.currentTime + (details.seekOffset ?? 10));
    });
  };

  // -- Seek + time

  const syncSeekFromAudio = (): void => {
    const duration = el.audio.duration;
    el.timeCurrent.textContent = formatTime(el.audio.currentTime);
    el.timeTotal.textContent = formatTime(Number.isFinite(duration) ? duration : (current?.metadata.durationMs ?? 0) / 1000);
    if (seeking || !Number.isFinite(duration) || duration <= 0) return;
    el.seek.value = String(Math.round((el.audio.currentTime / duration) * 1000));
  };

  // -- Events

  el.play.addEventListener("click", () => {
    if (el.audio.paused) void el.audio.play();
    else el.audio.pause();
  });
  el.prev.addEventListener("click", playPrevious);
  el.next.addEventListener("click", playNext);

  el.shuffle.addEventListener("click", () => {
    shuffle = !shuffle;
    el.shuffle.setAttribute("aria-pressed", String(shuffle));
  });

  el.repeat.addEventListener("click", () => {
    repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
    el.repeat.dataset.mode = repeatMode;
    el.repeat.setAttribute("aria-pressed", String(repeatMode !== "off"));
    el.repeat.title = repeatMode === "off" ? "Repeat: off" : repeatMode === "all" ? "Repeat: all" : "Repeat: one";
    el.repeatBadge.hidden = repeatMode !== "one";
  });

  el.seek.addEventListener("input", () => {
    seeking = true;
    const duration = el.audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      el.timeCurrent.textContent = formatTime((Number(el.seek.value) / 1000) * duration);
    }
  });
  const commitSeek = (): void => {
    const duration = el.audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      el.audio.currentTime = (Number(el.seek.value) / 1000) * duration;
    }
    seeking = false;
  };
  el.seek.addEventListener("change", commitSeek);
  el.seek.addEventListener("pointerup", commitSeek);

  el.audio.addEventListener("timeupdate", syncSeekFromAudio);
  el.audio.addEventListener("durationchange", syncSeekFromAudio);
  el.audio.addEventListener("play", updatePlayButton);
  el.audio.addEventListener("pause", updatePlayButton);
  el.audio.addEventListener("ended", () => {
    if (repeatMode === "one") {
      el.audio.currentTime = 0;
      void el.audio.play();
      return;
    }
    if (tracks.length === 0) return;
    const next = nextIndex(1);
    if (next === currentIndex && repeatMode !== "all" && !shuffle) {
      updatePlayButton(); // reached the end of the queue
      return;
    }
    playIndex(next);
  });

  // -- Volume

  const syncVolumeUI = (): void => {
    const muted = el.audio.muted || el.audio.volume === 0;
    el.iconVolume.hidden = muted;
    el.iconMuted.hidden = !muted;
    el.mute.setAttribute("aria-pressed", String(muted));
  };
  const setVolume = (value: number): void => {
    const clamped = Math.min(1, Math.max(0, value));
    el.audio.volume = clamped;
    el.audio.muted = clamped > 0 ? el.audio.muted : true;
    if (clamped > 0) el.audio.muted = false;
    if (clamped > 0) lastVolume = clamped;
    el.volume.value = String(clamped);
    try {
      window.localStorage.setItem(VOLUME_STORAGE_KEY, String(clamped));
    } catch {
      /* ignore */
    }
    syncVolumeUI();
  };
  el.volume.addEventListener("input", () => setVolume(Number(el.volume.value)));
  el.mute.addEventListener("click", () => {
    if (el.audio.muted || el.audio.volume === 0) {
      el.audio.muted = false;
      setVolume(lastVolume || 0.9);
    } else {
      lastVolume = el.audio.volume;
      el.audio.muted = true;
      syncVolumeUI();
    }
  });

  // -- Filter

  el.filter.addEventListener("input", renderList);

  // -- Keyboard shortcuts (ignored while typing)

  window.addEventListener("keydown", event => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    switch (event.key) {
      case " ":
        event.preventDefault();
        if (el.audio.paused) void el.audio.play();
        else el.audio.pause();
        break;
      case "ArrowRight":
        el.audio.currentTime = Math.min(el.audio.duration || 0, el.audio.currentTime + 5);
        break;
      case "ArrowLeft":
        el.audio.currentTime = Math.max(0, el.audio.currentTime - 5);
        break;
      case "ArrowUp":
        event.preventDefault();
        setVolume(el.audio.volume + 0.05);
        break;
      case "ArrowDown":
        event.preventDefault();
        setVolume(el.audio.volume - 0.05);
        break;
      case "n":
        playNext();
        break;
      case "p":
        playPrevious();
        break;
      case "/":
        event.preventDefault();
        el.filter.focus();
        break;
    }
  });

  // -- Drag & drop ingestion

  let dragDepth = 0;
  const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") ?? false;

  window.addEventListener("dragenter", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    el.dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", event => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.dropOverlay.hidden = true;
  });
  window.addEventListener("drop", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    el.dropOverlay.hidden = true;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) void addDroppedFiles(files);
  });

  const addDroppedFiles = async (files: File[]): Promise<void> => {
    const { parseBuffer } = await import("music-metadata-browser");
    const audioExtensions = /\.(mp3|flac|m4a|mp4|m4b|ogg|opus|wav|aiff?|wma|ape|wv)$/i;
    const audioFiles = files.filter(file => audioExtensions.test(file.name) || file.type.startsWith("audio/"));
    if (audioFiles.length === 0) {
      el.status.textContent = "No audio files in the drop.";
      return;
    }

    el.status.textContent = `Reading ${audioFiles.length} file${audioFiles.length === 1 ? "" : "s"}…`;
    const added: PlayableTrack[] = [];

    for (const file of audioFiles) {
      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let metadata: SongMetadata;
        let art: string | undefined;
        let embeddedLyrics: string | undefined;
        try {
          const parsed = await parseBuffer(bytes, file.type || file.name, { duration: true });
          const durationMs = parsed.format.duration ? Math.round(parsed.format.duration * 1000) : undefined;
          const raw = commonToRawTags(parsed.common as Parameters<typeof commonToRawTags>[0], durationMs);
          metadata = applyFilenameFallback(rawTagsToSongMetadata(raw, { sources: ["file-tags"] }), file.name);

          const pictures = (parsed.common as { picture?: Array<{ data: Uint8Array; format?: string }> }).picture;
          const picture = pictures?.[0];
          if (picture?.data && picture.data.byteLength > 0) {
            art = URL.createObjectURL(new Blob([picture.data.slice().buffer as ArrayBuffer], { type: picture.format ?? "image/jpeg" }));
          }
          const lyricsTags = (parsed.common as { lyrics?: Array<{ text?: string }> }).lyrics;
          const lyricsText = (Array.isArray(lyricsTags) ? lyricsTags : [])
            .map(entry => entry?.text)
            .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
            .join("\n\n")
            .trim();
          if (lyricsText) embeddedLyrics = lyricsText;
        } catch {
          metadata = applyFilenameFallback(rawTagsToSongMetadata({ durationMs: 0 }, { sources: ["file-tags"] }), file.name);
        }

        const id = await trackIdFor(file.name, bytes);
        const objectUrl = URL.createObjectURL(file);
        const track: PlayableTrack = {
          id,
          path: objectUrl,
          objectUrl,
          metadata,
          sizeBytes: file.size,
        };
        if (art) track.art = art;
        if (embeddedLyrics) track.embeddedLyrics = embeddedLyrics;
        added.push(track);
      } catch (error) {
        warnCore("Failed to read dropped file", file.name, error);
      }
    }

    if (added.length > 0) {
      tracks = [...added, ...tracks];
      renderList();
      playAt(0);
      el.status.textContent = `Added ${added.length} track${added.length === 1 ? "" : "s"} from drop.`;
    }
  };

  // -- Boot

  const boot = async (): Promise<void> => {
    wireMediaSession();
    syncVolumeUI();
    renderList();

    try {
      const index = await fetchLibraryIndex();
      if (index) {
        tracks = index.tracks;
        renderList();
        el.emptyState.hidden = tracks.length > 0;
        if (tracks.length > 0) {
          el.status.textContent = `${tracks.length} track${tracks.length === 1 ? "" : "s"} in library`;
        } else {
          el.emptyState.hidden = false;
        }
      } else {
        el.emptyState.hidden = false;
        el.status.textContent = "No library found — drop audio files here or run npm run library";
      }
    } catch (error) {
      el.emptyState.hidden = false;
      el.status.textContent = "Failed to load the library.";
      warnCore("library.json failed to load:", error);
    }
  };

  void boot();
  logCore("Player mounted");
}
