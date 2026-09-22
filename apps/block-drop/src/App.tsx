import { useCallback, useEffect, useRef, useState } from 'react';
import { getClient } from './client';
import {
  COLS,
  Game,
  SPRINT_LINES,
  ULTRA_SECONDS,
  VISIBLE_ROWS,
  type Mode,
  type PieceKind,
} from './tetris';

type Screen = 'menu' | 'game';

const BLOCK_COLORS: Record<PieceKind, string> = {
  I: '#22d3ee',
  O: '#facc15',
  T: '#c084fc',
  S: '#4ade80',
  Z: '#f87171',
  J: '#60a5fa',
  L: '#fb923c',
};
const KIND_INDEX: PieceKind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

const CELL = 23;
const PW = COLS * CELL; // 230
const PH = VISIBLE_ROWS * CELL; // 460

const MODES: Array<{ id: Mode; name: string; tag: string; hint: string }> = [
  { id: 'classic', name: 'Classic', tag: 'Endless', hint: 'Survive. Speed rises every 10 lines.' },
  { id: 'sprint', name: 'Sprint', tag: '40 lines', hint: 'Clear 40 lines as fast as you can.' },
  { id: 'ultra', name: 'Ultra', tag: '2:00', hint: 'Score as much as possible in 2 minutes.' },
];

function fmtTime(ms: number): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${m}:${s.toString().padStart(2, '0')}.${tenths}`;
}

// best-effort durable best scores: device store first, localStorage fallback
function bestKey(mode: Mode): string { return `block-drop:best:${mode}`; }

async function loadBest(mode: Mode): Promise<number | null> {
  try {
    const r = await Promise.race([
      getClient().store.get({ key: bestKey(mode) }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 900)),
    ]);
    if (r.ok && r.response.value != null) {
      const n = Number(r.response.value);
      if (Number.isFinite(n)) return n;
    }
  } catch { /* fall through to localStorage */ }
  const v = localStorage.getItem(bestKey(mode));
  return v === null ? null : Number(v);
}

async function saveBest(mode: Mode, value: number): Promise<void> {
  try { localStorage.setItem(bestKey(mode), String(value)); } catch { /* ignore */ }
  try {
    await Promise.race([
      getClient().store.put({ key: bestKey(mode), value: String(value) }),
      new Promise((res) => setTimeout(res, 900)),
    ]);
  } catch { /* daemon unreachable, local copy is enough */ }
}

function isBetter(mode: Mode, value: number, best: number | null): boolean {
  if (best === null) return true;
  return mode === 'sprint' ? value < best : value > best;
}

function drawPieceMini(
  ctx: CanvasRenderingContext2D,
  kind: PieceKind,
  ox: number,
  oy: number,
  size: number,
): void {
  // spawn orientation cells for the preview boxes
  const spawn: Record<PieceKind, Array<[number, number]>> = {
    I: [[0, 1], [1, 1], [2, 1], [3, 1]],
    O: [[1, 0], [2, 0], [1, 1], [2, 1]],
    T: [[1, 0], [0, 1], [1, 1], [2, 1]],
    S: [[1, 0], [2, 0], [0, 1], [1, 1]],
    Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
    J: [[0, 0], [0, 1], [1, 1], [2, 1]],
    L: [[2, 0], [0, 1], [1, 1], [2, 1]],
  };
  ctx.fillStyle = BLOCK_COLORS[kind];
  for (const [x, y] of spawn[kind]) {
    ctx.fillRect(ox + x * size, oy + y * size, size - 1, size - 1);
  }
}

// Portrait detection: the daemon pins the layout viewport at 800x480 and
// rotates the panel, so CSS (orientation: portrait) and Tailwind portrait:
// variants never match on-device. screen.orientation does report the rotated
// orientation (portraitSecondary at 270 deg), so check it first and keep
// matchMedia as the fallback (same approach as Calendar 0.1.7 / Radio 0.6.6).
function detectPortrait(): boolean {
  try {
    if (screen.orientation?.type.startsWith('portrait')) return true;
  } catch {
    /* older webview */
  }
  try {
    if (window.matchMedia('(orientation: portrait)').matches) return true;
  } catch {
    /* no matchMedia */
  }
  return false;
}

function useIsPortrait(): boolean {
  const [portrait, setPortrait] = useState(detectPortrait);
  useEffect(() => {
    const update = (): void => setPortrait(detectPortrait());
    let orientation: ScreenOrientation | null = null;
    let mq: MediaQueryList | null = null;
    try {
      orientation = screen.orientation;
      orientation.addEventListener('change', update);
      mq = window.matchMedia('(orientation: portrait)');
      mq.addEventListener('change', update);
    } catch {
      /* listeners unavailable */
    }
    return () => {
      try {
        orientation?.removeEventListener('change', update);
        mq?.removeEventListener('change', update);
      } catch {
        /* ignore */
      }
    };
  }, []);
  return portrait;
}

export default function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('menu');
  const [mode, setMode] = useState<Mode>('classic');
  const [tick, setTick] = useState(0);
  const [bests, setBests] = useState<Record<Mode, number | null>>({ classic: null, sprint: null, ultra: null });
  const gameRef = useRef<Game | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wheelAcc = useRef(0);
  const lastKnobPress = useRef(0);
  const escTimer = useRef<number | null>(null);
  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const dasRef = useRef<{ dir: -1 | 1; next: number } | null>(null);
  const portrait = useIsPortrait();

  const game = gameRef.current;

  useEffect(() => {
    (async () => {
      const b = await Promise.all((['classic', 'sprint', 'ultra'] as Mode[]).map(loadBest));
      setBests({ classic: b[0], sprint: b[1], ultra: b[2] });
    })();
  }, []);

  const startGame = useCallback((m: Mode, seed?: number) => {
    const g = new Game(m, { onEvent: () => setTick(t => t + 1) }, seed);
    gameRef.current = g;
    setMode(m);
    setScreen('game');
    setTick(t => t + 1);
  }, []);

  const quitToMenu = useCallback(() => {
    gameRef.current = null;
    setScreen('menu');
  }, []);

  // deterministic screenshot seams: ?shot=menu | game | over
  // ?debug=1 exposes the live game for headless interaction tests
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') {
      (window as unknown as { __blockdrop: () => Game | null }).__blockdrop = () => gameRef.current;
    }
    const shot = params.get('shot');
    if (shot === 'menu') return;
    if (shot === 'game' || shot === 'over') {
      const g = new Game('classic', { onEvent: () => setTick(t => t + 1) }, 7);
      // script a believable mid-game stack
      const targets = [0, -1, 1, -2, 2, 0, -1, 1, -3, 2, -2, 0, 1, -1];
      for (const dx of targets) {
        if (g.over) break;
        for (let i = 0; i < Math.abs(dx); i++) g.move(dx > 0 ? 1 : -1);
        if (dx % 3 === 0) g.rotate();
        g.hardDrop();
        g.tick(16);
      }
      if (shot === 'over') {
        g.score = 128400;
        g.lines = 87;
        g.level = 9;
        g.over = true;
      }
      gameRef.current = g;
      setMode('classic');
      setScreen('game');
      setTick(t => t + 1);
    }
  }, []);

  // main loop: advance the sim and paint the playfield
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const g = gameRef.current;
      const dt = Math.min(100, now - last);
      last = now;
      if (g && screen === 'game') {
        // held left/right buttons get auto-repeat
        const das = dasRef.current;
        if (das && !g.paused && !g.over && now >= das.next) {
          g.move(das.dir);
          das.next = now + 45;
        }
        g.tick(dt);
        paint(g);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [screen]);

  const paint = (g: Game): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== PW * dpr) { canvas.width = PW * dpr; canvas.height = PH * dpr; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PW, PH);

    // locked cells
    for (let y = 0; y < VISIBLE_ROWS; y++) {
      const row = g.visibleRow(y);
      const flashing = g.clearing.includes(y + 2); // clearing uses absolute rows
      for (let x = 0; x < COLS; x++) {
        const v = row[x];
        if (v === 0) continue;
        const kind = KIND_INDEX[v - 1];
        ctx.fillStyle = flashing ? '#ffffff' : BLOCK_COLORS[kind];
        ctx.globalAlpha = flashing ? 0.9 : 1;
        ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, 4);
      }
    }

    if (!g.over && g.piece) {
      // ghost
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      for (const [x, y] of g.ghostCells()) {
        const vy = y - 2;
        if (vy < 0) continue;
        ctx.fillRect(x * CELL + 1, vy * CELL + 1, CELL - 2, CELL - 2);
      }
      // active piece
      const color = BLOCK_COLORS[g.piece.kind];
      for (const [x, y] of g.piece.cells) {
        const vy = y - 2;
        if (vy < 0) continue;
        ctx.fillStyle = color;
        ctx.fillRect(x * CELL + 1, vy * CELL + 1, CELL - 2, CELL - 2);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(x * CELL + 1, vy * CELL + 1, CELL - 2, 4);
      }
    }

    // faint grid
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < COLS; x++) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, PH); }
    for (let y = 1; y < VISIBLE_ROWS; y++) { ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(PW, y * CELL + 0.5); }
    ctx.stroke();
  };

  // record a finished run against the best score
  useEffect(() => {
    const g = gameRef.current;
    if (!g || !g.over || screen !== 'game') return;
    const value = g.mode === 'sprint' ? Math.round(g.timeMs) : g.score;
    if (g.mode === 'sprint' && !g.won) return; // unfinished sprint does not count
    if (isBetter(g.mode, value, bests[g.mode])) {
      saveBest(g.mode, value).then(() =>
        setBests(b => ({ ...b, [g.mode]: value })),
      );
    }
  }, [tick, screen, bests]);

  // ---- input ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const g = gameRef.current;
      if (e.key >= '1' && e.key <= '4') {
        e.preventDefault();
        if (screen === 'menu') {
          const m = MODES[Number(e.key) - 1];
          if (m) startGame(m.id);
        } else if (g) {
          if (e.key === '4') g.togglePause();
          else {
            const m = MODES[Number(e.key) - 1];
            if (m && m.id !== g.mode) startGame(m.id);
          }
        }
        return;
      }
      if (e.key === 'Escape') {
        // on the menu, let the event through so the platform back button exits the app
        if (screen === 'game' && g) {
          e.preventDefault();
          if (g.over || g.paused) { quitToMenu(); return; }
          if (e.repeat) return;
          // short press = hard drop, long press (hold 600ms) = exit to menu
          if (escTimer.current !== null) clearTimeout(escTimer.current);
          escTimer.current = window.setTimeout(() => {
            escTimer.current = null;
            quitToMenu();
          }, 600);
        }
        return;
      }
      if (screen === 'menu') {
        if (e.key === 'm' || e.key === 'M') {
          const i = MODES.findIndex(m => m.id === mode);
          setMode(MODES[(i + 1) % MODES.length].id);
        }
        if (e.key === 'Enter' || e.key === ' ') startGame(mode);
        return;
      }
      if (!g || g.paused || g.over) {
        if ((e.key === 'Enter' || e.key === ' ') && g && (g.paused || g.over)) {
          if (g.over) startGame(g.mode);
          else g.togglePause();
        }
        return;
      }
      // knob press arrives as space/enter: rotate, debounced
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        const now = performance.now();
        if (now - lastKnobPress.current > 200) {
          lastKnobPress.current = now;
          g.rotate();
        }
        return;
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); g.move(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); g.move(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); g.softDrop(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); g.rotate(); }
      else if (e.key === 'h' || e.key === 'H') g.hold();
      else if (e.key === 'p' || e.key === 'P') g.togglePause();
    };
    const onWheel = (e: WheelEvent) => {
      const g = gameRef.current;
      if (screen !== 'game' || !g || g.paused || g.over) return;
      const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (dx === 0) return;
      e.preventDefault();
      // one detent = exactly one column: accumulate to the detent threshold,
      // step a single column, then reset — never jump multiple columns
      wheelAcc.current += dx;
      const step = 24;
      if (Math.abs(wheelAcc.current) >= step) {
        g.move(wheelAcc.current > 0 ? 1 : -1);
        wheelAcc.current = 0;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escTimer.current !== null) {
        // released before the long-press fired: short press = hard drop
        clearTimeout(escTimer.current);
        escTimer.current = null;
        const g = gameRef.current;
        if (g && screen === 'game' && !g.paused && !g.over) g.hardDrop();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      if (escTimer.current !== null) { clearTimeout(escTimer.current); escTimer.current = null; }
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('wheel', onWheel);
    };
  }, [screen, mode, startGame, quitToMenu]);

  // touch gestures on the playfield: tap rotates, swipe moves, swipe down drops
  const onBoardPointerDown = (e: React.PointerEvent): void => {
    touchRef.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onBoardPointerUp = (e: React.PointerEvent): void => {
    const g = gameRef.current;
    const start = touchRef.current;
    touchRef.current = null;
    if (!g || !start || g.paused || g.over) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = performance.now() - start.t;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 300) { g.rotate(); return; }
    if (dy > 70 && Math.abs(dy) > Math.abs(dx) * 1.4) { g.hardDrop(); return; }
    const steps = Math.round(dx / 30);
    for (let i = 0; i < Math.abs(steps); i++) g.move(steps > 0 ? 1 : -1);
  };

  const holdMove = (dir: -1 | 1) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      const g = gameRef.current;
      if (!g || g.paused || g.over) return;
      g.move(dir);
      dasRef.current = { dir, next: performance.now() + 170 };
    },
    onPointerUp: () => { dasRef.current = null; },
    onPointerLeave: () => { dasRef.current = null; },
  });

  if (screen === 'menu') {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center bg-screen font-body select-none">
        <div className={`rise mb-1 font-display font-extrabold tracking-tight text-fg ${portrait ? 'text-[52px]' : 'text-hero'}`}>BLOCK DROP</div>
        <div className="mb-8 text-body text-dim">a tiny falling-block game for the car thing</div>
        <div className={portrait ? 'flex flex-col items-center gap-4' : 'flex gap-4'}>
          {MODES.map((m, i) => {
            const best = bests[m.id];
            return (
              <button
                key={m.id}
                onClick={() => startGame(m.id)}
                className={portrait ? 'pressable flex h-40 w-[min(88vw,380px)] flex-col items-start justify-between rounded-2xl border border-rule-strong bg-bg p-4 text-left' : 'pressable flex h-52 w-56 flex-col items-start justify-between rounded-2xl border border-rule-strong bg-bg p-5 text-left'}
              >
                <div>
                  <div className="font-display text-title font-bold text-fg">{m.name}</div>
                  <div className="mt-1 text-small font-semibold text-accent">{m.tag}</div>
                  <div className="mt-3 text-small leading-snug text-muted">{m.hint}</div>
                </div>
                <div className="flex w-full items-center justify-between">
                  <span className="text-tiny text-dim">
                    {best === null ? 'no best yet' : m.id === 'sprint' ? `best ${fmtTime(best)}` : `best ${best.toLocaleString()}`}
                  </span>
                  <span className="rounded-md bg-accent-soft px-2 py-1 font-mono text-tiny font-bold text-accent">preset {i + 1}</span>
                </div>
              </button>
            );
          })}
        </div>
        <div className={`mt-8 text-small text-dim ${portrait ? 'px-6 text-center' : ''}`}>
          knob: move · knob press: rotate · swipe down: drop · esc: drop · hold esc: exit
        </div>
      </div>
    );
  }

  // ---- game screen ----
  const g = game!;
  const modeLabel = MODES.find(m => m.id === g.mode)!.name.toUpperCase();
  const timeLabel = fmtTime(g.timeMs);
  const statValue = g.mode === 'classic' ? g.lines.toString() : g.mode === 'sprint' ? `${Math.min(g.lines, SPRINT_LINES)}/${SPRINT_LINES}` : timeLabel;
  const statName = g.mode === 'classic' ? 'LINES' : g.mode === 'sprint' ? 'LINES' : 'TIME LEFT';

  const btn = 'pressable flex items-center justify-center rounded-xl border border-rule-strong bg-bg font-display font-bold text-fg';

  // ---- portrait (480x800): vertical reflow; landscape below is untouched ----
  // gated on the JS detectPortrait() state (screen.orientation), never on CSS,
  // because the daemon pins the layout viewport at 800x480 and rotates the panel.
  if (portrait) {
    return (
      <div className="flex h-screen w-screen flex-col bg-screen font-body select-none">
        {/* hero: playfield centered in the middle */}
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 pt-3">
          <div
            className="relative rounded-lg border border-rule-strong bg-bg"
            style={{ width: PW + 2, height: PH + 2, touchAction: 'none' }}
            onPointerDown={onBoardPointerDown}
            onPointerUp={onBoardPointerUp}
          >
            <canvas ref={canvasRef} style={{ width: PW, height: PH }} className="m-[1px] block" />
          </div>
        </div>

        {/* below the playfield: score strip */}
        <div className="flex w-full items-end justify-between gap-2 px-4 pt-2">
          <div className="shrink-0">
            <div className="font-display text-[18px] font-extrabold leading-none tracking-tight text-fg">BLOCK<br />DROP</div>
            <div className="mt-1 text-tiny font-bold tracking-widest text-accent">{modeLabel}</div>
          </div>
          <div>
            <div className="text-tiny font-bold tracking-widest text-dim">SCORE</div>
            <div className="font-display text-[20px] font-bold tabular-nums text-fg">{g.score.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-tiny font-bold tracking-widest text-dim">{statName}</div>
            <div className="font-display text-[20px] font-bold tabular-nums text-fg">{statValue}</div>
          </div>
          {g.mode === 'classic' && (
            <div>
              <div className="text-tiny font-bold tracking-widest text-dim">LEVEL</div>
              <div className="font-display text-[20px] font-bold tabular-nums text-fg">{g.level}</div>
            </div>
          )}
          <div>
            <div className="text-tiny font-bold tracking-widest text-dim">BEST</div>
            <div className="text-[16px] font-semibold tabular-nums text-muted">
              {bests[g.mode] === null ? '—' : g.mode === 'sprint' ? fmtTime(bests[g.mode]!) : bests[g.mode]!.toLocaleString()}
            </div>
          </div>
        </div>

        {/* hold + next in one row */}
        <div className="flex w-full items-start justify-center gap-4 px-4 pt-2">
          <div>
            <div className="mb-1 text-center text-tiny font-bold tracking-widest text-dim">HOLD</div>
            <MiniBox kind={g.holdKind} dim={!g.canHold} onTap={() => g.hold()} />
          </div>
          <div>
            <div className="mb-1 text-center text-tiny font-bold tracking-widest text-dim">NEXT</div>
            <div className="flex gap-2">
              {g.queue.slice(0, 3).map((k, i) => (
                <MiniBox key={i} kind={k} dim={i > 0} />
              ))}
            </div>
          </div>
        </div>

        {/* bottom: control buttons */}
        <div className="w-full px-4 pb-4 pt-2">
          <div className="flex gap-3">
            <button className={`${btn} h-14 flex-1 text-[20px]`} onPointerDown={e => { e.preventDefault(); g.rotate(); }}>
              ⟳ ROTATE
            </button>
            <button className={`${btn} h-14 flex-1 text-[20px]`} onPointerDown={e => { e.preventDefault(); g.hardDrop(); }}>
              ⤓ DROP
            </button>
          </div>
          <div className="mt-3 flex gap-3">
            <button className={`${btn} h-14 flex-1 text-[22px]`} {...holdMove(-1)}>◀</button>
            <button className={`${btn} h-14 flex-1 text-[22px]`} {...holdMove(1)}>▶</button>
            <button className={`${btn} h-14 flex-1 text-body`} onPointerDown={e => { e.preventDefault(); g.hold(); }}>HOLD</button>
            <button className={`${btn} h-14 flex-1 text-body`} onPointerDown={e => { e.preventDefault(); g.togglePause(); }}>II</button>
          </div>
        </div>

        {/* pause overlay */}
        {g.paused && !g.over && (
          <Overlay>
            <div className="font-display text-title font-extrabold text-fg">PAUSED</div>
            <OverlayBtn label="RESUME" primary onClick={() => g.togglePause()} />
            <OverlayBtn label="RESTART" onClick={() => startGame(g.mode)} />
            <OverlayBtn label="MENU" onClick={quitToMenu} />
          </Overlay>
        )}

        {/* game over overlay */}
        {g.over && (
          <Overlay>
            <div className="font-display text-title font-extrabold text-fg">{g.won ? 'SPRINT DONE' : 'GAME OVER'}</div>
            <div className="flex gap-8 text-center">
              <Stat label="SCORE" value={g.score.toLocaleString()} />
              <Stat label={g.mode === 'ultra' ? 'TIME' : 'LINES'} value={g.mode === 'ultra' ? fmtTime(ULTRA_SECONDS * 1000) : g.lines.toString()} />
              {g.mode === 'sprint' && g.won && <Stat label="TIME" value={fmtTime(g.timeMs)} />}
              {g.mode === 'classic' && <Stat label="LEVEL" value={g.level.toString()} />}
            </div>
            {g.mode === 'sprint' && g.won && bests.sprint !== null && (
              <div className="text-body text-accent">best {fmtTime(bests.sprint)}</div>
            )}
            <OverlayBtn label="PLAY AGAIN" primary onClick={() => startGame(g.mode)} />
            <OverlayBtn label="MENU" onClick={quitToMenu} />
          </Overlay>
        )}
        <span className="hidden">{tick}</span>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen items-stretch gap-0 bg-screen font-body select-none">
      {/* left: stats */}
      <div className="flex w-44 shrink-0 flex-col justify-center gap-5 px-5">
        <div>
          <div className="font-display text-[22px] font-extrabold tracking-tight text-fg">BLOCK<br />DROP</div>
          <div className="mt-1 text-tiny font-bold tracking-widest text-accent">{modeLabel}</div>
        </div>
        <div>
          <div className="text-tiny font-bold tracking-widest text-dim">SCORE</div>
          <div className="font-display text-[30px] font-bold tabular-nums text-fg">{g.score.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-tiny font-bold tracking-widest text-dim">{statName}</div>
          <div className="font-display text-[30px] font-bold tabular-nums text-fg">{statValue}</div>
        </div>
        {g.mode === 'classic' && (
          <div>
            <div className="text-tiny font-bold tracking-widest text-dim">LEVEL</div>
            <div className="font-display text-[30px] font-bold tabular-nums text-fg">{g.level}</div>
          </div>
        )}
        <div>
          <div className="text-tiny font-bold tracking-widest text-dim">BEST</div>
          <div className="text-body font-semibold tabular-nums text-muted">
            {bests[g.mode] === null ? '—' : g.mode === 'sprint' ? fmtTime(bests[g.mode]!) : bests[g.mode]!.toLocaleString()}
          </div>
        </div>
      </div>

      {/* playfield */}
      <div className="flex items-center py-2.5">
        <div
          className="relative rounded-lg border border-rule-strong bg-bg"
          style={{ width: PW + 2, height: PH + 2, touchAction: 'none' }}
          onPointerDown={onBoardPointerDown}
          onPointerUp={onBoardPointerUp}
        >
          <canvas ref={canvasRef} style={{ width: PW, height: PH }} className="m-[1px] block" />
        </div>
      </div>

      {/* next + hold */}
      <div className="flex w-28 shrink-0 flex-col items-center justify-center gap-4 px-2">
        <div>
          <div className="mb-1 text-center text-tiny font-bold tracking-widest text-dim">HOLD</div>
          <MiniBox kind={g.holdKind} dim={!g.canHold} onTap={() => g.hold()} />
        </div>
        <div>
          <div className="mb-1 text-center text-tiny font-bold tracking-widest text-dim">NEXT</div>
          <div className="flex flex-col gap-2">
            {g.queue.slice(0, 3).map((k, i) => (
              <MiniBox key={i} kind={k} dim={i > 0} />
            ))}
          </div>
        </div>
      </div>

      {/* right: big controls */}
      <div className="flex flex-1 flex-col justify-center gap-3 px-4 py-4">
        <button className={`${btn} h-20 text-[22px]`} onPointerDown={e => { e.preventDefault(); g.rotate(); }}>
          ⟳ ROTATE
        </button>
        <div className="flex gap-3">
          <button className={`${btn} h-20 flex-1 text-[26px]`} {...holdMove(-1)}>◀</button>
          <button className={`${btn} h-20 flex-1 text-[26px]`} {...holdMove(1)}>▶</button>
        </div>
        <button className={`${btn} h-20 text-[22px]`} onPointerDown={e => { e.preventDefault(); g.hardDrop(); }}>
          ⤓ DROP
        </button>
        <div className="flex gap-3">
          <button className={`${btn} h-16 flex-1 text-body`} onPointerDown={e => { e.preventDefault(); g.hold(); }}>HOLD</button>
          <button className={`${btn} h-16 flex-1 text-body`} onPointerDown={e => { e.preventDefault(); g.togglePause(); }}>II</button>
        </div>
        <div className="mt-1 text-center text-tiny leading-relaxed text-dim">
          knob: move · press: rotate<br />1-3: mode · 4: pause · esc: drop · hold: exit
        </div>
      </div>

      {/* pause overlay */}
      {g.paused && !g.over && (
        <Overlay>
          <div className="font-display text-title font-extrabold text-fg">PAUSED</div>
          <OverlayBtn label="RESUME" primary onClick={() => g.togglePause()} />
          <OverlayBtn label="RESTART" onClick={() => startGame(g.mode)} />
          <OverlayBtn label="MENU" onClick={quitToMenu} />
        </Overlay>
      )}

      {/* game over overlay */}
      {g.over && (
        <Overlay>
          <div className="font-display text-title font-extrabold text-fg">{g.won ? 'SPRINT DONE' : 'GAME OVER'}</div>
          <div className="flex gap-8 text-center">
            <Stat label="SCORE" value={g.score.toLocaleString()} />
            <Stat label={g.mode === 'ultra' ? 'TIME' : 'LINES'} value={g.mode === 'ultra' ? fmtTime(ULTRA_SECONDS * 1000) : g.lines.toString()} />
            {g.mode === 'sprint' && g.won && <Stat label="TIME" value={fmtTime(g.timeMs)} />}
            {g.mode === 'classic' && <Stat label="LEVEL" value={g.level.toString()} />}
          </div>
          {g.mode === 'sprint' && g.won && bests.sprint !== null && (
            <div className="text-body text-accent">best {fmtTime(bests.sprint)}</div>
          )}
          <OverlayBtn label="PLAY AGAIN" primary onClick={() => startGame(g.mode)} />
          <OverlayBtn label="MENU" onClick={quitToMenu} />
        </Overlay>
      )}
      <span className="hidden">{tick}</span>
    </div>
  );
}

function MiniBox({ kind, dim, onTap }: { kind: PieceKind | null; dim?: boolean; onTap?: () => void }): React.JSX.Element {
  return (
    <div
      className={`grid h-16 w-20 place-items-center rounded-lg border border-rule bg-bg ${onTap ? 'pressable' : ''}`}
      style={{ opacity: dim ? 0.45 : 1 }}
      onPointerDown={onTap ? (e) => { e.preventDefault(); onTap(); } : undefined}
    >
      {kind && <MiniPiece kind={kind} />}
    </div>
  );
}

function MiniPiece({ kind }: { kind: PieceKind }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 64, H = 40;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const size = kind === 'I' ? 13 : 15;
    drawPieceMini(ctx, kind, (W - 4 * size) / 2, (H - 2 * size) / 2, size);
  }, [kind]);
  return <canvas ref={ref} style={{ width: 64, height: 40 }} />;
}

function Overlay({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/70 backdrop-blur-[2px]">
      {children}
    </div>
  );
}

function OverlayBtn({ label, primary, onClick }: { label: string; primary?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`pressable h-16 w-72 rounded-xl border font-display text-[22px] font-bold ${
        primary ? 'border-transparent bg-accent text-black' : 'border-rule-strong bg-bg text-fg'
      }`}
    >
      {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-tiny font-bold tracking-widest text-dim">{label}</div>
      <div className="font-display text-[26px] font-bold tabular-nums text-fg">{value}</div>
    </div>
  );
}
