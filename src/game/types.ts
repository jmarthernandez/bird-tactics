// Shared game types. Everything here is plain data (JSON-serializable) so it
// can be saved to disk and sent over the network unchanged.

// ---------- Config (loaded from data files, editable by the host) ----------

/** Named direction sets, or an explicit list of [dx, dy] unit vectors. */
export type DirectionSet = "orthogonal" | "diagonal" | "all" | Array<[number, number]>;

/**
 * A movement pattern. A bird may have several; its legal moves are the union.
 *  - step:  walk up to maxSteps single-tile steps (like a king, repeated).
 *           Finds paths around obstacles unless canJumpOver is true.
 *  - slide: travel in a straight line along each direction, up to maxRange
 *           (like a rook/bishop). Stops at the first obstacle unless canJumpOver.
 *  - leap:  jump straight to each fixed offset (like a knight).
 */
export type MovePattern =
  | { kind: "step"; directions: DirectionSet; maxSteps: number; canJumpOver: boolean }
  | { kind: "slide"; directions: DirectionSet; maxRange: number; canJumpOver: boolean }
  | { kind: "leap"; offsets: Array<[number, number]>; canJumpOver: boolean };

/** Future-facing stats. Not used by any rule yet. */
export interface BirdStats {
  health: number;
  attack: number;
}

export interface BirdTypeDef {
  id: string;
  name: string;
  /** Emoji or short text drawn on the board. */
  icon: string;
  /** Human-readable movement description for the side panel. */
  description: string;
  movement: MovePattern[];
  stats: BirdStats; // unused for now (combat comes later)
  abilities: string[]; // unused for now (ability ids, e.g. "push")
}

export type TileType = "open" | "tree";

export interface MapDef {
  name: string;
  /** Character -> tile type, e.g. { ".": "open", "T": "tree" }. */
  legend: Record<string, TileType>;
  /** One string per row, top to bottom. */
  rows: string[];
}

export type TurnMode = "allUnits" | "oneUnit";

export interface GameConfig {
  board: { width: number; height: number };
  turnMode: TurnMode;
  /** Bird type ids each player starts with, placed left-to-right on the back row. */
  startingTeam: string[];
  birdTypes: BirdTypeDef[];
  map: MapDef;
}

// ---------- Game state (owned by the host) ----------

export type Side = "blue" | "red";
export const SIDES: readonly Side[] = ["blue", "red"];

export interface Pos {
  x: number;
  y: number;
}

export interface Unit {
  id: string;
  typeId: string;
  side: Side;
  pos: Pos;
  /** Has this unit already moved this turn? Reset on End Turn. */
  hasMoved: boolean;
  // Future: hp, status effects, cooldowns...
}

export interface Seat {
  playerId: string;
  name: string;
}

export type HistoryEntry =
  | { kind: "move"; turn: number; side: Side; unitId: string; from: Pos; to: Pos }
  | { kind: "endTurn"; turn: number; side: Side };

export interface GameState {
  config: GameConfig;
  /** tiles[y][x] */
  tiles: TileType[][];
  units: Unit[];
  /** Who sits on each side. null = empty seat. */
  seats: Record<Side, Seat | null>;
  activeSide: Side;
  turnNumber: number;
  /** Every move and turn end, oldest first. Undo pops moves from the current turn. */
  history: HistoryEntry[];
}

// ---------- Actions (what players ask the host to do) ----------

export type Action =
  | { type: "move"; unitId: string; to: Pos }
  | { type: "undo" }
  | { type: "endTurn" };

export type ActionResult = { ok: true; state: GameState } | { ok: false; error: string };
