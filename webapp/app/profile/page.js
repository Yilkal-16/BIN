'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import AuthGate from '../../components/AuthGate';
import { useTelegramUser } from '../../components/TelegramProvider';
import { api } from '../../lib/api';

/*
 * Data contract for the leaderboard + games count.
 * Expected from `api.getProfileStats()` (GET /profile/stats, authenticated):
 *
 *   {
 *     gamesPlayed: 42,                       // games where the player bought >= 1 cartela
 *     weekly:  { topPercent: 8, spent: 340, endsAt: '2026-10-05T21:00:00.000Z' },
 *     monthly: { topPercent: 15, spent: 1260, endsAt: '2026-10-31T21:00:00.000Z' }
 *   }
 *
 * `topPercent` is 1..100 ("Top 8%" = ahead of 92% of players), ranked by total
 * Birr spent on cartelas in that period. Use `null` when the player has not
 * bought anything in the period. `spent` and `endsAt` are optional.
 */

const PERIODS = [
  { key: 'weekly', label: 'This Week', noun: 'week' },
  { key: 'monthly', label: 'This Month', noun: 'month' }
];

const TIERS = [
  { max: 1, label: 'Legend', chip: 'from-amber-400 to-yellow-300 text-amber-950' },
  { max: 5, label: 'Diamond', chip: 'from-cyan-400 to-sky-300 text-sky-950' },
  { max: 10, label: 'Platinum', chip: 'from-violet-400 to-fuchsia-400 text-violet-950' },
  { max: 25, label: 'Gold', chip: 'from-amber-500 to-orange-400 text-orange-950' },
  { max: 50, label: 'Silver', chip: 'from-slate-300 to-slate-100 text-slate-900' },
  { max: 100, label: 'Rising Star', chip: 'from-emerald-400 to-teal-300 text-emerald-950' }
];

function tierFor(topPercent) {
  return TIERS.find((t) => topPercent <= t.max) || TIERS[TIERS.length - 1];
}

function formatReset(endsAt) {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return d >= 1 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

function ProfileContent() {
  const { user } = useTelegramUser();
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [period, setPeriod] = useState('weekly');
  const aliveRef = useRef(true);

  const loadStats = useCallback(async () => {
    setStatus('loading');
    try {
      if (typeof api.getProfileStats !== 'function') throw new Error('unavailable');
      const data = await api.getProfileStats();
      if (!aliveRef.current) return;
      setStats(data);
      setStatus('ready');
    } catch {
      if (aliveRef.current) setStatus('error');
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    loadStats();
    return () => {
      aliveRef.current = false;
    };
  }, [loadStats]);

  // Games played: trust the server's count (derived from real purchases).
  // Until it is available, never show fewer games than wins — a win
  // requires having played, so that is a safe lower bound.
  const gamesPlayed = Number.isFinite(stats?.gamesPlayed)
    ? stats.gamesPlayed
    : Math.max(user.totalGamesPlayed || 0, user.totalWins || 0);

  return (
    <div className="relative isolate overflow-hidden px-5 pt-8 pb-10">
      {/* Ambient rim-light, kept at the edges like the rest of the game flow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-28 left-1/2 -translate-x-1/2 w-72 h-72 rounded-full bg-violet-600/20 blur-[100px]" />
        <div className="absolute top-80 -right-24 w-56 h-56 rounded-full bg-fuchsia-500/10 blur-[100px]" />
      </div>

      <div className="flex flex-col items-center mb-8">
        <div className="p-[3px] rounded-full bg-gradient-to-br from-violet-500 via-fuchsia-500 to-amber-400 shadow-lg shadow-violet-500/30 mb-3">
          <div className="w-20 h-20 rounded-full bg-[#140f22] flex items-center justify-center font-display font-bold text-2xl text-ivory">
            {(user.displayName || '?')[0]?.toUpperCase()}
          </div>
        </div>
        <h1 className="font-display font-semibold text-xl text-ivory">{user.displayName}</h1>
        <p className="text-mute text-sm mt-1.5">{user.phone}</p>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label="Games" value={gamesPlayed} accent="violet" />
        <StatCard label="Wins" value={user.totalWins || 0} accent="emerald" />
        <StatCard label="Won" value={user.totalWinnings || 0} suffix="Birr" accent="amber" />
      </div>

      <Leaderboard
        stats={stats}
        status={status}
        period={period}
        onPeriod={setPeriod}
        onRetry={loadStats}
      />
    </div>
  );
}

const ACCENTS = {
  violet: { line: 'rgba(139,92,246,0.7)', text: 'text-violet-200' },
  emerald: { line: 'rgba(52,211,153,0.7)', text: 'text-emerald-200' },
  amber: { line: 'rgba(251,191,36,0.7)', text: 'text-amber-200' }
};

function StatCard({ label, value, suffix, accent = 'violet' }) {
  const a = ACCENTS[accent];
  return (
    <div className="relative overflow-hidden bg-[#140f22] border border-violet-400/15 rounded-card px-3 py-4 text-center">
      <div
        className="absolute left-3 right-3 top-0 h-px"
        style={{ backgroundImage: `linear-gradient(90deg, transparent, ${a.line}, transparent)` }}
      />
      <p className={`font-display font-semibold text-xl tabular-nums ${a.text}`}>
        {Number(value).toLocaleString()}
      </p>
      <p className="text-mute text-[11px] uppercase tracking-wide mt-0.5">
        {label}
        {suffix ? ` ${suffix}` : ''}
      </p>
    </div>
  );
}

function Leaderboard({ stats, status, period, onPeriod, onRetry }) {
  const meta = PERIODS.find((p) => p.key === period);
  const data = stats?.[period];

  return (
    <div
      className="rounded-card p-px"
      style={{
        backgroundImage:
          'linear-gradient(155deg, rgba(139,92,246,0.5), rgba(139,92,246,0.06) 40%, rgba(217,70,239,0.25) 100%)'
      }}
    >
      <div className="rounded-card bg-[#140f22] p-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-chip bg-gradient-to-br from-violet-500/30 to-fuchsia-500/30 border border-violet-400/30 flex items-center justify-center">
            <TrophyIcon />
          </div>
          <div>
            <h2 className="font-display font-semibold text-ivory text-base leading-tight">Leaderboard</h2>
            <p className="text-mute text-[11px]">Ranked by cartelas purchased</p>
          </div>
        </div>

        <div
          role="tablist"
          className="grid grid-cols-2 gap-1 p-1 mb-5 rounded-chip bg-violet-500/10 border border-violet-400/20"
        >
          {PERIODS.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={period === p.key}
              onClick={() => onPeriod(p.key)}
              className={[
                'py-2 rounded-chip text-sm font-semibold transition-all',
                period === p.key
                  ? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white shadow-lg shadow-violet-500/30'
                  : 'text-mute active:opacity-60'
              ].join(' ')}
            >
              {p.label}
            </button>
          ))}
        </div>

        {status === 'loading' && <RankSkeleton />}

        {status === 'error' && (
          <div className="text-center py-6">
            <p className="text-mute text-sm mb-3">Rankings are unavailable right now.</p>
            <button
              onClick={onRetry}
              className="px-4 py-2 rounded-chip text-sm font-semibold text-violet-200 bg-violet-500/10 border border-violet-400/30 active:opacity-60"
            >
              Try again
            </button>
          </div>
        )}

        {status === 'ready' && (data?.topPercent == null ? (
          <div className="text-center py-6">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-violet-500/10 border border-violet-400/25 flex items-center justify-center">
              <TrophyIcon dim />
            </div>
            <p className="text-ivory text-sm font-medium">You're not ranked yet</p>
            <p className="text-mute text-xs mt-1">
              Buy a cartela this {meta.noun} to enter the leaderboard.
            </p>
          </div>
        ) : (
          <RankBody data={data} noun={meta.noun} />
        ))}
      </div>
    </div>
  );
}

function RankBody({ data, noun }) {
  const top = Math.max(1, Math.min(100, Math.round(data.topPercent)));
  const tier = tierFor(top);
  const ahead = 100 - top;
  const reset = formatReset(data.endsAt);

  return (
    <div className="flex items-center gap-5">
      <RankRing topPercent={top} />
      <div className="flex-1 min-w-0">
        <span
          className={`inline-block px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide bg-gradient-to-r ${tier.chip}`}
        >
          {tier.label}
        </span>
        <p className="text-ivory text-sm font-medium mt-2 leading-snug">
          {ahead > 0
            ? `You're ahead of ${ahead}% of players this ${noun}.`
            : `Every game moves you up this ${noun}.`}
        </p>
        {Number.isFinite(data.spent) && (
          <p className="text-mute text-xs mt-1.5">
            Your play: <span className="font-mono text-violet-200">{Number(data.spent).toLocaleString()} Birr</span>
          </p>
        )}
        {reset && <p className="text-mute text-[11px] mt-1">Resets in {reset}</p>}
      </div>
    </div>
  );
}

const RING_R = 56;
const RING_C = 2 * Math.PI * RING_R;

function RankRing({ topPercent }) {
  // Fuller ring = better rank (Top 1% is almost a full circle). Animates from
  // its previous value whenever the period changes.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(100 - topPercent));
    return () => cancelAnimationFrame(id);
  }, [topPercent]);

  return (
    <div className="relative w-32 h-32 shrink-0">
      <svg viewBox="0 0 140 140" className="w-full h-full -rotate-90">
        <defs>
          <linearGradient id="rankRingGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#d946ef" />
          </linearGradient>
        </defs>
        <circle cx="70" cy="70" r={RING_R} fill="none" stroke="rgba(139,92,246,0.15)" strokeWidth="10" />
        <circle
          cx="70"
          cy="70"
          r={RING_R}
          fill="none"
          stroke="url(#rankRingGrad)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - shown / 100)}
          style={{ transition: 'stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-mute text-[10px] uppercase tracking-widest">Top</span>
        <span className="font-display font-bold text-3xl text-ivory tabular-nums leading-none drop-shadow-[0_0_14px_rgba(139,92,246,0.5)]">
          {topPercent}%
        </span>
      </div>
    </div>
  );
}

function RankSkeleton() {
  return (
    <div className="flex items-center gap-5 animate-pulse">
      <div className="w-32 h-32 rounded-full border-[10px] border-violet-500/15 shrink-0" />
      <div className="flex-1 space-y-2.5">
        <div className="h-5 w-20 rounded-full bg-violet-500/15" />
        <div className="h-3.5 w-full rounded bg-violet-500/10" />
        <div className="h-3.5 w-2/3 rounded bg-violet-500/10" />
      </div>
    </div>
  );
}

function TrophyIcon({ dim }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={dim ? 'rgba(196,181,253,0.5)' : '#c4b5fd'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z" />
      <path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
    </svg>
  );
}

export default function ProfilePage() {
  return (
    <AuthGate>
      <ProfileContent />
    </AuthGate>
  );
}
