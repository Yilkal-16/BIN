'use client';
import { useEffect, useState, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthGate from '../../../components/AuthGate';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { useGameState } from '../../../hooks/useGameState';
import { api } from '../../../lib/api';
import { hapticFeedback, notifyHaptic } from '../../../lib/telegram';

// --- CONSTANTS ---
const LETTERS = ['B', 'I', 'N', 'G', 'O'];
const COLUMN_ACCENTS = {
  B: { text: 'text-[#5B84C4]', solid: 'bg-[#1A2C53]', soft: 'bg-[#1A2C53]/20 border-[#5B84C4]/40', ring: 'ring-[#5B84C4]' },
  I: { text: 'text-[#E356B0]', solid: 'bg-[#C11C84]', soft: 'bg-[#C11C84]/20 border-[#E356B0]/40', ring: 'ring-[#E356B0]' },
  N: { text: 'text-[#B080BE]', solid: 'bg-[#2F0F39]', soft: 'bg-[#2F0F39]/20 border-[#B080BE]/40', ring: 'ring-[#B080BE]' },
  G: { text: 'text-[#4FD1B8]', solid: 'bg-[#0E5952]', soft: 'bg-[#0E5952]/20 border-[#4FD1B8]/40', ring: 'ring-[#4FD1B8]' },
  O: {
    text: 'text-[#E8B87A]',
    solid: 'bg-gradient-to-br from-[#F6C97C] to-[#CF9146]',
    soft: 'bg-[#CF9146]/20 border-[#E8B87A]/40',
    ring: 'ring-[#E8B87A]',
    // Rose gold is light, so its header/ball text needs a dark ink instead
    // of the white used on the other four (all dark) accents.
    headerText: 'text-[#3D2410]'
  }
};

function letterFor(n) {
  return LETTERS[Math.floor((n - 1) / 15)];
}

const EMPTY_SET = new Set();

function LiveContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const gameId = searchParams.get('gameId');
  const { socket, connected } = useWebSocket();
  const gameState = useGameState(socket, connected, gameId);

  const [myCartelas, setMyCartelas] = useState([]);
  const [cartelasLoaded, setCartelasLoaded] = useState(false);
  const [autoMode, setAutoMode] = useState(true);
  const [manualMarks, setManualMarks] = useState({}); // cartelaId -> Set of manually-daubed numbers
  const [navigatedAway, setNavigatedAway] = useState(false);

  useEffect(() => {
    if (!gameId) return;
    setManualMarks({}); // fresh round — clear any manual daubs from the previous one
    api
      .getMyCartelas(gameId)
      .then(({ cartelas }) => setMyCartelas(cartelas))
      .catch(() => {})
      .finally(() => setCartelasLoaded(true));
  }, [gameId]);

  const handleRefresh = () => {
    if (!gameId) return;
    setCartelasLoaded(false);
    api
      .getMyCartelas(gameId)
      .then(({ cartelas }) => setMyCartelas(cartelas))
      .catch(() => {})
      .finally(() => setCartelasLoaded(true));
  };

  // Restored to the original flow: SETTLING/COMPLETED (or a winner payload)
  // routes to the dedicated winner-announcement page, same as before.
  useEffect(() => {
    if (navigatedAway) return;
    if (gameState.winners || gameState.status === 'COMPLETED' || gameState.status === 'SETTLING') {
      notifyHaptic('success');
      setNavigatedAway(true);
      router.replace(`/game/winner?gameId=${gameId}`);
    }
  }, [gameState.winners, gameState.status, gameId, router, navigatedAway]);

  const markedSet = useMemo(() => new Set(gameState.calledNumbers), [gameState.calledNumbers]);
  const netPrizePool = gameState.grossPrizePool ? Math.floor(gameState.grossPrizePool * 0.8) : 0;
  const isSpectator = cartelasLoaded && myCartelas.length === 0;

  // Manual mode: the player taps their own cells to daub them. Server-side
  // winner detection always runs off the actually-called numbers regardless
  // (§4.7/§6.6) — this only controls what's visually marked, so a tap only
  // does anything for a number that's already been called.
  const toggleManualDaub = (cartelaId, number) => {
    if (autoMode || !markedSet.has(number)) return;
    hapticFeedback('light');
    setManualMarks((prev) => {
      const current = new Set(prev[cartelaId]);
      if (current.has(number)) current.delete(number);
      else current.add(number);
      return { ...prev, [cartelaId]: current };
    });
  };

  // Get last 10 called numbers for recent calls display
  const recentCalls = useMemo(() => {
    return [...gameState.calledNumbers].reverse().slice(0, 10);
  }, [gameState.calledNumbers]);

  return (
    <div className="flex flex-col h-screen max-h-screen bg-[#0F1115] overflow-hidden">
      {/* --- 1. TOP HEADER & STATS --- */}
      <header className="px-3 py-2.5 bg-[#1A1D24] border-b border-[#2A2F3A] flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-3 flex-1">
          <StatChip label="Game" value={gameId?.slice(-8) || '—'} tone="sky" compact />
          <StatChip label="መደብ" value={gameState.stake ?? '—'} tone="sky" compact />
          <StatChip label="Players" value={gameState.playersCount ?? 0} tone="gold" compact />
          <StatChip label="ደራሽ" value={netPrizePool ? `${netPrizePool.toLocaleString()} ብር` : '—'} tone="gold" compact />
          <StatChip label="Called" value={gameState.calledNumbers.length} tone="emerald" compact />
        </div>
      </header>

      {/* --- 2. MAIN SPLIT LAYOUT --- */}
      <div className="flex flex-1 overflow-hidden p-2 gap-2">
        {/* Caller board - full height */}
        <div className="flex-1 bg-[#1A1D24] rounded-xl border border-[#2A2F3A] p-2 overflow-hidden flex flex-col">
          <CallerBoard calledNumbers={gameState.calledNumbers} lastCalled={gameState.lastCalled} />
        </div>

        {/* Right panel - current ball, recent calls + cartelas */}
        <div className="w-[45%] flex flex-col gap-2 overflow-hidden">
          {/* Current Ball + Recent calls row */}
          <div className="shrink-0 bg-[#1A1D24] rounded-xl border border-[#2A2F3A] p-2 flex items-center gap-3">
            {/* Circular number calling display */}
            <CurrentBallDisplay lastCalled={gameState.lastCalled} />

            {/* Recent calls strip */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] text-mute font-medium uppercase tracking-wide">Recent</span>
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400/60" />
                <span className="text-[9px] text-amber-400 font-mono">#{gameState.calledNumbers.length}</span>
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
                {recentCalls.length === 0 ? (
                  <span className="text-mute text-[10px]">Waiting for first call...</span>
                ) : (
                  recentCalls.map((n) => {
                    const accent = COLUMN_ACCENTS[letterFor(n)];
                    return (
                      <div
                        key={n}
                        className={`shrink-0 px-2.5 h-6 rounded-full border flex items-center justify-center text-[10px] font-bold font-mono ${accent.soft} ${accent.text}`}
                      >
                        {n}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Cartelas - scrollable */}
          <div className="flex-1 overflow-y-auto pr-1 pb-1 space-y-2">
            {!cartelasLoaded ? (
              <p className="text-center text-mute text-sm py-10">Loading cartela…</p>
            ) : isSpectator ? (
              <NoCartelasBoughtPlaceholder />
            ) : (
              myCartelas.map((c) => (
                <CartelaCard
                  key={c.cartelaId}
                  cartela={c}
                  calledSet={markedSet}
                  autoMode={autoMode}
                  manualMarked={manualMarks[c.cartelaId] || EMPTY_SET}
                  onCellTap={(number) => toggleManualDaub(c.cartelaId, number)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* --- 3. BOTTOM BUTTONS --- */}
      <div className="flex gap-2 p-3 bg-[#1A1D24] border-t border-[#2A2F3A] shrink-0">
        <button
          onClick={() => router.push(`/game/lobby?stake=${gameState.stake}`)}
          className="flex-1 py-3 rounded-lg text-sm font-bold bg-sky-500/15 text-sky-300 border border-sky-500/30 active:scale-[0.98] transition-transform"
        >
          Back
        </button>
        <button
          onClick={handleRefresh}
          className="flex-1 py-3 rounded-lg text-sm font-bold bg-[#2E3440] text-ivory border border-[#3A4050] active:scale-[0.98] transition-transform"
        >
          Refresh
        </button>
        <button
          onClick={() => setAutoMode((v) => !v)}
          className={`flex-1 py-3 rounded-lg text-sm font-bold border active:scale-[0.98] transition-transform ${
            autoMode ? 'bg-[#0E5952]/20 text-[#4FD1B8] border-[#0E5952]/50' : 'bg-[#2E3440] text-mute border-[#3A4050]'
          }`}
        >
          Auto {autoMode ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}

// --- COMPONENT: STAT CHIP ---
function StatChip({ label, value, tone, compact }) {
  const tones = {
    slate: 'bg-[#252A34] border-[#3A4050] text-ivory',
    sky: 'bg-sky-500/10 border-sky-500/30 text-sky-300',
    gold: 'bg-gradient-to-br from-amber-500/20 to-amber-600/10 border-amber-400/40 text-amber-300',
    emerald: 'bg-[#0E5952]/15 border-[#0E5952]/40 text-[#4FD1B8]'
  };
  return (
    <div className={`rounded-lg border px-2 py-1 text-center ${tones[tone]} ${compact ? 'flex-1' : ''}`}>
      <p className="text-[8px] uppercase tracking-wide opacity-70 font-medium">{label}</p>
      <p className={`font-mono font-extrabold leading-none ${compact ? 'text-xs' : 'text-sm'}`}>{value}</p>
    </div>
  );
}

// --- COMPONENT: CURRENT BALL DISPLAY (Circular) ---
function CurrentBallDisplay({ lastCalled }) {
  if (!lastCalled) {
    return (
      <div className="w-14 h-14 rounded-full flex flex-col items-center justify-center shrink-0 bg-gradient-to-br from-[#2E3440] to-[#252A34] border-2 border-[#3A4050]">
        <span className="text-white/40 font-extrabold text-[10px]">?</span>
        <span className="text-white/40 font-extrabold text-sm">--</span>
      </div>
    );
  }

  const accent = COLUMN_ACCENTS[lastCalled.letter];

  return (
    <div className="relative shrink-0">
      <div className={`w-14 h-14 rounded-full flex flex-col items-center justify-center bg-gradient-to-br ${accent.solid} shadow-lg ring-4 ${accent.ring}/30 transition-all duration-300 animate-popIn`}>
        <span className="text-white/90 font-extrabold text-[10px]">{lastCalled.letter}</span>
        <span className="text-white font-extrabold text-xl leading-none">{lastCalled.number}</span>
      </div>
      {/* Glow effect ring */}
      <div className={`absolute inset-0 rounded-full ${accent.ring}/20 animate-ping pointer-events-none`} style={{ animationDuration: '2s' }} />
    </div>
  );
}

// --- COMPONENT: MASTER CALLER BOARD ---
function CallerBoard({ calledNumbers, lastCalled }) {
  const markedSet = new Set(calledNumbers);
  const lastCallNum = lastCalled?.number;
  const rows = Array.from({ length: 15 }, (_, i) => i + 1);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="grid grid-cols-5 gap-[3px] mb-[3px] shrink-0">
        {LETTERS.map((l) => (
          <div
            key={l}
            className={`text-center text-base font-extrabold py-1.5 rounded ${COLUMN_ACCENTS[l].solid} ${COLUMN_ACCENTS[l].headerText || 'text-white'} shadow-sm`}
          >
            {l}
          </div>
        ))}
      </div>

      <div
        className="grid grid-cols-5 gap-[3px] flex-1 min-h-0"
        style={{ gridTemplateRows: 'repeat(15, minmax(0, 1fr))' }}
      >
        {rows.flatMap((rowNum) => {
          return Array.from({ length: 5 }, (_, colIndex) => {
            const num = rowNum + colIndex * 15;
            const isCalled = markedSet.has(num);
            const isLast = lastCallNum === num;
            const accent = COLUMN_ACCENTS[LETTERS[colIndex]];
            return (
              <div
                key={num}
                className={[
                  'w-full h-full flex items-center justify-center text-sm font-mono font-extrabold rounded bg-[#252A34] text-ivory transition-all duration-200',
                  isCalled ? 'bg-amber-300 text-[#111]' : '',
                  isLast ? `!bg-white !text-[#111] scale-105 shadow-lg ring-2 ${accent.ring} z-10` : ''
                ].join(' ')}
              >
                {num}
              </div>
            );
          });
        })}
      </div>
    </div>
  );
}

// --- COMPONENT: NO CARTELAS BOUGHT (spectator state) ---
// Shown in the space where the player's cartela card(s) would normally sit,
// for a player who reached the live round without buying a cartela. They
// can still watch every number get called live — matching the "Watching
// Only" pattern from Beteseb Bingo — instead of being locked out entirely.
function NoCartelasBoughtPlaceholder() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8 bg-gradient-to-b from-[#1A1D24] to-[#20242E] rounded-xl border border-amber-500/20">
      <div className="w-14 h-14 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-2xl mb-3">
        🎰
      </div>
      <p className="text-amber-300 font-extrabold text-sm mb-2 tracking-wide">
        ይሄ ዙር ጠርቶ እስኪጨርስ ጠብቁ፤ ክዛ ራሱ ቀጣይ ዙር ይጀምራል።
      </p>
      </div>
  );
}

// --- COMPONENT: CARTELA CARD ---
// Auto mode: every called number is daubed automatically. Manual mode: the
// player taps a cell themselves to daub it — only numbers that have
// actually been called respond to a tap. Either way, server-side winner
// detection runs off the real called numbers (§4.7/§6.6), so this is purely
// a visual/interaction preference, never a gameplay requirement.
function CartelaCard({ cartela, calledSet, autoMode, manualMarked, onCellTap }) {
  return (
    <div
      className={`rounded-xl border p-2 ${
        cartela.isWinner ? 'border-amber-400 bg-amber-400/10 shadow-lg shadow-amber-400/10' : 'border-[#2A2F3A] bg-[#1A1D24]'
      }`}
    >
      <div className="flex justify-between items-center mb-2 px-1">
        <span className="text-amber-400 text-sm font-extrabold">ካርቴላ #{cartela.cartelaId}</span>
        {cartela.isWinner && <span className="text-[10px] text-amber-400 font-extrabold animate-pulse">🏆 WINNER</span>}
      </div>

      <div className="grid grid-cols-5 gap-[3px]">
        {/* B I N G O headers with bold fonts and colored cells */}
        {LETTERS.map((l) => {
          const accent = COLUMN_ACCENTS[l];
          return (
            <div
              key={l}
              className={`text-center text-sm font-extrabold py-1 rounded ${accent.solid} ${accent.headerText || 'text-white'} shadow-sm`}
            >
              {l}
            </div>
          );
        })}

        {cartela.grid.map((row, r) =>
          row.map((cell, c) => {
            const isFree = cell === null;
            const isCalled = isFree || calledSet.has(cell);
            const isMarked = autoMode ? isCalled : isFree || manualMarked.has(cell);
            // In manual mode, any called (non-free) cell can be tapped to
            // toggle its daub on/off; a called-but-not-yet-daubed cell gets
            // a distinct "ready to daub" pulse so it's clear it's tappable.
            const isClickable = !autoMode && !isFree && isCalled;
            const needsAttention = isClickable && !isMarked;
            const colAccent = COLUMN_ACCENTS[LETTERS[c]];

            return (
              <div
                key={`${r}-${c}`}
                onClick={isClickable ? () => onCellTap(cell) : undefined}
                role={isClickable ? 'button' : undefined}
                className={[
                  'aspect-square rounded flex items-center justify-center text-sm font-mono font-extrabold transition-colors',
                  isFree
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : isMarked
                    ? `bg-amber-400 text-ink${isClickable ? ' cursor-pointer' : ''}`
                    : needsAttention
                    ? `bg-[#252A34] ${colAccent.text} ring-2 ring-amber-400/70 animate-pulse cursor-pointer`
                    : `bg-[#252A34] ${colAccent.text}`
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
