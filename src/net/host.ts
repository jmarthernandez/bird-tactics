// The host: holds the one true game state, checks every incoming connection
// and action, and broadcasts updates. The host's own clicks go through the
// exact same submit -> applyAction -> broadcast path as remote players.

import Peer, { type DataConnection } from "peerjs";
import { applyAction, createInitialState, sideOf } from "../game/rules";
import type { Action, GameConfig, GameState, Side } from "../game/types";
import type { Identity } from "../storage/identity";
import { saveToDb, writeSaveFile, type SaveData, type SaveFileHandle, SCHEMA_VERSION } from "../storage/save";
import { constantTimeEqual, randomId } from "../util/crypto";
import { Emitter, type NetLogEntry } from "./events";
import { PROTOCOL_VERSION, parseClientMessage, type AuthStatus, type HostMessage } from "./protocol";

/** How long a new connection has to send a valid hello (+ password). */
const AUTH_TIMEOUT_MS = 10_000;
/** How long a correct-password connection may wait for the host to click Allow. */
const APPROVAL_TIMEOUT_MS = 120_000;

interface ConnInfo {
  conn: DataConnection;
  status: "new" | "pending" | "authed";
  playerId?: string;
  name?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface JoinRequest {
  connId: string;
  playerId: string;
  name: string;
}

export function newSave(host: Identity, config: GameConfig): SaveData {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    roomId: randomId(16), // 128 bits: the unguessable part of the invite link
    password: "",
    approvedPlayers: [],
    game: createInitialState(config, { blue: { playerId: host.playerId, name: host.name }, red: null }),
  };
}

/** Hide other players' ids from a client (an id is what gets you back in). */
function redactFor(state: GameState, playerId: string): GameState {
  const seats = { ...state.seats };
  for (const side of ["blue", "red"] as const) {
    const seat = seats[side];
    if (seat && seat.playerId !== playerId) seats[side] = { ...seat, playerId: "" };
  }
  return { ...state, seats };
}

export class HostSession {
  readonly events = new Emitter<{
    change: void;
    log: NetLogEntry;
    chat: { from: string; text: string };
    toast: string;
  }>();
  status = "Starting...";
  online = false;
  fileHandle: SaveFileHandle | null = null;

  private peer: Peer | null = null;
  private conns = new Map<string, ConnInfo>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(public save: SaveData, public readonly me: Identity) {
    // Make sure the host is seated, e.g. after importing a save made in another
    // browser: take the seat that doesn't belong to an approved (remote) player.
    if (!sideOf(save.game, me.playerId)) {
      const isRemote = (side: Side) => save.approvedPlayers.some((p) => p.playerId === save.game.seats[side]?.playerId);
      const side: Side = !isRemote("blue") ? "blue" : !isRemote("red") ? "red" : "blue";
      save.game = { ...save.game, seats: { ...save.game.seats, [side]: { playerId: me.playerId, name: me.name } } };
    }
  }

  get state(): GameState {
    return this.save.game;
  }
  get inviteLink(): string {
    return `${location.origin}${location.pathname}#join=${this.save.roomId}`;
  }
  get joinRequests(): JoinRequest[] {
    return [...this.conns.entries()]
      .filter(([, c]) => c.status === "pending")
      .map(([connId, c]) => ({ connId, playerId: c.playerId!, name: c.name! }));
  }
  /** playerIds of currently connected, approved players. */
  get connectedIds(): Set<string> {
    return new Set([...this.conns.values()].filter((c) => c.status === "authed").map((c) => c.playerId!));
  }

  // ---------- Lifecycle ----------

  start(): void {
    this.stopped = false;
    this.persist();
    this.openPeer();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    for (const c of this.conns.values()) c.conn.close();
    this.conns.clear();
    this.peer?.destroy();
    this.peer = null;
  }

  private openPeer(): void {
    this.peer?.destroy();
    this.online = false;
    this.setStatus("Connecting to signaling server...");
    const peer = new Peer(this.save.roomId, { debug: 1 });
    this.peer = peer;

    peer.on("open", () => {
      this.online = true;
      this.setStatus("Online. Your invite link is live.");
    });
    peer.on("connection", (conn) => this.onConnection(conn));
    peer.on("disconnected", () => {
      // Lost the signaling server (existing games keep working); try to get it back.
      if (this.stopped || peer.destroyed) return;
      this.online = false;
      this.setStatus("Signaling server lost, reconnecting...");
      setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
    });
    peer.on("error", (err) => {
      if (this.stopped) return;
      this.online = false;
      // After a refresh the server can take a few seconds to release our old id.
      const msg = err.type === "unavailable-id" ? "Room id still in use (old tab?), retrying..." : `Network error (${err.type}), retrying...`;
      this.setStatus(msg);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.openPeer(), 4000);
    });
  }

  // ---------- Connections & auth ----------

  private onConnection(conn: DataConnection): void {
    const info: ConnInfo = { conn, status: "new" };
    this.conns.set(conn.connectionId, info);
    // Close anyone who doesn't authenticate quickly.
    info.timer = setTimeout(() => this.reject(info, "timeout", "Took too long to authenticate"), AUTH_TIMEOUT_MS);

    conn.on("data", (raw) => this.onData(info, raw));
    conn.on("close", () => this.onClose(info));
    conn.on("error", () => this.onClose(info));
  }

  private onClose(info: ConnInfo): void {
    if (!this.conns.has(info.conn.connectionId)) return;
    clearTimeout(info.timer);
    this.conns.delete(info.conn.connectionId);
    if (info.status === "authed" && info.name) {
      this.broadcast({ v: PROTOCOL_VERSION, type: "playerLeft", name: info.name });
      this.events.emit("toast", `${info.name} disconnected`);
    }
    this.events.emit("change", undefined);
  }

  private send(info: ConnInfo, msg: HostMessage): void {
    if (!info.conn.open) return;
    info.conn.send(msg);
    this.events.emit("log", { dir: "out", peer: info.name ?? info.conn.peer.slice(0, 6), msg });
  }

  private broadcast(msg: HostMessage | ((c: ConnInfo) => HostMessage)): void {
    for (const c of this.conns.values()) {
      if (c.status === "authed") this.send(c, typeof msg === "function" ? msg(c) : msg);
    }
  }

  /** Tell a connection why it's being refused, then hang up. Never sends game state. */
  private reject(info: ConnInfo, status: AuthStatus, message: string): void {
    clearTimeout(info.timer);
    this.send(info, { v: PROTOCOL_VERSION, type: "authResult", status, message });
    this.conns.delete(info.conn.connectionId);
    setTimeout(() => info.conn.close(), 300); // small delay so the message gets out
    this.events.emit("change", undefined);
  }

  private onData(info: ConnInfo, raw: unknown): void {
    const msg = parseClientMessage(raw);
    // Log it (with any password masked) for the debug panel.
    const logged = msg && msg !== "badVersion" && msg.type === "hello" && msg.password ? { ...msg, password: "***" } : (msg ?? "(malformed, ignored)");
    this.events.emit("log", { dir: "in", peer: info.name ?? info.conn.peer.slice(0, 6), msg: logged });
    if (msg === null) return; // malformed: ignore
    if (msg === "badVersion") {
      return this.reject(info, "versionMismatch", `Version mismatch: host uses protocol v${PROTOCOL_VERSION}. Both players should refresh to get the latest version.`);
    }

    if (info.status === "new") {
      if (msg.type !== "hello") return; // nothing else allowed before hello
      if (this.save.password && !constantTimeEqual(msg.password ?? "", this.save.password)) {
        return this.reject(info, "badPassword", "Wrong password");
      }
      if (msg.playerId === this.me.playerId) {
        return this.reject(info, "denied", "That's the host's own id (did you open the invite in the host's browser?)");
      }
      info.playerId = msg.playerId;
      info.name = msg.name;
      clearTimeout(info.timer);
      if (this.save.approvedPlayers.some((p) => p.playerId === msg.playerId)) {
        this.admit(info);
      } else {
        info.status = "pending";
        info.timer = setTimeout(() => this.reject(info, "timeout", "The host didn't respond"), APPROVAL_TIMEOUT_MS);
        this.send(info, { v: PROTOCOL_VERSION, type: "authResult", status: "pending", message: "Waiting for the host to let you in..." });
        this.events.emit("toast", `${msg.name} wants to join`);
        this.events.emit("change", undefined);
      }
      return;
    }

    if (info.status !== "authed") return; // pending players can't do anything yet
    if (msg.type === "action") {
      const error = this.apply(info.playerId!, msg.action);
      if (error) this.send(info, { v: PROTOCOL_VERSION, type: "actionRejected", error });
    } else if (msg.type === "chat") {
      this.relayChat(info.name!, msg.text);
    }
  }

  /** Let an approved player in: seat them, then (only now) send game state. */
  private admit(info: ConnInfo): void {
    const playerId = info.playerId!;
    const name = info.name!;
    // Only one live connection per player: drop any older one.
    for (const [id, other] of this.conns) {
      if (other !== info && other.playerId === playerId) {
        this.conns.delete(id);
        other.conn.close();
      }
    }
    clearTimeout(info.timer);
    info.status = "authed";

    // Returning players get their old side back; new players take a free seat.
    const g = this.save.game;
    let side: Side | null = sideOf(g, playerId);
    if (!side) side = !g.seats.blue ? "blue" : !g.seats.red ? "red" : null; // null = spectator
    if (side) this.save.game = { ...g, seats: { ...g.seats, [side]: { playerId, name } } };
    const approved = this.save.approvedPlayers.find((p) => p.playerId === playerId);
    if (approved) approved.name = name;

    this.send(info, { v: PROTOCOL_VERSION, type: "authResult", status: "ok", message: "Welcome!" });
    this.send(info, { v: PROTOCOL_VERSION, type: "welcome", state: redactFor(this.save.game, playerId), you: { playerId, side } });
    this.broadcastState();
    this.events.emit("toast", `${name} joined${side ? ` as ${side}` : " as a spectator"}`);
    this.persist();
  }

  approve(connId: string): void {
    const info = this.conns.get(connId);
    if (!info || info.status !== "pending") return;
    this.save.approvedPlayers.push({ playerId: info.playerId!, name: info.name!, approvedAt: new Date().toISOString() });
    this.admit(info);
  }

  deny(connId: string): void {
    const info = this.conns.get(connId);
    if (info?.status === "pending") this.reject(info, "denied", "The host declined your request");
  }

  /** Disconnect a player and revoke their approval (they'd need approving again). */
  kick(playerId: string): void {
    for (const info of [...this.conns.values()]) {
      if (info.playerId === playerId) {
        this.send(info, { v: PROTOCOL_VERSION, type: "kicked", reason: "The host removed you from the game" });
        this.conns.delete(info.conn.connectionId);
        setTimeout(() => info.conn.close(), 300);
      }
    }
    this.save.approvedPlayers = this.save.approvedPlayers.filter((p) => p.playerId !== playerId);
    this.persist();
    this.events.emit("change", undefined);
  }

  /** New room id = new invite link. Everyone connected is dropped; the old link stops working. */
  regenerateLink(): void {
    this.save.roomId = randomId(16);
    for (const c of this.conns.values()) c.conn.close();
    this.conns.clear();
    this.persist();
    this.openPeer();
  }

  setPassword(pw: string): void {
    this.save.password = pw;
    this.persist();
    this.events.emit("change", undefined);
  }

  // ---------- Game ----------

  /** The host's own actions. Same validation as everyone else's. */
  submit(action: Action): void {
    const error = this.apply(this.me.playerId, action);
    if (error) this.events.emit("toast", error);
  }

  /** Returns an error message, or null on success. */
  private apply(playerId: string, action: Action): string | null {
    const result = applyAction(this.save.game, playerId, action);
    if (!result.ok) return result.error;
    this.save.game = result.state;
    this.broadcastState();
    this.persist();
    return null;
  }

  private broadcastState(): void {
    this.broadcast((c) => ({ v: PROTOCOL_VERSION, type: "stateUpdate", state: redactFor(this.save.game, c.playerId!) }));
    this.events.emit("change", undefined);
  }

  /** Replace the game (new game, loaded config, imported save) and push it to everyone. */
  replaceGame(game: GameState): void {
    this.save.game = game;
    this.broadcastState();
    this.persist();
  }

  sendChat(text: string): void {
    this.relayChat(this.me.name, text);
  }

  private relayChat(from: string, text: string): void {
    this.broadcast({ v: PROTOCOL_VERSION, type: "chat", from, text });
    this.events.emit("chat", { from, text });
  }

  // ---------- Saving ----------

  /** Autosave: IndexedDB always, plus the linked file on disk if there is one. */
  persist(): void {
    this.save.savedAt = new Date().toISOString();
    const snapshot = structuredClone(this.save);
    saveToDb(snapshot).catch((e: unknown) => this.events.emit("toast", `Autosave failed: ${String(e)}`));
    if (this.fileHandle) {
      writeSaveFile(this.fileHandle, snapshot).catch((e: unknown) => {
        this.fileHandle = null;
        this.events.emit("toast", `Couldn't write save file (unlinked): ${String(e)}`);
        this.events.emit("change", undefined);
      });
    }
  }

  private setStatus(s: string): void {
    this.status = s;
    this.events.emit("change", undefined);
  }
}
