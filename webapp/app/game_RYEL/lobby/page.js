'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import AuthGate from '../../../components/AuthGate';
import { useTelegramUser } from '../../../components/TelegramProvider';
import { api, STAKES } from '../../../lib/api';
import { hapticFeedback } from '../../../lib/telegram';

function LobbyContent() {
  const { user } = useTelegramUser();
  const router = useRouter();
  const [stake, setStake] = useState(STAKES[0]);
  const [lobby, setLobby] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (selectedStake) => {
    setLoading(true);
    setError(null);
    try {
      const { gameState } = await api.getLobby(selectedStake);
      setLobby(gameState);
    } catch (err) {
      setError(err.message);
      setLobby(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(stake); }, [load, stake]);

  const handleSelectStake = (s) => {
    if (s === stake) return;
    hapticFeedback('light');
    setStake(s);
  };

  const handleJoin = () => {
    hapticFeedback('medium');
    router.push(`/game/cartela-selection?stake=${stake}`);
  };

  return (
    <div className="px-5 pt-8">
      <header className="flex items-center justify-between mb-8">
        <div>
          <p className="text-mute text-xs uppercase tracking-[0.18em]">Welcome back</p>
          <h1 className="font-display font-semibold text-2xl text-ivory">{user.displayName}</h1>
        </div>
        <div className="text-right">
          <p className="text-mute text-xs">Balance</p>
          <p className="font-mono text-gold text-lg">{user.mainWalletBalance} <span className="text-xs text-mute">Birr</span></p>
        </div>
      </header>

      <p className="text-mute text-xs uppercase tracking-[0.18em] mb-2">Choose a stake</p>
      <div className="grid grid-cols-4 gap-2 mb-6">
        {STAKES.map((s) => (
          <button
            key={s}
            onClick={() => handleSelectStake(s)}
            className={`rounded-chip py-3 font-display font-bold text-sm transition-transform active:scale-[0.97] ${
              s === stake
                ? 'bg-gold text-ink shadow-lg shadow-gold/20'
                : 'bg-surface2 text-ivory border border-line'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="relative rounded-card overflow-hidden bg-gradient-to-br from-surface2 to-surface border border-line p-6 mb-6">
        <div className="absolute -right-8 -top-8 w-32 h-32 rounded-full bg-gold/10" />
        <p className="text-mute text-xs uppercase tracking-[0.18em] mb-1">Stake</p>
        <p className="font-display font-bold text-4xl text-gold mb-4">{stake} <span className="text-lg text-mute font-body font-normal">Birr / cartela</span></p>

        {loading ? (
          <div className="h-16 flex items-center text-mute text-sm">Checking the room…</div>
        ) : error ? (
          <div className="text-coral text-sm">{error}</div>
        ) : (
          <div className="grid grid-cols-2 gap-4 mb-2">
            <Stat label="Players in" value={lobby?.playersCount ?? 0} />
            <Stat label="Status" value={statusLabel(lobby?.status)} />
          </div>
        )}
      </div>

      <button
        onClick={handleJoin}
        className="w-full bg-gold hover:bg-gold/90 active:scale-[0.98] transition-transform text-ink font-display font-semibold text-lg py-4 rounded-card shadow-lg shadow-gold/10"
      >
        Play Now
      </button>

      <button onClick={() => load(stake)} className="w-full text-mute text-xs mt-4 py-2">
        Refresh
      </button>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-ink/40 rounded-chip px-4 py-3">
      <p className="text-mute text-[11px] uppercase tracking-wide">{label}</p>
      <p className="font-display font-semibold text-ivory text-lg">{value}</p>
    </div>
  );
}

function statusLabel(status) {
  if (status === 'WAITING') return 'Selecting';
  if (status === 'ACTIVE') return 'Live';
  if (status === 'SETTLING') return 'Settling';
  return '—';
}

export default function LobbyPage() {
  return (
    <AuthGate>
      <LobbyContent />
    </AuthGate>
  );
}
