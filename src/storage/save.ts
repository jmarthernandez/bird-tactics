// The host's save file: everything needed to resume a game days later.
// Stored in IndexedDB (automatic), and optionally exported/imported as .json
// or autosaved to a real file on disk (Chromium only).

import { validateConfig } from "../game/config";
import type { GameState } from "../game/types";

export const SCHEMA_VERSION = 1;

export interface ApprovedPlayer {
  playerId: string;
  name: string;
  approvedAt: string; // ISO date
}

export interface SaveData {
  schemaVersion: number;
  savedAt: string;
  /** The host's PeerJS id. Reusing it keeps the invite link working. */
  roomId: string;
  /** Optional join password. Stored only on the host's own computer. */
  password: string;
  approvedPlayers: ApprovedPlayer[];
  /** Board, units, seats (players), whose turn, turn number, full history, config. */
  game: GameState;
}

/**
 * Upgrade older saves to the current schema. Add a step here each time
 * SCHEMA_VERSION goes up, e.g. `if (s.schemaVersion === 1) { ...; s.schemaVersion = 2 }`.
 */
export function migrate(raw: unknown): SaveData {
  if (typeof raw !== "object" || raw === null) throw new Error("Save file is not a JSON object");
  const s = raw as Record<string, unknown>;
  const version = s.schemaVersion;
  if (typeof version !== "number") throw new Error("Save file has no schemaVersion");
  if (version > SCHEMA_VERSION) throw new Error(`Save is from a newer version (schema ${version}) of the game`);
  // (No older schemas exist yet.)

  const save = s as unknown as SaveData;
  if (typeof save.roomId !== "string" || !/^[a-f0-9]{32,}$/.test(save.roomId)) throw new Error("Save has an invalid roomId");
  if (!Array.isArray(save.approvedPlayers)) throw new Error("Save has no approvedPlayers list");
  if (typeof save.game !== "object" || save.game === null) throw new Error("Save has no game");
  const configErrors = validateConfig(save.game.config);
  if (configErrors.length) throw new Error("Save's config is invalid: " + configErrors.join("; "));
  if (!Array.isArray(save.game.units) || !Array.isArray(save.game.history)) throw new Error("Save's game state is incomplete");
  return { ...save, password: typeof save.password === "string" ? save.password : "" };
}

// ---------- IndexedDB (autosave) ----------

const DB_NAME = "birdTactics";
const STORE = "saves";
const SLOT = "current";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveToDb(save: SaveData): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(save, SLOT);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadFromDb(): Promise<SaveData | null> {
  const db = await openDb();
  const raw = await new Promise<unknown>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(SLOT);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return raw ? migrate(raw) : null;
}

export async function clearDb(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(SLOT);
    tx.oncomplete = () => resolve();
  });
  db.close();
}

// ---------- Export / import (.json download & upload) ----------

export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a file picker and resolves with the parsed JSON of the chosen file. */
export function pickJsonFile(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error("No file chosen"));
      try {
        resolve(JSON.parse(await file.text()));
      } catch {
        reject(new Error("That file isn't valid JSON"));
      }
    };
    input.click();
  });
}

// ---------- File System Access API (Chromium only) ----------

// Minimal typings: the API isn't in TypeScript's DOM lib everywhere yet.
interface WritableFile {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
export interface SaveFileHandle {
  name: string;
  createWritable(): Promise<WritableFile>;
}
type SavePicker = (opts: unknown) => Promise<SaveFileHandle>;

export const supportsFileLink = (): boolean => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";

export async function pickSaveFile(): Promise<SaveFileHandle> {
  const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker;
  return picker({
    suggestedName: "bird-tactics-save.json",
    types: [{ description: "Bird Tactics save", accept: { "application/json": [".json"] } }],
  });
}

export async function writeSaveFile(handle: SaveFileHandle, save: SaveData): Promise<void> {
  const w = await handle.createWritable();
  await w.write(JSON.stringify(save, null, 2));
  await w.close();
}
