// The joining player. Never changes game state itself: it only sends actions
// to the host and displays whatever state the host sends back.

import Peer, { type DataConnection } from "peerjs";
import type { Action, GameState, Side } from "../game/types";
import type { Identity } from "../storage/identity";
import { Emitter, type NetLogEntry } from "./events";
import { PROTOCOL_VERSION, parseHostMessage, type ClientMessage, type HostMessage } from "./protocol";

const RETRY_MS = 3000;

export type ClientStatus =
  | { kind: "connecting" }
  | { kind: "pending"; message: string }
  | { kind: "inGame" }
  | { kind: "offline"; message: string } // will retry automatically
  | { kind: "failed"; message: string; canRetryWithPassword: boolean }; // stopped for good

export class ClientSession {
  readonly events = new Emitter<{
    change: void;
    log: NetLogEntry;
    chat: { from: string; text: string };
    toast: string;
  }>();
  status: ClientStatus = { kind: "connecting" };
  state: GameState | null = null;
  mySide: Side | null = null;

  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    public readonly roomId: string,
    public readonly me: Identity,
    private password: string,
  ) {}

  start(): void {
    this.stopped = false;
    this.peer = new Peer({ debug: 1 });
    this.peer.on("open", () => this.connect());
    this.peer.on("disconnected", () => {
      if (!this.stopped && this.peer && !this.peer.destroyed) setTimeout(() => this.peer?.reconnect(), 2000);
    });
    this.peer.on("error", (err) => {
      if (this.stopped) return;
      // "peer-unavailable" = the host's tab isn't open (or the link is wrong).
      const message = err.type === "peer-unavailable" ? "Host offline, retrying..." : `Connection problem (${err.type}), retrying...`;
      this.setStatus({ kind: "offline", message });
      this.scheduleRetry();
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.conn?.close();
    this.peer?.destroy();
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.stopped || !this.peer) return;
      if (this.peer.destroyed) return this.start();
      if (this.peer.disconnected) this.peer.reconnect();
      else this.connect();
    }, RETRY_MS);
  }

  private connect(): void {
    if (this.stopped || !this.peer) return;
    this.conn?.close();
    const conn = this.peer.connect(this.roomId, { serialization: "json", reliable: true });
    this.conn = conn;
    // If the WebRTC link never opens (flaky network), give up on it and retry.
    const openTimer = setTimeout(() => {
      if (!conn.open && conn === this.conn && !this.stopped) {
        this.setStatus({ kind: "offline", message: "Host offline, retrying..." });
        this.scheduleRetry();
      }
    }, 15_000);
    conn.on("open", () => {
      clearTimeout(openTimer);
      const hello: ClientMessage = { v: PROTOCOL_VERSION, type: "hello", name: this.me.name, playerId: this.me.playerId };
      if (this.password) hello.password = this.password;
      this.send(hello);
    });
    conn.on("data", (raw) => this.onData(raw));
    conn.on("close", () => {
      if (this.stopped || conn !== this.conn) return;
      this.setStatus({ kind: "offline", message: "Host offline, retrying..." });
      this.scheduleRetry();
    });
  }

  private fail(message: string, canRetryWithPassword = false): void {
    this.stop();
    this.setStatus({ kind: "failed", message, canRetryWithPassword });
  }

  private onData(raw: unknown): void {
    const msg = parseHostMessage(raw);
    this.events.emit("log", { dir: "in", peer: "host", msg: msg ?? raw });
    if (msg === null) return;
    if (msg === "badVersion") return this.fail("Version mismatch with the host. Both players should refresh the page to get the latest version.");
    this.handle(msg);
  }

  private handle(msg: HostMessage): void {
    switch (msg.type) {
      case "authResult":
        if (msg.status === "pending") this.setStatus({ kind: "pending", message: msg.message });
        else if (msg.status === "badPassword") this.fail("Wrong password.", true);
        else if (msg.status !== "ok") this.fail(msg.message);
        break;
      case "welcome":
        this.state = msg.state;
        this.mySide = msg.you.side;
        this.setStatus({ kind: "inGame" });
        break;
      case "stateUpdate":
        this.state = msg.state;
        this.events.emit("change", undefined);
        break;
      case "actionRejected":
        this.events.emit("toast", `Host rejected that: ${msg.error}`);
        break;
      case "chat":
        this.events.emit("chat", { from: msg.from, text: msg.text });
        break;
      case "playerLeft":
        this.events.emit("toast", `${msg.name} left`);
        break;
      case "kicked":
        this.fail(msg.reason);
        break;
    }
  }

  private send(msg: ClientMessage): void {
    if (!this.conn?.open) return this.events.emit("toast", "Not connected to the host right now");
    this.conn.send(msg);
    const logged = msg.type === "hello" && msg.password ? { ...msg, password: "***" } : msg;
    this.events.emit("log", { dir: "out", peer: "host", msg: logged });
  }

  submit(action: Action): void {
    this.send({ v: PROTOCOL_VERSION, type: "action", action });
  }

  sendChat(text: string): void {
    this.send({ v: PROTOCOL_VERSION, type: "chat", text });
  }

  private setStatus(s: ClientStatus): void {
    this.status = s;
    this.events.emit("change", undefined);
  }
}
