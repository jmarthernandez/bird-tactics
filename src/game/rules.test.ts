import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "./config";
import { applyAction, createInitialState, getValidMoves } from "./rules";
import type { GameConfig, GameState, Pos, Unit } from "./types";

// A blank 8x8 board with no trees, so tests control every obstacle.
const blankConfig: GameConfig = {
  ...DEFAULT_CONFIG,
  map: { name: "blank", legend: { ".": "open", T: "tree" }, rows: Array(8).fill("........") },
};

const seats = { blue: { playerId: "p1", name: "Ann" }, red: { playerId: "p2", name: "Bo" } };

/** Build a state with just the given units, plus optional trees. */
function board(units: Array<Partial<Unit> & { typeId: string; pos: Pos }>, trees: Pos[] = []): GameState {
  const s = createInitialState(blankConfig, seats);
  for (const t of trees) s.tiles[t.y]![t.x] = "tree";
  return {
    ...s,
    units: units.map((u, i) => ({ id: u.id ?? `u${i}`, side: u.side ?? "blue", hasMoved: false, ...u })),
  };
}

const sortPos = (ps: Pos[]) => [...ps].sort((a, b) => a.y - b.y || a.x - b.x);
const has = (ps: Pos[], x: number, y: number) => ps.some((p) => p.x === x && p.y === y);

describe("movement patterns", () => {
  it("sparrow reaches every tile within 2 steps on an open board", () => {
    const moves = getValidMoves(board([{ typeId: "sparrow", pos: { x: 4, y: 4 } }]), "u0");
    expect(moves).toHaveLength(24); // 5x5 square minus its own tile
  });

  it("sparrow walks around a tree but can't land on it", () => {
    const s = board([{ typeId: "sparrow", pos: { x: 0, y: 0 } }], [{ x: 1, y: 0 }]);
    const moves = getValidMoves(s, "u0");
    expect(has(moves, 1, 0)).toBe(false);
    expect(has(moves, 2, 0)).toBe(true); // via (1,1)
  });

  it("hawk slides orthogonally up to 4 and is blocked by trees and birds", () => {
    const s = board(
      [
        { typeId: "hawk", pos: { x: 0, y: 0 } },
        { typeId: "sparrow", pos: { x: 0, y: 2 }, side: "red" },
      ],
      [{ x: 3, y: 0 }],
    );
    expect(sortPos(getValidMoves(s, "u0"))).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
    ]);
  });

  it("hawk range stops at 4", () => {
    const moves = getValidMoves(board([{ typeId: "hawk", pos: { x: 0, y: 0 } }]), "u0");
    expect(has(moves, 4, 0)).toBe(true);
    expect(has(moves, 5, 0)).toBe(false);
  });

  it("owl slides diagonally up to 3 and is blocked", () => {
    const s = board([{ typeId: "owl", pos: { x: 3, y: 3 } }], [{ x: 4, y: 4 }]);
    const moves = getValidMoves(s, "u0");
    expect(has(moves, 4, 4)).toBe(false);
    expect(has(moves, 5, 5)).toBe(false);
    expect(has(moves, 0, 0)).toBe(true);
    expect(has(moves, 6, 0)).toBe(true);
    expect(has(moves, 3, 4)).toBe(false); // never orthogonal
    expect(moves).toHaveLength(9); // 3 up-left, 3 up-right, 3 down-left, 0 down-right
  });

  it("crow leaps like a knight over anything, but not onto trees or birds", () => {
    const s = board(
      [
        { typeId: "crow", pos: { x: 3, y: 3 } },
        { typeId: "sparrow", pos: { x: 5, y: 4 } },
      ],
      [
        { x: 3, y: 4 }, { x: 4, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 2 }, // surrounded by trees
        { x: 4, y: 5 }, // tree on a landing tile
      ],
    );
    const moves = getValidMoves(s, "u0");
    expect(moves).toHaveLength(6);
    expect(has(moves, 4, 5)).toBe(false);
    expect(has(moves, 5, 4)).toBe(false);
    expect(has(moves, 1, 2)).toBe(true);
  });
});

describe("applyAction", () => {
  const start = () => createInitialState(DEFAULT_CONFIG, seats);
  const blueHawk = (s: GameState) => s.units.find((u) => u.side === "blue" && u.typeId === "hawk")!;

  it("rejects moves out of turn, of enemy birds, and illegal destinations", () => {
    const s = start();
    const hawk = blueHawk(s);
    expect(applyAction(s, "p2", { type: "move", unitId: hawk.id, to: { x: hawk.pos.x, y: 6 } }).ok).toBe(false);
    const redHawk = s.units.find((u) => u.side === "red" && u.typeId === "hawk")!;
    expect(applyAction(s, "p1", { type: "move", unitId: redHawk.id, to: { x: redHawk.pos.x, y: 1 } }).ok).toBe(false);
    expect(applyAction(s, "p1", { type: "move", unitId: hawk.id, to: { x: hawk.pos.x + 1, y: 6 } }).ok).toBe(false);
    expect(applyAction(s, "stranger", { type: "endTurn" }).ok).toBe(false);
  });

  it("moves, blocks a second move, undoes, and ends the turn", () => {
    let s = start();
    const hawk = blueHawk(s);
    const r = applyAction(s, "p1", { type: "move", unitId: hawk.id, to: { x: hawk.pos.x, y: 5 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    expect(applyAction(s, "p1", { type: "move", unitId: hawk.id, to: { x: hawk.pos.x, y: 4 } }).ok).toBe(false);

    const undone = applyAction(s, "p1", { type: "undo" });
    expect(undone.ok && blueHawk(undone.state).pos).toEqual(hawk.pos);

    const ended = applyAction(s, "p1", { type: "endTurn" });
    expect(ended.ok && ended.state.activeSide).toBe("red");
    expect(ended.ok && ended.state.turnNumber).toBe(2);
    expect(ended.ok && ended.state.units.every((u) => !u.hasMoved)).toBe(true);
    // Can't undo last turn's moves.
    expect(ended.ok && applyAction(ended.state, "p2", { type: "undo" }).ok).toBe(false);
  });

  it("oneUnit mode allows only one move per turn", () => {
    let s = createInitialState({ ...DEFAULT_CONFIG, turnMode: "oneUnit" }, seats);
    const blue = s.units.filter((u) => u.side === "blue");
    const r = applyAction(s, "p1", { type: "move", unitId: blue[1]!.id, to: { x: blue[1]!.pos.x, y: 5 } });
    expect(r.ok).toBe(true);
    if (r.ok) s = r.state;
    const sparrow = blue.find((u) => u.typeId === "sparrow")!;
    expect(applyAction(s, "p1", { type: "move", unitId: sparrow.id, to: { x: sparrow.pos.x, y: 6 } }).ok).toBe(false);
  });
});

describe("config", () => {
  it("default config is valid", () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });
  it("catches a bad map", () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, map: { ...DEFAULT_CONFIG.map, rows: ["..."] } }).length).toBeGreaterThan(0);
  });
});
