'use client';
import { useState } from 'react';
import AuthGate from '../../components/AuthGate';
import { useTelegramUser } from '../../components/TelegramProvider';
import { api } from '../../lib/api';

function ProfileContent() {
  const { user, refreshProfile } = useTelegramUser();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.displayName || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const startEditing = () => {
    setName(user.displayName || '');
    setError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    if (!name.trim()) {
      setError('Name cannot be empty.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile({ displayName: name.trim() });
      await refreshProfile();
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-5 pt-8">
      <div className="flex flex-col items-center mb-8">
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-gold to-emerald flex items-center justify-center font-display font-bold text-2xl text-ink mb-3">
          {(user.displayName || '?')[0]?.toUpperCase()}
        </div>

        {editing ? (
          <div className="flex flex-col items-center gap-2 w-full">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              className="bg-surface2 border border-line rounded-chip px-3 py-1.5 text-ivory text-center outline-none focus:border-gold w-full max-w-[220px]"
            />
            {error && <p className="text-coral text-xs">{error}</p>}
            <div className="flex gap-3 mt-1">
              <button onClick={cancelEditing} disabled={busy} className="text-mute text-sm px-3 py-1">Cancel</button>
              <button onClick={save} disabled={busy} className="text-gold text-sm font-medium px-3 py-1">
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <h1 className="font-display font-semibold text-xl text-ivory">{user.displayName}</h1>
            <button onClick={startEditing} className="text-gold text-xs font-medium mt-1">Edit name</button>
          </>
        )}
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
