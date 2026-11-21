// Push-optimal Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Strategy: every level is a one-wide hallway with 1-4 rooms off it, each
// room holding 3-4 boxes and as many goals behind a single door. A box
// pushed through a door into the hallway can never come back, so every box
// stays in its room and the level optimum P* is the sum of the per-room
// optima. This program therefore splits the level into rooms and solves
// each room push-optimally on its own, then stitches the rooms together
// with hallway walks.
//
// Per room the search is A* over pushes: a state is the sorted box squares
// plus the player's reachable region (named by its lowest square). The
// heuristic is a minimum-cost matching of boxes to goals on precomputed
// shortest-path distances ignoring boxes (admissible: one push changes the
// matching cost by at most one), falling back to a sum of nearest-goal
// distances when there are too many boxes to permute. Deadlock pruning:
// boxes on dead squares (computed by pulling boxes back from the goals)
// and pushes that create a frozen 2x2 block of walls/boxes with a box off
// its goal are discarded. Neither prunes a solvable state, so optimality
// stands.
//
// Budgets are expansion counts, never wall-clock reads, so two runs write
// byte-identical output. If a room's A* exhausts its budget, a plain
// push-BFS with a larger budget retries it; if the level is not a set of
// rooms at all, a whole-level push-A* runs instead; if even that fails, an
// empty (valid-format) answer is still written for every instance, so the
// entry never leaves a level unanswered.
//
// Node 22, builtins only, erasable TypeScript.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Expansion budgets (counts of work, never time). The practice rooms solve
// in a few thousand expansions each, so these caps are generous headroom.
const ROOM_ASTAR_BUDGET = 300_000;
const ROOM_BFS_BUDGET = 900_000;
const WHOLE_ASTAR_BUDGET = 1_200_000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// Squares from which a box alone can be pushed onto some goal: pull boxes
// back from the goals over open floor. A square outside this set is dead:
// a box there can never reach a goal.
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Lowest square of the region the player reaches from `from` with
// `occupied` in the way. `seen`/`stamp`/`stack` are scratch reused across
// calls so no allocation happens per call.
function reachLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    // Neighbours in fixed order; only the lowest square matters, so the
    // order does not affect the result, only determinism of the walk.
    if (wall[p - w] === 0 && occupied[p - w] === 0 && seen[p - w] !== stamp) { seen[p - w] = stamp; stack[n++] = p - w; }
    if (wall[p + w] === 0 && occupied[p + w] === 0 && seen[p + w] !== stamp) { seen[p + w] = stamp; stack[n++] = p + w; }
    if (wall[p - 1] === 0 && occupied[p - 1] === 0 && seen[p - 1] !== stamp) { seen[p - 1] = stamp; stack[n++] = p - 1; }
    if (wall[p + 1] === 0 && occupied[p + 1] === 0 && seen[p + 1] !== stamp) { seen[p + 1] = stamp; stack[n++] = p + 1; }
  }
  return low;
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block of walls
// and boxes with a box off its goal: no push can ever move any of them.
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// Shortest-path distances from each goal over the level's floor, ignoring
// boxes. dist[g][cell] is the fewest steps, or -1 when unreachable.
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

// Admissible push heuristic: minimum-cost matching of boxes to goals on
// the precomputed distances (exact Hungarian by permutation for <= 5
// boxes; sum of nearest-goal distances beyond that, still admissible).
function heuristic(boxes: number[], dists: Int32Array[], goals: number[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 5) {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (let g = 0; g < goals.length; g++) {
        const d = dists[g]![b]!;
        if (d >= 0 && d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  // All permutations of goal indices, in lexicographic order.
  const perm = goals.map((_, i) => i);
  let best = Infinity;
  const rec = (k: number, acc: number): void => {
    if (acc >= best) return;
    if (k === n) {
      best = acc;
      return;
    }
    for (let i = k; i < n; i++) {
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      const d = dists[perm[k]!]![boxes[k]!]!;
      if (d >= 0) rec(k + 1, acc + d);
      [perm[k], perm[i]] = [perm[i]!, perm[k]!];
    }
  };
  rec(0, 0);
  return best;
}

// Shortest walk from `from` to `to` around walls and boxes, in lower-case
// LURD letters (fixed direction order, so ties break deterministically).
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const { w, wall } = level;
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

// Core push search over one (sub-)level. When `astar` is true the open
// list is ordered by pushes + heuristic; otherwise it is plain breadth
// first over pushes (still push-optimal). Returns null when the budget
// runs out or the level has no solution.
function solvePush(level: Level, maxStates: number, astar: boolean): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dists = astar ? goalDistances(level) : [];
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  // Numeric state keys while they fit exactly in a double; string keys
  // beyond that (many boxes). Key = region-low, then box squares, base size.
  const numericKey = size ** (level.boxes.length + 1) < 2 ** 53;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numericKey) return low + ':' + boxes.join(',');
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const boxesOf: number[][] = [level.boxes.slice()];
  const playerOf: number[] = [level.player];
  const parent: number[] = [-1];
  const fromOf: number[] = [-1];
  const toOf: number[] = [-1];
  const gOf: number[] = [0];
  const seenBest = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reachLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  seenBest.set(keyOf(level.boxes, startLow), 0);

  // Open list: a binary heap on [f, -g, insertion counter] for A*, a plain
  // FIFO queue for BFS. Heap entries carry the state index.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  const queue: number[] = [0];
  let qhead = 0;
  let counter = 0;
  const h0 = astar ? heuristic(level.boxes, dists, goals) : 0;
  if (h0 === Infinity) return null;
  if (astar) heapPush([h0, 0, counter++, 0]);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  let expanded = 0;
  while ((astar ? heap.length > 0 : qhead < queue.length) && expanded < maxStates) {
    const s = astar ? heapPop()[3] : queue[qhead++]!;
    const g = gOf[s]!;
    const boxes = boxesOf[s]!;
    // Skip stale entries superseded by a cheaper route to the same state.
    for (const b of boxes) occupied[b] = 1;
    const low = reachLow(level, occupied, playerOf[s]!, seen, ++stamp, stack);
    if (seenBest.get(keyOf(boxes, low)) !== g) {
      for (const b of boxes) occupied[b] = 0;
      continue;
    }
    if (solved(boxes)) {
      for (const b of boxes) occupied[b] = 0;
      return buildMoves(level, s, boxesOf, playerOf, parent, fromOf, toOf);
    }
    expanded++;
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy, , pushLetter] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        // The player must be able to stand on the pushing square, and the
        // box must land on open, live floor.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let next: number[] | null = null;
        let key: number | string = '';
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          key = keyOf(next, reachLow(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const prevBest = seenBest.get(key);
        if (prevBest !== undefined && prevBest <= g + 1) continue;
        // Score the child before registering it: a state whose heuristic
        // is infinite (a box that reaches no goal even ignoring boxes) is
        // dead, and must not occupy its key in the transposition table.
        let h = 0;
        if (astar) {
          h = heuristic(next, dists, goals);
          if (h === Infinity) continue;
        }
        if (boxesOf.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        seenBest.set(key, g + 1);
        const idx = boxesOf.length;
        boxesOf.push(next);
        playerOf.push(b);
        parent.push(s);
        fromOf.push(b);
        toOf.push(t);
        gOf.push(g + 1);
        if (solved(next)) {
          for (const x of boxes) occupied[x] = 0;
          return buildMoves(level, idx, boxesOf, playerOf, parent, fromOf, toOf);
        }
        if (astar) {
          heapPush([g + 1 + h, -(g + 1), counter++, idx]);
        } else {
          queue.push(idx);
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  return null;
}

// Rebuild the full move string for state `s`: walk to each push's square,
// then push. `playerOf[s]` is where the player stands after state s's push.
function buildMoves(
  level: Level,
  s: number,
  boxesOf: number[][],
  playerOf: number[],
  parent: number[],
  fromOf: number[],
  toOf: number[],
): SearchResult {
  const path: number[] = [];
  for (let t = s; t > 0; t = parent[t]!) path.push(t);
  path.reverse();
  const occupied = new Uint8Array(level.wall.length);
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const st of path) {
    const from = fromOf[st]!;
    const to = toOf[st]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * level.w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = boxesOf[st]!.slice();
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

// Split a level into rooms: cut the dead squares of the player's row (the
// hallway) out of the floor; each remaining component holding boxes is a
// room. Null when the level is no set of rooms (a box in the hallway, a
// goal outside every room, or a room whose boxes and goals do not match).
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Solve one level room by room; each room is searched with the other
// rooms' boxes as walls (a finished room's boxes sit on its goals, also
// as walls). Falls back to a whole-level search when the level is no set
// of rooms, and to a plain push-BFS per room when A* exhausts its budget.
function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    const done = new Set<Room>();
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        const cells = done.has(other) ? other.goals : other.boxes;
        for (const b of cells) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      let res = solvePush(sub, ROOM_ASTAR_BUDGET, true);
      if (res === null) res = solvePush(sub, ROOM_BFS_BUDGET, false);
      if (res === null) return solveWhole(level);
      moves += res.moves;
      player = endOf(level.w, player, res.moves);
      done.add(room);
    }
    return moves;
  }
  return solveWhole(level);
}

// Whole-level fallback: A* over pushes on the full level, then plain BFS.
function solveWhole(level: Level): string {
  let res = solvePush(level, WHOLE_ASTAR_BUDGET, true);
  if (res === null) res = solvePush(level, WHOLE_ASTAR_BUDGET, false);
  return res === null ? '' : res.moves;
}

// The square the player stands on after `moves` from `from`.
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

for (const id of readdirSync(I).sort()) {
  const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  const moves = solveLevel(level);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
