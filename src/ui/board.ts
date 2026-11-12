// Draws the board on a <canvas>. Canvas (instead of a DOM grid) because the
// board is one picture that's redrawn whole on every state change, highlights
// and team rings are easy to draw crisply, and later effects (attack arrows,
// push previews, telegraphed enemy moves) are just more drawing calls.

import { getBirdType, samePos } from "../game/rules";
import type { GameState, Pos, Side } from "../game/types";

export const COLORS = {
  bg: "#12161f",
  tile: "#2a3346",
  tileAlt: "#26303f",
  grid: "#0d1017",
  tree: "#1f4d33",
  treeTop: "#3c8a55",
  label: "#7f8aa3",
  blue: "#4aa3ff",
  red: "#ff5d52",
  move: "#f2b84b", // valid destination for your bird
  inspect: "#8f9bb5", // range of a bird you can't move right now
  selected: "#ffffff",
  lastMove: "rgba(242,184,75,0.18)",
};

export interface BoardViewOptions {
  selectedId: string | null;
  moves: Pos[];
  /** true = moves are actionable (bright); false = just showing range. */
  movesActive: boolean;
  /** Rotate the board 180° so each player sees their own side at the bottom. */
  flip: boolean;
}

const MARGIN = 22; // room for the a-h / 1-8 labels

/** Chess-style coordinate name, from blue's point of view (a1 = blue's bottom-left). */
export function tileName(state: GameState, p: Pos): string {
  return `${String.fromCharCode(97 + p.x)}${state.config.board.height - p.y}`;
}

export class BoardView {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private tileSize = 60;
  private last: { state: GameState; opts: BoardViewOptions } | null = null;

  constructor(private onTileClick: (p: Pos | null) => void) {
    this.canvas.className = "board";
    this.canvas.addEventListener("click", (e) => this.onTileClick(this.hitTest(e)));
  }

  private observing = false;
  /** Redraw at the right size when the container resizes (set up once the canvas is on the page). */
  private watchSize(): void {
    const parent = this.canvas.parentElement;
    if (this.observing || !parent) return;
    this.observing = true;
    let lastWidth = parent.clientWidth;
    new ResizeObserver(() => {
      if (parent.clientWidth === lastWidth || !this.last) return;
      lastWidth = parent.clientWidth;
      this.draw(this.last.state, this.last.opts);
    }).observe(parent);
  }

  /** Board -> screen coordinates (accounts for flipping). */
  private toScreen(state: GameState, p: Pos, flip: boolean): Pos {
    const { width, height } = state.config.board;
    return flip ? { x: width - 1 - p.x, y: height - 1 - p.y } : p;
  }

  private hitTest(e: MouseEvent): Pos | null {
    if (!this.last) return null;
    const rect = this.canvas.getBoundingClientRect();
    const sx = Math.floor((e.clientX - rect.left - MARGIN) / this.tileSize);
    const sy = Math.floor((e.clientY - rect.top - MARGIN) / this.tileSize);
    const { width, height } = this.last.state.config.board;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
    return this.toScreen(this.last.state, { x: sx, y: sy }, this.last.opts.flip); // flipping is its own inverse
  }

  draw(state: GameState, opts: BoardViewOptions): void {
    this.last = { state, opts };
    this.watchSize();
    const { width, height } = state.config.board;

    // Fit the available width (max 72px tiles), sharp on high-DPI screens.
    const avail = Math.min(this.canvas.parentElement?.clientWidth ?? 600, 640);
    this.tileSize = Math.max(28, Math.min(72, Math.floor((avail - MARGIN * 2) / width)));
    const ts = this.tileSize;
    const cssW = width * ts + MARGIN * 2;
    const cssH = height * ts + MARGIN * 2;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const rectOf = (p: Pos) => {
      const s = this.toScreen(state, p, opts.flip);
      return { x: MARGIN + s.x * ts, y: MARGIN + s.y * ts };
    };

    // Coordinate labels.
    ctx.fillStyle = COLORS.label;
    ctx.font = "600 12px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let x = 0; x < width; x++) {
      const r = rectOf({ x, y: 0 });
      ctx.fillText(String.fromCharCode(97 + x), r.x + ts / 2, cssH - MARGIN / 2);
    }
    for (let y = 0; y < height; y++) {
      const r = rectOf({ x: 0, y });
      ctx.fillText(String(height - y), MARGIN / 2, r.y + ts / 2);
    }

    // Tiles and terrain.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const r = rectOf({ x, y });
        const isTree = state.tiles[y]?.[x] === "tree";
        ctx.fillStyle = isTree ? COLORS.tree : (x + y) % 2 ? COLORS.tileAlt : COLORS.tile;
        ctx.fillRect(r.x, r.y, ts, ts);
        if (isTree) drawTree(ctx, r.x, r.y, ts);
      }
    }

    // The most recent move: faint from/to highlight so the other player sees what changed.
    const lastMove = [...state.history].reverse().find((h) => h.kind === "move");
    if (lastMove && lastMove.kind === "move") {
      ctx.fillStyle = COLORS.lastMove;
      for (const p of [lastMove.from, lastMove.to]) {
        const r = rectOf(p);
        ctx.fillRect(r.x, r.y, ts, ts);
      }
    }

    // Grid lines.
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 2;
    for (let i = 0; i <= width; i++) line(ctx, MARGIN + i * ts, MARGIN, MARGIN + i * ts, MARGIN + height * ts);
    for (let i = 0; i <= height; i++) line(ctx, MARGIN, MARGIN + i * ts, MARGIN + width * ts, MARGIN + i * ts);

    // Valid destination highlights.
    const hl = opts.movesActive ? COLORS.move : COLORS.inspect;
    for (const p of opts.moves) {
      const r = rectOf(p);
      ctx.fillStyle = hl + (opts.movesActive ? "40" : "26");
      ctx.fillRect(r.x + 2, r.y + 2, ts - 4, ts - 4);
      ctx.strokeStyle = hl;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 4, r.y + 4, ts - 8, ts - 8);
    }

    // Birds.
    for (const u of state.units) {
      const r = rectOf(u.pos);
      const type = getBirdType(state.config, u.typeId);
      const cx = r.x + ts / 2;
      const cy = r.y + ts / 2;
      const ready = u.side === state.activeSide && !u.hasMoved;
      ctx.globalAlpha = u.hasMoved ? 0.4 : 1; // already moved this turn = dimmed
      // Team ring.
      ctx.beginPath();
      ctx.arc(cx, cy, ts * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = "#151a24";
      ctx.fill();
      ctx.lineWidth = Math.max(3, ts * 0.07);
      ctx.strokeStyle = COLORS[u.side as Side];
      ctx.stroke();
      // Icon.
      ctx.font = `${Math.floor(ts * 0.42)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      ctx.fillText(type?.icon ?? "?", cx, cy + 1);
      // Small type letter in the corner, in case the emoji doesn't render.
      ctx.font = `700 ${Math.floor(ts * 0.18)}px ui-monospace, Menlo, monospace`;
      ctx.fillStyle = COLORS[u.side as Side];
      ctx.fillText((type?.name ?? "?")[0]!.toUpperCase(), r.x + ts * 0.14, r.y + ts * 0.16);
      // A small dot marks birds that can still move this turn.
      if (ready) {
        ctx.beginPath();
        ctx.arc(r.x + ts * 0.86, r.y + ts * 0.14, ts * 0.06, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.move;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (opts.selectedId === u.id) {
        ctx.strokeStyle = COLORS.selected;
        ctx.lineWidth = 3;
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, ts - 3, ts - 3);
      }
    }
  }

  /** Is there a destination highlight at this position? */
  static contains(moves: Pos[], p: Pos): boolean {
    return moves.some((m) => samePos(m, p));
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** A flat, chunky pine tree. */
function drawTree(ctx: CanvasRenderingContext2D, x: number, y: number, ts: number): void {
  ctx.fillStyle = "#5b3f2a";
  ctx.fillRect(x + ts * 0.45, y + ts * 0.66, ts * 0.1, ts * 0.18);
  ctx.fillStyle = COLORS.treeTop;
  for (const [top, half, bottom] of [[0.14, 0.2, 0.46], [0.3, 0.27, 0.7]] as const) {
    ctx.beginPath();
    ctx.moveTo(x + ts / 2, y + ts * top);
    ctx.lineTo(x + ts * (0.5 + half), y + ts * bottom);
    ctx.lineTo(x + ts * (0.5 - half), y + ts * bottom);
    ctx.closePath();
    ctx.fill();
  }
}
