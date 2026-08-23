'use client';
import { useEffect, useState } from 'react';
import AuthGate from '../../components/AuthGate';
import { api } from '../../lib/api';

function HistoryContent() {
  const [games, setGames] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getGameHistory({ limit: 20 })
      .then(({ games: list }) => setGames(list))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="px-5 pt-8">
      <h1 className="font-display font-semibold text-2xl text-ivory mb-6">History</h1>

      {error && <p className="text-coral text-sm">{error}</p>}

      {!games ? (
        <p className="text-mute text-sm">Loading past rounds…</p>
      ) : games.length === 0 ? (
        <p className="text-mute text-sm">No completed rounds yet — play one to see it here.</p>
      ) : (
        <div className="space-y-3">
          {games.map((g) => (
            <div key={g.gameId} className="bg-surface border border-line rounded-card px-4 py-3">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-xs text-mute">{g.gameId}</span>
                <span className="text-xs text-mute">{new Date(g.endTime || g.startTime).toLocaleString()}</span>
              </div>
              {g.noWinner ? (
                <p className="text-sm text-mute">No winner — pool rolled over</p>
              ) : (
                <div className="flex flex-wrap gap-2 mt-2">
                  {(g.winners || []).map((w, i) => (
                    <span key={i} className="text-xs bg-emerald/10 text-emerald border border-emerald/30 rounded-chip px-2 py-1">
                      #{w.cartelaId} · +{w.prizeAmount} Birr
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function HistoryPage() {
  return (
    <AuthGate>
      <HistoryContent />
    </AuthGate>
  );
}
