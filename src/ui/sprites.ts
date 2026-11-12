// Pixel art. Bird sprites come from the data files (birds.json); terrain art
// lives here. Sprites are tiny canvases drawn 1 pixel = 1 pixel, and the whole
// board is scaled up afterwards with smoothing off, so everything stays crisp.

import type { SpriteDef } from "../game/types";

const OUTLINE = "#191322";

/** Make a canvas of the given size. */
export function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/**
 * Turn rows of palette characters into a canvas, adding a 1px dark outline
 * around the shape (so the art itself only needs fill colors).
 * `tint` replaces every color (used for the white "hit flash").
 */
export function renderPixels(def: SpriteDef, opts: { flip?: boolean; tint?: string; overrides?: Record<string, string> } = {}): HTMLCanvasElement {
  const rows = def.pixels;
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const [c, ctx] = makeCanvas(w + 2, h + 2);
  const filled = (x: number, y: number) => {
    const ch = rows[y]?.[x];
    return ch !== undefined && ch !== ".";
  };
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      const px = opts.flip ? w - 1 - x : x;
      let color: string | undefined;
      if (filled(px, y)) {
        const ch = rows[y]![px]!;
        color = opts.tint ?? opts.overrides?.[ch] ?? def.palette[ch];
      } else if (filled(px - 1, y) || filled(px + 1, y) || filled(px, y - 1) || filled(px, y + 1)) {
        color = opts.tint ? undefined : OUTLINE; // outline around the shape
      }
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(x + 1, y + 1, 1, 1);
      }
    }
  }
  return c;
}

const cache = new Map<string, HTMLCanvasElement>();
/** Cached version of renderPixels. */
export function sprite(key: string, def: SpriteDef, opts: Parameters<typeof renderPixels>[1] = {}): HTMLCanvasElement {
  const k = `${key}|${opts.flip ? 1 : 0}|${opts.tint ?? ""}|${JSON.stringify(opts.overrides ?? {})}`;
  let c = cache.get(k);
  if (!c) cache.set(k, (c = renderPixels(def, opts)));
  return c;
}

// ---------- Terrain props ----------

export const TREE: SpriteDef = {
  mirror: false,
  palette: { L: "#7cc45a", l: "#4f9a40", D: "#2f6a32", t: "#6b4426" },
  pixels: [
    "......llll......",
    "....llLLllll....",
    "...lLLLLllllD...",
    "..lLLLLlllllDD..",
    ".llLLLlllllllDD.",
    ".lLLllllllllDDD.",
    "llLlllllllllDDDD",
    "lLLlllllllllDDDD",
    ".llllllllllDDDD.",
    ".lllllllllDDDDD.",
    "..llllllDDDDDD..",
    "...DDDllDDDDD...",
    ".....DDDDDD.....",
    ".......tt.......",
    ".......tt.......",
    "......tttt......",
  ],
};

export const ROCK: SpriteDef = {
  mirror: false,
  palette: { g: "#b4b2bf", G: "#86849a", x: "#5c5a72" },
  pixels: [
    "......gggg......",
    "....gggggGG.....",
    "...ggggGGGGx....",
    "..gggGGGGGxxx...",
    ".ggGGGGGGxxxxx..",
    ".gGGGGGGxxxxxx..",
    ".GGGGGGxxxxxxx..",
    "..xxxxxxxxxxx...",
  ],
};

export const BUSH: SpriteDef = {
  mirror: false,
  palette: { b: "#4fa04a", B: "#2f6e36", L: "#7fcf62", R: "#e8344e" },
  pixels: [
    ".....bbbb.......",
    "...bbLLbbbb.....",
    "..bLLbRbbbbbb...",
    ".bLLbbbbbRbbBb..",
    ".bbbRbbbbbbBBB..",
    "bbbbbbbRbbBBBBB.",
    ".BbbRbbbbBBRBB..",
    "..BBBBBBBBBBB...",
  ],
};
/** Berries eaten: paint the red pixels as leaves instead. */
export const BUSH_EMPTY = { R: "#3f8a42" };

export const PEBBLE: SpriteDef = {
  mirror: false,
  palette: { g: "#c8c6d4", G: "#8a889c" },
  pixels: [".gg.", "gGGG", ".GG."],
};

export const WORM_ICON: SpriteDef = {
  mirror: false,
  palette: { p: "#f08aa6" },
  pixels: ["p.p", ".p."],
};

// ---------- Tile textures ----------

/** Small deterministic hash so textures look random but never flicker. */
export function hash(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) {
    h ^= v + 0x9e3779b9;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return (h >>> 0) / 4294967296;
}

export interface TilePalette {
  top: string[]; // base, then speckle shades
  left: string;
  right: string;
}

export const TILE_PALETTES: Record<string, TilePalette> = {
  grass: { top: ["#5f9e4a", "#6cae52", "#548d42", "#79bb5c"], left: "#6b4a2e", right: "#4e3420" },
  dirt: { top: ["#8a6440", "#9a7250", "#7a5636", "#a8805a"], left: "#6b4a2e", right: "#4e3420" },
  pond: { top: ["#3d7fc4", "#4b90d4", "#346fb0", "#8fc8f0"], left: "#2a5a8a", right: "#1e456c" },
};
