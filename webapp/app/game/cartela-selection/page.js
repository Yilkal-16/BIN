'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthGate from '../../../components/AuthGate';
import { useTelegramUser } from '../../../components/TelegramProvider';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { api, STAKES } from '../../../lib/api';
import { hapticFeedback, notifyHaptic } from '../../../lib/telegram';

const MAX_SELECTABLE = 2;
const TOTAL_CARTELAS = 256;

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
  const searchParams = useSearchParams();
  const stakeParam = Number(searchParams.get('stake'));
  const stake = STAKES.includes(stakeParam) ? stakeParam : STAKES[0];
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
  // Synchronous double-submit guard. `busy` (React state) only disables the
  // button on the NEXT render, not instantly — a fast double-tap (common in
  // Telegram's in-app WebView) can fire handleBuy twice before that render
  // happens, sending a second POST /purchase for the same cartelas right
  // after the first one already succeeded. The backend then legitimately
  // rejects the second request ("maximum 2 cartelas") or it fails for some
  // other transient reason ("failed to fetch") — and that stale rejection
  // was getting shown to the player as if their purchase had failed, even
  // though it had already gone through. A ref is checked/set synchronously,
  // before any re-render, so it closes that race completely.
  const purchaseInProgressRef = useRef(false);

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
        const { gameState } = await api.getLobby(stake);
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
  }, [loadAvailability, stake]);

  // Once a round is live, send everyone straight to the live page — whether
  // or not they bought a cartela in time. This mirrors Beteseb Bingo: a
  // player without a cartela still gets to watch the numbers get called
  // live, with a "No Cartelas Bought" placeholder shown in the live page
  // instead of being stranded here behind a locked selection screen.
  // Ownership itself (buyer vs. spectator) is resolved by the live page.
  //
  // Guarded by `busy`: if a purchase request is still in flight when the
  // round flips to ACTIVE (e.g. the player tapped Buy right as the
  // countdown ended), we must NOT navigate away mid-request — that yanks
  // the page out from under handleBuy's in-flight `api.purchaseCartelas`
  // call, producing misleading "failed to fetch" / validation errors even
  // when the purchase itself already succeeded server-side. Instead we wait
  // for the request to settle (busy -> false); handleBuy's own redirect
  // handles the success case, and if it failed we still send the player to
  // live as a spectator once busy clears.
  useEffect(() => {
    if (!gameId || status === 'WAITING' || purchasedRef.current || busy) return;
    purchasedRef.current = true;
    router.replace(`/game/live?gameId=${gameId}`);
  }, [gameId, status, router, busy]);

  useEffect(() => {
    if (!socket || !connected || !gameId) return undefined;
    socket.emit('join_game', { gameId });

    const onState = (payload) => {
      if (payload.gameId !== gameId) return;
      setStatus(payload.status);
      if (payload.status === 'WAITING') {
        // New round started — reset and show the board again.
        purchasedRef.current = false;
        setSelected([]);
        loadAvailability(gameId).catch(() => {});
      }
    };
    const onCartelaUpdate = (payload) => {
      if (payload.gameId && payload.gameId !== gameId) return;
      if (payload.status === 'bulk-allocated') {
        // Once a purchase has already succeeded, availability no longer
        // matters to this player — skip the call entirely rather than risk
        // a late/irrelevant response (or error) after they've already
        // bought in. Also never let this throw unhandled: it's a background
        // refresh, not a user action, and must never surface as an error.
        if (!purchasedRef.current) loadAvailability(gameId).catch(() => {});
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
    if (purchaseInProgressRef.current || purchasedRef.current) return; // synchronous guard — see purchaseInProgressRef comment above
    purchaseInProgressRef.current = true;

    setBusy(true);
    setError(null);
    try {
      const availableSelected = selected.filter((id) => !takenIds.has(id));
      if (availableSelected.length === 0) {
        setError('Selected cartelas are no longer available');
        setSelected([]);
        return;
      }
      setSelected(availableSelected);
      await api.purchaseCartelas(gameId, availableSelected);
      purchasedRef.current = true;
      notifyHaptic('success');
      await refreshProfile();
      router.push(`/game/live?gameId=${gameId}`);
    } catch (err) {
      // If a purchase already succeeded (e.g. this was a stray duplicate
      // request settling late), the error is stale — the player already
      // has their cartela(s), so don't show it.
      if (!purchasedRef.current) {
        setError(err.message);
        if (err.code === 'CARTELA_UNAVAILABLE') {
          await loadAvailability(gameId).catch(() => {});
          setSelected((prev) => prev.filter((id) => !takenIds.has(id)));
        }
      }
    } finally {
      setBusy(false);
      purchaseInProgressRef.current = false;
    }
  };

  const totalCost = selected.length * stake;
  const canAfford = user.mainWalletBalance >= totalCost;
  // Once the round isn't WAITING anymore, the effect above is already
  // sending the player to the live page — show a brief "joining" spinner
  // for that instant instead of the (now stale) selection grid.
  const joiningLive = status !== 'WAITING';

  return (
    <div className="relative px-4 pt-6 isolate overflow-hidden bg-[#0c0a16]">
      {/* Ambient indigo rim-light — light lives at the extreme edges only,
          the way trim lighting hugs a dash rail, rather than a fog filling
          the middle of the screen where it would fight the gold accents. */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 -left-24 w-64 h-64 rounded-full bg-indigo-500/20 blur-[110px]" />
        <div className="absolute -top-32 -right-24 w-64 h-64 rounded-full bg-indigo-500/20 blur-[110px]" />
      </div>

      <header className="relative flex items-center justify-between mb-4 pb-4">
        {/* Hairline trim under the header — a crisp gradient edge instead of
            a glow blob, echoing the pinstripe light along a dash rail. */}
        <div
          className="absolute left-0 right-0 bottom-0 h-px"
          style={{ backgroundImage: 'linear-gradient(90deg, transparent, rgba(99,102,241,0.5), transparent)' }}
        />
        <button onClick={() => router.push('/game/lobby')} className="text-mute text-sm active:opacity-60">
          ← Back
        </button>
        <div className="text-center">
          <p className="text-mute text-[11px] uppercase tracking-wide">Stake</p>
          <p className="font-display font-bold text-gold text-lg drop-shadow-[0_0_12px_rgba(99,102,241,0.4)]">{stake} Birr</p>
        </div>
        <div className="text-right">
          <p className="text-mute text-[11px] uppercase tracking-wide">Balance</p>
          <p className="font-mono text-ivory text-base font-semibold">{user.mainWalletBalance}</p>
        </div>
      </header>

      {countdown != null && status === 'WAITING' && (
        <div className="mb-4 flex items-center justify-center gap-2 bg-violet-500/10 border border-violet-400/30 rounded-chip py-2.5">
          <span className="text-violet-200 text-xs font-medium">Selection closes in</span>
          <span className="font-mono font-bold text-violet-300 text-lg tabular-nums">{countdown}s</span>
        </div>
      )}

      {error && (
        <p className="text-coral text-sm text-center mb-3 bg-coral/10 border border-coral/30 rounded-chip py-2 px-3">
          {error}
        </p>
      )}

      {loading || joiningLive ? (
        <div className="text-center text-mute py-16">
          <div className="w-8 h-8 mx-auto mb-3 rounded-full border-2 border-line border-t-gold animate-spin" />
          {loading ? 'Loading the board…' : 'Joining the live round…'}
        </div>
      ) : (
        <>
          <div
            className="mb-28 rounded-card p-px"
            style={{ backgroundImage: 'linear-gradient(155deg, rgba(99,102,241,0.45), rgba(99,102,241,0.05) 40%, transparent 70%)' }}
          >
            <div className="grid grid-cols-8 gap-1.5 max-h-[58vh] overflow-y-auto pr-1 rounded-card bg-[#0c0a16] p-2">
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
                        ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white font-bold scale-105 shadow-lg shadow-violet-500/40 ring-2 ring-white/40'
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
          </div>

          <div
            className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[560px] bg-[#140f22] px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
            style={{ borderTop: '1px solid transparent', borderImage: 'linear-gradient(90deg, transparent, rgba(99,102,241,0.55), transparent) 1' }}
          >
            <div className="flex items-center justify-between mb-2 text-sm">
              <span className="text-mute font-medium">
                {selected.length}/{MAX_SELECTABLE} selected
              </span>
              <span className="font-mono text-ivory font-bold text-base">{totalCost} Birr</span>
            </div>
            <button
              onClick={handleBuy}
              disabled={selected.length === 0 || busy || !canAfford}
              className="w-full bg-gradient-to-r from-violet-600 to-fuchsia-600 disabled:bg-line disabled:bg-none disabled:text-mute text-white font-display font-bold text-base py-4 rounded-card active:scale-[0.98] transition-transform shadow-lg shadow-violet-500/30 ring-1 ring-white/20 disabled:ring-0 disabled:shadow-none"
            >
              {!canAfford && selected.length > 0 ? 'Insufficient balance' : busy ? 'Confirming…' : 'Buy Cartela(s)'}
            </button>
          </div>
        </>
      )}
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
