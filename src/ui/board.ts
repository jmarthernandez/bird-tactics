// Isometric pixel-art board, in the spirit of Into the Breach.
//
// How drawing works:
//  1. Everything is drawn into a small low-resolution "buffer" canvas, where
//     1 unit = 1 art pixel (tiles are 32x16 diamonds, birds are 16x16).
//  2. The buffer is scaled up onto the visible canvas with smoothing off,
//     so every pixel stays a crisp square.
//  3. Text (shouts, damage numbers) is drawn on top at full resolution.
//
// The board redraws every animation frame (cheap at this size), which gives us
// idle bobbing, shimmering water, and action animations for free.

import { getBirdType, posKey, samePos, TILE_NAMES } from "../game/rules";
import type { GameEvent, GameState, Pos, Side, StrikeStyle, Unit } from "../game/types";
import { sfx } from "./sfx";
import { BUSH, BUSH_EMPTY, hash, makeCanvas, PEBBLE, ROCK, sprite, TILE_PALETTES, TREE, WORM_ICON } from "./sprites";

const TW = 32; // tile width (art pixels)
const TH = 16; // tile height
const DEPTH = 7; // cliff thickness under each tile
const HEAD = 34; // headroom above the back tiles for sprites and HP bars
const PAD = 10;

const FONT = '"Press Start 2P", ui-monospace, monospace';
export const TEAM_COLORS: Record<Side, string> = { blue: "#4aa3ff", red: "#ff5d52" };

export interface BoardViewOptions {
  selectedId: string | null;
  /** Tiles the selected bird can fly to. */
  moves: Pos[];
  /** Tiles the selected bird can attack. */
  targets: Pos[];
  /** false = just inspecting someone else's bird (muted highlights). */
  active: boolean;
  /** Rotate 180° so each player sees their own flock at the front. */
  flip: boolean;
  /** Events the hovered attack would cause (drawn as a preview). */
  preview: GameEvent[] | null;
}

/** Which rows of a diamond are filled: for each row, start x and width. */
const SPANS: Array<[number, number]> = Array.from({ length: TH }, (_, r) => {
  const half = r < TH / 2 ? (r + 1) * 2 : (TH - r) * 2;
  return [TW / 2 - half, half * 2];
});
/** Lowest filled row in each column (where the cliff starts). */
const BOTTOM: number[] = Array.from({ length: TW }, (_, x) => {
  let b = 0;
  SPANS.forEach(([x0, w], r) => x >= x0 && x < x0 + w && (b = r));
  return b;
});

// ---------- Animation timeline ----------

interface Step {
  ev: GameEvent;
  t0: number;
  dur: number;
}

function buildTimeline(events: GameEvent[]): { steps: Step[]; total: number } {
  const steps: Step[] = [];
  let t = 0;
  const add = (ev: GameEvent, dur: number, advance: number) => {
    steps.push({ ev, t0: t, dur });
    t += advance;
  };
  for (const ev of events) {
    switch (ev.kind) {
      case "move": add(ev, 320, 320); break;
      case "shout": add(ev, 1000, 160); break;
      case "strike": {
        const d = ({ peck: 220, dive: 420, screech: 380, lob: 480 } as Record<StrikeStyle, number>)[ev.style];
        add(ev, d, d);
        break;
      }
      case "damage": add(ev, 1000, 90); break;
      case "push": add(ev, 200, 200); break;
      case "bump": add(ev, 240, 240); break;
      case "faint": add(ev, 800, 300); break;
      case "heal": add(ev, 1000, 200); break;
      case "regrow": add(ev, 700, 0); break;
    }
  }
  // Done when the last effect (including floating numbers) finishes.
  return { steps, total: Math.max(t, ...steps.map((st) => st.t0 + st.dur)) };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

interface UnitView {
  x: number; // fractional board coords
  y: number;
  lift: number; // pixels up
  dx: number; // extra screen offset (lunges, shakes)
  dy: number;
  alpha: number;
  flash: boolean;
}

export class BoardView {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private buf: HTMLCanvasElement;
  private b: CanvasRenderingContext2D;
  private scale = 3;
  private state: GameState | null = null;
  private opts: BoardViewOptions = { selectedId: null, moves: [], targets: [], active: false, flip: false, preview: null };
  private hover: Pos | null = null;

  // Animation state.
  private seenSeq = -1;
  private seenSide: Side | null = null;
  private steps: Step[] = [];
  private animStart = 0;
  private animEnd = 0;
  private ghosts: Unit[] = []; // birds that fainted during the current animation
  private fired = new Set<Step>();
  private bannerStart = -1e9;
  private bannerText = "";
  private bannerSide: Side = "blue";
  private shakeUntil = 0;

  constructor(
    private onTileClick: (p: Pos | null) => void,
    private onHover: (p: Pos | null) => void,
    private mySide: () => Side | null,
  ) {
    this.canvas.className = "board";
    [this.buf, this.b] = makeCanvas(1, 1);
    this.canvas.addEventListener("click", (e) => this.onTileClick(this.hitTest(e)));
    this.canvas.addEventListener("mousemove", (e) => {
      const p = this.hitTest(e);
      if (!(p && this.hover && samePos(p, this.hover)) && !(p === null && this.hover === null)) {
        this.hover = p;
        this.onHover(p);
      }
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.hover = null;
      this.onHover(null);
    });
    const frame = (now: number) => {
      if (this.state && this.canvas.isConnected) this.draw(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  get animating(): boolean {
    return performance.now() < this.animEnd;
  }

  /** Give the board new state/options. Starts animations when the state has new events. */
  update(state: GameState, opts: BoardViewOptions): void {
    const prev = this.state;
    this.state = state;
    this.opts = opts;
    if (state.eventSeq !== this.seenSeq) {
      if (this.seenSeq !== -1 && prev && state.lastEvents.length) this.startAnim(state.lastEvents);
      this.seenSeq = state.eventSeq;
    }
    if (state.activeSide !== this.seenSide) {
      if (this.seenSide !== null && !state.winner) {
        const mine = this.mySide() === state.activeSide;
        this.bannerText = mine ? "YOUR TURN" : `${state.activeSide.toUpperCase()}'S TURN`;
        this.bannerSide = state.activeSide;
        this.bannerStart = performance.now() + (this.animating ? this.animEnd - performance.now() - 700 : 0);
        sfx.turn();
      }
      this.seenSide = state.activeSide;
    }
  }

  private startAnim(events: GameEvent[]): void {
    const { steps, total } = buildTimeline(events);
    this.steps = steps;
    this.animStart = performance.now();
    this.animEnd = this.animStart + total;
    this.ghosts = events.filter((e): e is Extract<GameEvent, { kind: "faint" }> => e.kind === "faint").map((e) => e.unit);
    this.fired.clear();
  }

  // ---------- Coordinates ----------

  private get dims() {
    const { width, height } = this.state!.config.board;
    return { w: width, h: height, bufW: ((width + height) * TW) / 2 + PAD * 2, bufH: ((width + height) * TH) / 2 + DEPTH + HEAD + PAD };
  }

  /** Board position (may be fractional) -> buffer pixel of the tile's top vertex. */
  private toScreen(x: number, y: number): { sx: number; sy: number; depth: number } {
    const { w, h } = this.dims;
    const fx = this.opts.flip ? w - 1 - x : x;
    const fy = this.opts.flip ? h - 1 - y : y;
    return { sx: PAD + (h * TW) / 2 + ((fx - fy) * TW) / 2, sy: HEAD + ((fx + fy) * TH) / 2, depth: fx + fy };
  }

  private hitTest(e: MouseEvent): Pos | null {
    if (!this.state) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) / this.scale;
    const py = (e.clientY - rect.top) / this.scale;
    const { w, h } = this.dims;
    // A highlighted tile under the cursor always wins (so you can target tiles behind tall birds).
    const tile = this.tileAt(px, py);
    if (tile && [...this.opts.moves, ...this.opts.targets].some((p) => samePos(p, tile))) return tile;
    // Clicking a bird's body counts as clicking its tile (front-most bird first).
    const units = [...this.state.units].sort((a, b) => this.toScreen(b.pos.x, b.pos.y).depth - this.toScreen(a.pos.x, a.pos.y).depth);
    for (const u of units) {
      const { sx, sy } = this.toScreen(u.pos.x, u.pos.y);
      if (px >= sx - 8 && px <= sx + 8 && py >= sy + TH / 2 - 16 && py <= sy + TH / 2 + 2) return u.pos;
    }
    return tile;
  }

  /** Invert the isometric projection: buffer pixel -> board tile. */
  private tileAt(px: number, py: number): Pos | null {
    const { w, h } = this.dims;
    const u = (px - (PAD + (h * TW) / 2)) / (TW / 2);
    const v = (py - HEAD) / (TH / 2);
    let fx = Math.floor((v + u) / 2);
    let fy = Math.floor((v - u) / 2);
    if (fx < 0 || fy < 0 || fx >= w || fy >= h) return null;
    if (this.opts.flip) [fx, fy] = [w - 1 - fx, h - 1 - fy];
    return { x: fx, y: fy };
  }

  // ---------- Drawing ----------

  private draw(now: number): void {
    const s = this.state!;
    const { bufW, bufH } = this.dims;
    if (this.buf.width !== bufW || this.buf.height !== bufH) {
      this.buf.width = bufW;
      this.buf.height = bufH;
    }
    const b = this.b;
    b.clearRect(0, 0, bufW, bufH);
    const t = now - this.animStart;
    const animating = now < this.animEnd;

    // Fire sound effects as their animation steps begin.
    if (animating) for (const st of this.steps) if (t >= st.t0 && !this.fired.has(st)) this.fire(st);

    // 1. Ground tiles, back to front.
    const tiles: Array<{ x: number; y: number; d: number }> = [];
    for (let y = 0; y < s.config.board.height; y++) for (let x = 0; x < s.config.board.width; x++) tiles.push({ x, y, d: this.toScreen(x, y).depth });
    tiles.sort((a, b) => a.d - b.d);
    for (const { x, y } of tiles) this.drawGround(x, y, now);

    // 2. Highlights on the ground.
    const o = this.opts;
    const affected = new Set((o.preview ?? []).filter((e) => e.kind === "damage").map((e) => posKey((e as { pos: Pos }).pos)));
    for (const p of o.moves) this.diamond(p, o.active ? "rgba(90,200,255,0.38)" : "rgba(220,220,240,0.18)", o.active ? "#a8e8ff" : "#c8c8d8");
    for (const p of o.targets) this.diamond(p, affected.has(posKey(p)) ? "rgba(255,70,50,0.55)" : "rgba(255,90,60,0.32)", "#ff8a6a");
    for (const key of affected) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      if (!o.targets.some((p) => p.x === x && p.y === y)) this.diamond({ x, y }, "rgba(255,70,50,0.45)", "#ff6a4a");
    }
    const sel = s.units.find((u) => u.id === o.selectedId);
    if (sel) this.diamond(sel.pos, null, Math.floor(now / 300) % 2 ? "#ffffff" : "#ffe9a8");
    if (this.hover) this.diamond(this.hover, "rgba(255,255,255,0.10)", "rgba(255,255,255,0.6)");

    // 3. Props and birds, back to front.
    const things: Array<{ d: number; draw: () => void }> = [];
    for (const { x, y, d } of tiles) {
      const tile = s.tiles[y]![x]!;
      if (tile === "tree" || tile === "rock" || tile === "bush") things.push({ d, draw: () => this.drawProp(x, y, tile) });
    }
    const all = animating ? [...s.units, ...this.ghosts] : s.units;
    for (const u of all) {
      const v = this.unitView(u, t, animating);
      if (v.alpha <= 0) continue;
      things.push({ d: this.toScreen(v.x, v.y).depth + 0.01, draw: () => this.drawUnit(u, v, now) });
    }
    things.sort((a, b) => a.d - b.d).forEach((th) => th.draw());

    // 4. Effects on top (pebbles, screech rings, sparkles).
    if (animating) for (const st of this.steps) this.drawEffect(st, t);

    // 5. Scale up to the visible canvas, then draw crisp text on top.
    this.present(now, t, animating);
  }

  private fire(st: Step): void {
    this.fired.add(st);
    const ev = st.ev;
    if (ev.kind === "move") sfx.hop();
    else if (ev.kind === "strike") ({ peck: sfx.chirp, dive: sfx.dive, screech: sfx.screech, lob: sfx.caw })[ev.style]();
    else if (ev.kind === "damage") sfx.hit();
    else if (ev.kind === "bump") (sfx.bump(), (this.shakeUntil = performance.now() + 180));
    else if (ev.kind === "faint") sfx.poof();
    else if (ev.kind === "heal") sfx.nom();
  }

  private tileCanvas(type: string, x: number, y: number, frame: number, wormsRipe: boolean): HTMLCanvasElement {
    const key = `tile|${type}|${x}|${y}|${frame}|${wormsRipe}`;
    const cached = tileCache.get(key);
    if (cached) return cached;
    const pal = TILE_PALETTES[type === "dirt" || type === "pond" ? type : "grass"]!;
    const [c, ctx] = makeCanvas(TW, TH + DEPTH);
    // Cliff sides: left face lighter than right, with a darker stripe.
    for (let cx = 0; cx < TW; cx++) {
      const top = BOTTOM[cx]!;
      for (let d = 0; d < DEPTH + 1; d++) {
        ctx.fillStyle = d === 3 ? "#3a2716" : cx < TW / 2 ? pal.left : pal.right;
        if (type === "pond") ctx.fillStyle = cx < TW / 2 ? "#6b4a2e" : "#4e3420";
        ctx.fillRect(cx, top + d, 1, 1);
      }
    }
    // Top surface, speckled.
    SPANS.forEach(([x0, w], r) => {
      for (let cx = x0; cx < x0 + w; cx++) {
        const edge = cx === x0 || cx === x0 + w - 1 || r === 0 || r === TH - 1;
        const n = hash(x, y, cx, r, type === "pond" ? frame : 0);
        let color = pal.top[0]!;
        if (type === "pond") {
          const wave = (cx + r * 2 + frame * 3) % 11 === 0 && n > 0.4;
          color = wave ? pal.top[3]! : n < 0.2 ? pal.top[1]! : n > 0.92 ? pal.top[2]! : pal.top[0]!;
        } else {
          color = n < 0.14 ? pal.top[2]! : n < 0.26 ? pal.top[1]! : n > 0.985 ? (type === "grass" ? "#f4e36a" : pal.top[3]!) : pal.top[0]!;
        }
        if (edge) color = shade(color, -0.18);
        ctx.fillStyle = color;
        ctx.fillRect(cx, r, 1, 1);
      }
    });
    // Worms wiggling out of a ripe worm patch.
    if (type === "dirt" && wormsRipe) {
      ctx.fillStyle = "#f08aa6";
      for (const [wx, wy] of [[11, 6], [18, 8], [14, 10]] as const) {
        ctx.fillRect(wx, wy, 1, 1);
        ctx.fillRect(wx + 1, wy - 1 + (frame % 2), 1, 1);
        ctx.fillRect(wx + 2, wy, 1, 1);
      }
    }
    tileCache.set(key, c);
    return c;
  }

  private drawGround(x: number, y: number, now: number): void {
    const s = this.state!;
    const tile = s.tiles[y]![x]!;
    const { sx, sy } = this.toScreen(x, y);
    const frame = tile === "pond" || tile === "dirt" ? Math.floor(now / 600) % 3 : 0;
    const ripe = s.food[posKey({ x, y })]?.ripe ?? false;
    this.b.drawImage(this.tileCanvas(tile, x, y, frame, ripe), sx - TW / 2, sy);
  }

  private drawProp(x: number, y: number, tile: "tree" | "rock" | "bush"): void {
    const { sx, sy } = this.toScreen(x, y);
    const cy = sy + TH / 2;
    const ripe = this.state!.food[posKey({ x, y })]?.ripe ?? false;
    const art =
      tile === "tree" ? sprite("tree", TREE) : tile === "rock" ? sprite("rock", ROCK) : sprite(`bush${ripe}`, BUSH, ripe ? {} : { overrides: BUSH_EMPTY });
    // Shadow, then the prop standing on the tile center.
    this.ellipse(sx, cy + 1, 7, 2, "rgba(0,0,0,0.28)");
    this.b.drawImage(art, Math.round(sx - art.width / 2), Math.round(cy - art.height + 3));
  }

  private unitView(u: Unit, t: number, animating: boolean): UnitView {
    const v: UnitView = { x: u.pos.x, y: u.pos.y, lift: 0, dx: 0, dy: 0, alpha: u.hasActed && !animating ? 0.55 : 1, flash: false };
    if (!animating) return v;
    v.alpha = 1;
    let started = false;
    for (const st of this.steps) {
      const ev = st.ev;
      const p = Math.min(1, Math.max(0, (t - st.t0) / st.dur));
      const active = t >= st.t0 && t < st.t0 + st.dur;
      if ((ev.kind === "move" || ev.kind === "push") && ev.unitId === u.id) {
        if (!started) {
          v.x = ev.from.x;
          v.y = ev.from.y;
          started = true;
        }
        if (t >= st.t0) {
          const e = ease(p);
          v.x = lerp(ev.from.x, ev.to.x, e);
          v.y = lerp(ev.from.y, ev.to.y, e);
          if (ev.kind === "move" && active) v.lift = Math.sin(Math.PI * p) * 10;
        }
      } else if (ev.kind === "strike" && ev.unitId === u.id && active) {
        const dir = { x: Math.sign(ev.to.x - ev.from.x), y: Math.sign(ev.to.y - ev.from.y) };
        if (ev.style === "dive") {
          // Swoop to the tile in front of the target and back.
          const dist = Math.max(Math.abs(ev.to.x - ev.from.x), Math.abs(ev.to.y - ev.from.y)) - 0.6;
          const k = Math.sin(Math.PI * p) * dist;
          v.x = ev.from.x + dir.x * k;
          v.y = ev.from.y + dir.y * k;
          v.lift = Math.sin(Math.PI * p) * 6;
        } else if (ev.style === "peck") {
          const k = Math.sin(Math.PI * p) * 0.35;
          v.x = ev.from.x + dir.x * k;
          v.y = ev.from.y + dir.y * k;
        } else if (ev.style === "screech") {
          v.dx = Math.round(Math.sin(t / 15)) * 1;
          v.lift = 2;
        } else {
          v.lift = Math.sin(Math.PI * p) * 3;
        }
      } else if (ev.kind === "bump" && ev.unitId === u.id && active) {
        const a = this.toScreen(ev.pos.x, ev.pos.y);
        const b = this.toScreen(ev.into.x, ev.into.y);
        const k = Math.sin(Math.PI * p) * 0.25;
        v.dx = (b.sx - a.sx) * k;
        v.dy = (b.sy - a.sy) * k;
      } else if (ev.kind === "damage" && ev.unitId === u.id && t >= st.t0 && t < st.t0 + 160) {
        v.flash = true;
      } else if (ev.kind === "faint" && ev.unit.id === u.id && t >= st.t0) {
        v.alpha = 1 - p;
        v.lift = p * 14;
      }
    }
    return v;
  }

  private drawUnit(u: Unit, v: UnitView, now: number): void {
    const s = this.state!;
    const type = getBirdType(s.config, u.typeId);
    if (!type) return;
    const { sx, sy } = this.toScreen(v.x, v.y);
    const cx = Math.round(sx + v.dx);
    const cy = Math.round(sy + TH / 2 + v.dy);
    const b = this.b;
    b.save();
    b.globalAlpha = v.alpha;

    // Shadow and team ring on the ground.
    this.ellipse(cx, cy + 1, 6, 2, "rgba(0,0,0,0.35)");
    b.drawImage(ringCanvas(TEAM_COLORS[u.side]), cx - 8, cy - 3);

    // The bird, facing the enemy. Idle birds that can still act bob gently.
    const facesRight = (u.side === "blue") !== this.opts.flip;
    const ready = !u.hasActed && u.side === s.activeSide && !s.winner;
    const bob = ready && Math.floor((now + hash(u.id.length, u.pos.x) * 800) / 400) % 2 ? 1 : 0;
    const art = sprite(type.id, type.sprite, { flip: type.sprite.mirror && !facesRight, tint: v.flash ? "#ffffff" : undefined });
    const top = Math.round(cy - art.height + 2 - v.lift - bob);
    b.drawImage(art, cx - Math.floor(art.width / 2), top);

    // HP pips above the head (green = health left).
    const pipW = 3;
    const barW = u.maxHp * pipW + 1;
    const bx = cx - Math.floor(barW / 2);
    const by = top - 4;
    b.fillStyle = "#141018";
    b.fillRect(bx, by, barW, 4);
    for (let i = 0; i < u.maxHp; i++) {
      b.fillStyle = i < u.hp ? (u.hp <= 1 ? "#ffcf40" : "#5fe36b") : "#5a1e28";
      b.fillRect(bx + 1 + i * pipW, by + 1, pipW - 1, 2);
    }
    if (u.fed) b.drawImage(sprite("worm", WORM_ICON), bx + barW + 1, by);
    b.restore();
  }

  private drawEffect(st: Step, t: number): void {
    const ev = st.ev;
    const p = (t - st.t0) / st.dur;
    if (p < 0 || p > 1) return;
    const b = this.b;
    if (ev.kind === "strike" && ev.style === "lob") {
      // Pebble arcs over everything.
      const a = this.toScreen(ev.from.x, ev.from.y);
      const z = this.toScreen(ev.to.x, ev.to.y);
      const x = lerp(a.sx, z.sx, p);
      const y = lerp(a.sy, z.sy, p) + TH / 2 - 10 - Math.sin(Math.PI * p) * 36;
      b.drawImage(sprite("pebble", PEBBLE), Math.round(x) - 2, Math.round(y));
    } else if (ev.kind === "strike" && ev.style === "screech") {
      // Expanding sound rings.
      const { sx, sy } = this.toScreen(ev.from.x, ev.from.y);
      for (const k of [0, 0.35]) {
        const q = p - k;
        if (q < 0 || q > 0.65) continue;
        this.ringOutline(sx, sy + TH / 2 - 6, 4 + q * 40, 2 + q * 20, `rgba(255,240,180,${1 - q / 0.65})`);
      }
    } else if (ev.kind === "damage" || ev.kind === "bump") {
      // Little burst of feathers/dust.
      const { sx, sy } = this.toScreen(ev.pos.x, ev.pos.y);
      b.fillStyle = ev.kind === "damage" ? "#fff6d0" : "#c9b48a";
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + i;
        b.fillRect(Math.round(sx + Math.cos(ang) * p * 12), Math.round(sy + TH / 2 - 6 + Math.sin(ang) * p * 8 + p * p * 6), 1, 1);
      }
    } else if (ev.kind === "faint") {
      const { sx, sy } = this.toScreen(ev.unit.pos.x, ev.unit.pos.y);
      b.fillStyle = TEAM_COLORS[ev.unit.side];
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        b.fillRect(Math.round(sx + Math.cos(ang) * p * 16), Math.round(sy - 4 + Math.sin(ang) * p * 10 + p * p * 14), 2, 1);
      }
    } else if (ev.kind === "regrow" || ev.kind === "heal") {
      const pos = ev.pos;
      const { sx, sy } = this.toScreen(pos.x, pos.y);
      b.fillStyle = ev.kind === "heal" ? "#7dff8a" : "#fff7a0";
      for (let i = 0; i < 4; i++) b.fillRect(Math.round(sx - 6 + i * 4), Math.round(sy + 2 - p * 14 - (i % 2) * 3), 1, 2);
    }
  }

  /** Copy the buffer to the screen at scale, then draw text overlays. */
  private present(now: number, t: number, animating: boolean): void {
    const { bufW, bufH } = this.dims;
    const avail = Math.min(this.canvas.parentElement?.clientWidth ?? bufW * 3, 1000);
    // Whole-number scales keep pixels perfectly square; allow halves on small screens.
    this.scale = Math.max(1.5, Math.min(4, avail / bufW >= 3 ? Math.floor(avail / bufW) : Math.floor((avail / bufW) * 2) / 2));
    const sc = this.scale;
    const cssW = Math.round(bufW * sc);
    const cssH = Math.round(bufH * sc);
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cssW, cssH);
    const shake = now < this.shakeUntil ? Math.round(Math.sin(now / 20) * 2) : 0;
    ctx.drawImage(this.buf, shake, 0, cssW, cssH);

    // Screen position (CSS px) of a board tile's center.
    const at = (p: Pos, up = 0) => {
      const { sx, sy } = this.toScreen(p.x, p.y);
      return { x: sx * sc, y: (sy + TH / 2 - up) * sc };
    };
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (animating) {
      for (const st of this.steps) {
        const p = (t - st.t0) / st.dur;
        if (p < 0 || p > 1) continue;
        const ev = st.ev;
        if (ev.kind === "shout") bubble(ctx, at(ev.pos, 26), ev.text, sc);
        if (ev.kind === "damage") floatText(ctx, at(ev.pos, 22 + p * 12), `-${ev.amount}`, "#ff5050", sc, 1 - p * p);
        if (ev.kind === "heal") floatText(ctx, at(ev.pos, 22 + p * 12), ev.amount > 0 ? `+${ev.amount}` : "+0", "#6bff7a", sc, 1 - p * p);
        if (ev.kind === "bump") floatText(ctx, at(ev.into, 8), "BONK", "#ffd166", sc * 0.8, 1 - p);
      }
    }

    // Attack preview: damage numbers, push arrows, knockouts.
    const preview = this.opts.preview;
    if (preview && !animating) {
      const s = this.state!;
      const fainted = new Set(preview.filter((e) => e.kind === "faint").map((e) => (e as { unit: Unit }).unit.id));
      for (const ev of preview) {
        if (ev.kind === "push") arrow(ctx, at(ev.from, 4), at(ev.to, 4), sc);
        if (ev.kind === "bump") arrow(ctx, at(ev.pos, 4), at(ev.into, 4), sc, true);
      }
      const totals = new Map<string, { pos: Pos; dmg: number }>();
      for (const ev of preview) {
        if (ev.kind !== "damage") continue;
        const cur = totals.get(ev.unitId) ?? { pos: s.units.find((u) => u.id === ev.unitId)?.pos ?? ev.pos, dmg: 0 };
        cur.dmg += ev.amount;
        totals.set(ev.unitId, cur);
      }
      for (const [id, { pos, dmg }] of totals) {
        floatText(ctx, at(pos, 28), fainted.has(id) ? `KO!` : `-${dmg}`, fainted.has(id) ? "#ffd166" : "#ff5050", sc, 1);
      }
    }

    // Turn banner sweeping across the board.
    const bt = now - this.bannerStart;
    if (bt >= 0 && bt < 1300) {
      const slide = bt < 250 ? 1 - bt / 250 : bt > 1050 ? -(bt - 1050) / 250 : 0;
      const y = cssH * 0.42;
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = "#0d1017";
      ctx.fillRect(0, y - 9 * sc, cssW, 18 * sc);
      ctx.fillStyle = TEAM_COLORS[this.bannerSide];
      ctx.fillRect(0, y - 9 * sc, cssW, sc);
      ctx.fillRect(0, y + 8 * sc, cssW, sc);
      ctx.globalAlpha = 1;
      ctx.font = `${Math.round(8 * sc)}px ${FONT}`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(this.bannerText, cssW / 2 + slide * cssW, y + sc);
    }
  }

  // ---------- Small pixel helpers ----------

  /** Fill and/or outline a tile diamond in the buffer. */
  private diamond(p: Pos, fill: string | null, edge: string | null): void {
    const { sx, sy } = this.toScreen(p.x, p.y);
    const b = this.b;
    SPANS.forEach(([x0, w], r) => {
      const x = Math.round(sx - TW / 2 + x0);
      if (fill) {
        b.fillStyle = fill;
        b.fillRect(x + 1, sy + r, w - 2, 1);
      }
      if (edge) {
        b.fillStyle = edge;
        b.fillRect(x, sy + r, 2, 1);
        b.fillRect(x + w - 2, sy + r, 2, 1);
      }
    });
  }

  private ellipse(cx: number, cy: number, rx: number, ry: number, color: string): void {
    this.b.fillStyle = color;
    for (let dy = -ry; dy <= ry; dy++) {
      const w = Math.round(rx * Math.sqrt(1 - (dy * dy) / ((ry + 0.5) * (ry + 0.5))));
      this.b.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
    }
  }

  private ringOutline(cx: number, cy: number, rx: number, ry: number, color: string): void {
    this.b.fillStyle = color;
    for (let a = 0; a < Math.PI * 2; a += 0.08) this.b.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), 1, 1);
  }

  /** Short description of a tile, for the hover info line. */
  describeTile(p: Pos): string {
    const s = this.state;
    if (!s) return "";
    const tile = s.tiles[p.y]?.[p.x];
    if (!tile) return "";
    const food = s.food[posKey(p)];
    const extra =
      tile === "bush"
        ? food?.ripe ? " (ripe berries! hurt birds next to it can forage)" : ` (eaten, regrows in ${food?.regrowIn ?? "?"} turns)`
        : tile === "dirt"
          ? food?.ripe ? " (wriggling with worms! stand here to forage)" : ` (dug up, regrows in ${food?.regrowIn ?? "?"} turns)`
          : tile === "grass" ? "" : " (blocks landing; shoving a bird into it = BONK)";
    return TILE_NAMES[tile] + extra;
  }
}

const tileCache = new Map<string, HTMLCanvasElement>();

const ringCache = new Map<string, HTMLCanvasElement>();
/** Pixel ellipse outline in the team color, drawn under each bird. */
function ringCanvas(color: string): HTMLCanvasElement {
  let c = ringCache.get(color);
  if (c) return c;
  const [cv, ctx] = makeCanvas(17, 7);
  ctx.fillStyle = color;
  for (let a = 0; a < Math.PI * 2; a += 0.05) ctx.fillRect(Math.round(8 + Math.cos(a) * 7.5), Math.round(3 + Math.sin(a) * 2.6), 1, 1);
  ringCache.set(color, (c = cv));
  return c;
}

/** Lighten (amt > 0) or darken (amt < 0) a #rrggbb color. */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function bubble(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, text: string, sc: number): void {
  ctx.font = `${Math.round(4 * sc)}px ${FONT}`;
  const w = ctx.measureText(text).width + 4 * sc;
  const h = 8 * sc;
  ctx.fillStyle = "#191322";
  ctx.fillRect(p.x - w / 2 - sc, p.y - h / 2 - sc, w + 2 * sc, h + 2 * sc);
  ctx.fillStyle = "#fffbea";
  ctx.fillRect(p.x - w / 2, p.y - h / 2, w, h);
  ctx.fillRect(p.x - sc, p.y + h / 2, 2 * sc, 2 * sc); // tail
  ctx.fillStyle = "#191322";
  ctx.fillText(text, p.x, p.y + sc * 0.5);
}

function floatText(ctx: CanvasRenderingContext2D, p: { x: number; y: number }, text: string, color: string, sc: number, alpha: number): void {
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.font = `${Math.round(5 * sc)}px ${FONT}`;
  ctx.lineWidth = sc * 1.5;
  ctx.strokeStyle = "#191322";
  ctx.strokeText(text, p.x, p.y);
  ctx.fillStyle = color;
  ctx.fillText(text, p.x, p.y);
  ctx.globalAlpha = 1;
}

function arrow(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, sc: number, blocked = false): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const end = { x: a.x + ux * len * (blocked ? 0.5 : 0.8), y: a.y + uy * len * (blocked ? 0.5 : 0.8) };
  ctx.strokeStyle = "#191322";
  ctx.lineWidth = sc * 3;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  ctx.strokeStyle = blocked ? "#ffd166" : "#fff3b0";
  ctx.lineWidth = sc * 1.5;
  ctx.stroke();
  const hs = sc * 4;
  ctx.fillStyle = blocked ? "#ffd166" : "#fff3b0";
  ctx.beginPath();
  ctx.moveTo(end.x + ux * hs, end.y + uy * hs);
  ctx.lineTo(end.x - uy * hs * 0.7, end.y + ux * hs * 0.7);
  ctx.lineTo(end.x + uy * hs * 0.7, end.y - ux * hs * 0.7);
  ctx.closePath();
  ctx.fill();
}
