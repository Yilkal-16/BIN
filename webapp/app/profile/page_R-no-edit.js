'use client';
import AuthGate from '../../components/AuthGate';
import { useTelegramUser } from '../../components/TelegramProvider';

function ProfileContent() {
  const { user } = useTelegramUser();

  return (
    <div className="px-5 pt-8">
      <div className="flex flex-col items-center mb-8">
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-gold to-emerald flex items-center justify-center font-display font-bold text-2xl text-ink mb-3">
          {(user.displayName || '?')[0]?.toUpperCase()}
        </div>

        <h1 className="font-display font-semibold text-xl text-ivory">{user.displayName}</h1>
        <p className="text-mute text-sm mt-2">{user.phone}</p>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-8">
        <StatCard label="Games" value={user.totalGamesPlayed || 0} />
        <StatCard label="Wins" value={user.totalWins || 0} />
        <StatCard label="Won" value={user.totalWinnings || 0} suffix="Birr" />
      </div>
    </div>
  );
}

function StatCard({ label, value, suffix }) {
  return (
    <div className="bg-surface border border-line rounded-card px-3 py-4 text-center">
      <p className="font-display font-semibold text-lg text-ivory">{value}</p>
      <p className="text-mute text-[11px] uppercase tracking-wide">{label}{suffix ? ` ${suffix}` : ''}</p>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <AuthGate>
      <ProfileContent />
    </AuthGate>
  );
}
