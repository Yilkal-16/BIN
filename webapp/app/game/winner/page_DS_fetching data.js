'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthGate from '../../../components/AuthGate';
import { useTelegramUser } from '../../../components/TelegramProvider';
import { api } from '../../../lib/api';

// --- CONSTANTS (same as live page) ---
const LETTERS = ['B', 'I', 'N', 'G', 'O'];
const COLUMN_ACCENTS = {
  B: {
    text: 'text-sky-400',
    solid: 'bg-sky-500',
    soft: 'bg-sky-500/15 border-sky-500/40',
    ring: 'ring-sky-400'
  },
  I: {
    text: 'text-violet-400',
    solid: 'bg-violet-500',
    soft: 'bg-violet-500/15 border-violet-500/40',
    ring: 'ring-violet-400'
  },
  N: {
    text: 'text-pink-400',
    solid: 'bg-pink-500',
    soft: 'bg-pink-500/15 border-pink-500/40',
    ring: 'ring-pink-400'
  },
  G: {
    text: 'text-emerald-400',
    solid: 'bg-emerald-500',
    soft: 'bg-emerald-500/15 border-emerald-500/40',
    ring: 'ring-emerald-400'
  },
  O: {
    text: 'text-amber-400',
    solid: 'bg-amber-500',
    soft: 'bg-amber-500/15 border-amber-400/40',
    ring: 'ring-amber-400'
  }
};

// --- COMPONENT: WINNER CARTELA CARD (matches live page exactly) ---
function WinnerCartelaCard({ cartela, markedSet }) {
  return (
    <div className="rounded-xl border border-amber-400 bg-amber-400/10 shadow-lg shadow-amber-400/10 p-2 max-w-sm mx-auto">
      <div className="flex justify-between items-center mb-2 px-1">
        <span className="text-amber-400 text-xs font-extrabold">#{cartela.cartelaId}</span>
        <span className="text-[10px] text-amber-400 font-extrabold animate-pulse">🏆 WINNER</span>
      </div>

      <div className="grid grid-cols-5 gap-[3px]">
        {/* B I N G O headers */}
        {LETTERS.map((l) => {
          const accent = COLUMN_ACCENTS[l];
          return (
            <div
              key={l}
              className={`text-center text-xs font-extrabold py-1 rounded ${accent.solid} text-white shadow-sm`}
            >
              {l}
            </div>
          );
        })}

        {cartela.grid.map((row, r) =>
          row.map((cell, c) => {
            const isFree = cell === null;
            const isMarked = isFree || markedSet.has(cell);
            const colAccent = COLUMN_ACCENTS[LETTERS[c]];

            return (
              <div
                key={`${r}-${c}`}
                className={`aspect-square rounded flex items-center justify-center text-xs font-mono font-bold ${
                  isFree
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : isMarked
                    ? 'bg-amber-400 text-ink'
                    : `bg-[#252A34] ${colAccent.text}`
                }`}
              >
                {isFree ? '★' : cell}
              </div>
            );
          })
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
  const [winnerCartela, setWinnerCartela] = useState(null);

  // Fetch the winning cartela data
  const fetchWinnerCartela = async (gameState) => {
    if (!gameState.winners || gameState.winners.length === 0) return;

    // Pick the first winner
    const firstWinner = gameState.winners[0];
    const cartelaId = firstWinner.cartelaId;

    try {
      // Fetch all cartelas for this game
      const { cartelas } = await api.getMyCartelas(gameId);
      
      // Find the specific winner cartela
      const found = cartelas.find(c => c.cartelaId === cartelaId);
      if (found) {
        setWinnerCartela(found);
      }
    } catch (err) {
      console.warn('Failed to fetch winner cartela:', err);
      // We'll show the cartela placeholder if we can't load it
    }
  };

  useEffect(() => {
    if (!gameId) return;
    let attempts = 0;
    const poll = async () => {
      try {
        const { gameState } = await api.getGameState(gameId);
        if (gameState.status === 'COMPLETED') {
          setGame(gameState);
          refreshProfile();
          // Fetch the winning cartela
          await fetchWinnerCartela(gameState);
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

  // Auto-advance to cartela selection for the next round
  useEffect(() => {
    if (game && countdown === 0) router.replace('/game/cartela-selection');
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
  const firstWinner = game.winners?.[0];
  const hasMultipleWinners = game.winners?.length > 1;
  const markedSet = new Set(game.calledNumbers || []);

  return (
    <div className="px-4 pt-8 text-center overflow-y-auto max-h-screen pb-8">
      {game.noWinner ? (
        <>
          <div className="text-5xl mb-4">🎯</div>
          <h1 className="font-display font-bold text-2xl text-ivory mb-2">No Winner This Round</h1>
          <p className="text-mute text-sm">The pool rolls over into the next game.</p>
        </>
      ) : (
        <>
          <div className="text-6xl mb-3 animate-popIn">{didIWin ? '🏆' : '🎉'}</div>
          <h1 className="font-display font-bold text-3xl text-gold mb-2">BINGO!</h1>
          <p className="text-mute text-sm mb-4">{didIWin ? 'You won this round!' : 'Round complete'}</p>

          {/* Winner Cartela Display - matches live page exactly */}
          {winnerCartela ? (
            <div className="mb-6">
              <WinnerCartelaCard
                cartela={winnerCartela}
                markedSet={markedSet}
              />
              {hasMultipleWinners && (
                <p className="text-mute text-[10px] mt-2">
                  Showing 1 of {game.winners.length} winning cartelas
                </p>
              )}
            </div>
          ) : (
            // Fallback: show a simple placeholder if cartela data isn't available
            <div className="max-w-sm mx-auto mb-6 p-4 bg-[#1A1D24] rounded-xl border border-[#2A2F3A]">
              <div className="flex flex-col items-center gap-2">
                <span className="text-amber-400 text-sm font-extrabold">
                  🎟️ Winner Cartela #{firstWinner?.cartelaId || '—'}
                </span>
                <p className="text-mute text-xs">Loading cartela data...</p>
              </div>
            </div>
          )}

          {/* Winner list */}
          <div className="space-y-3 mb-8 max-w-sm mx-auto">
            {game.winners.map((w, i) => (
              <div key={i} className="flex items-center justify-between bg-surface border border-line rounded-chip px-4 py-3">
                <div className="text-left">
                  <p className="font-mono text-sm text-ivory">Cartela #{w.cartelaId}</p>
                  <p className="text-mute text-[11px]">{winnerLabel(w, user)}</p>
                </div>
                <p className="font-display font-semibold text-emerald">+{w.prizeAmount} Birr</p>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="text-mute text-xs">Next round starts in {countdown}s</p>
    </div>
  );
}

function winnerLabel(winner, user) {
  if (!winner.ownerId || winner.ownerId === 'system-admin') return 'CARTELA WON!';
  if (user.id && winner.ownerId.toString() === user.id.toString()) return 'You';
  return winner.displayName || 'CARTELA WON!';
}

export default function WinnerPage() {
  return (
    <AuthGate hideNav>
      <WinnerContent />
    </AuthGate>
  );
}