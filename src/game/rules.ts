// Pure game rules. No networking, no DOM, no randomness: every function takes
// state in and returns new data out (never mutating its input). The host runs
// every action through applyAction; the UI uses the same functions to show
// highlights and attack previews.

import type {
  Action,
  ActionResult,
  AttackDef,
  BirdTypeDef,
  DirectionSet,
  FoodSpot,
  GameConfig,
  GameEvent,
  GameState,
  MovePattern,
  Pos,
  Seat,
  Side,
  TileType,
  Unit,
} from "./types";

const ORTHOGONAL: Array<[number, number]> = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N E S W
const DIAGONAL: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export function expandDirections(d: DirectionSet): Array<[number, number]> {
  if (d === "orthogonal") return ORTHOGONAL;
  if (d === "diagonal") return DIAGONAL;
  if (d === "all") return [...ORTHOGONAL, ...DIAGONAL];
  return d;
}

export const otherSide = (s: Side): Side => (s === "blue" ? "red" : "blue");
export const samePos = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y;
export const posKey = (p: Pos): string => `${p.x},${p.y}`;
const add = (p: Pos, [dx, dy]: [number, number], n = 1): Pos => ({ x: p.x + dx * n, y: p.y + dy * n });

export function getBirdType(config: GameConfig, typeId: string): BirdTypeDef | undefined {
  return config.birdTypes.find((b) => b.id === typeId);
}

/** Tiles nobody can stand on (fliers can still pass over them). */
export const BLOCKING: ReadonlySet<TileType> = new Set(["tree", "rock", "pond", "bush"]);
/** Tiles that stop projectiles (ponds don't: shots fly over water). */
const STOPS_SHOTS: ReadonlySet<TileType> = new Set(["tree", "rock", "bush"]);

export const TILE_NAMES: Record<TileType, string> = {
  grass: "Grass",
  tree: "Tree",
  rock: "Rock",
  pond: "Pond",
  bush: "Berry bush",
  dirt: "Worm patch",
};

// ---------- Setup ----------

export function parseMap(config: GameConfig): TileType[][] {
  const { width, height } = config.board;
  const tiles: TileType[][] = [];
  for (let y = 0; y < height; y++) {
    const chars = [...(config.map.rows[y] ?? "")];
    const row: TileType[] = [];
    for (let x = 0; x < width; x++) row.push(config.map.legend[chars[x] ?? "."] ?? "grass");
    tiles.push(row);
  }
  return tiles;
}

/**
 * Fresh game: each side gets its starting birds on its back row
 * (blue = bottom row, red = top row), centered. Those tiles are cleared to grass.
 */
export function createInitialState(config: GameConfig, seats: Record<Side, Seat | null> = { blue: null, red: null }): GameState {
  const tiles = parseMap(config);
  const { width, height } = config.board;
  const team = config.startingTeam;
  const startX = Math.floor((width - team.length) / 2);
  const units: Unit[] = [];
  const nameCount: Record<string, number> = {};
  for (const side of ["blue", "red"] as const) {
    const y = side === "blue" ? height - 1 : 0;
    team.forEach((typeId, i) => {
      // Red's team is mirrored so the two flocks face each other symmetrically.
      const x = side === "blue" ? startX + i : width - 1 - (startX + i);
      if (BLOCKING.has(tiles[y]![x]!)) tiles[y]![x] = "grass";
      const type = getBirdType(config, typeId)!;
      const n = (nameCount[typeId] = (nameCount[typeId] ?? -1) + 1);
      const nickname = type.nicknames[n % Math.max(1, type.nicknames.length)] ?? type.name;
      units.push({
        id: `${side}-${typeId}-${i}`,
        typeId,
        side,
        nickname,
        pos: { x, y },
        hp: type.stats.health,
        maxHp: type.stats.health,
        hasMoved: false,
        hasActed: false,
        fed: false,
      });
    });
  }
  const food: Record<string, FoodSpot> = {};
  tiles.forEach((row, y) =>
    row.forEach((t, x) => {
      if (t === "bush" || t === "dirt") food[posKey({ x, y })] = { ripe: true, regrowIn: 0 };
    }),
  );
  return {
    config,
    tiles,
    food,
    units,
    seats,
    activeSide: "blue",
    turnNumber: 1,
    winner: null,
    history: [],
    lastEvents: [],
    eventSeq: 0,
  };
}

// ---------- Board queries ----------

export const inBounds = (s: GameState, p: Pos): boolean =>
  p.x >= 0 && p.y >= 0 && p.x < s.config.board.width && p.y < s.config.board.height;
export const tileAt = (s: GameState, p: Pos): TileType | undefined => s.tiles[p.y]?.[p.x];
export const unitAt = (s: GameState, p: Pos): Unit | undefined => s.units.find((u) => samePos(u.pos, p));
const isFreeLanding = (s: GameState, p: Pos): boolean => inBounds(s, p) && !BLOCKING.has(tileAt(s, p)!) && !unitAt(s, p);

// ---------- Movement ----------

function movesForPattern(s: GameState, from: Pos, p: MovePattern): Pos[] {
  const out: Pos[] = [];
  if (p.kind === "leap") {
    for (const off of p.offsets) {
      const to = add(from, off);
      if (isFreeLanding(s, to)) out.push(to);
    }
  } else if (p.kind === "slide") {
    for (const dir of expandDirections(p.directions)) {
      for (let i = 1; i <= p.maxRange; i++) {
        const to = add(from, dir, i);
        if (!inBounds(s, to)) break;
        if (isFreeLanding(s, to)) out.push(to);
        else if (!p.canJumpOver) break;
      }
    }
  } else {
    // step: breadth-first search, so walkers route around obstacles.
    const dirs = expandDirections(p.directions);
    const seen = new Set([posKey(from)]);
    let frontier = [from];
    for (let step = 1; step <= p.maxSteps; step++) {
      const next: Pos[] = [];
      for (const cur of frontier) {
        for (const dir of dirs) {
          const to = add(cur, dir);
          if (!inBounds(s, to) || seen.has(posKey(to))) continue;
          seen.add(posKey(to));
          const free = isFreeLanding(s, to);
          if (free) out.push(to);
          if (free || p.canJumpOver) next.push(to);
        }
      }
      frontier = next;
    }
  }
  return out;
}

/** All tiles this bird could fly to (ignores whose turn it is). */
export function getValidMoves(state: GameState, unitId: string): Pos[] {
  const unit = state.units.find((u) => u.id === unitId);
  const type = unit && getBirdType(state.config, unit.typeId);
  if (!unit || !type) return [];
  const all = type.movement.flatMap((p) => movesForPattern(state, unit.pos, p));
  return all.filter((p, i) => all.findIndex((q) => samePos(p, q)) === i);
}

// ---------- Turn bookkeeping ----------

export function sideOf(state: GameState, playerId: string): Side | null {
  if (state.seats.blue?.playerId === playerId) return "blue";
  if (state.seats.red?.playerId === playerId) return "red";
  return null;
}

/** Ids of birds that moved or acted this turn. */
function usedThisTurn(state: GameState): Set<string> {
  return new Set(
    state.history.filter((h) => h.kind !== "endTurn" && h.turn === state.turnNumber).map((h) => (h as { unitId: string }).unitId),
  );
}

/** In "oneUnit" mode only one bird may do things each turn. */
function blockedByTurnMode(state: GameState, unit: Unit): boolean {
  if (state.config.turnMode !== "oneUnit") return false;
  const used = usedThisTurn(state);
  return used.size > 0 && !used.has(unit.id);
}

export function canMoveUnit(state: GameState, unit: Unit): boolean {
  return !state.winner && unit.side === state.activeSide && !unit.hasMoved && !unit.hasActed && !blockedByTurnMode(state, unit);
}

export function canActUnit(state: GameState, unit: Unit): boolean {
  return !state.winner && unit.side === state.activeSide && !unit.hasActed && !blockedByTurnMode(state, unit);
}

/** Moves made this turn (used to enable the Undo button). */
export function canUndo(state: GameState): boolean {
  const last = state.history[state.history.length - 1];
  return !!last && last.kind === "move" && last.turn === state.turnNumber && !state.winner;
}

// ---------- Attacks ----------

/** Tiles this bird can aim its attack at from where it stands. */
export function getAttackTargets(state: GameState, unitId: string): Pos[] {
  const unit = state.units.find((u) => u.id === unitId);
  const type = unit && getBirdType(state.config, unit.typeId);
  if (!unit || !type) return [];
  const a = type.attack;
  const out: Pos[] = [];
  if (a.targeting === "self") {
    // Only worth doing if someone is next to us.
    if (ORTHOGONAL.some((d) => unitAt(state, add(unit.pos, d)))) out.push(unit.pos);
    return out;
  }
  for (const dir of ORTHOGONAL) {
    if (a.targeting === "adjacent") {
      const p = add(unit.pos, dir);
      if (unitAt(state, p)) out.push(p);
    } else if (a.targeting === "projectile") {
      for (let i = 1; i <= (a.maxRange ?? 8); i++) {
        const p = add(unit.pos, dir, i);
        if (!inBounds(state, p) || STOPS_SHOTS.has(tileAt(state, p)!)) break;
        if (unitAt(state, p)) {
          out.push(p);
          break;
        }
      }
    } else {
      for (let i = a.minRange ?? 2; i <= (a.maxRange ?? 8); i++) {
        const p = add(unit.pos, dir, i);
        if (inBounds(state, p)) out.push(p);
      }
    }
  }
  return out;
}

/** Unit direction from a to b (b must be in a straight line from a). */
function dirTo(a: Pos, b: Pos): [number, number] {
  return [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];
}

/**
 * Mutable scratch copy of the parts of state that combat changes. Resolving
 * an attack mutates this copy only; callers get fresh objects back.
 */
interface Scratch {
  units: Unit[];
  events: GameEvent[];
  notes: string[];
}

function damage(s: GameState, w: Scratch, unit: Unit, amount: number): void {
  if (amount <= 0) return;
  unit.hp -= amount;
  w.events.push({ kind: "damage", unitId: unit.id, pos: { ...unit.pos }, amount });
  w.notes.push(`${unit.nickname} -${amount}`);
  if (unit.hp <= 0) {
    unit.hp = 0;
    w.units = w.units.filter((u) => u.id !== unit.id);
    w.events.push({ kind: "faint", unit: { ...unit } });
    w.notes.push(`${unit.nickname} fainted!`);
  }
}

/** Shove a bird one tile. Hitting something hurts (bump damage) and it stays put. */
function push(s: GameState, w: Scratch, unit: Unit, dir: [number, number]): void {
  if (!w.units.includes(unit)) return; // already fainted
  const to = add(unit.pos, dir);
  if (!inBounds(s, to)) return; // the edge of the world: just teeters, nothing happens
  const other = w.units.find((u) => samePos(u.pos, to));
  const tile = tileAt(s, to)!;
  const bump = s.config.bumpDamage;
  if (other) {
    w.events.push({ kind: "bump", unitId: unit.id, pos: { ...unit.pos }, into: to, what: other.nickname });
    damage(s, w, unit, bump);
    damage(s, w, other, bump);
  } else if (BLOCKING.has(tile)) {
    w.events.push({ kind: "bump", unitId: unit.id, pos: { ...unit.pos }, into: to, what: tile });
    damage(s, w, unit, bump);
  } else {
    w.events.push({ kind: "push", unitId: unit.id, from: { ...unit.pos }, to });
    unit.pos = to;
  }
}

/** Resolve an attack on a scratch copy. Shared by applyAction and previewAttack. */
function resolveAttack(state: GameState, attacker: Unit, a: AttackDef, target: Pos): Scratch {
  const w: Scratch = { units: state.units.map((u) => ({ ...u, pos: { ...u.pos } })), events: [], notes: [] };
  const me = w.units.find((u) => u.id === attacker.id)!;
  const bonus = me.fed ? state.config.forage.wormDamageBonus : 0;
  me.fed = false;
  me.hasActed = true;
  me.hasMoved = true;

  w.events.push({ kind: "shout", unitId: me.id, pos: { ...me.pos }, text: a.shout });
  w.events.push({ kind: "strike", unitId: me.id, style: a.style, from: { ...me.pos }, to: target });

  const center = a.targeting === "self" ? me.pos : target;
  if (a.targeting !== "self") {
    const victim = w.units.find((u) => samePos(u.pos, target));
    if (victim) {
      damage(state, w, victim, a.damage + bonus);
      if (a.push) push(state, w, victim, dirTo(me.pos, target));
    }
  }
  // Splash hits the 4 tiles around the center, in N/E/S/W order, friend or foe.
  if (a.splashDamage > 0 || a.splashPush) {
    for (const dir of ORTHOGONAL) {
      const p = add(center, dir);
      const victim = w.units.find((u) => samePos(u.pos, p) && u.id !== me.id);
      if (!victim) continue;
      damage(state, w, victim, a.splashDamage + (a.targeting === "self" ? bonus : 0));
      if (a.splashPush) push(state, w, victim, dir);
    }
  }
  return w;
}

/** What would happen if this bird attacked here? (For hover previews; changes nothing.) */
export function previewAttack(state: GameState, unitId: string, target: Pos): GameEvent[] {
  const unit = state.units.find((u) => u.id === unitId);
  const type = unit && getBirdType(state.config, unit.typeId);
  if (!unit || !type) return [];
  return resolveAttack(state, unit, type.attack, target).events;
}

// ---------- Foraging ----------

export interface ForageOption {
  food: "berries" | "worms";
  at: Pos;
  heal: number;
}

/** Can this bird forage right now, and what would it get? */
export function getForageOption(state: GameState, unit: Unit): ForageOption | null {
  const type = getBirdType(state.config, unit.typeId);
  const bonus = type?.stats.forageBonus ?? 0;
  const f = state.config.forage;
  // Standing on a worm patch: dig! (Worms also power up your next attack, so allowed at full HP.)
  const here = state.food[posKey(unit.pos)];
  if (tileAt(state, unit.pos) === "dirt" && here?.ripe) {
    return { food: "worms", at: unit.pos, heal: Math.min(f.wormHeal + bonus, unit.maxHp - unit.hp) };
  }
  // Next to a ripe berry bush: peck berries (pointless at full health).
  if (unit.hp >= unit.maxHp) return null;
  for (const dir of ORTHOGONAL) {
    const p = add(unit.pos, dir);
    if (tileAt(state, p) === "bush" && state.food[posKey(p)]?.ripe) {
      return { food: "berries", at: p, heal: Math.min(f.berryHeal + bonus, unit.maxHp - unit.hp) };
    }
  }
  return null;
}

// ---------- Actions ----------

function checkWinner(units: Unit[]): GameState["winner"] {
  const blue = units.some((u) => u.side === "blue");
  const red = units.some((u) => u.side === "red");
  if (blue && red) return null;
  if (!blue && !red) return "draw";
  return blue ? "blue" : "red";
}

/**
 * Validate and apply one action for one player. Returns the new state, or an
 * error explaining why it was rejected.
 */
export function applyAction(state: GameState, playerId: string, action: Action): ActionResult {
  const side = sideOf(state, playerId);
  if (!side) return { ok: false, error: "You are not seated in this game" };
  if (state.winner) return { ok: false, error: "The game is over" };
  if (side !== state.activeSide) return { ok: false, error: "It's not your turn" };
  const turn = state.turnNumber;
  const seq = state.eventSeq + 1;

  const findMine = (unitId: string): Unit | string => {
    const u = state.units.find((x) => x.id === unitId);
    if (!u) return "No such bird";
    if (u.side !== side) return "That's not your bird";
    return u;
  };

  switch (action.type) {
    case "move": {
      const unit = findMine(action.unitId);
      if (typeof unit === "string") return { ok: false, error: unit };
      if (!canMoveUnit(state, unit)) return { ok: false, error: unit.hasActed || unit.hasMoved ? "That bird already moved" : "Only one bird per turn in this mode" };
      if (!getValidMoves(state, unit.id).some((p) => samePos(p, action.to))) return { ok: false, error: "That bird can't fly there" };
      const to = { x: action.to.x, y: action.to.y };
      return {
        ok: true,
        state: {
          ...state,
          units: state.units.map((u) => (u.id === unit.id ? { ...u, pos: to, hasMoved: true } : u)),
          history: [...state.history, { kind: "move", turn, side, unitId: unit.id, from: unit.pos, to }],
          lastEvents: [{ kind: "move", unitId: unit.id, from: unit.pos, to }],
          eventSeq: seq,
        },
      };
    }

    case "attack": {
      const unit = findMine(action.unitId);
      if (typeof unit === "string") return { ok: false, error: unit };
      if (!canActUnit(state, unit)) return { ok: false, error: "That bird already acted" };
      if (!getAttackTargets(state, unit.id).some((p) => samePos(p, action.target))) return { ok: false, error: "Can't attack there" };
      const type = getBirdType(state.config, unit.typeId)!;
      const w = resolveAttack(state, unit, type.attack, action.target);
      const text = `${unit.nickname}: ${type.attack.name}!` + (w.notes.length ? ` ${w.notes.join(", ")}` : " (missed)");
      return {
        ok: true,
        state: {
          ...state,
          units: w.units,
          winner: checkWinner(w.units),
          history: [...state.history, { kind: "attack", turn, side, unitId: unit.id, target: action.target, text }],
          lastEvents: w.events,
          eventSeq: seq,
        },
      };
    }

    case "forage": {
      const unit = findMine(action.unitId);
      if (typeof unit === "string") return { ok: false, error: unit };
      if (!canActUnit(state, unit)) return { ok: false, error: "That bird already acted" };
      const opt = getForageOption(state, unit);
      if (!opt) return { ok: false, error: "Nothing to eat here (stand on a worm patch, or next to ripe berries when hurt)" };
      const f = state.config.forage;
      const regrowIn = opt.food === "berries" ? f.berryRegrowTurns : f.wormRegrowTurns;
      const text =
        opt.food === "berries"
          ? `${unit.nickname} gobbled berries (+${opt.heal} HP)`
          : `${unit.nickname} slurped worms (${opt.heal > 0 ? `+${opt.heal} HP, ` : ""}next attack +${f.wormDamageBonus})`;
      return {
        ok: true,
        state: {
          ...state,
          units: state.units.map((u) =>
            u.id === unit.id ? { ...u, hp: u.hp + opt.heal, hasActed: true, hasMoved: true, fed: u.fed || opt.food === "worms" } : u,
          ),
          food: { ...state.food, [posKey(opt.at)]: { ripe: false, regrowIn } },
          history: [...state.history, { kind: "forage", turn, side, unitId: unit.id, text }],
          lastEvents: [
            { kind: "shout", unitId: unit.id, pos: unit.pos, text: opt.food === "berries" ? "nom nom" : "slurp!" },
            { kind: "heal", unitId: unit.id, pos: unit.pos, amount: opt.heal, food: opt.food },
          ],
          eventSeq: seq,
        },
      };
    }

    case "undo": {
      // Only moves can be undone. Attacks and snacks are final (like Into the Breach).
      if (!canUndo(state)) return { ok: false, error: "Nothing to undo (attacks can't be undone)" };
      const last = state.history[state.history.length - 1] as Extract<GameState["history"][number], { kind: "move" }>;
      return {
        ok: true,
        state: {
          ...state,
          units: state.units.map((u) => (u.id === last.unitId ? { ...u, pos: last.from, hasMoved: false } : u)),
          history: state.history.slice(0, -1),
          lastEvents: [{ kind: "move", unitId: last.unitId, from: last.to, to: last.from }],
          eventSeq: seq,
        },
      };
    }

    case "endTurn": {
      // Food grows back a little every turn.
      const food: Record<string, FoodSpot> = {};
      const events: GameEvent[] = [];
      for (const [key, spot] of Object.entries(state.food)) {
        if (spot.ripe) food[key] = spot;
        else if (spot.regrowIn <= 1) {
          food[key] = { ripe: true, regrowIn: 0 };
          const [x, y] = key.split(",").map(Number);
          events.push({ kind: "regrow", pos: { x: x!, y: y! } });
        } else food[key] = { ripe: false, regrowIn: spot.regrowIn - 1 };
      }
      return {
        ok: true,
        state: {
          ...state,
          food,
          units: state.units.map((u) => ({ ...u, hasMoved: false, hasActed: false })),
          activeSide: otherSide(side),
          turnNumber: turn + 1,
          history: [...state.history, { kind: "endTurn", turn, side }],
          lastEvents: events,
          eventSeq: seq,
        },
      };
    }
  }
}
