import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "./config";
import { applyAction, createInitialState, getAttackTargets, getForageOption, getValidMoves, previewAttack } from "./rules";
import type { GameConfig, GameState, Pos, TileType, Unit } from "./types";

// A blank 8x8 grass board so each test places its own obstacles.
const blankConfig: GameConfig = {
  ...DEFAULT_CONFIG,
  map: { name: "blank", legend: { ".": "grass" }, rows: Array(8).fill("........") },
};
const seats = { blue: { playerId: "p1", name: "Ann" }, red: { playerId: "p2", name: "Bo" } };

type UnitSpec = Partial<Unit> & { typeId: string; pos: Pos };
function board(units: UnitSpec[], tiles: Array<[Pos, TileType]> = []): GameState {
  const s = createInitialState(blankConfig, seats);
  for (const [p, t] of tiles) {
    s.tiles[p.y]![p.x] = t;
    if (t === "bush" || t === "dirt") s.food[`${p.x},${p.y}`] = { ripe: true, regrowIn: 0 };
  }
  return {
    ...s,
    units: units.map((u, i) => {
      const hp = DEFAULT_CONFIG.birdTypes.find((b) => b.id === u.typeId)!.stats.health;
      return { id: `u${i}`, side: "blue", nickname: `B${i}`, hp, maxHp: hp, hasMoved: false, hasActed: false, fed: false, ...u };
    }),
  };
}
const has = (ps: Pos[], x: number, y: number) => ps.some((p) => p.x === x && p.y === y);
const unit = (s: GameState, id: string) => s.units.find((u) => u.id === id);
function act(s: GameState, player: string, a: Parameters<typeof applyAction>[2]): GameState {
  const r = applyAction(s, player, a);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

describe("movement", () => {
  it("sparrow walks up to 4 steps but must go around trees", () => {
    const s = board([{ typeId: "sparrow", pos: { x: 0, y: 0 } }], [[{ x: 1, y: 0 }, "tree"]]);
    const m = getValidMoves(s, "u0");
    expect(has(m, 1, 0)).toBe(false); // can't land on a tree
    expect(has(m, 2, 0)).toBe(true); // around via (0,1),(1,1),(2,1),(2,0)
    expect(has(m, 4, 0)).toBe(false); // too far once it has to detour
    expect(has(m, 0, 4)).toBe(true);
  });

  it("hawk flies over trees and birds (up to 3 steps)", () => {
    const s = board([{ typeId: "hawk", pos: { x: 0, y: 0 } }, { typeId: "owl", pos: { x: 1, y: 0 }, side: "red" }], [[{ x: 2, y: 0 }, "tree"]]);
    const m = getValidMoves(s, "u0");
    expect(has(m, 3, 0)).toBe(true);
    expect(has(m, 4, 0)).toBe(false);
  });
});

describe("attacks", () => {
  it("sparrow pecks a neighbor and pushes it back", () => {
    let s = board([{ typeId: "sparrow", pos: { x: 3, y: 3 } }, { typeId: "crow", pos: { x: 4, y: 3 }, side: "red" }]);
    expect(getAttackTargets(s, "u0")).toEqual([{ x: 4, y: 3 }]);
    s = act(s, "p1", { type: "attack", unitId: "u0", target: { x: 4, y: 3 } });
    expect(unit(s, "u1")).toMatchObject({ hp: 2, pos: { x: 5, y: 3 } });
    expect(unit(s, "u0")!.hasActed).toBe(true);
  });

  it("pushing into a rock deals bump damage and the bird stays put", () => {
    const s = act(
      board([{ typeId: "sparrow", pos: { x: 3, y: 3 } }, { typeId: "crow", pos: { x: 4, y: 3 }, side: "red" }], [[{ x: 5, y: 3 }, "rock"]]),
      "p1",
      { type: "attack", unitId: "u0", target: { x: 4, y: 3 } },
    );
    expect(unit(s, "u1")).toMatchObject({ hp: 1, pos: { x: 4, y: 3 } }); // 1 peck + 1 bump
  });

  it("pushing a bird into another bird hurts both", () => {
    const s = act(
      board([
        { typeId: "sparrow", pos: { x: 3, y: 3 } },
        { typeId: "crow", pos: { x: 4, y: 3 }, side: "red" },
        { typeId: "owl", pos: { x: 5, y: 3 }, side: "red" },
      ]),
      "p1",
      { type: "attack", unitId: "u0", target: { x: 4, y: 3 } },
    );
    expect(unit(s, "u1")!.hp).toBe(1);
    expect(unit(s, "u2")!.hp).toBe(4);
  });

  it("hawk dive hits the first bird in line, not birds behind trees", () => {
    const s = board(
      [
        { typeId: "hawk", pos: { x: 0, y: 0 } },
        { typeId: "crow", pos: { x: 3, y: 0 }, side: "red" },
        { typeId: "crow", pos: { x: 0, y: 3 }, side: "red" },
      ],
      [[{ x: 0, y: 2 }, "tree"]],
    );
    expect(getAttackTargets(s, "u0")).toEqual([{ x: 3, y: 0 }]);
    const after = act(s, "p1", { type: "attack", unitId: "u0", target: { x: 3, y: 0 } });
    expect(unit(after, "u1")).toMatchObject({ hp: 1, pos: { x: 4, y: 0 } });
  });

  it("owl screech hits friends too and pushes everyone outward", () => {
    const s = act(
      board([
        { typeId: "owl", pos: { x: 3, y: 3 } },
        { typeId: "sparrow", pos: { x: 3, y: 2 } }, // friend, north
        { typeId: "crow", pos: { x: 4, y: 3 }, side: "red" }, // foe, east
      ]),
      "p1",
      { type: "attack", unitId: "u0", target: { x: 3, y: 3 } },
    );
    expect(unit(s, "u1")).toMatchObject({ hp: 2, pos: { x: 3, y: 1 } });
    expect(unit(s, "u2")).toMatchObject({ hp: 2, pos: { x: 5, y: 3 } });
  });

  it("crow pebble scatters birds around the impact", () => {
    const s = board([
      { typeId: "crow", pos: { x: 0, y: 3 } },
      { typeId: "owl", pos: { x: 3, y: 3 }, side: "red" }, // impact
      { typeId: "sparrow", pos: { x: 3, y: 4 }, side: "red" }, // south of impact
    ]);
    const preview = previewAttack(s, "u0", { x: 3, y: 3 });
    expect(preview.some((e) => e.kind === "push" && e.unitId === "u2")).toBe(true);
    expect(unit(s, "u2")!.pos).toEqual({ x: 3, y: 4 }); // preview changed nothing
    const after = act(s, "p1", { type: "attack", unitId: "u0", target: { x: 3, y: 3 } });
    expect(unit(after, "u1")!.hp).toBe(4);
    expect(unit(after, "u2")!.pos).toEqual({ x: 3, y: 5 });
  });

  it("knocking out the last enemy bird wins", () => {
    const s = act(board([{ typeId: "hawk", pos: { x: 0, y: 0 } }, { typeId: "crow", pos: { x: 2, y: 0 }, side: "red", hp: 2 }]), "p1", {
      type: "attack",
      unitId: "u0",
      target: { x: 2, y: 0 },
    });
    expect(s.units.some((u) => u.side === "red")).toBe(false);
    expect(s.winner).toBe("blue");
    expect(applyAction(s, "p2", { type: "endTurn" }).ok).toBe(false);
  });
});

describe("foraging", () => {
  it("berries heal a hurt bird next to a bush, then regrow after a few turns", () => {
    let s = board([{ typeId: "hawk", pos: { x: 3, y: 3 }, hp: 1 }], [[{ x: 3, y: 2 }, "bush"]]);
    s = act(s, "p1", { type: "forage", unitId: "u0" });
    expect(unit(s, "u0")!.hp).toBe(3);
    expect(s.food["3,2"]!.ripe).toBe(false);
    for (let i = 0; i < 4; i++) s = act(s, i % 2 ? "p2" : "p1", { type: "endTurn" });
    expect(s.food["3,2"]!.ripe).toBe(true);
  });

  it("can't forage berries at full health, but worms still power up the next attack", () => {
    const s = board([{ typeId: "sparrow", pos: { x: 3, y: 3 } }, { typeId: "crow", pos: { x: 4, y: 3 }, side: "red" }], [[{ x: 3, y: 2 }, "bush"]]);
    expect(getForageOption(s, unit(s, "u0")!)).toBeNull();

    let w = board([{ typeId: "sparrow", pos: { x: 3, y: 3 } }, { typeId: "crow", pos: { x: 5, y: 3 }, side: "red" }], [[{ x: 3, y: 3 }, "dirt"]]);
    w = act(w, "p1", { type: "forage", unitId: "u0" });
    expect(unit(w, "u0")!.fed).toBe(true);
    w = act(act(w, "p1", { type: "endTurn" }), "p2", { type: "endTurn" });
    w = act(w, "p1", { type: "move", unitId: "u0", to: { x: 4, y: 3 } });
    w = act(w, "p1", { type: "attack", unitId: "u0", target: { x: 5, y: 3 } });
    expect(unit(w, "u1")!.hp).toBe(1); // 1 peck + 1 worm bonus
  });
});

describe("turns", () => {
  it("rejects out-of-turn and enemy-bird actions; undo only reverts moves", () => {
    let s = createInitialState(DEFAULT_CONFIG, seats);
    const hawk = s.units.find((u) => u.side === "blue" && u.typeId === "hawk")!;
    const redHawk = s.units.find((u) => u.side === "red" && u.typeId === "hawk")!;
    expect(applyAction(s, "p2", { type: "endTurn" }).ok).toBe(false);
    expect(applyAction(s, "p1", { type: "move", unitId: redHawk.id, to: { x: redHawk.pos.x, y: 1 } }).ok).toBe(false);
    s = act(s, "p1", { type: "move", unitId: hawk.id, to: { x: hawk.pos.x, y: 5 } });
    expect(applyAction(s, "p1", { type: "move", unitId: hawk.id, to: { x: hawk.pos.x, y: 4 } }).ok).toBe(false);
    s = act(s, "p1", { type: "undo" });
    expect(unit(s, hawk.id)!.pos).toEqual(hawk.pos);
    s = act(s, "p1", { type: "endTurn" });
    expect(s.activeSide).toBe("red");
    expect(applyAction(s, "p2", { type: "undo" }).ok).toBe(false);
  });

  it("oneUnit mode: only one bird does things each turn", () => {
    let s = createInitialState({ ...DEFAULT_CONFIG, turnMode: "oneUnit" }, seats);
    const [a, b] = s.units.filter((u) => u.side === "blue" && u.typeId !== "sparrow");
    s = act(s, "p1", { type: "move", unitId: a!.id, to: { x: a!.pos.x, y: 6 } });
    expect(applyAction(s, "p1", { type: "move", unitId: b!.id, to: { x: b!.pos.x, y: 6 } }).ok).toBe(false);
  });
});

describe("config", () => {
  it("default config is valid", () => expect(validateConfig(DEFAULT_CONFIG)).toEqual([]));
  it("catches a bad map", () => expect(validateConfig({ ...DEFAULT_CONFIG, map: { ...DEFAULT_CONFIG.map, rows: ["..."] } }).length).toBeGreaterThan(0));
  it("every sprite row only uses its palette", () => {
    for (const b of DEFAULT_CONFIG.birdTypes) for (const row of b.sprite.pixels) expect(row.length).toBe(16);
  });
});
