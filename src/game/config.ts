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
  bumpDamage: settings.bumpDamage,
  forage: settings.forage,
  birdTypes: birds as unknown as GameConfig["birdTypes"],
  map: map as GameConfig["map"],
};

const TILE_TYPES = ["grass", "tree", "rock", "pond", "bush", "dirt"];
const TARGETING = ["adjacent", "projectile", "artillery", "self"];
const STYLES = ["peck", "dive", "screech", "lob"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 0, max = 1000): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isVec = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isInt(v[0], -50, 50) && isInt(v[1], -50, 50);
const isText = (v: unknown) => typeof v === "string" && v.length > 0;

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

function checkAttack(a: unknown, where: string, errors: string[]): void {
  if (!isObj(a)) return void errors.push(`${where} must be an object`);
  for (const k of ["name", "description", "shout"]) if (!isText(a[k])) errors.push(`${where}.${k} must be text`);
  if (!TARGETING.includes(a.targeting as string)) errors.push(`${where}.targeting must be one of ${TARGETING.join(", ")}`);
  if (!STYLES.includes(a.style as string)) errors.push(`${where}.style must be one of ${STYLES.join(", ")}`);
  for (const k of ["damage", "splashDamage"]) if (!isInt(a[k], 0, 20)) errors.push(`${where}.${k} must be 0-20`);
  for (const k of ["push", "splashPush"]) if (typeof a[k] !== "boolean") errors.push(`${where}.${k} must be true/false`);
  for (const k of ["minRange", "maxRange"]) if (a[k] !== undefined && !isInt(a[k], 1, 50)) errors.push(`${where}.${k} must be 1-50`);
}

function checkSprite(s: unknown, where: string, errors: string[]): void {
  if (!isObj(s) || !isObj(s.palette) || !Array.isArray(s.pixels)) return void errors.push(`${where} needs palette and pixels`);
  if (typeof s.mirror !== "boolean") errors.push(`${where}.mirror must be true/false`);
  if (s.pixels.length === 0 || s.pixels.length > 32) errors.push(`${where}.pixels must have 1-32 rows`);
  s.pixels.forEach((row: unknown, i) => {
    if (typeof row !== "string" || row.length > 32) return void errors.push(`${where}.pixels[${i}] must be text up to 32 characters`);
    for (const ch of row) if (ch !== "." && !(ch in (s.palette as object))) errors.push(`${where}.pixels[${i}]: "${ch}" isn't in the palette`);
  });
}

/** Returns a list of human-readable problems. Empty list = config is valid. */
export function validateConfig(c: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(c)) return ["Config must be a JSON object"];

  const board = c.board;
  if (!isObj(board) || !isInt(board.width, 3, 16) || !isInt(board.height, 3, 16)) {
    errors.push("board.width and board.height must be whole numbers from 3 to 16");
  }
  if (c.turnMode !== "allUnits" && c.turnMode !== "oneUnit") errors.push('turnMode must be "allUnits" or "oneUnit"');
  if (!isInt(c.bumpDamage, 0, 20)) errors.push("bumpDamage must be 0-20");
  const f = c.forage;
  if (!isObj(f)) errors.push("forage settings missing");
  else for (const k of ["berryHeal", "wormHeal", "wormDamageBonus", "berryRegrowTurns", "wormRegrowTurns"]) if (!isInt(f[k], 0, 50)) errors.push(`forage.${k} must be 0-50`);

  const typeIds = new Set<string>();
  if (!Array.isArray(c.birdTypes) || c.birdTypes.length === 0) {
    errors.push("birdTypes must be a non-empty list");
  } else {
    c.birdTypes.forEach((b: unknown, i) => {
      const where = `birdTypes[${i}]`;
      if (!isObj(b)) return void errors.push(`${where} must be an object`);
      for (const key of ["id", "name", "description"]) if (!isText(b[key])) errors.push(`${where}.${key} must be text`);
      if (typeof b.id === "string") typeIds.add(b.id);
      if (!Array.isArray(b.movement) || b.movement.length === 0) errors.push(`${where}.movement must be a non-empty list`);
      else b.movement.forEach((p: unknown, j) => checkPattern(p, `${where}.movement[${j}]`, errors));
      checkAttack(b.attack, `${where}.attack`, errors);
      if (!isObj(b.stats) || !isInt(b.stats.health, 1, 99) || !isInt(b.stats.forageBonus, 0, 20)) errors.push(`${where}.stats needs health (1-99) and forageBonus`);
      if (!Array.isArray(b.nicknames) || !b.nicknames.every(isText)) errors.push(`${where}.nicknames must be a list of names`);
      if (!Array.isArray(b.abilities)) errors.push(`${where}.abilities must be a list`);
      checkSprite(b.sprite, `${where}.sprite`, errors);
    });
  }

  if (!Array.isArray(c.startingTeam) || c.startingTeam.length === 0) {
    errors.push("startingTeam must be a non-empty list of bird type ids");
  } else {
    for (const id of c.startingTeam) if (!typeIds.has(id as string)) errors.push(`startingTeam: unknown bird type "${String(id)}"`);
    if (isObj(board) && isInt(board.width) && c.startingTeam.length > board.width) errors.push("startingTeam has more birds than the board is wide");
  }

  const m = c.map;
  if (!isObj(m) || !isObj(m.legend) || !Array.isArray(m.rows)) {
    errors.push("map needs legend and rows");
  } else if (isObj(board)) {
    for (const [ch, t] of Object.entries(m.legend)) if (!TILE_TYPES.includes(t as string)) errors.push(`map.legend "${ch}": unknown tile "${String(t)}"`);
    if (m.rows.length !== board.height) errors.push(`map.rows must have ${String(board.height)} rows`);
    m.rows.forEach((row: unknown, y) => {
      if (typeof row !== "string" || [...row].length !== board.width) return void errors.push(`map.rows[${y}] must be ${String(board.width)} characters`);
      for (const ch of row) if (!(ch in (m.legend as object))) errors.push(`map.rows[${y}]: character "${ch}" not in legend`);
    });
  }
  return errors;
}
