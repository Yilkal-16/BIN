'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthGate from '../../../components/AuthGate';
import { useTelegramUser } from '../../../components/TelegramProvider';
import { api } from '../../../lib/api';

const LETTERS = ['B', 'I', 'N', 'G', 'O'];
const HEADER_COLORS = {
  B: 'bg-[#1A2C53] text-white',
  I: 'bg-[#C11C84] text-white',
  N: 'bg-[#2F0F39] text-white',
  G: 'bg-[#0E5952] text-white',
  O: 'bg-gradient-to-br from-[#F6C97C] to-[#CF9146] text-[#3D2410]'
};
const NUMBER_COLORS = {
  B: 'text-[#5B84C4]',
  I: 'text-[#E356B0]',
  N: 'text-[#B080BE]',
  G: 'text-[#4FD1B8]',
  O: 'text-[#E8B87A]'
};
const BALL_COLORS = {
  B: 'from-[#3F63A8] to-[#1A2C53]',
  I: 'from-[#E356B0] to-[#C11C84]',
  N: 'from-[#7B4A8C] to-[#2F0F39]',
  G: 'from-[#2FB6A0] to-[#0E5952]',
  O: 'from-[#F6C97C] to-[#CF9146]'
};
const PATTERN_LABELS = {
  FULL_HOUSE: 'Full House',
  X_PATTERN: 'X Pattern',
  FOUR_CORNERS: 'Four Corners',
  DIAGONAL_LINE: 'Diagonal Line',
  VERTICAL_LINE: 'Vertical Line',
  HORIZONTAL_LINE: 'Horizontal Line'
};
const CONFETTI_COLORS = ['#E8A93B', '#2FB67C', '#E8615D', '#E356B0', '#5B84C4', '#4FD1B8', '#F6C97C'];

function letterFor(n) {
  return LETTERS[Math.floor((n - 1) / 15)];
}

// Returns the set of "r,c" keys that make up the winning pattern(s) of a grid
// (grid[row][col], FREE space = null and always marked).
function winningCells(grid, drawnSet, patterns) {
  const marked = (r, c) => grid[r][c] === null || drawnSet.has(grid[r][c]);
  const idx = [0, 1, 2, 3, 4];
  const cells = new Set();
  const add = (list) => list.forEach(([r, c]) => cells.add(`${r},${c}`));
  const complete = (list) => list.every(([r, c]) => marked(r, c));

  const rows = idx.map((r) => idx.map((c) => [r, c]));
  const cols = idx.map((c) => idx.map((r) => [r, c]));
  const main = idx.map((i) => [i, i]);
  const anti = idx.map((i) => [i, 4 - i]);
  const corners = [[0, 0], [0, 4], [4, 0], [4, 4]];

  (patterns || []).forEach((p) => {
    if (p === 'FULL_HOUSE') rows.forEach(add);
    else if (p === 'X_PATTERN') { add(main); add(anti); }
    else if (p === 'FOUR_CORNERS') add(corners);
    else if (p === 'DIAGONAL_LINE') [main, anti].filter(complete).forEach(add);
    else if (p === 'VERTICAL_LINE') cols.filter(complete).forEach(add);
    else if (p === 'HORIZONTAL_LINE') rows.filter(complete).forEach(add);
  });
  return cells;
}

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 36 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 1.6,
        size: 6 + Math.random() * 6,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        round: i % 3 === 0
      })),
    []
  );
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden z-20" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="absolute top-0 animate-confettiFall opacity-0"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.round ? p.size : p.size * 1.6,
            borderRadius: p.round ? '9999px' : '2px',
            backgroundColor: p.color,
            animationDelay: `${p.delay}s`
          }}
        />
      ))}
    </div>
  );
}

function usePrizeCount(target) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const total = Number(target) || 0;
    const start = performance.now();
    const duration = 1200;
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      setValue(Math.round(total * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return value;
}

function WinnerBoard({ winners, drawnNumbers, user }) {
  // Names for every winner; the matrix below shows only the first winner's cartela.
  const winner = winners[0];
  const multiple = winners.length > 1;
  const drawnSet = useMemo(() => new Set(drawnNumbers), [drawnNumbers]);
  const grid = winner.grid;
  const lastNumber = drawnNumbers.length ? drawnNumbers[drawnNumbers.length - 1] : null;
  const winCells = useMemo(
    () => (grid ? winningCells(grid, drawnSet, winner.pattern) : new Set()),
    [grid, drawnSet, winner.pattern]
  );
  const prize = usePrizeCount(winner.prizeAmount);
  const patternLabel = (winner.pattern || []).map((p) => PATTERN_LABELS[p] || p)[0];
  const nameFor = (w) =>
    user?.id && w.ownerId && w.ownerId.toString() === user.id.toString() ? 'You' : w.displayName || 'Player';

  return (
    <div className="rounded-card overflow-hidden border border-line bg-surface animate-riseIn">
      {/* Winner names */}
      <div className="px-4 py-2 text-center bg-gradient-to-r from-[#C98A1E] via-[#F2B94B] to-[#C98A1E] bg-[length:200%_100%] animate-bannerShine">
        <div className="flex flex-col items-center gap-1">
          {winners.map((w, i) => (
            <div key={i} className="flex flex-col items-center animate-popIn">
              <div
                className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 font-display font-bold text-[#2A1A00] ${
                  multiple ? 'text-xl' : 'text-2xl'
                }`}
              >
                <span>{nameFor(w)}</span>
                <span>WON !!</span>
              </div>
              {multiple && <span className="text-sm font-bold text-[#2A1A00]/80">ካርቴላ #{w.cartelaId}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="p-2">
        {grid ? (
          <div className="mx-auto max-w-[300px] rounded-xl border p-1.5 border-amber-400 bg-amber-400/10 shadow-lg shadow-amber-400/10">
            <div className="flex justify-between items-center mb-1 px-1">
              <span className="text-amber-400 text-sm font-extrabold">ካርቴላ #{winner.cartelaId}</span>
              <span className="text-[10px] text-amber-400 font-extrabold animate-pulse">🏆 WINNER</span>
            </div>
            <div className="grid grid-cols-5 gap-[2px] w-4/5 mx-auto">
              {LETTERS.map((l) => (
                <div key={l} className={`text-center text-sm font-extrabold py-0.5 rounded shadow-sm ${HEADER_COLORS[l]}`}>
                  {l}
                </div>
              ))}
              {grid.map((row, r) =>
                row.map((value, c) => {
                  const isFree = value === null;
                  const isMarked = !isFree && drawnSet.has(value);
                  const isWin = winCells.has(`${r},${c}`);
                  const isLast = value !== null && value === lastNumber;
                  const delay = `${(r * 5 + c) * 45}ms`;
                  const tone = isFree
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : isMarked
                    ? 'bg-amber-400 text-ink'
                    : `bg-[#252A34] ${NUMBER_COLORS[LETTERS[c]]}`;
                  return (
                    <div key={`${r}-${c}`} className="animate-cellPop" style={{ animationDelay: delay }}>
                      <div
                        className={`aspect-square rounded flex items-center justify-center text-sm font-mono font-extrabold ${tone} ${
                          isWin && !isFree ? 'animate-winGlow' : ''
                        } ${isLast ? 'ring-2 ring-white' : ''}`}
                        style={isWin ? { animationDelay: `${25 * 45 + 200}ms` } : undefined}
                      >
                        {isFree ? '★' : value}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <p className="text-center font-mono text-sm text-ivory">Cartela #{winner.cartelaId}</p>
        )}

        {/* Info row */}
        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-chip bg-surface2 border border-line py-2 px-1">
            <p className="text-[10px] uppercase tracking-wide text-mute">Pattern</p>
            <p className="font-display font-semibold text-xs text-ivory mt-0.5">{patternLabel || '—'}</p>
          </div>
          <div className="rounded-chip bg-surface2 border border-line py-2 px-1">
            <p className="text-[10px] uppercase tracking-wide text-mute">Numbers called</p>
            <p className="font-display font-semibold text-xs text-ivory mt-0.5">{drawnNumbers.length}</p>
          </div>
          <div className="rounded-chip bg-surface2 border border-line py-2 px-1">
            <p className="text-[10px] uppercase tracking-wide text-mute">Prize</p>
            <p className="font-display font-semibold text-xs text-emerald mt-0.5">+{prize} Birr</p>
          </div>
        </div>

        {/* Winning number */}
        {lastNumber !== null && (
          <div className="mt-2 flex flex-col items-center">
            <p className="text-[10px] uppercase tracking-wide text-mute mb-1">Winning number</p>
            <div
              className={`w-16 h-16 rounded-full bg-gradient-to-br ${BALL_COLORS[letterFor(lastNumber)]} ring-4 ring-gold/40 shadow-lg flex flex-col items-center justify-center animate-ballDrop`}
              style={{ animationDelay: '1300ms' }}
            >
              <span className={`text-[10px] font-bold leading-none ${letterFor(lastNumber) === 'O' ? 'text-[#3D2410]' : 'text-white/80'}`}>
                {letterFor(lastNumber)}
              </span>
              <span className={`font-mono font-extrabold text-2xl leading-none ${letterFor(lastNumber) === 'O' ? 'text-[#3D2410]' : 'text-white'}`}>
                {lastNumber}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WinnerContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const gameId = searchParams.get('gameId');
  const { user, refreshProfile } = useTelegramUser();

  const [game, setGame] = useState(null);
  const [error, setError] = useState(null);
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    if (!gameId) return;
    let attempts = 0;
    const poll = async () => {
      try {
        const { gameState } = await api.getGameState(gameId);
        if (gameState.status === 'COMPLETED') {
          setGame(gameState);
          refreshProfile();
          return;
        }
      } catch (err) {
        setError(err.message);
        return;
      }
      attempts += 1;
      if (attempts < 15) setTimeout(poll, 1000);
    };
    poll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  useEffect(() => {
    if (!game) return undefined;
    const t = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [game]);

  // Auto-advance to cartela selection for the next round once the countdown
  // ends, instead of dropping the player back at the lobby (which required
  // an extra "Play Now" tap to get back into a game).
  useEffect(() => {
    if (game && countdown === 0) router.replace(`/game/cartela-selection?stake=${game.stake}`);
  }, [game, countdown, router]);

  if (error) {
    return <p className="text-center text-coral text-sm py-16 px-6">{error}</p>;
  }

  if (!game) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] gap-3">
        <div className="w-10 h-10 rounded-full border-2 border-line border-t-gold animate-spin" />
        <p className="text-mute text-sm">Settling the round…</p>
      </div>
    );
  }

  const didIWin = (game.winners || []).some((w) => w.ownerId && w.ownerId.toString() === user.id?.toString());

  return (
    <div className="px-6 pt-3 text-center">
      {!game.noWinner && <Confetti />}
      {game.noWinner ? (
        <>
          <div className="text-5xl mb-4">🎯</div>
          <h1 className="font-display font-bold text-2xl text-ivory mb-2">No Winner This Round</h1>
          <p className="text-mute text-sm">The pool rolls over into the next game.</p>
        </>
      ) : (
        <>
          <div className="text-5xl mb-1 animate-popIn">{didIWin ? '🏆' : '🎉'}</div>
          <h1 className="font-display font-bold text-3xl text-gold mb-1">BINGO!</h1>
          <p className="text-mute text-sm mb-3">{didIWin ? 'You won this round!' : 'Round complete'}</p>

          <div className="mb-3">
            <WinnerBoard winners={game.winners} drawnNumbers={game.drawnNumbers || []} user={user} />
          </div>
        </>
      )}

      <p className="text-mute text-xs">Next round starts in {countdown}s</p>
    </div>
  );
}

function winnerHeadline(winner, user) {
  if (!winner.ownerId || winner.ownerId === 'system-admin') return winner.displayName ? `${winner.displayName} Won` : 'CARTELA WON!';
  if (user.id && winner.ownerId.toString() === user.id.toString()) return 'You Won';
  return `${winner.displayName || 'Player'} Won`;
}

export default function WinnerPage() {
  return (
    <AuthGate hideNav>
      <WinnerContent />
    </AuthGate>
  );
}