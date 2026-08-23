'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import AuthGate from '../../../components/AuthGate';
import { useTelegramUser } from '../../../components/TelegramProvider';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { api } from '../../../lib/api';
import { hapticFeedback, notifyHaptic } from '../../../lib/telegram';

const MAX_SELECTABLE = 2;
const TOTAL_CARTELAS = 600;

function SelectionContent() {
  const { user, refreshProfile } = useTelegramUser();
  const router = useRouter();
  const { socket, connected } = useWebSocket();

  const [gameId, setGameId] = useState(null);
  const [takenIds, setTakenIds] = useState(new Set());
  const [selected, setSelected] = useState([]);
  const [countdown, setCountdown] = useState(null);
  const [status, setStatus] = useState('WAITING');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const purchasedRef = useRef(false);

  const loadAvailability = useCallback(async (gid) => {
    const { cartelas } = await api.getAvailableCartelas(gid);
    const available = new Set(cartelas);
    const taken = new Set();
    for (let id = 1; id <= TOTAL_CARTELAS; id++) if (!available.has(id)) taken.add(id);
    setTakenIds(taken);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { gameState } = await api.getLobby(10);
        setGameId(gameState.gameId);
        setStatus(gameState.status);
        await loadAvailability(gameState.gameId);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAvailability]);

  useEffect(() => {
    if (!socket || !connected || !gameId) return undefined;
    socket.emit('join_game', { gameId });

    const onState = (payload) => {
      if (payload.gameId !== gameId) return;
      setStatus(payload.status);
      if (payload.status === 'ACTIVE') {
        if (purchasedRef.current) router.replace(`/game/live?gameId=${gameId}`);
      }
    };
    const onCartelaUpdate = (payload) => {
      if (payload.gameId && payload.gameId !== gameId) return;
      if (payload.status === 'bulk-allocated') {
        loadAvailability(gameId);
        return;
      }
      const ids = payload.cartelaIds || (payload.cartelaId != null ? [payload.cartelaId] : []);
      setTakenIds((prev) => new Set([...prev, ...ids]));
    };
    const onCountdown = (payload) => setCountdown(payload.remainingSeconds);

    socket.on('game_state_update', onState);
    socket.on('cartela_update', onCartelaUpdate);
    socket.on('countdown_update', onCountdown);
    return () => {
      socket.off('game_state_update', onState);
      socket.off('cartela_update', onCartelaUpdate);
      socket.off('countdown_update', onCountdown);
    };
  }, [socket, connected, gameId, router, loadAvailability]);

  const toggleCartela = (id) => {
    if (takenIds.has(id) || purchasedRef.current) return;
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((c) => c !== id);
      if (prev.length >= MAX_SELECTABLE) return prev;
      hapticFeedback('light');
      return [...prev, id];
    });
  };

  const handleBuy = async () => {
    if (selected.length === 0 || !gameId) return;
    setBusy(true);
    setError(null);
    try {
      await api.purchaseCartelas(gameId, selected);
      purchasedRef.current = true;
      notifyHaptic('success');
      await refreshProfile();
      router.push(`/game/live?gameId=${gameId}`);
    } catch (err) {
      setError(err.message);
      if (err.code === 'CARTELA_UNAVAILABLE') await loadAvailability(gameId);
    } finally {
      setBusy(false);
    }
  };

  const totalCost = selected.length * 10;
  const canAfford = user.mainWalletBalance >= totalCost;

  return (
    <div className="px-4 pt-6">
      <header className="flex items-center justify-between mb-4">
        <button onClick={() => router.push('/game/lobby')} className="text-mute text-sm">← Back</button>
        <div className="text-center">
          <p className="text-mute text-[11px] uppercase tracking-wide">Stake</p>
          <p className="font-display font-semibold text-gold">10 Birr</p>
        </div>
        <div className="text-right">
          <p className="text-mute text-[11px] uppercase tracking-wide">Balance</p>
          <p className="font-mono text-ivory text-sm">{user.mainWalletBalance}</p>
        </div>
      </header>

      {countdown != null && status === 'WAITING' && (
        <div className="mb-4 flex items-center justify-center gap-2 bg-surface2 rounded-chip py-2 border border-line">
          <span className="text-mute text-xs">Selection closes in</span>
          <span className="font-mono font-semibold text-gold text-base tabular-nums">{countdown}s</span>
        </div>
      )}

      {error && <p className="text-coral text-sm text-center mb-3">{error}</p>}

      {loading ? (
        <div className="text-center text-mute py-16">Loading the board…</div>
      ) : (
        <div className="grid grid-cols-8 gap-1.5 mb-28 max-h-[58vh] overflow-y-auto pr-1">
          {Array.from({ length: TOTAL_CARTELAS }, (_, i) => i + 1).map((id) => {
            const isTaken = takenIds.has(id);
            const isSelected = selected.includes(id);
            return (
              <button
                key={id}
                disabled={isTaken || purchasedRef.current}
                onClick={() => toggleCartela(id)}
                className={[
                  'aspect-square rounded-chip text-[11px] font-mono flex items-center justify-center transition-colors',
                  isSelected
                    ? 'bg-gold text-ink font-semibold'
                    : isTaken
                    ? 'bg-surface text-line cursor-not-allowed'
                    : 'bg-surface2 text-ivory active:bg-line'
                ].join(' ')}
              >
                {id}
              </button>
            );
          })}
        </div>
      )}

      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[560px] bg-surface border-t border-line px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between mb-2 text-sm">
          <span className="text-mute">{selected.length}/{MAX_SELECTABLE} selected</span>
          <span className="font-mono text-ivory">{totalCost} Birr</span>
        </div>
        <button
          onClick={handleBuy}
          disabled={selected.length === 0 || busy || !canAfford}
          className="w-full bg-gold disabled:bg-line disabled:text-mute text-ink font-display font-semibold py-3.5 rounded-card active:scale-[0.98] transition-transform"
        >
          {!canAfford && selected.length > 0 ? 'Insufficient balance' : busy ? 'Confirming…' : 'Buy Cartela(s)'}
        </button>
      </div>
    </div>
  );
}

export default function CartelaSelectionPage() {
  return (
    <AuthGate hideNav>
      <SelectionContent />
    </AuthGate>
  );
}
