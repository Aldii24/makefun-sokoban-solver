// Push-optimal Sokoban solver for make.fun's sokoban-solver-01 levels (Node 22, erasable TS types only).
//
// Layout (from the rules): a one-square-wide hallway carries the player; one to four rooms hang off it, each opening
// onto the hallway through a single door. A box pushed into the hallway can never be pushed back, so every room is an
// independent sub-problem and the level's push-optimal count P* is the sum of the rooms' optima. We therefore:
//   1. split the level into the hallway and its rooms;
//   2. solve each room EXACTLY with a breadth-first search over pushes (so the first solution found is push-optimal),
//      entering and leaving through the room's door;
//   3. order the rooms so the player can always walk on to the next one, and stitch the push sequences together with
//      shortest player walks, replaying everything into an L/U/R/D move string.
// If the board does not look like that layout we fall back to one exact push-BFS over the whole level.
// Everything is deterministic and bounded by work (expansion caps), never by the wall clock.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DIRCH = ['u', 'd', 'l', 'r'];
// neighbour in direction d (0=u,1=d,2=l,3=r), or -1 off the board edge
function nbr(w: number, h: number, c: number, d: number): number {
  const x = c % w, y = (c / w) | 0;
  if (d === 0) return y > 0 ? c - w : -1;
  if (d === 1) return y < h - 1 ? c + w : -1;
  if (d === 2) return x > 0 ? c - 1 : -1;
  return x < w - 1 ? c + 1 : -1;
}

type Level = { w: number; h: number; wall: Uint8Array; goal: Uint8Array; boxes: number[]; player: number };

function parse(text: string): Level {
  const rows = text.replace(/\r/g, '').split('\n');
  while (rows.length && rows[rows.length - 1]!.trim() === '') rows.pop();
  const h = rows.length;
  const w = Math.max(1, ...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = 0;
  for (let y = 0; y < h; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') wall[i] = 1;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // Anything the player cannot reach (treating boxes as passable) is outside the playfield: make it wall.
  const seen = new Uint8Array(w * h);
  const st = [player];
  seen[player] = 1;
  while (st.length) {
    const c = st.pop()!;
    for (let d = 0; d < 4; d++) {
      const n = nbr(w, h, c, d);
      if (n < 0 || seen[n] || wall[n]) continue;
      seen[n] = 1;
      st.push(n);
    }
  }
  for (let i = 0; i < w * h; i++) if (!seen[i]) wall[i] = 1;
  return { w, h, wall, goal, boxes, player };
}

type Push = [number, number]; // [box cell before the push, direction index]

// Exact push-optimal search over a region.
//   walk   : 1 where the player may stand/walk
//   boxOk  : 1 where a box may be
//   goals  : goal cells (within boxOk)
//   boxes0 : starting box cells
//   start  : the player's starting cell (for the region solve, the door)
//   exit   : if >= 0, the player must be able to reach this cell in the final state
// Returns a push-optimal list of pushes, or null if unsolved within the cap.
function solveRegion(
  w: number, h: number, walk: Uint8Array, boxOk: Uint8Array,
  goals: number[], boxes0: number[], start: number, exit: number, cap: number,
): Push[] | null {
  const N = w * h;
  const nb: Int32Array[] = [];
  for (let c = 0; c < N; c++) {
    const a = new Int32Array(4);
    for (let d = 0; d < 4; d++) { const n = nbr(w, h, c, d); a[d] = n >= 0 && walk[n] ? n : -1; }
    nb.push(a);
  }
  const isGoal = new Uint8Array(N);
  for (const g of goals) isGoal[g] = 1;
  // Live squares: a box can stand here and still reach some goal (found by reverse pulls from goals).
  const live = new Uint8Array(N);
  const q: number[] = [];
  for (const g of goals) if (boxOk[g]) { live[g] = 1; q.push(g); }
  while (q.length) {
    const c = q.pop()!;
    for (let d = 0; d < 4; d++) {
      const n = nb[c]![d]!;           // box would move from c to n ...
      if (n < 0 || !boxOk[n] || live[n]) continue;
      const p = nb[n]![d]!;           // ... with the player on the far side at p
      if (p < 0) continue;
      live[n] = 1;
      q.push(n);
    }
  }
  for (const b of boxes0) if (!live[b] && !isGoal[b]) return null;

  const occ = new Uint8Array(N);
  const mark = new Int32Array(N);
  let stamp = 0;
  const stackArr = new Int32Array(N);
  const reach = (p: number): number => { // flood the player zone, return its minimum cell (canonical id)
    stamp++;
    let sp = 0, mn = p;
    stackArr[sp++] = p; mark[p] = stamp;
    while (sp) {
      const c = stackArr[--sp]!;
      if (c < mn) mn = c;
      const a = nb[c]!;
      for (let d = 0; d < 4; d++) { const n = a[d]!; if (n >= 0 && !occ[n] && mark[n] !== stamp) { mark[n] = stamp; stackArr[sp++] = n; } }
    }
    return mn;
  };
  const isFrozen = (c: number): boolean => { // 2x2 block of wall/box containing an off-goal box => dead
    const x = c % w, y = (c / w) | 0;
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const x0 = x + dx, y0 = y + dy;
      if (x0 < 0 || x0 + 1 >= w || y0 < 0 || y0 + 1 >= h) continue;
      const cells = [y0 * w + x0, y0 * w + x0 + 1, (y0 + 1) * w + x0, (y0 + 1) * w + x0 + 1];
      let all = true, off = false;
      for (const s of cells) {
        const box = occ[s] === 1;
        const solid = !walk[s] || box;   // a wall (not walkable) or a box
        if (!solid) { all = false; break; }
        if (box && !isGoal[s]) off = true;
      }
      if (all && off) return true;
    }
    return false;
  };
  const key = (bs: number[], p: number): string => String.fromCharCode(p, ...bs);
  const solved = (bs: number[]): boolean => { for (const b of bs) if (!isGoal[b]) return false; return true; };

  const bsArr: number[][] = [];
  const pArr: number[] = [];
  const par: number[] = [];
  const psh: (Push | null)[] = [];
  const b0 = [...boxes0].sort((a, b) => a - b);
  for (const b of b0) occ[b] = 1;
  const p0 = reach(start);
  const endOk = (): boolean => exit < 0 || mark[exit] === stamp;
  if (solved(b0) && endOk()) { for (const b of b0) occ[b] = 0; return []; }
  for (const b of b0) occ[b] = 0;
  bsArr.push(b0); pArr.push(p0); par.push(-1); psh.push(null);
  const seenSet = new Set<string>([key(b0, p0)]);
  const build = (i: number): Push[] => { const out: Push[] = []; while (par[i]! >= 0) { out.push(psh[i]!); i = par[i]!; } return out.reverse(); };

  let head = 0, expanded = 0;
  while (head < bsArr.length) {
    if (++expanded > cap) return null;
    const ci = head++;
    const bs = bsArr[ci]!;
    for (const b of bs) occ[b] = 1;
    reach(pArr[ci]!);
    const myStamp = stamp;
    // Collect every legal push first (while the player zone in `mark` is valid), then apply them: applying a push
    // re-floods the zone, so the zone must be read before any push is applied.
    const cands: [number, number, number][] = []; // [box index k, direction d, destination to]
    for (let k = 0; k < bs.length; k++) {
      const b = bs[k]!;
      for (let d = 0; d < 4; d++) {
        const stand = nb[b]![d ^ 1]!;      // player stands opposite the push direction
        if (stand < 0 || mark[stand] !== myStamp) continue;
        const to = nb[b]![d]!;             // box's destination
        if (to < 0 || !boxOk[to] || occ[to] || !live[to]) continue;
        cands.push([k, d, to]);
      }
    }
    for (const [k, d, to] of cands) {
      const b = bs[k]!;
      occ[b] = 0; occ[to] = 1;
      const dead = !isGoal[to] && isFrozen(to);
      if (!dead) {
        const nbs = bs.slice(); nbs[k] = to; nbs.sort((x, y) => x - y);
        const np = reach(b);             // after the push the player is where the box was
        const kk = key(nbs, np);
        if (!seenSet.has(kk)) {
          seenSet.add(kk);
          bsArr.push(nbs); pArr.push(np); par.push(ci); psh.push([b, d]);
          if (solved(nbs) && endOk()) { for (let i = 0; i < N; i++) occ[i] = 0; return build(bsArr.length - 1); }
        }
      }
      occ[to] = 0; occ[b] = 1;
    }
    for (const b of bs) occ[b] = 0;
  }
  return null;
}

// Shortest player walk from a to b over floor avoiding boxes; returns the move string, or null.
function walkPath(w: number, h: number, wall: Uint8Array, occ: Uint8Array, a: number, b: number): string | null {
  if (a === b) return '';
  const N = w * h;
  const prev = new Int32Array(N).fill(-2);
  const pd = new Int8Array(N);
  const q = [a]; prev[a] = -1;
  for (let head = 0; head < q.length; head++) {
    const c = q[head]!;
    for (let d = 0; d < 4; d++) {
      const n = nbr(w, h, c, d);
      if (n < 0 || wall[n] || occ[n] || prev[n] !== -2) continue;
      prev[n] = c; pd[n] = d;
      if (n === b) { let s = ''; let x = b; while (x !== a) { s = DIRCH[pd[x]!]! + s; x = prev[x]!; } return s; }
      q.push(n);
    }
  }
  return null;
}

function solve(text: string): string {
  const L = parse(text);
  const { w, h } = L;
  const N = w * h;

  // Hallway: the horizontal floor run through the player's row.
  const hall = new Uint8Array(N);
  let hx = L.player;
  while (hx % w > 0 && !L.wall[hx - 1]) hx--;
  for (let x = hx; x % w <= w - 1 && !L.wall[x]; x++) { hall[x] = 1; if (x % w === w - 1) break; }

  // Rooms: connected floor components outside the hallway.
  const comp = new Int32Array(N).fill(-1);
  const rooms: number[][] = [];
  for (let i = 0; i < N; i++) {
    if (L.wall[i] || hall[i] || comp[i] >= 0) continue;
    const id = rooms.length; const cells: number[] = []; const st = [i]; comp[i] = id;
    while (st.length) {
      const c = st.pop()!; cells.push(c);
      for (let d = 0; d < 4; d++) { const n = nbr(w, h, c, d); if (n >= 0 && !L.wall[n] && !hall[n] && comp[n] < 0) { comp[n] = id; st.push(n); } }
    }
    rooms.push(cells);
  }

  // Validate the expected layout: nothing but floor in the hallway, every box & goal inside some room, each room with
  // exactly one door onto the hallway.
  let layoutOk = rooms.length >= 1;
  for (let i = 0; i < N && layoutOk; i++) if (hall[i] && (L.goal[i] || L.boxes.includes(i))) layoutOk = false;
  const doors: number[] = [];
  if (layoutOk) {
    for (const cells of rooms) {
      const ds = new Set<number>();
      for (const c of cells) for (let d = 0; d < 4; d++) { const n = nbr(w, h, c, d); if (n >= 0 && hall[n]) ds.add(n); }
      if (ds.size !== 1) { layoutOk = false; break; }
      doors.push([...ds][0]!);
    }
  }
  if (layoutOk) for (const b of L.boxes) if (comp[b] < 0) layoutOk = false;
  if (layoutOk) for (let i = 0; i < N; i++) if (L.goal[i] && comp[i] < 0) layoutOk = false;

  const fullOcc = new Uint8Array(N);
  for (const b of L.boxes) fullOcc[b] = 1;

  if (!layoutOk) {
    // Fallback: one exact push-BFS over the whole playfield.
    const walk = new Uint8Array(N); const boxOk = new Uint8Array(N);
    for (let i = 0; i < N; i++) { walk[i] = L.wall[i] ? 0 : 1; boxOk[i] = walk[i]; }
    const goals: number[] = []; for (let i = 0; i < N; i++) if (L.goal[i]) goals.push(i);
    const pushes = solveRegion(w, h, walk, boxOk, goals, L.boxes, L.player, -1, 3_000_000);
    if (!pushes) return '';
    return replay(w, h, L.wall, L.boxes.slice(), L.player, pushes);
  }

  // Solve each room, both free and must-exit (through its door), from the door.
  type R = { pushesFree: Push[] | null; pushesExit: Push[] | null; door: number };
  const solved: R[] = [];
  for (let r = 0; r < rooms.length; r++) {
    const cells = rooms[r]!;
    const door = doors[r]!;
    const walk = new Uint8Array(N); const boxOk = new Uint8Array(N);
    for (const c of cells) { walk[c] = 1; boxOk[c] = 1; }
    walk[door] = 1; // the player may stand on the door
    const goals: number[] = []; for (const c of cells) if (L.goal[c]) goals.push(c);
    const boxes0: number[] = []; for (const c of cells) if (fullOcc[c]) boxes0.push(c);
    const cap = 2_000_000;
    const pushesExit = solveRegion(w, h, walk, boxOk, goals, boxes0, door, door, cap);
    const pushesFree = solveRegion(w, h, walk, boxOk, goals, boxes0, door, -1, cap);
    solved.push({ pushesFree, pushesExit, door });
  }

  // Choose which room to visit last. A room whose only solutions trap the player (no must-exit solution) MUST be
  // last, since the player cannot walk on afterwards; at most one such room can be served. Otherwise pick the room
  // that saves the most pushes by not having to let the player back out.
  let lastIdx = -1;
  const trap: number[] = [];
  for (let r = 0; r < solved.length; r++) if (solved[r]!.pushesFree && !solved[r]!.pushesExit) trap.push(r);
  if (trap.length >= 1) {
    lastIdx = trap[0]!; // if more than one room traps the player this layout cannot be fully solved this way; serve one
  } else {
    let bestSave = -1;
    for (let r = 0; r < solved.length; r++) {
      const s = solved[r]!;
      if (s.pushesFree && s.pushesExit) {
        const save = s.pushesExit.length - s.pushesFree.length;
        if (save > bestSave) { bestSave = save; lastIdx = r; }
      }
    }
  }

  const order = [...rooms.keys()].filter((r) => r !== lastIdx);
  if (lastIdx >= 0) order.push(lastIdx);

  // Build the full ordered push list; each non-last room uses its must-exit solution, the last its free one.
  const allPushes: Push[] = [];
  for (const r of order) {
    const s = solved[r]!;
    const chosen = r === lastIdx ? (s.pushesFree ?? s.pushesExit) : (s.pushesExit ?? s.pushesFree);
    if (!chosen) return '';
    for (const p of chosen) allPushes.push(p);
  }
  return replay(w, h, L.wall, L.boxes.slice(), L.player, allPushes);
}

// Replay a push list from the real start into a move string, walking the player to each push and performing it.
function replay(w: number, h: number, wall: Uint8Array, boxes: number[], player: number, pushes: Push[]): string {
  const N = w * h;
  const occ = new Uint8Array(N);
  for (const b of boxes) occ[b] = 1;
  let out = '';
  for (const [box, d] of pushes) {
    const stand = nbr(w, h, box, d ^ 1);
    if (stand < 0 || wall[stand] || occ[stand]) return '';
    const path = walkPath(w, h, wall, occ, player, stand);
    if (path === null) return '';
    out += path;
    const to = nbr(w, h, box, d);
    if (to < 0 || wall[to] || occ[to]) return '';
    occ[box] = 0; occ[to] = 1;      // move the box
    out += DIRCH[d]!;               // the pushing step
    player = box;                   // the player ends where the box was
  }
  return out;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try { moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8')); } catch { moves = ''; }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
