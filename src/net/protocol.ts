// The network message protocol. Every message is JSON shaped like
// { v: PROTOCOL_VERSION, type: "...", ...payload }.
// Bump PROTOCOL_VERSION whenever a message shape changes incompatibly.

import type { Action, GameState, Side } from "../game/types";

export const PROTOCOL_VERSION = 1;

export type AuthStatus =
  | "ok" // approved; a welcome message follows
  | "pending" // waiting for the host to click Allow
  | "denied"
  | "badPassword"
  | "versionMismatch"
  | "timeout";

/** Messages a client sends to the host. */
export type ClientMessage =
  | { v: number; type: "hello"; name: string; playerId: string; password?: string }
  | { v: number; type: "action"; action: Action }
  | { v: number; type: "chat"; text: string };

/** Messages the host sends to a client. */
export type HostMessage =
  | { v: number; type: "authResult"; status: AuthStatus; message: string }
  | { v: number; type: "welcome"; state: GameState; you: { playerId: string; side: Side | null } }
  | { v: number; type: "stateUpdate"; state: GameState }
  | { v: number; type: "actionRejected"; error: string }
  | { v: number; type: "chat"; from: string; text: string }
  | { v: number; type: "playerLeft"; name: string }
  | { v: number; type: "kicked"; reason: string };

export const MAX_NAME = 24;
export const MAX_CHAT = 300;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isCoord = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100;

/**
 * Host-side shape check for anything a client sends. Returns the typed
 * message, `"badVersion"` if the version is wrong, or null if malformed
 * (the host just ignores those).
 */
export function parseClientMessage(raw: unknown): ClientMessage | "badVersion" | null {
  let m = raw;
  if (typeof m === "string") {
    if (m.length > 10_000) return null;
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!isObj(m)) return null;
  if (m.v !== PROTOCOL_VERSION) return "badVersion";
  const v = PROTOCOL_VERSION;
  switch (m.type) {
    case "hello":
      if (!isStr(m.name, MAX_NAME) || m.name.trim() === "") return null;
      if (!isStr(m.playerId, 64) || !/^[a-f0-9]{16,64}$/.test(m.playerId)) return null;
      if (m.password !== undefined && !isStr(m.password, 200)) return null;
      return { v, type: "hello", name: m.name.trim(), playerId: m.playerId, password: m.password as string | undefined };
    case "chat":
      if (!isStr(m.text, MAX_CHAT) || m.text.trim() === "") return null;
      return { v, type: "chat", text: m.text.trim() };
    case "action": {
      const a = m.action;
      if (!isObj(a)) return null;
      if (a.type === "undo" || a.type === "endTurn") return { v, type: "action", action: { type: a.type } };
      if (a.type === "move" && isStr(a.unitId, 64) && isObj(a.to) && isCoord(a.to.x) && isCoord(a.to.y)) {
        return { v, type: "action", action: { type: "move", unitId: a.unitId, to: { x: a.to.x, y: a.to.y } } };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Client-side check: the host is trusted, so just confirm version and type. */
export function parseHostMessage(raw: unknown): HostMessage | "badVersion" | null {
  if (!isObj(raw) || typeof raw.type !== "string") return null;
  if (raw.v !== PROTOCOL_VERSION) return "badVersion";
  return raw as unknown as HostMessage;
}
