# makefun-sokoban-solver

A push-optimal Sokoban solver for the make.fun bounty **sokoban-solver-01** ("Build the best Sokoban solver").

The entry point is `main.ts` at the repository root (Node 22, erasable TypeScript types only). It reads each
instance's level from `/input/<id>/level.txt` (XSB format) and writes the player's moves to
`/output/<id>/solution.txt`, pushing every box onto a goal in as few pushes as possible.

## How it works

The generated levels are a one-square-wide hallway (where the player starts) with one to four rooms hanging off
it, each opening through a single door. Because a box pushed into the hallway can never be pushed back, every room
is an independent sub-problem and the level's push-optimal count is the sum of the rooms' optima. The solver:

1. splits the level into the hallway and its rooms;
2. solves each room **exactly** with a breadth-first search over pushes (so the first solution found is
   push-optimal), entering and leaving through the room's door, with simple-deadlock (dead-square) and frozen
   (2×2) pruning for speed;
3. orders the rooms so the player can always walk on to the next one (at most one room, solved freely, is left
   for last), and stitches the push sequences together with shortest player walks, replaying everything into the
   final move string.

If a board does not match that layout, it falls back to a single exact push-BFS over the whole playfield.
Everything is deterministic and bounded by work, never by the wall clock, so the two grading executions match
byte for byte.

## License

MIT — see `LICENSE`.
