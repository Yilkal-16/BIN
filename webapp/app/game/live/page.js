'use client';
import { useEffect, useState, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthGate from '../../../components/AuthGate';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { useGameState } from '../../../hooks/useGameState';
import { api } from '../../../lib/api';
import { notifyHaptic } from '../../../lib/telegram';

const COLUMN_COLORS = ['text-gold', 'text-emerald', 'text-ivory', 'text-coral', 'text-mute'];

function LiveContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const gameId = searchParams.get('gameId');
  const { socket, connected } = useWebSocket();
  const gameState = useGameState(socket, connected, gameId);

  const [myCartelas, setMyCartelas] = useState([]);
  const [autoMode, setAutoMode] = useState(true);
  const [navigatedAway, setNavigatedAway] = useState(false);

  useEffect(() => {
    if (!gameId) return;
    api.getMyCartelas(gameId).then(({ cartelas }) => setMyCartelas(cartelas)).catch(() => {});
  }, [gameId]);

  useEffect(() => {
    if (navigatedAway) return;
    if (gameState.winners || gameState.status === 'COMPLETED' || gameState.status === 'SETTLING') {
      notifyHaptic('success');
      setNavigatedAway(true);
      router.replace(`/game/winner?gameId=${gameId}`);
    }
  }, [gameState.winners, gameState.status, gameId, router, navigatedAway]);

  const markedSet = useMemo(() => new Set(gameState.calledNumbers), [gameState.calledNumbers]);

  return (
    <div className="px-4 pt-5 pb-8">
      <header className="flex items-center justify-between mb-4 text-xs">
        <span className="text-mute font-mono">{gameId}</span>
        <span className="text-mute">{gameState.playersCount} players</span>
        <span className="text-gold font-mono">{gameState.grossPrizePool} Birr pool</span>
      </header>

      <div className="flex flex-col items-center mb-5">
        <BallDisplay lastCalled={gameState.lastCalled} />
        <p className="text-mute text-xs mt-2">{gameState.calledNumbers.length} of 75 called</p>
      </div>

      <div className="flex gap-1.5 overflow-x-auto mb-6 pb-1 -mx-1 px-1">
        {[...gameState.calledNumbers].reverse().slice(0, 14).map((n) => (
          <div key={n} className="shrink-0 w-8 h-8 rounded-full bg-surface2 border border-line flex items-center justify-center text-[11px] font-mono text-ivory animate-slideIn">
            {n}
          </div>
        ))}
      </div>

      {myCartelas.length === 0 ? (
        <p className="text-center text-mute text-sm py-10">Loading your cartela…</p>
      ) : (
        <div className="space-y-6">
          {myCartelas.map((c) => (
            <CartelaCard key={c.cartelaId} cartela={c} markedSet={markedSet} />
          ))}
        </div>
      )}

      <div className="flex gap-3 mt-8">
        <button
          onClick={() => setAutoMode((v) => !v)}
          className={`flex-1 py-3 rounded-chip text-sm font-medium border ${autoMode ? 'bg-emerald/15 text-emerald border-emerald/30' : 'bg-surface2 text-mute border-line'}`}
        >
          Auto-daub {autoMode ? 'on' : 'off'}
        </button>
        <button
          onClick={() => router.push('/game/lobby')}
          className="flex-1 py-3 rounded-chip text-sm font-medium bg-surface2 text-mute border border-line"
        >
          Leave
        </button>
      </div>
    </div>
  );
}

function BallDisplay({ lastCalled }) {
  if (!lastCalled) {
    return (
      <div className="w-28 h-28 rounded-full bg-surface2 border border-line flex items-center justify-center">
        <span className="text-mute text-xs">Waiting…</span>
      </div>
    );
  }
  return (
    <div
      key={lastCalled.number}
      className="w-28 h-28 rounded-full bg-gradient-to-br from-gold to-gold/70 shadow-xl shadow-gold/20 flex flex-col items-center justify-center animate-popIn"
    >
      <span className="text-ink/70 font-display font-semibold text-sm">{lastCalled.letter}</span>
      <span className="text-ink font-display font-bold text-3xl leading-none">{lastCalled.number}</span>
    </div>
  );
}

function CartelaCard({ cartela, markedSet }) {
  return (
    <div className={`rounded-card border p-3 ${cartela.isWinner ? 'border-gold bg-gold/5' : 'border-line bg-surface'}`}>
      <p className="text-mute text-[11px] font-mono mb-2 text-center">Cartela #{cartela.cartelaId}</p>
      <div className="grid grid-cols-5 gap-1.5">
        {['B', 'I', 'N', 'G', 'O'].map((l, i) => (
          <div key={l} className={`text-center text-[11px] font-display font-semibold ${COLUMN_COLORS[i]}`}>{l}</div>
        ))}
        {cartela.grid.map((row, r) =>
          row.map((cell, c) => {
            const isFree = cell === null;
            const isMarked = isFree || markedSet.has(cell);
            return (
              <div
                key={`${r}-${c}`}
                className={[
                  'aspect-square rounded-chip flex items-center justify-center text-sm font-mono',
                  isFree ? 'bg-emerald/20 text-emerald font-semibold' : isMarked ? 'bg-gold text-ink font-semibold' : 'bg-surface2 text-ivory'
                ].join(' ')}
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

export default function LivePage() {
  return (
    <AuthGate hideNav>
      <LiveContent />
    </AuthGate>
  );
}
