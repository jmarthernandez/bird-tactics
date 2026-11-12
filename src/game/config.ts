// Builds the default config from the JSON data files, and validates custom
// configs the host loads with "Load Config".

import birds from "../data/birds.json";
import map from "../data/map.json";
import settings from "../data/settings.json";
import type { GameConfig, MovePattern } from "./types";

export const DEFAULT_CONFIG: GameConfig = {
  board: settings.board,
  turnMode: settings.turnMode as GameConfig["turnMode"],
  startingTeam: settings.startingTeam,
  birdTypes: birds as GameConfig["birdTypes"],
  map: map as GameConfig["map"],
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 0, max = 1000): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isVec = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isInt(v[0], -50, 50) && isInt(v[1], -50, 50);

function checkDirections(d: unknown): boolean {
  return d === "orthogonal" || d === "diagonal" || d === "all" || (Array.isArray(d) && d.every(isVec));
}

function checkPattern(p: unknown, where: string, errors: string[]): void {
  if (!isObj(p)) return void errors.push(`${where}: must be an object`);
  if (typeof p.canJumpOver !== "boolean") errors.push(`${where}.canJumpOver must be true/false`);
  const kind = p.kind as MovePattern["kind"];
  if (kind === "step") {
    if (!checkDirections(p.directions)) errors.push(`${where}.directions invalid`);
    if (!isInt(p.maxSteps, 1, 50)) errors.push(`${where}.maxSteps must be 1-50`);
  } else if (kind === "slide") {
    if (!checkDirections(p.directions)) errors.push(`${where}.directions invalid`);
    if (!isInt(p.maxRange, 1, 50)) errors.push(`${where}.maxRange must be 1-50`);
  } else if (kind === "leap") {
    if (!Array.isArray(p.offsets) || !p.offsets.every(isVec)) errors.push(`${where}.offsets must be [[dx,dy],...]`);
  } else {
    errors.push(`${where}.kind must be "step", "slide" or "leap"`);
  }
}

/** Returns a list of human-readable problems. Empty list = config is valid. */
export function validateConfig(c: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(c)) return ["Config must be a JSON object"];

  const board = c.board;
  if (!isObj(board) || !isInt(board.width, 3, 20) || !isInt(board.height, 3, 20)) {
    errors.push("board.width and board.height must be whole numbers from 3 to 20");
  }
  if (c.turnMode !== "allUnits" && c.turnMode !== "oneUnit") {
    errors.push('turnMode must be "allUnits" or "oneUnit"');
  }

  const typeIds = new Set<string>();
  if (!Array.isArray(c.birdTypes) || c.birdTypes.length === 0) {
    errors.push("birdTypes must be a non-empty list");
  } else {
    c.birdTypes.forEach((b: unknown, i) => {
      const where = `birdTypes[${i}]`;
      if (!isObj(b)) return void errors.push(`${where} must be an object`);
      for (const key of ["id", "name", "icon", "description"]) {
        if (typeof b[key] !== "string" || (b[key] as string).length === 0) errors.push(`${where}.${key} must be text`);
      }
      if (typeof b.id === "string") typeIds.add(b.id);
      if (!Array.isArray(b.movement) || b.movement.length === 0) errors.push(`${where}.movement must be a non-empty list`);
      else b.movement.forEach((p: unknown, j) => checkPattern(p, `${where}.movement[${j}]`, errors));
      if (!isObj(b.stats)) errors.push(`${where}.stats must be an object`);
      if (!Array.isArray(b.abilities)) errors.push(`${where}.abilities must be a list`);
    });
  }

  if (!Array.isArray(c.startingTeam) || c.startingTeam.length === 0) {
    errors.push("startingTeam must be a non-empty list of bird type ids");
  } else {
    for (const id of c.startingTeam) if (!typeIds.has(id as string)) errors.push(`startingTeam: unknown bird type "${String(id)}"`);
    if (isObj(board) && isInt(board.width) && c.startingTeam.length > board.width) {
      errors.push("startingTeam has more birds than the board is wide");
    }
  }

  const m = c.map;
  if (!isObj(m) || !isObj(m.legend) || !Array.isArray(m.rows)) {
    errors.push("map needs legend and rows");
  } else if (isObj(board)) {
    if (m.rows.length !== board.height) errors.push(`map.rows must have ${String(board.height)} rows`);
    m.rows.forEach((row: unknown, y) => {
      if (typeof row !== "string" || [...row].length !== board.width) {
        errors.push(`map.rows[${y}] must be ${String(board.width)} characters`);
        return;
      }
      for (const ch of row) {
        const t = (m.legend as Record<string, unknown>)[ch];
        if (t !== "open" && t !== "tree") errors.push(`map.rows[${y}]: character "${ch}" not in legend (open/tree)`);
      }
    });
  }
  return errors;
}
