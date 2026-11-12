// What every browser (host or client) remembers about itself, in localStorage.
// Only the player's own id and name — never game state.

import { randomId } from "../util/crypto";

const KEY = "birdTactics.identity";

export interface Identity {
  playerId: string;
  name: string;
}

export function loadIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Identity>;
      if (typeof v.playerId === "string" && /^[a-f0-9]{32}$/.test(v.playerId)) {
        return { playerId: v.playerId, name: typeof v.name === "string" ? v.name : "" };
      }
    }
  } catch {
    // Storage blocked or corrupted: fall through and make a new identity.
  }
  const fresh = { playerId: randomId(16), name: "" };
  saveIdentity(fresh);
  return fresh;
}

export function saveIdentity(id: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    // Ignore: private mode etc. The player just gets a new id next visit.
  }
}
