'use client';
import { useTelegramUser } from './TelegramProvider';
import Navigation from './Navigation';

export default function AuthGate({ children, hideNav }) {
  const { user, loading, error } = useTelegramUser();

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] gap-3 px-6 text-center">
        <div className="w-10 h-10 rounded-full border-2 border-line border-t-gold animate-spin" />
        <p className="text-mute text-sm">Loading your game...</p>
      </div>
    );
  }

  if (error || !user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh] gap-3 px-8 text-center">
        <div className="text-3xl">🎱</div>
        <p className="text-ivory font-display font-semibold text-lg">Can&apos;t load your account</p>
        <p className="text-mute text-sm">{error || 'Please open this from the Bingo bot in Telegram.'}</p>
      </div>
    );
  }

  return (
    <>
      {children}
      {!hideNav && <Navigation />}
    </>
  );
}
