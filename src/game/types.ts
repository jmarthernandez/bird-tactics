// Shared game types. Everything here is plain data (JSON-serializable) so it
// can be saved to disk and sent over the network unchanged.

// ---------- Config (loaded from data files, editable by the host) ----------

/** Named direction sets, or an explicit list of [dx, dy] unit vectors. */
export type DirectionSet = "orthogonal" | "diagonal" | "all" | Array<[number, number]>;

/**
 * A movement pattern. A bird may have several; its legal moves are the union.
 *  - step:  walk up to maxSteps single-tile steps. Routes around obstacles,
 *           unless canJumpOver (flying high over trees, rocks and birds).
 *  - slide: straight lines up to maxRange (stops at obstacles unless canJumpOver).
 *  - leap:  jump straight to fixed offsets.
 */
export type MovePattern =
  | { kind: "step"; directions: DirectionSet; maxSteps: number; canJumpOver: boolean }
  | { kind: "slide"; directions: DirectionSet; maxRange: number; canJumpOver: boolean }
  | { kind: "leap"; offsets: Array<[number, number]>; canJumpOver: boolean };

/**
 * How an attack picks its target. All attacks aim in the 4 straight directions.
 *  - adjacent:   a bird right next to you
 *  - projectile: flies in a line and hits the first bird in the way (up to maxRange)
 *  - artillery:  lobbed over everything onto any tile minRange..maxRange away
 *  - self:       centered on the attacker (hits the 4 tiles around it)
 */
export type Targeting = "adjacent" | "projectile" | "artillery" | "self";

/** Visual style of the strike animation. */
export type StrikeStyle = "peck" | "dive" | "screech" | "lob";

export interface AttackDef {
  name: string;
  description: string;
  /** What the bird yells when it attacks. */
  shout: string;
  style: StrikeStyle;
  targeting: Targeting;
  minRange?: number;
  maxRange?: number;
  /** Damage to the bird on the target tile (not used by "self"). */
  damage: number;
  /** Push the target bird one tile away from the attacker. */
  push: boolean;
  /** Damage to birds on the 4 tiles around the target (or around the attacker for "self"). */
  splashDamage: number;
  /** Push those surrounding birds one tile outward. */
  splashPush: boolean;
}

/** Pixel art: each character in `pixels` is a palette key; "." is transparent. */
export interface SpriteDef {
  palette: Record<string, string>;
  pixels: string[];
  /** Mirror the art for birds facing left. Off for front-facing birds like owls. */
  mirror: boolean;
}

export interface BirdStats {
  health: number;
  /** Extra HP this bird gets from any food. */
  forageBonus: number;
}

export interface BirdTypeDef {
  id: string;
  name: string;
  description: string;
  movement: MovePattern[];
  attack: AttackDef;
  stats: BirdStats;
  /** Silly names given to birds of this type, in order. */
  nicknames: string[];
  sprite: SpriteDef;
  abilities: string[]; // unused for now (future passives / skill tree hooks)
}

export type TileType = "grass" | "tree" | "rock" | "pond" | "bush" | "dirt";

export interface MapDef {
  name: string;
  /** Character -> tile type, e.g. { ".": "grass", "T": "tree" }. */
  legend: Record<string, TileType>;
  /** One string per row, top to bottom. */
  rows: string[];
}

export type TurnMode = "allUnits" | "oneUnit";

export interface ForageConfig {
  /** HP from pecking a ripe berry bush next to you. */
  berryHeal: number;
  /** HP from digging worms out of the dirt patch you stand on. */
  wormHeal: number;
  /** Worms also make your next attack hit this much harder. */
  wormDamageBonus: number;
  /** Turns until food grows back (each player's turn counts as one). */
  berryRegrowTurns: number;
  wormRegrowTurns: number;
}

export interface GameConfig {
  board: { width: number; height: number };
  turnMode: TurnMode;
  /** Bird type ids each player starts with, placed left-to-right on the back row. */
  startingTeam: string[];
  /** Damage when a bird is shoved into a tree, rock, bush, pond or another bird. */
  bumpDamage: number;
  forage: ForageConfig;
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
  nickname: string;
  pos: Pos;
  hp: number;
  maxHp: number;
  hasMoved: boolean;
  hasActed: boolean;
  /** Ate worms: next attack does extra damage. */
  fed: boolean;
}

export interface Seat {
  playerId: string;
  name: string;
}

/** Food on a bush or dirt tile. Key is "x,y". */
export interface FoodSpot {
  ripe: boolean;
  /** Turns until ripe again (when not ripe). */
  regrowIn: number;
}

/** Things that happened during one action, in order. Used for animation and the log. */
export type GameEvent =
  | { kind: "move"; unitId: string; from: Pos; to: Pos }
  | { kind: "shout"; unitId: string; pos: Pos; text: string }
  | { kind: "strike"; unitId: string; style: StrikeStyle; from: Pos; to: Pos }
  | { kind: "damage"; unitId: string; pos: Pos; amount: number }
  | { kind: "push"; unitId: string; from: Pos; to: Pos }
  | { kind: "bump"; unitId: string; pos: Pos; into: Pos; what: string }
  | { kind: "faint"; unit: Unit }
  | { kind: "heal"; unitId: string; pos: Pos; amount: number; food: "berries" | "worms" }
  | { kind: "regrow"; pos: Pos };

export type HistoryEntry =
  | { kind: "move"; turn: number; side: Side; unitId: string; from: Pos; to: Pos }
  | { kind: "attack"; turn: number; side: Side; unitId: string; target: Pos; text: string }
  | { kind: "forage"; turn: number; side: Side; unitId: string; text: string }
  | { kind: "endTurn"; turn: number; side: Side };

export interface GameState {
  config: GameConfig;
  /** tiles[y][x] */
  tiles: TileType[][];
  food: Record<string, FoodSpot>;
  units: Unit[];
  /** Who sits on each side. null = empty seat. */
  seats: Record<Side, Seat | null>;
  activeSide: Side;
  turnNumber: number;
  winner: Side | "draw" | null;
  history: HistoryEntry[];
  /** What the last action did, for animations. eventSeq goes up by one per action. */
  lastEvents: GameEvent[];
  eventSeq: number;
}

// ---------- Actions (what players ask the host to do) ----------

export type Action =
  | { type: "move"; unitId: string; to: Pos }
  | { type: "attack"; unitId: string; target: Pos }
  | { type: "forage"; unitId: string }
  | { type: "undo" }
  | { type: "endTurn" };

export type ActionResult = { ok: true; state: GameState } | { ok: false; error: string };
