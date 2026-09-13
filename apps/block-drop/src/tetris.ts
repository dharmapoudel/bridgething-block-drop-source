// Block Drop engine: guideline-style falling blocks (7-bag, SRS kicks, lock delay).
// Pure logic, no DOM. Coordinates: x right, y down, board 10 wide x 22 tall
// (top two rows are hidden spawn space).

export type Mode = 'classic' | 'sprint' | 'ultra';
export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export const COLS = 10;
export const ROWS = 22;
export const VISIBLE_ROWS = 20;
export const HIDDEN_ROWS = 2;

export const SPRINT_LINES = 40;
export const ULTRA_SECONDS = 120;

const EMPTY = 0;
const KIND_INDEX: Record<PieceKind, number> = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };

// spawn cells inside a 4x4 box, SRS orientation 0
const SPAWN: Record<PieceKind, Array<[number, number]>> = {
  I: [[0, 1], [1, 1], [2, 1], [3, 1]],
  O: [[1, 0], [2, 0], [1, 1], [2, 1]],
  T: [[1, 0], [0, 1], [1, 1], [2, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
};

type Kick = [number, number];
// y-down conversions of the SRS kick tables, clockwise 0->R->2->L->0
const KICKS_JLSTZ: Kick[][] = [
  [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
];
const KICKS_I: Kick[][] = [
  [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
];

const LINE_SCORE = [0, 100, 300, 500, 800];
// seconds per row by level, guideline-ish curve
const GRAVITY = [0.8, 0.72, 0.63, 0.55, 0.47, 0.38, 0.3, 0.22, 0.15, 0.1, 0.08, 0.07, 0.06, 0.05, 0.04];
const LOCK_DELAY = 0.5;
const MAX_LOCK_RESETS = 15;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ActivePiece {
  kind: PieceKind;
  cells: Array<[number, number]>; // absolute board coords
  rot: number; // 0..3
}

export interface GameEvents {
  onEvent: () => void;
}

export class Game {
  board = new Uint8Array(COLS * ROWS);
  mode: Mode;
  score = 0;
  lines = 0;
  level = 1;
  combo = -1;
  pieces = 0;
  timeMs = 0; // counts up in sprint/classic, down in ultra
  over = false;
  won = false; // sprint finished
  paused = false;
  clearing: number[] = []; // rows flashing before collapse
  clearTimer = 0;

  piece: ActivePiece | null = null;
  bag: PieceKind[] = [];
  queue: PieceKind[] = [];
  holdKind: PieceKind | null = null;
  canHold = true;

  private rng: () => number;
  private gravityAcc = 0;
  private lockAcc = 0;
  private lockResets = 0;
  private events: GameEvents;

  constructor(mode: Mode, events: GameEvents, seed?: number) {
    this.mode = mode;
    this.events = events;
    this.rng = seed === undefined ? Math.random : mulberry32(seed);
    this.level = mode === 'classic' ? 1 : mode === 'sprint' ? 5 : 8;
    if (mode === 'ultra') this.timeMs = ULTRA_SECONDS * 1000;
    this.refill();
    this.spawn();
  }

  private emit(): void { this.events.onEvent(); }

  private refill(): void {
    while (this.queue.length < 7) {
      if (this.bag.length === 0) {
        this.bag = (Object.keys(SPAWN) as PieceKind[]).slice();
        for (let i = this.bag.length - 1; i > 0; i--) {
          const j = Math.floor(this.rng() * (i + 1));
          [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
        }
      }
      this.queue.push(this.bag.pop()!);
    }
  }

  private collides(cells: Array<[number, number]>): boolean {
    for (const [x, y] of cells) {
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && this.board[y * COLS + x] !== EMPTY) return true;
    }
    return false;
  }

  private spawn(): void {
    this.refill();
    const kind = this.queue.shift()!;
    this.refill();
    const cells = SPAWN[kind].map(([x, y]) => [x + 3, y] as [number, number]);
    this.piece = { kind, cells, rot: 0 };
    this.gravityAcc = 0;
    this.lockAcc = 0;
    this.lockResets = 0;
    this.canHold = true;
    if (this.collides(cells)) {
      this.over = true;
      this.emit();
    }
  }

  private rotatedCells(): Array<[number, number]> | null {
    const p = this.piece;
    if (!p || p.kind === 'O') return p ? p.cells : null;
    // rotate inside the 4x4 spawn box: (x,y) -> (3-y, x) is cw on screen
    const minX = Math.min(...p.cells.map(c => c[0]));
    const minY = Math.min(...p.cells.map(c => c[1]));
    const local = p.cells.map(([x, y]) => [x - minX, y - minY] as [number, number]);
    const turned = local.map(([x, y]) => [3 - y, x] as [number, number]);
    const nMinX = Math.min(...turned.map(c => c[0]));
    const nMinY = Math.min(...turned.map(c => c[1]));
    const base = turned.map(([x, y]) => [x - nMinX + minX, y - nMinY + minY] as [number, number]);
    const kicks = (p.kind === 'I' ? KICKS_I : KICKS_JLSTZ)[p.rot];
    for (const [kx, ky] of kicks) {
      const moved = base.map(([x, y]) => [x + kx, y + ky] as [number, number]);
      if (!this.collides(moved)) return moved;
    }
    return null;
  }

  rotate(): boolean {
    if (!this.piece || this.over || this.paused || this.clearing.length > 0) return false;
    const cells = this.rotatedCells();
    if (!cells) return false;
    this.piece.cells = cells;
    this.piece.rot = (this.piece.rot + 1) % 4;
    this.bumpLock();
    this.emit();
    return true;
  }

  move(dx: number): boolean {
    if (!this.piece || this.over || this.paused || this.clearing.length > 0) return false;
    const cells = this.piece.cells.map(([x, y]) => [x + dx, y] as [number, number]);
    if (this.collides(cells)) return false;
    this.piece.cells = cells;
    this.bumpLock();
    this.emit();
    return true;
  }

  private bumpLock(): void {
    if (this.onGround() && this.lockResets < MAX_LOCK_RESETS) {
      this.lockAcc = 0;
      this.lockResets++;
    }
  }

  private onGround(): boolean {
    if (!this.piece) return false;
    return this.collides(this.piece.cells.map(([x, y]) => [x, y + 1] as [number, number]));
  }

  softDrop(): boolean {
    if (!this.piece || this.over || this.paused || this.clearing.length > 0) return false;
    const cells = this.piece.cells.map(([x, y]) => [x, y + 1] as [number, number]);
    if (this.collides(cells)) return false;
    this.piece.cells = cells;
    this.score += 1;
    this.gravityAcc = 0;
    this.emit();
    return true;
  }

  hardDrop(): void {
    if (!this.piece || this.over || this.paused || this.clearing.length > 0) return;
    let dist = 0;
    while (!this.collides(this.piece.cells.map(([x, y]) => [x, y + 1] as [number, number]))) {
      this.piece.cells = this.piece.cells.map(([x, y]) => [x, y + 1] as [number, number]);
      dist++;
    }
    this.score += dist * 2;
    this.lock();
  }

  hold(): void {
    if (!this.piece || !this.canHold || this.over || this.paused || this.clearing.length > 0) return;
    const cur = this.piece.kind;
    if (this.holdKind === null) {
      this.holdKind = cur;
      this.canHold = false;
      this.spawn();
    } else {
      const swap = this.holdKind;
      this.holdKind = cur;
      this.canHold = false;
      const cells = SPAWN[swap].map(([x, y]) => [x + 3, y] as [number, number]);
      this.piece = { kind: swap, cells, rot: 0 };
      this.gravityAcc = 0;
      this.lockAcc = 0;
      this.lockResets = 0;
      if (this.collides(cells)) this.over = true;
    }
    this.emit();
  }

  private lock(): void {
    const p = this.piece;
    if (!p) return;
    for (const [x, y] of p.cells) {
      if (y >= 0) this.board[y * COLS + x] = KIND_INDEX[p.kind];
    }
    this.pieces++;
    this.piece = null;
    const full: number[] = [];
    for (let y = 0; y < ROWS; y++) {
      let ok = true;
      for (let x = 0; x < COLS; x++) {
        if (this.board[y * COLS + x] === EMPTY) { ok = false; break; }
      }
      if (ok) full.push(y);
    }
    if (full.length > 0) {
      this.clearing = full;
      this.clearTimer = 0.15;
      this.combo++;
      const gained = LINE_SCORE[full.length] * this.level + (this.combo > 0 ? 50 * this.combo * this.level : 0);
      this.score += gained;
      this.lines += full.length;
      if (this.mode === 'classic') this.level = 1 + Math.floor(this.lines / 10);
      if (this.mode === 'sprint' && this.lines >= SPRINT_LINES) {
        this.collapse();
        this.won = true;
        this.over = true;
      }
    } else {
      this.combo = -1;
      this.collapse();
      this.spawn();
    }
    this.emit();
  }

  private collapse(): void {
    if (this.clearing.length === 0) return;
    const cleared = new Set(this.clearing);
    const kept: number[][] = [];
    for (let y = 0; y < ROWS; y++) {
      if (!cleared.has(y)) kept.push(Array.from(this.board.slice(y * COLS, (y + 1) * COLS)));
    }
    while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(EMPTY));
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) this.board[y * COLS + x] = kept[y][x];
    }
    this.clearing = [];
  }

  togglePause(): void {
    if (this.over) return;
    this.paused = !this.paused;
    this.emit();
  }

  ghostCells(): Array<[number, number]> {
    if (!this.piece) return [];
    let cells = this.piece.cells;
    while (!this.collides(cells.map(([x, y]) => [x, y + 1] as [number, number]))) {
      cells = cells.map(([x, y]) => [x, y + 1] as [number, number]);
    }
    return cells;
  }

  /** advance the simulation; dtMs is wall time since the last call */
  tick(dtMs: number): void {
    if (this.over || this.paused) return;
    const dt = dtMs / 1000;
    if (this.mode === 'ultra') {
      this.timeMs -= dtMs;
      if (this.timeMs <= 0) { this.timeMs = 0; this.over = true; this.emit(); return; }
    } else {
      this.timeMs += dtMs;
    }
    if (this.clearing.length > 0) {
      this.clearTimer -= dt;
      if (this.clearTimer <= 0) {
        this.collapse();
        if (!this.over) this.spawn();
        this.emit();
      }
      return;
    }
    if (!this.piece) return;
    this.gravityAcc += dt;
    const step = GRAVITY[Math.min(this.level - 1, GRAVITY.length - 1)];
    let moved = false;
    while (this.gravityAcc >= step) {
      this.gravityAcc -= step;
      const cells = this.piece.cells.map(([x, y]) => [x, y + 1] as [number, number]);
      if (this.collides(cells)) break;
      this.piece.cells = cells;
      moved = true;
    }
    if (moved) this.lockAcc = 0;
    if (this.onGround()) {
      this.lockAcc += dt;
      if (this.lockAcc >= LOCK_DELAY) {
        this.lockAcc = 0;
        this.lock();
      }
    } else {
      this.lockAcc = 0;
    }
  }

  /** rows of the visible playfield for rendering, top row first */
  visibleRow(y: number): Uint8Array {
    return this.board.slice((y + HIDDEN_ROWS) * COLS, (y + HIDDEN_ROWS + 1) * COLS);
  }
}
