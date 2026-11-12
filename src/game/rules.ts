// Pure game rules. No networking, no DOM, no randomness, no mutation:
// every function takes state in and returns new data out. This is the part
// combat, push effects, etc. will grow from, and it's covered by unit tests.

import type {
  Action,
  ActionResult,
  BirdTypeDef,
  DirectionSet,
  GameConfig,
  GameState,
  MovePattern,
  Pos,
  Seat,
  Side,
  TileType,
  Unit,
} from "./types";

const ORTHOGONAL: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export function expandDirections(d: DirectionSet): Array<[number, number]> {
  if (d === "orthogonal") return ORTHOGONAL;
  if (d === "diagonal") return DIAGONAL;
  if (d === "all") return [...ORTHOGONAL, ...DIAGONAL];
  return d;
}

export const otherSide = (s: Side): Side => (s === "blue" ? "red" : "blue");
export const samePos = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y;

export function getBirdType(config: GameConfig, typeId: string): BirdTypeDef | undefined {
  return config.birdTypes.find((b) => b.id === typeId);
}

// ---------- Setup ----------

/** Parse the map's text rows into tile types. */
export function parseMap(config: GameConfig): TileType[][] {
  const { width, height } = config.board;
  const tiles: TileType[][] = [];
  for (let y = 0; y < height; y++) {
    const chars = [...(config.map.rows[y] ?? "")];
    const row: TileType[] = [];
    for (let x = 0; x < width; x++) row.push(config.map.legend[chars[x] ?? "."] ?? "open");
    tiles.push(row);
  }
  return tiles;
}

/**
 * Fresh game: each side gets one of each starting bird on its back row
 * (blue = bottom, red = top), centered. Back-row tiles are forced open.
 */
export function createInitialState(config: GameConfig, seats: Record<Side, Seat | null> = { blue: null, red: null }): GameState {
  const tiles = parseMap(config);
  const { width, height } = config.board;
  const team = config.startingTeam;
  const startX = Math.floor((width - team.length) / 2);
  const units: Unit[] = [];
  for (const side of ["blue", "red"] as const) {
    const y = side === "blue" ? height - 1 : 0;
    team.forEach((typeId, i) => {
      const x = startX + i;
      tiles[y]![x] = "open";
      units.push({ id: `${side}-${typeId}-${i}`, typeId, side, pos: { x, y }, hasMoved: false });
    });
  }
  return { config, tiles, units, seats, activeSide: "blue", turnNumber: 1, history: [] };
}

// ---------- Movement ----------

const inBounds = (s: GameState, p: Pos): boolean =>
  p.x >= 0 && p.y >= 0 && p.x < s.config.board.width && p.y < s.config.board.height;
const unitAt = (s: GameState, p: Pos): Unit | undefined => s.units.find((u) => samePos(u.pos, p));
/** Can a bird end its move here? (on the board, not a tree, not occupied) */
const isFreeLanding = (s: GameState, p: Pos): boolean =>
  inBounds(s, p) && s.tiles[p.y]?.[p.x] !== "tree" && !unitAt(s, p);

function movesForPattern(s: GameState, from: Pos, p: MovePattern): Pos[] {
  const out: Pos[] = [];
  if (p.kind === "leap") {
    for (const [dx, dy] of p.offsets) {
      const to = { x: from.x + dx, y: from.y + dy };
      // A leap never touches the tiles in between, so canJumpOver doesn't matter here.
      if (isFreeLanding(s, to)) out.push(to);
    }
  } else if (p.kind === "slide") {
    for (const [dx, dy] of expandDirections(p.directions)) {
      for (let i = 1; i <= p.maxRange; i++) {
        const to = { x: from.x + dx * i, y: from.y + dy * i };
        if (!inBounds(s, to)) break;
        if (isFreeLanding(s, to)) out.push(to);
        else if (!p.canJumpOver) break; // blocked: can't go further this way
      }
    }
  } else {
    // step: breadth-first search, so a bird can route around obstacles.
    const dirs = expandDirections(p.directions);
    const key = (q: Pos) => `${q.x},${q.y}`;
    const seen = new Set([key(from)]);
    let frontier = [from];
    for (let step = 1; step <= p.maxSteps; step++) {
      const next: Pos[] = [];
      for (const cur of frontier) {
        for (const [dx, dy] of dirs) {
          const to = { x: cur.x + dx, y: cur.y + dy };
          if (!inBounds(s, to) || seen.has(key(to))) continue;
          seen.add(key(to));
          const free = isFreeLanding(s, to);
          if (free) out.push(to);
          if (free || p.canJumpOver) next.push(to); // can only pass through blocked tiles if flying over
        }
      }
      frontier = next;
    }
  }
  return out;
}

/** All tiles this bird may move to right now (ignores whose turn it is). */
export function getValidMoves(state: GameState, unitId: string): Pos[] {
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return [];
  const type = getBirdType(state.config, unit.typeId);
  if (!type) return [];
  const all = type.movement.flatMap((p) => movesForPattern(state, unit.pos, p));
  // Remove duplicates when patterns overlap.
  return all.filter((p, i) => all.findIndex((q) => samePos(p, q)) === i);
}

// ---------- Actions ----------

export function sideOf(state: GameState, playerId: string): Side | null {
  if (state.seats.blue?.playerId === playerId) return "blue";
  if (state.seats.red?.playerId === playerId) return "red";
  return null;
}

/** Moves made by the active side during the current turn. */
export function movesThisTurn(state: GameState) {
  return state.history.filter((h) => h.kind === "move" && h.turn === state.turnNumber);
}

export function canMoveUnit(state: GameState, unit: Unit): boolean {
  if (unit.side !== state.activeSide || unit.hasMoved) return false;
  if (state.config.turnMode === "oneUnit" && movesThisTurn(state).length > 0) return false;
  return true;
}

/**
 * Validate and apply one action for one player. Returns the new state, or an
 * error explaining why it was rejected. The host runs every action (its own
 * included) through here.
 */
export function applyAction(state: GameState, playerId: string, action: Action): ActionResult {
  const side = sideOf(state, playerId);
  if (!side) return { ok: false, error: "You are not seated in this game" };
  if (side !== state.activeSide) return { ok: false, error: "It's not your turn" };

  switch (action.type) {
    case "move": {
      const unit = state.units.find((u) => u.id === action.unitId);
      if (!unit) return { ok: false, error: "No such bird" };
      if (unit.side !== side) return { ok: false, error: "That's not your bird" };
      if (unit.hasMoved) return { ok: false, error: "That bird already moved this turn" };
      if (!canMoveUnit(state, unit)) return { ok: false, error: "Only one move per turn in this mode" };
      if (!getValidMoves(state, unit.id).some((p) => samePos(p, action.to))) {
        return { ok: false, error: "That bird can't move there" };
      }
      const to = { x: action.to.x, y: action.to.y };
      return {
        ok: true,
        state: {
          ...state,
          units: state.units.map((u) => (u.id === unit.id ? { ...u, pos: to, hasMoved: true } : u)),
          history: [...state.history, { kind: "move", turn: state.turnNumber, side, unitId: unit.id, from: unit.pos, to }],
        },
      };
    }
    case "undo": {
      const last = state.history[state.history.length - 1];
      if (!last || last.kind !== "move" || last.turn !== state.turnNumber) {
        return { ok: false, error: "Nothing to undo this turn" };
      }
      return {
        ok: true,
        state: {
          ...state,
          units: state.units.map((u) => (u.id === last.unitId ? { ...u, pos: last.from, hasMoved: false } : u)),
          history: state.history.slice(0, -1),
        },
      };
    }
    case "endTurn": {
      return {
        ok: true,
        state: {
          ...state,
          units: state.units.map((u) => ({ ...u, hasMoved: false })),
          activeSide: otherSide(side),
          turnNumber: state.turnNumber + 1,
          history: [...state.history, { kind: "endTurn", turn: state.turnNumber, side }],
        },
      };
    }
  }
}
