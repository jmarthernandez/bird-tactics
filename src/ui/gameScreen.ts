// The in-game screen: board, turn indicator, buttons, bird card, chat,
// battle log, and the debug network log. Works the same for host and client:
// it only reads state and submits actions through a GameSession.

import {
  canActUnit,
  canMoveUnit,
  canUndo,
  getAttackTargets,
  getBirdType,
  getForageOption,
  getValidMoves,
  previewAttack,
  samePos,
  sideOf,
} from "../game/rules";
import type { Action, GameEvent, GameState, HistoryEntry, Pos, Unit } from "../game/types";
import type { Emitter, NetLogEntry } from "../net/events";
import { MAX_CHAT } from "../net/protocol";
import { BoardView, TEAM_COLORS } from "./board";
import { h, setChildren, SIDE_LABEL, toast } from "./dom";
import { isMuted, setMuted, sfx } from "./sfx";
import { sprite } from "./sprites";

/** What the game screen needs from either a HostSession or a ClientSession. */
export interface GameSession {
  readonly state: GameState | null;
  readonly me: { playerId: string; name: string };
  readonly events: Emitter<{ change: void; log: NetLogEntry; chat: { from: string; text: string }; toast: string }>;
  submit(action: Action): void;
  sendChat(text: string): void;
}

type Mode = "move" | "attack";

export class GameScreen {
  readonly el: HTMLElement;
  private board: BoardView;
  private selectedId: string | null = null;
  private mode: Mode = "move";
  private hover: Pos | null = null;
  private overlayPending = false;

  private banner = h("div", { class: "banner hidden" });
  private turnBox = h("div", { class: "turn" });
  private seatsBox = h("div", { class: "seats" });
  private undoBtn = h("button", { onclick: () => this.session.submit({ type: "undo" }), title: "Take back your last move (attacks and snacks are final)" }, "↶ Undo move");
  private endBtn = h("button", { class: "primary", onclick: () => this.endTurn() }, "End Turn");
  private infoBox = h("div", { class: "info" });
  private hoverLine = h("div", { class: "hoverline" }, " ");
  private overlay = h("div", { class: "overlay hidden" });
  private logBox = h("ol", { class: "movelog" });
  private chatBox = h("div", { class: "chatlog" });
  private chatInput = h("input", { type: "text", maxLength: MAX_CHAT, placeholder: "Say something..." });
  private debugBox = h("pre", { class: "debuglog" });
  private debugLines: string[] = [];

  constructor(
    private session: GameSession,
    extraPanel?: HTMLElement,
    /** Host only: start a new game with the same players. */
    private onRematch?: () => void,
  ) {
    this.board = new BoardView(
      (p) => this.onTileClick(p),
      (p) => {
        this.hover = p;
        this.render();
      },
      () => this.mySide,
    );
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
    const muteBtn = h("button", { class: "small", onclick: () => (setMuted(!isMuted()), (muteBtn.textContent = isMuted() ? "🔇 Sound off" : "🔊 Sound on")) }, isMuted() ? "🔇 Sound off" : "🔊 Sound on");

    this.el = h(
      "div",
      { class: "game" },
      this.banner,
      h(
        "div",
        { class: "boardcol" },
        h("div", { class: "boardwrap" }, this.board.canvas, this.overlay),
        this.hoverLine,
        h("div", { class: "help muted small" }, "Click a bird → click a blue tile to fly → click a red tile to attack. ", h("b", {}, "A"), " attack · ", h("b", {}, "F"), " forage · ", h("b", {}, "Esc"), " cancel · ", muteBtn),
      ),
      h(
        "aside",
        { class: "side" },
        this.turnBox,
        this.seatsBox,
        h("div", { class: "buttons" }, this.undoBtn, this.endBtn),
        h("section", { class: "card-bird" }, this.infoBox),
        h("section", {}, h("h3", {}, "Battle log"), this.logBox),
        h("section", {}, h("h3", {}, "Chat"), this.chatBox, chatForm),
        extraPanel,
        h("details", { class: "debug" }, h("summary", {}, "Debug: network messages"), this.debugBox),
      ),
    );

    session.events.on("change", () => this.render());
    session.events.on("chat", ({ from, text }) => this.addChat(from, text));
    session.events.on("toast", (t) => toast(t));
    session.events.on("log", (e) => this.addDebug(e));
    document.addEventListener("keydown", (e) => {
      if (!this.el.isConnected || e.target instanceof HTMLInputElement) return;
      if (e.key === "Escape") this.select(null);
      if (e.key === "a" || e.key === "A") this.toggleAttack();
      if (e.key === "f" || e.key === "F") this.forage();
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
  private get selected(): Unit | undefined {
    return this.session.state?.units.find((u) => u.id === this.selectedId);
  }
  private isMine(u: Unit | undefined): u is Unit {
    return !!u && u.side === this.mySide && this.mySide === this.session.state?.activeSide;
  }

  private endTurn(): void {
    const s = this.session.state;
    if (!s) return;
    const idle = s.units.filter((u) => u.side === s.activeSide && canActUnit(s, u)).length;
    if (s.config.turnMode === "allUnits" && idle > 0 && !confirm(`${idle} bird(s) haven't acted yet. End turn anyway?`)) return;
    this.select(null);
    this.session.submit({ type: "endTurn" });
  }

  private select(id: string | null): void {
    if (id && id !== this.selectedId) sfx.select();
    this.selectedId = id;
    const u = this.selected;
    const s = this.session.state;
    // A bird that already moved goes straight to aiming its attack.
    this.mode = s && this.isMine(u) && !canMoveUnit(s, u) && canActUnit(s, u) ? "attack" : "move";
    this.render();
  }

  private toggleAttack(): void {
    const s = this.session.state;
    const u = this.selected;
    if (!s || !this.isMine(u) || !canActUnit(s, u)) return;
    this.mode = this.mode === "attack" ? "move" : "attack";
    if (this.mode === "attack" && getAttackTargets(s, u.id).length === 0) toast("No targets in range from here");
    this.render();
  }

  private forage(): void {
    const s = this.session.state;
    const u = this.selected;
    if (!s || !this.isMine(u) || !canActUnit(s, u)) return;
    if (!getForageOption(s, u)) return void toast("Nothing to eat here. Stand on a worm patch, or next to ripe berries when hurt.");
    this.session.submit({ type: "forage", unitId: u.id });
  }

  private onTileClick(p: Pos | null): void {
    const s = this.session.state;
    if (!s || !p) return this.select(null);
    const u = this.selected;
    if (this.isMine(u)) {
      if (this.mode === "attack" && canActUnit(s, u) && getAttackTargets(s, u.id).some((t) => samePos(t, p))) {
        this.session.submit({ type: "attack", unitId: u.id, target: p });
        this.mode = "move";
        return;
      }
      if (this.mode === "move" && canMoveUnit(s, u) && getValidMoves(s, u.id).some((t) => samePos(t, p))) {
        this.session.submit({ type: "move", unitId: u.id, to: p });
        this.mode = "attack"; // after flying, aim the attack next
        return;
      }
    }
    const clicked = s.units.find((x) => samePos(x.pos, p));
    this.select(clicked && clicked.id !== this.selectedId ? clicked.id : null);
  }

  render(): void {
    const s = this.session.state;
    if (!s) return;
    const mySide = this.mySide;
    const myTurn = mySide === s.activeSide && !s.winner;
    if (this.selectedId && !s.units.some((u) => u.id === this.selectedId)) this.selectedId = null;
    const u = this.selected;
    const mine = this.isMine(u);

    // What to highlight on the board.
    let moves: Pos[] = [];
    let targets: Pos[] = [];
    let preview: GameEvent[] | null = null;
    if (u) {
      if (mine && this.mode === "attack" && canActUnit(s, u)) {
        targets = getAttackTargets(s, u.id);
        if (this.hover && targets.some((t) => samePos(t, this.hover!))) preview = previewAttack(s, u.id, this.hover);
      } else if (!mine || canMoveUnit(s, u)) {
        moves = getValidMoves(s, u.id);
      }
    }
    this.board.update(s, { selectedId: this.selectedId, moves, targets, active: mine, flip: mySide === "red", preview });

    // Hover info line under the board.
    const hu = this.hover && s.units.find((x) => samePos(x.pos, this.hover!));
    const ht = hu ? getBirdType(s.config, hu.typeId) : undefined;
    this.hoverLine.textContent = this.hover
      ? hu && ht
        ? `${hu.nickname} the ${ht.name} (${SIDE_LABEL[hu.side]}) · ${hu.hp}/${hu.maxHp} HP${hu.fed ? " · full of worms (+1 dmg)" : ""}`
        : this.board.describeTile(this.hover)
      : " ";

    // Turn indicator.
    const seat = s.seats[s.activeSide];
    this.turnBox.className = `turn ${s.activeSide}`;
    setChildren(
      this.turnBox,
      h("div", { class: "turnnum" }, `Turn ${s.turnNumber}`),
      h("div", { class: "whose" }, s.winner ? "Game over" : myTurn ? "Your turn" : `${seat?.name ?? SIDE_LABEL[s.activeSide]}'s turn`),
      h("div", { class: "mode" }, s.config.turnMode === "allUnits" ? "Each bird: fly, then attack or forage" : "One bird per turn: fly, then attack or forage"),
    );
    setChildren(
      this.seatsBox,
      ...(["blue", "red"] as const).map((side) => {
        const alive = s.units.filter((x) => x.side === side);
        return h(
          "div",
          { class: `seat ${side}` },
          h("span", { class: "dot" }),
          `${SIDE_LABEL[side]}: ${s.seats[side]?.name ?? "(empty seat)"}${mySide === side ? " (you)" : ""}`,
          h("span", { class: "muted small" }, ` · ${alive.length} bird${alive.length === 1 ? "" : "s"} left`),
        );
      }),
      mySide ? null : h("div", { class: "muted" }, "You're spectating."),
    );
    this.undoBtn.disabled = !myTurn || !canUndo(s);
    this.endBtn.disabled = !myTurn;

    this.renderBirdCard(s, u, mine);
    this.renderOverlay(s);

    // Battle log, newest first.
    setChildren(this.logBox, ...[...s.history].reverse().slice(0, 120).map((e) => h("li", { class: `${e.side} ${e.kind}` }, describe(s, e))));
  }

  private renderBirdCard(s: GameState, u: Unit | undefined, mine: boolean): void {
    const type = u && getBirdType(s.config, u.typeId);
    if (!u || !type) {
      setChildren(
        this.infoBox,
        h("h3", {}, "Selected bird"),
        h("p", { class: "muted" }, this.mySide === s.activeSide && !s.winner ? "Click one of your birds to give it orders." : "Click any bird to see what it does."),
      );
      return;
    }
    const portrait = document.createElement("canvas");
    const art = sprite(type.id, type.sprite, { flip: type.sprite.mirror && u.side === "red" });
    portrait.width = art.width * 4;
    portrait.height = art.height * 4;
    portrait.className = `portrait ${u.side}`;
    const pctx = portrait.getContext("2d")!;
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(art, 0, 0, portrait.width, portrait.height);

    const canAct = mine && canActUnit(s, u);
    const forage = canAct ? getForageOption(s, u) : null;
    const hearts = Array.from({ length: u.maxHp }, (_, i) => h("span", { class: i < u.hp ? "pip on" : "pip" }));
    const a = type.attack;
    const status = !mine
      ? ""
      : !canActUnit(s, u)
        ? "Done for this turn."
        : this.mode === "attack"
          ? "Aiming: click a red tile. Hover to preview."
          : canMoveUnit(s, u)
            ? "Click a blue tile to fly there, or act from here."
            : "Choose: attack or forage.";

    setChildren(
      this.infoBox,
      h(
        "div",
        { class: "birdhead" },
        portrait,
        h(
          "div",
          {},
          h("div", { class: `birdname ${u.side}` }, u.nickname),
          h("div", { class: "muted small" }, `${type.name} · ${SIDE_LABEL[u.side]}`),
          h("div", { class: "hp" }, ...hearts, h("span", { class: "small" }, ` ${u.hp}/${u.maxHp}`)),
          u.fed ? h("div", { class: "small fed" }, "🪱 Full of worms: next attack +1") : null,
        ),
      ),
      h("p", { class: "small" }, type.description),
      h(
        "div",
        { class: "abilities" },
        h(
          "button",
          { class: this.mode === "attack" && canAct ? "attack on" : "attack", disabled: !canAct, onclick: () => this.toggleAttack() },
          h("b", {}, `⚔ ${a.name}`),
          h("span", { class: "small" }, a.description),
        ),
        h(
          "button",
          { class: "forage", disabled: !forage, onclick: () => this.forage() },
          h("b", {}, forage ? `🍓 Forage: ${forage.food === "berries" ? "berries" : "worms"} (+${forage.heal} HP)` : "🍓 Forage"),
          h("span", { class: "small" }, forage ? (forage.food === "worms" ? "Also: next attack +1 damage." : "Gobble the berries next to you.") : "Stand on a worm patch, or next to ripe berries when hurt."),
        ),
      ),
      status ? h("p", { class: "muted small" }, status) : null,
    );
  }

  private renderOverlay(s: GameState): void {
    if (!s.winner) {
      this.overlayPending = false;
      return void this.overlay.classList.add("hidden");
    }
    if (!this.overlay.classList.contains("hidden") || this.overlayPending) return;
    this.overlayPending = true;
    // Wait for the final knockout animation before celebrating.
    setTimeout(() => {
      this.overlayPending = false;
      if (!this.session.state?.winner) return;
      const mine = this.mySide;
      const title = s.winner === "draw" ? "DRAW!" : `${s.winner!.toUpperCase()} WINS!`;
      const sub =
        s.winner === "draw" ? "Everyone fainted. Nobody gets the worms." : s.winner === mine ? "Your flock rules the hollow. 🏆" : mine ? "Your flock flaps away in shame." : "";
      setChildren(
        this.overlay,
        h("div", { class: "wintitle", style: s.winner !== "draw" ? `color:${TEAM_COLORS[s.winner as "blue" | "red"]}` : "" }, title),
        h("p", {}, sub),
        this.onRematch ? h("button", { class: "primary big", onclick: () => this.onRematch!() }, "Rematch") : h("p", { class: "muted small" }, "Waiting for the host to start a rematch..."),
      );
      this.overlay.classList.remove("hidden");
      sfx.win();
    }, this.board.animating ? 1600 : 0);
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
  if (e.kind === "endTurn") return `— ${SIDE_LABEL[e.side]} ended turn ${e.turn} —`;
  if (e.kind === "attack" || e.kind === "forage") return e.text;
  const unit = s.units.find((u) => u.id === e.unitId);
  return `${unit?.nickname ?? "A bird"} flew ${Math.abs(e.to.x - e.from.x) + Math.abs(e.to.y - e.from.y)} tiles`;
}
