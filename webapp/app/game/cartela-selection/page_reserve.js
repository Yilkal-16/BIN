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

// B/I/N/G/O accent colors — shared "brand" for the whole game flow so the
// selection grid and the live board read as the same product.
const COLUMN_ACCENTS = {
  B: { text: 'text-sky-400', solid: 'bg-sky-500', soft: 'bg-sky-500/15 border-sky-500/30' },
  I: { text: 'text-violet-400', solid: 'bg-violet-500', soft: 'bg-violet-500/15 border-violet-500/30' },
  N: { text: 'text-pink-400', solid: 'bg-pink-500', soft: 'bg-pink-500/15 border-pink-500/30' },
  G: { text: 'text-emerald-400', solid: 'bg-emerald-500', soft: 'bg-emerald-500/15 border-emerald-500/30' },
  O: { text: 'text-amber-400', solid: 'bg-amber-500', soft: 'bg-amber-500/15 border-amber-500/30' }
};

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
  // null = "haven't checked yet", 0 = confirmed no cartela this round, >0 = owns cartela(s)
  const [ownedCount, setOwnedCount] = useState(null);
  const purchasedRef = useRef(false);

  const loadAvailability = useCallback(async (gid) => {
    const { cartelas } = await api.getAvailableCartelas(gid);
    const available = new Set(cartelas);
    const taken = new Set();
    for (let id = 1; id <= TOTAL_CARTELAS; id++) if (!available.has(id)) taken.add(id);
    setTakenIds(taken);
    setSelected((prev) => prev.filter((id) => !taken.has(id)));
  }, []);

  // Initial load: figure out what round is running right now.
  useEffect(() => {
    (async () => {
      try {
        const { gameState } = await api.getLobby(10);
        setGameId(gameState.gameId);
        setStatus(gameState.status);
        if (gameState.status === 'WAITING') {
          await loadAvailability(gameState.gameId);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAvailability]);

  // Whenever we land on (or transition into) a round that's already live,
  // find out whether this player actually has a cartela in it. This is what
  // makes "Play Now" resolve to the right screen: live session + owns a
  // cartela -> live game; live session + owns nothing -> "No Cartelas Bought".
  useEffect(() => {
    if (!gameId || status === 'WAITING' || purchasedRef.current) return;
    let cancelled = false;
    setOwnedCount(null);
    api
      .getMyCartelas(gameId)
      .then(({ cartelas }) => {
        if (cancelled) return;
        if (cartelas && cartelas.length > 0) {
          purchasedRef.current = true;
          router.replace(`/game/live?gameId=${gameId}`);
        } else {
          setOwnedCount(0);
        }
      })
      .catch(() => !cancelled && setOwnedCount(0));
    return () => {
      cancelled = true;
    };
  }, [gameId, status, router]);

  useEffect(() => {
    if (!socket || !connected || !gameId) return undefined;
    socket.emit('join_game', { gameId });

    const onState = (payload) => {
      if (payload.gameId !== gameId) return;
      setStatus(payload.status);
      if (payload.status === 'ACTIVE' && purchasedRef.current) {
        router.replace(`/game/live?gameId=${gameId}`);
      }
      if (payload.status === 'WAITING') {
        // New round started — reset and show the board again.
        purchasedRef.current = false;
        setOwnedCount(null);
        setSelected([]);
        loadAvailability(gameId);
      }
    };
    const onCartelaUpdate = (payload) => {
      if (payload.gameId && payload.gameId !== gameId) return;
      if (payload.status === 'bulk-allocated') {
        loadAvailability(gameId);
        return;
      }
      const ids = payload.cartelaIds || (payload.cartelaId != null ? [payload.cartelaId] : []);
      setTakenIds((prev) => {
        const newTaken = new Set([...prev, ...ids]);
        setSelected((prevSelected) => prevSelected.filter((id) => !newTaken.has(id)));
        return newTaken;
      });
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
      const availableSelected = selected.filter((id) => !takenIds.has(id));
      if (availableSelected.length === 0) {
        setError('Selected cartelas are no longer available');
        setSelected([]);
        setBusy(false);
        return;
      }
      setSelected(availableSelected);
      await api.purchaseCartelas(gameId, availableSelected);
      purchasedRef.current = true;
      notifyHaptic('success');
      await refreshProfile();
      router.push(`/game/live?gameId=${gameId}`);
    } catch (err) {
      setError(err.message);
      if (err.code === 'CARTELA_UNAVAILABLE') {
        await loadAvailability(gameId);
        setSelected((prev) => prev.filter((id) => !takenIds.has(id)));
      }
    } finally {
      setBusy(false);
    }
  };

  const totalCost = selected.length * 10;
  const canAfford = user.mainWalletBalance >= totalCost;
  const showNoCartelas = status !== 'WAITING' && ownedCount === 0 && !purchasedRef.current;
  const checkingOwnership = status !== 'WAITING' && ownedCount === null && !purchasedRef.current;

  return (
    <div className="px-4 pt-6">
      <header className="flex items-center justify-between mb-4">
        <button onClick={() => router.push('/game/lobby')} className="text-mute text-sm active:opacity-60">
          ← Back
        </button>
        <div className="text-center">
          <p className="text-mute text-[11px] uppercase tracking-wide">Stake</p>
          <p className="font-display font-bold text-gold text-lg">10 Birr</p>
        </div>
        <div className="text-right">
          <p className="text-mute text-[11px] uppercase tracking-wide">Balance</p>
          <p className="font-mono text-ivory text-base font-semibold">{user.mainWalletBalance}</p>
        </div>
      </header>

      {countdown != null && status === 'WAITING' && (
        <div className="mb-4 flex items-center justify-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-chip py-2.5">
          <span className="text-amber-200 text-xs font-medium">Selection closes in</span>
          <span className="font-mono font-bold text-amber-400 text-lg tabular-nums">{countdown}s</span>
        </div>
      )}

      {error && (
        <p className="text-coral text-sm text-center mb-3 bg-coral/10 border border-coral/30 rounded-chip py-2 px-3">
          {error}
        </p>
      )}

      {loading || checkingOwnership ? (
        <div className="text-center text-mute py-16">
          <div className="w-8 h-8 mx-auto mb-3 rounded-full border-2 border-line border-t-gold animate-spin" />
          {loading ? 'Loading the board…' : 'Checking your cartelas…'}
        </div>
      ) : showNoCartelas ? (
        <NoCartelasBought onBack={() => router.push('/game/lobby')} />
      ) : (
        <>
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
                    'aspect-square rounded-chip text-xs font-mono font-semibold flex items-center justify-center transition-all',
                    isSelected
                      ? 'bg-gold text-ink font-bold scale-105 shadow-lg shadow-gold/30'
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

          <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[560px] bg-surface border-t border-line px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between mb-2 text-sm">
              <span className="text-mute font-medium">
                {selected.length}/{MAX_SELECTABLE} selected
              </span>
              <span className="font-mono text-ivory font-bold text-base">{totalCost} Birr</span>
            </div>
            <button
              onClick={handleBuy}
              disabled={selected.length === 0 || busy || !canAfford}
              className="w-full bg-gold disabled:bg-line disabled:text-mute text-ink font-display font-bold text-base py-4 rounded-card active:scale-[0.98] transition-transform shadow-lg shadow-gold/20 disabled:shadow-none"
            >
              {!canAfford && selected.length > 0 ? 'Insufficient balance' : busy ? 'Confirming…' : 'Buy Cartela(s)'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Shown when the current round is already live and the player didn't buy in this time. */
function NoCartelasBought({ onBack }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20 px-4">
      <div className="w-20 h-20 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-4xl mb-5">
        🎟️
      </div>
      <h2 className="font-display font-bold text-ivory text-xl mb-2">No Cartelas Bought</h2>
      <p className="text-mute text-sm max-w-[280px] mb-1">
        This round is already in progress and you didn't select a cartela in time.
      </p>
      <p className="text-mute text-sm max-w-[280px] mb-6">The board will reopen automatically for the next round.</p>
      <div className="flex items-center gap-2 text-emerald-400 text-xs font-medium mb-6">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        Waiting for next round…
      </div>
      <button
        onClick={onBack}
        className="px-6 py-3 rounded-card bg-surface2 border border-line text-ivory text-sm font-semibold active:scale-[0.98] transition-transform"
      >
        Back to Lobby
      </button>
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
