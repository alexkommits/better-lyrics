// -- API Response Types --------------------------

export interface Mark {
  type: string;
  label: string;
  icon: string;
  by?: { keyId: string; displayName: string; tier?: string | null };
  at?: number;
}

// -- Submission Types --------------------------

// -- Vote Types --------------------------

// -- Report Types --------------------------

// -- Enums --------------------------

export type UnisonSyncType = "richsync" | "linesync" | "plain";
// -- Feed Filters --------------------------

// -- Request Types --------------------------

export interface UnisonLyricsRequest {
  videoId: string;
  song: string;
  artist: string;
  thumbnailUrl: string;
}

export type UnisonRequestSuccess =
  | { status: "created" | "already_requested"; requestCount: number; demand?: number }
  | { status: "already_available" };

// -- Revision Types --------------------------

export type RevisionStatus = "live" | "past" | "pending" | "superseded" | "rejected" | "withdrawn";
export type PendingReason = "sealed" | "flagged" | "large_text_drift" | "large_timing_drift";

interface LyricRevisionState {
  revNo: number;
  count: number;
  pending: { revNo: number; pendingReason: PendingReason; textDrift: number; timingDrift: number } | null;
  lastRejected: { revNo: number; reviewNote: string | null } | null;
  updatedAt: number;
}

export interface RevisionSummary {
  id: number;
  revNo: number;
  status: RevisionStatus;
  pendingReason: PendingReason | null;
  isAnchor: boolean;
  textDrift: number;
  timingDrift: number;
  revertsRevNo: number | null;
  author: { displayName: string } | null;
  reviewNote: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

export interface FieldCheck {
  field: "lyrics" | "language" | "isrc" | "album";
  status: "ok" | "warn" | "bad";
  message: string;
  line?: number;
}

export interface PreviewResult {
  checks: FieldCheck[];
  drift: {
    text: number;
    timing: number;
    timingOffsetMs: number;
    textLimit: number;
    timingLimit: number;
    anchorRevNo?: number | null;
  };
  outcome: { goesLive: boolean; reason: PendingReason | null };
  noChanges: boolean;
  rateLimit: { lyricRemaining: number; lyricLimit: number; userRemaining: number; userLimit: number };
  diff?: RevisionDiff;
}

export interface DiffHead {
  kind: "translation" | "transliteration" | "credit";
  lang: string | null;
  line: number | null;
}

export interface SyllableChange {
  before: string | null;
  after: string | null;
  moved: number;
}

export type DiffRow =
  | { kind: "same"; lineNo: number; startMs: number | null; text: string; head?: DiffHead }
  | { kind: "add"; lineNo: number; startMs: number | null; text: string; head?: DiffHead }
  | { kind: "del"; lineNo: number; startMs: number | null; text: string; head?: DiffHead }
  | { kind: "word"; lineNo: number; startMs: number | null; parts: Array<["=" | "+" | "-", string]>; head?: DiffHead }
  | {
      kind: "timing";
      lineNo: number;
      startMs: number;
      deltaMs: number;
      text: string;
      syllables?: SyllableChange;
    }
  | ({ kind: "syllable"; lineNo: number; startMs: number | null; text: string } & SyllableChange)
  | { kind: "gap"; count: number; section?: "head" }
  | { kind: "field"; field: "language" | "isrc" | "album"; before: string | null; after: string | null };

export interface RevisionDiff {
  rows: DiffRow[];
  againstRevNo: number | null;
}
