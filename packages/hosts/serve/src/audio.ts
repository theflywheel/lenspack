import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeWhole } from "./settings";

// Kept recordings of spoken questions, for checking speech to text against what people really say. Off by default:
// with speech.keepAudio false nothing is written and a clip lives only as long as its transcription takes. On, each
// clip a transcription answered is saved as uploaded, under audio/<yyyy-mm>/<transcriptId>.<ext> in the state
// directory, and listed in audio/index.jsonl with its user. Old clips go after audioRetentionDays, and the oldest
// first when the folder is over maxStoredMb. Only an admin route plays one, and every play is audited. A consent
// notice, when set, must be acknowledged by each user before the mic records while audio is kept.

export type AudioSettings = {
  keepAudio: boolean;
  audioRetentionDays: number;
  maxStoredMb: number;
  /** Shown once to each user before their first recording while audio is kept; null: none. */
  consentNotice: string | null;
};

export type StoredAudio = { id: string; user: string; at: string; file: string; bytes: number; format: string };

/** A clip's format as its file extension, from the format name the speech provider is sent. */
const EXT: Record<string, string> = { webm: "webm", ogg: "ogg", wav: "wav", mp3: "mp3", m4a: "m4a", aac: "aac", flac: "flac" };
export const AUDIO_TYPES: Record<string, string> = { webm: "audio/webm", ogg: "audio/ogg", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac" };
const ID = /^[\w-]{1,64}$/;

export type AudioLink = { stored: true; bytes: number; format: string };

/**
 * Where kept recordings live, and who acknowledged the consent notice. A folder in the state directory today
 * (fileAudioStore); object storage and a table could serve several copies of Lenspack through the same methods.
 */
export interface AudioStore {
  settings: () => AudioSettings;
  /** Deletes clips older than the retention, then the oldest while over the size cap. Returns how many went. */
  sweep(): Promise<number>;
  /** The notice this user must acknowledge before recording (audio is kept, a notice is set, they have not acknowledged it); else null. */
  consentNeeded(user: string): Promise<string | null>;
  /** Records that the user acknowledged the notice in force now; a changed notice is asked again. */
  acknowledge(user: string): Promise<void>;
  /** Saves one clip when audio is kept: what the transcript record links to, or null when nothing was written. */
  keep(id: string, user: string, audio: Uint8Array, format: string): Promise<AudioLink | null>;
  read(id: string): Promise<(StoredAudio & { type: string; data: Uint8Array }) | null>;
  list(): Promise<StoredAudio[]>;
  delete(id: string): Promise<number>;
  deleteUser(user: string): Promise<number>;
  deleteAll(): Promise<number>;
  stats(): Promise<{ files: number; bytes: number; oldest: string | null }>;
  /** Writes an export (a benchmark manifest) beside the clips, and says where. */
  saveExport(name: string, text: string): Promise<string>;
}

export function fileAudioStore(o: { dir: string; settings: () => AudioSettings; now?: () => Date }): AudioStore {
  const now = o.now ?? (() => new Date());
  const root = join(o.dir, "audio");
  const indexFile = join(root, "index.jsonl");
  const consentFile = join(root, "consent.json");
  const read = (): StoredAudio[] =>
    existsSync(indexFile)
      ? readFileSync(indexFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l) as StoredAudio];
            } catch {
              return [];
            }
          })
      : [];
  let index = read();
  const save = () => {
    mkdirSync(root, { recursive: true });
    writeWhole(indexFile, index.map((e) => JSON.stringify(e)).join("\n") + (index.length ? "\n" : ""));
  };
  const remove = (gone: StoredAudio[]) => {
    if (!gone.length) return 0;
    for (const e of gone) rmSync(join(root, e.file), { force: true });
    const ids = new Set(gone.map((e) => e.id));
    index = index.filter((e) => !ids.has(e.id));
    save();
    // Month folders left empty go too.
    for (const m of existsSync(root) ? readdirSync(root) : []) {
      const p = join(root, m);
      if (/^\d{4}-\d{2}$/.test(m) && statSync(p).isDirectory() && readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
    }
    return gone.length;
  };
  const noticeHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  const consents = (): Record<string, { at: string; notice: string }> => {
    try {
      return existsSync(consentFile) ? (JSON.parse(readFileSync(consentFile, "utf8")) as Record<string, { at: string; notice: string }>) : {};
    } catch {
      return {};
    }
  };

  /** Deletes clips older than the retention, then the oldest while the folder is over its cap. Returns how many went. */
  function sweep(): number {
    const s = o.settings();
    const cutoff = new Date(now().getTime() - s.audioRetentionDays * 86_400_000).toISOString();
    const old = index.filter((e) => e.at < cutoff);
    let gone = remove(old);
    const cap = s.maxStoredMb * 1024 * 1024;
    let total = index.reduce((t, e) => t + e.bytes, 0);
    const over: StoredAudio[] = [];
    for (const e of [...index].sort((a, b) => a.at.localeCompare(b.at))) {
      if (total <= cap) break;
      over.push(e);
      total -= e.bytes;
    }
    gone += remove(over);
    return gone;
  }

  return {
    settings: o.settings,
    sweep: async () => sweep(),
    async consentNeeded(user) {
      const s = o.settings();
      if (!s.keepAudio || !s.consentNotice) return null;
      return consents()[user]?.notice === noticeHash(s.consentNotice) ? null : s.consentNotice;
    },
    async acknowledge(user) {
      const s = o.settings();
      if (!s.consentNotice) return;
      mkdirSync(root, { recursive: true });
      writeWhole(consentFile, JSON.stringify({ ...consents(), [user]: { at: now().toISOString(), notice: noticeHash(s.consentNotice) } }, null, 2));
    },
    async keep(id, user, audio, format) {
      if (!o.settings().keepAudio || !ID.test(id) || !EXT[format]) return null;
      const at = now();
      const month = at.toISOString().slice(0, 7);
      const file = `${month}/${id}.${EXT[format]}`;
      mkdirSync(join(root, month), { recursive: true });
      writeFileSync(join(root, file), audio, { mode: 0o600 });
      index.push({ id, user, at: at.toISOString(), file, bytes: audio.byteLength, format });
      save();
      sweep();
      return index.some((e) => e.id === id) ? { stored: true, bytes: audio.byteLength, format } : null;
    },
    async read(id) {
      const e = index.find((x) => x.id === id);
      return e && existsSync(join(root, e.file)) ? { ...e, type: AUDIO_TYPES[e.format] ?? "application/octet-stream", data: readFileSync(join(root, e.file)) } : null;
    },
    list: async () => [...index],
    delete: async (id) => remove(index.filter((e) => e.id === id)),
    deleteUser: async (user) => remove(index.filter((e) => e.user === user)),
    deleteAll: async () => remove([...index]),
    stats: async () => ({ files: index.length, bytes: index.reduce((t, e) => t + e.bytes, 0), oldest: index.reduce<string | null>((m, e) => (m === null || e.at < m ? e.at : m), null) }),
    async saveExport(name, text) {
      mkdirSync(root, { recursive: true });
      const file = join(root, name);
      writeWhole(file, text);
      return file;
    },
  };
}

/** One line of the speech benchmark's manifest (evals/speech/data/manifest.jsonl), plus why a line is set aside. */
export type ManifestLine = { id: string; set: string; lang: string | null; speaker: string; audio: string; ref: string | null; seconds: number | null; refSource: "accepted" | "edited" | "none"; flag?: string };

/**
 * The kept clips as a benchmark manifest. The reference is what the user sent: the transcript itself when they
 * sent it unchanged, their corrected question when they edited it. An edit that changed most of the words (more
 * than 40%, or the length by half) may be a new question rather than a correction, so it is flagged, as are
 * clips never sent and clips whose texts are not kept.
 */
export function audioManifest(
  clips: StoredAudio[],
  lookup: (id: string) => { transcript: string | null; sent: string | null; lang: string | null; seconds: number | null; edits: number | null; several?: boolean } | null,
  speakerOf: (user: string) => string,
): { lines: ManifestLine[]; flagged: ManifestLine[] } {
  const lines: ManifestLine[] = [];
  const flagged: ManifestLine[] = [];
  for (const c of clips) {
    const t = lookup(c.id);
    const base = { id: `field/${c.id}`, set: `field-${t?.lang ?? "und"}`, lang: t?.lang ?? null, speaker: speakerOf(c.user), audio: c.file, seconds: t?.seconds ?? null };
    if (!t || t.transcript === null) {
      flagged.push({ ...base, ref: null, refSource: "none", flag: "no-text" });
      continue;
    }
    if (t.sent === null) {
      flagged.push({ ...base, ref: null, refSource: "none", flag: "not-sent" });
      continue;
    }
    // One question spoken in several clips: which words came from which clip is not known.
    if (t.several) {
      flagged.push({ ...base, ref: t.sent, refSource: "edited", flag: "several-clips" });
      continue;
    }
    if (!t.edits) {
      lines.push({ ...base, ref: t.sent, refSource: "accepted" });
      continue;
    }
    const a = t.transcript.split(/\s+/).filter(Boolean).length;
    const b = t.sent.split(/\s+/).filter(Boolean).length;
    const unclear = t.edits / Math.max(a, b, 1) > 0.4 || Math.abs(a - b) > Math.max(a, b) / 2;
    (unclear ? flagged : lines).push({ ...base, ref: t.sent, refSource: "edited", ...(unclear ? { flag: "edited-unclear" } : {}) });
  }
  return { lines, flagged };
}
