// The in-game screen: board, turn indicator, buttons, bird info, chat,
// move log, and the debug network log. Works the same for host and client;
// it only talks to a GameSession (submit actions, read state).

import { canMoveUnit, getBirdType, getValidMoves, movesThisTurn, samePos, sideOf } from "../game/rules";
import type { Action, GameState, HistoryEntry, Pos } from "../game/types";
import type { Emitter, NetLogEntry } from "../net/events";
import { MAX_CHAT } from "../net/protocol";
import { BoardView, tileName } from "./board";
import { h, setChildren, SIDE_LABEL, toast } from "./dom";

/** What the game screen needs from either a HostSession or a ClientSession. */
export interface GameSession {
  readonly state: GameState | null;
  readonly me: { playerId: string; name: string };
  readonly events: Emitter<{ change: void; log: NetLogEntry; chat: { from: string; text: string }; toast: string }>;
  submit(action: Action): void;
  sendChat(text: string): void;
}

export class GameScreen {
  readonly el: HTMLElement;
  private board: BoardView;
  private selectedId: string | null = null;

  private banner = h("div", { class: "banner hidden" });
  private turnBox = h("div", { class: "turn" });
  private seatsBox = h("div", { class: "seats" });
  private undoBtn = h("button", { onclick: () => this.session.submit({ type: "undo" }) }, "Undo");
  private endBtn = h("button", { class: "primary", onclick: () => this.endTurn() }, "End Turn");
  private infoBox = h("div", { class: "info" });
  private logBox = h("ol", { class: "movelog" });
  private chatBox = h("div", { class: "chatlog" });
  private chatInput = h("input", { type: "text", maxLength: MAX_CHAT, placeholder: "Say something..." });
  private debugBox = h("pre", { class: "debuglog" });
  private debugLines: string[] = [];

  constructor(private session: GameSession, extraPanel?: HTMLElement) {
    this.board = new BoardView((p) => this.onTileClick(p));
    const chatForm = h(
      "form",
      {
        class: "chatform",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const text = this.chatInput.value.trim();
          if (text) session.sendChat(text);
          this.chatInput.value = "";
        },
      },
      this.chatInput,
      h("button", { type: "submit" }, "Send"),
    );

    this.el = h(
      "div",
      { class: "game" },
      this.banner,
      h("div", { class: "boardwrap" }, this.board.canvas),
      h(
        "aside",
        { class: "side" },
        this.turnBox,
        this.seatsBox,
        h("div", { class: "buttons" }, this.undoBtn, this.endBtn),
        h("section", {}, h("h3", {}, "Selected bird"), this.infoBox),
        h("section", {}, h("h3", {}, "Chat"), this.chatBox, chatForm),
        h("section", {}, h("h3", {}, "Move log"), this.logBox),
        extraPanel,
        h("details", { class: "debug" }, h("summary", {}, "Debug: network messages"), this.debugBox),
      ),
    );

    session.events.on("change", () => this.render());
    session.events.on("chat", ({ from, text }) => this.addChat(from, text));
    session.events.on("toast", (t) => toast(t));
    session.events.on("log", (e) => this.addDebug(e));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.select(null);
    });
  }

  /** Show/hide the "Host offline, retrying..." strip. */
  setBanner(text: string | null): void {
    this.banner.textContent = text ?? "";
    this.banner.classList.toggle("hidden", !text);
  }

  private get mySide() {
    return this.session.state ? sideOf(this.session.state, this.session.me.playerId) : null;
  }

  private endTurn(): void {
    const s = this.session.state;
    if (!s) return;
    const unmoved = s.units.filter((u) => u.side === s.activeSide && canMoveUnit(s, u)).length;
    if (s.config.turnMode === "allUnits" && unmoved > 0 && !confirm(`${unmoved} bird(s) haven't moved yet. End turn anyway?`)) return;
    this.selectedId = null;
    this.session.submit({ type: "endTurn" });
  }

  private select(id: string | null): void {
    this.selectedId = id;
    this.render();
  }

  private onTileClick(p: Pos | null): void {
    const s = this.session.state;
    if (!s || !p) return this.select(null);
    const selected = s.units.find((u) => u.id === this.selectedId);
    // Clicking a highlighted tile with your movable bird selected = move there.
    if (selected && this.isActionable(s, selected.id) && BoardView.contains(getValidMoves(s, selected.id), p)) {
      this.selectedId = null;
      this.session.submit({ type: "move", unitId: selected.id, to: p });
      return;
    }
    // Clicking any bird selects it (yours to move, or anyone's to inspect).
    const clicked = s.units.find((u) => samePos(u.pos, p));
    this.select(clicked && clicked.id !== this.selectedId ? clicked.id : null);
  }

  /** Can *I* move this bird right now? */
  private isActionable(s: GameState, unitId: string): boolean {
    const u = s.units.find((x) => x.id === unitId);
    return !!u && this.mySide === s.activeSide && u.side === this.mySide && canMoveUnit(s, u);
  }

  render(): void {
    const s = this.session.state;
    if (!s) return;
    const mySide = this.mySide;
    const myTurn = mySide === s.activeSide;
    if (this.selectedId && !s.units.some((u) => u.id === this.selectedId)) this.selectedId = null;

    const active = this.selectedId ? this.isActionable(s, this.selectedId) : false;
    const moves = this.selectedId ? getValidMoves(s, this.selectedId) : [];
    this.board.draw(s, { selectedId: this.selectedId, moves, movesActive: active, flip: mySide === "red" });

    // Turn indicator.
    const seat = s.seats[s.activeSide];
    this.turnBox.className = `turn ${s.activeSide}`;
    setChildren(
      this.turnBox,
      h("div", { class: "turnnum" }, `Turn ${s.turnNumber}`),
      h("div", { class: "whose" }, myTurn ? "Your turn" : `${seat?.name ?? SIDE_LABEL[s.activeSide]}'s turn`),
      h("div", { class: "mode" }, s.config.turnMode === "allUnits" ? "Move each bird once, then End Turn" : "Move one bird, then End Turn"),
    );
    setChildren(
      this.seatsBox,
      ...(["blue", "red"] as const).map((side) =>
        h("div", { class: `seat ${side}` }, h("span", { class: "dot" }), `${SIDE_LABEL[side]}: ${s.seats[side]?.name ?? "(empty seat)"}${mySide === side ? " (you)" : ""}`),
      ),
      mySide ? null : h("div", { class: "muted" }, "You're spectating."),
    );
    this.undoBtn.disabled = !myTurn || movesThisTurn(s).length === 0;
    this.endBtn.disabled = !myTurn;

    // Selected bird panel.
    const unit = s.units.find((u) => u.id === this.selectedId);
    const type = unit && getBirdType(s.config, unit.typeId);
    if (unit && type) {
      setChildren(
        this.infoBox,
        h("div", { class: `birdname ${unit.side}` }, `${type.icon} ${type.name}`, h("span", { class: "muted" }, ` · ${SIDE_LABEL[unit.side]} · ${tileName(s, unit.pos)}`)),
        h("p", {}, type.description),
        h("p", { class: "muted" }, unit.hasMoved ? "Already moved this turn." : active ? "Click a highlighted tile to move." : `${moves.length} possible move(s).`),
        h("p", { class: "muted small" }, `Health ${type.stats.health} · Attack ${type.stats.attack} (combat not implemented yet)`),
      );
    } else {
      setChildren(this.infoBox, h("p", { class: "muted" }, myTurn ? "Click one of your birds." : "Click any bird to see how it moves."));
    }

    // Move log, newest first.
    setChildren(this.logBox, ...[...s.history].reverse().slice(0, 100).map((e) => h("li", { class: e.side }, describe(s, e))));
  }

  private addChat(from: string, text: string): void {
    this.chatBox.append(h("div", {}, h("b", {}, `${from}: `), text));
    this.chatBox.scrollTop = this.chatBox.scrollHeight;
  }

  private addDebug(e: NetLogEntry): void {
    const time = new Date().toLocaleTimeString();
    let body = JSON.stringify(e.msg);
    if (body && body.length > 400) body = body.slice(0, 400) + "…";
    this.debugLines.unshift(`${time} ${e.dir === "in" ? "⬇ from" : "⬆ to"} ${e.peer}: ${body}`);
    this.debugLines.length = Math.min(this.debugLines.length, 200);
    this.debugBox.textContent = this.debugLines.join("\n");
  }
}

function describe(s: GameState, e: HistoryEntry): string {
  if (e.kind === "endTurn") return `Turn ${e.turn}: ${SIDE_LABEL[e.side]} ended turn`;
  const unit = s.units.find((u) => u.id === e.unitId);
  const name = (unit && getBirdType(s.config, unit.typeId)?.name) ?? "Bird";
  return `Turn ${e.turn}: ${SIDE_LABEL[e.side]} ${name} ${tileName(s, e.from)} → ${tileName(s, e.to)}`;
}
