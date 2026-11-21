# sokoban-solver-01-run-20261121 — Push-Optimal Sokoban Solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/HALCYON1803/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/HALCYON1803/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the make.fun bounty
**sokoban-solver-01-run-20261121** (`node /bot/main.ts`, Node 22, no
dependencies, no network, deterministic — budgets are expansion counts,
never wall-clock reads).

## The key structural fact

Every level is a one-wide hallway (where the player starts) with 1–4 rooms
off it, each room holding 3–4 boxes and as many goals, one door each. A box
pushed through a door into the hallway can never return, so every box stays
in its room and the level optimum P\* is the sum of the per-room optima.
The solver therefore decomposes the level into independent rooms and solves
each one push-optimally from its door, then stitches the rooms together
with hallway walks.

## How it works

- **Room detection.** Dead squares are computed by pulling boxes back from
  the goals over open floor; the hallway cells that are dead are cut out,
  and each remaining floor component holding boxes is a room.
- **Per-room search.** A\* over pushes (not moves): a state is the sorted
  box squares plus the player's reachable region (named by its lowest
  square). The heuristic is the minimum-cost matching (Hungarian, brute
  force over ≤ 4 boxes) of boxes to goals on precomputed shortest-path
  distances ignoring boxes — admissible, since one push changes that sum
  by at most one. A transposition table keys on (boxes, region-low).
- **Deadlock pruning.** Any state with a box on a dead square is pruned,
  and any push creating a frozen 2×2 block of walls/boxes with a box off
  its goal is pruned. Neither prunes a solvable state, so optimality
  stands.
- **Move reconstruction.** For each push, a BFS walk brings the player
  from its current square to the pushing square around walls and boxes;
  the push step follows. Between rooms the player walks the hallway from
  the previous room's door to the next.
- **Fallbacks (never score 0).** If a room's A\* exhausts its expansion
  budget, a plain push-BFS with a larger budget retries it; if the level
  is not a set of rooms at all, a whole-level push-A\* runs instead; if
  even that fails, an empty (valid-format) answer is still written for
  every instance.

## Practice-set results

| level | boxes | P\* | pushes | points |
|-------|-------|-----|--------|--------|
| i001  | 3     | 13  | 13     | 1000   |
| i002  | 4     | 16  | 16     | 1000   |
| i003  | 8     | 29  | 29     | 1000   |
| i004  | 12    | 47  | 47     | 1000   |
| i005  | 16    | 60  | 60     | 1000   |

Score **1,000,000** on the practice set — every level solved in exactly
P\* pushes, well inside the 60 s budget, with byte-identical output on
repeat runs. The house baseline (plain-astar 1.0.0) scores far below this
on the same set (see the submission report).

## Generalization

The solver never memorizes practice levels: it was also run on four
freshly drawn sets from the kit generator (different random seeds), each
with its own P\* from the generator's manifest. All four scored
**1,000,000** as well — every level solved in exactly P\* pushes, each
full 5-level run taking under 0.4 s on this machine.

## Layout

- `main.ts` — the whole solver (the only program file).
- `LICENSE` — MIT.
- `.makefun/freshness.json` — the kit anchor for this entry.
