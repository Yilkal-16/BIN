'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthGate from '../../../components/AuthGate';
import { useTelegramUser } from '../../../components/TelegramProvider';
import { api } from '../../../lib/api';

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
    <div className="px-6 pt-14 text-center">
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
          <p className="text-mute text-sm mb-8">{didIWin ? 'You won this round!' : 'Round complete'}</p>

          <div className="space-y-3 mb-8">
            {game.winners.map((w, i) => (
              <div key={i} className="flex items-center justify-between bg-surface border border-line rounded-chip px-4 py-3">
                <div className="text-left">
                  <p className="font-mono text-sm text-ivory">Cartela #{w.cartelaId}</p>
                  <p className="text-ivory/80 text-xs">{winnerName(w, user)}</p>
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

function winnerName(winner, user) {
  if (!winner.ownerId || winner.ownerId === 'system-admin') return 'House Cartela';
  if (user.id && winner.ownerId.toString() === user.id.toString()) return user.displayName || user.username || 'You';
  return winner.displayName || 'Player';
}

function winnerLabel(winner, user) {
  if (!winner.ownerId || winner.ownerId === 'system-admin') return 'CARTELA WON!';
  if (user.id && winner.ownerId.toString() === user.id.toString()) return 'You won!';
  return 'Won this round';
}

export default function WinnerPage() {
  return (
    <AuthGate hideNav>
      <WinnerContent />
    </AuthGate>
  );
}