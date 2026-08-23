'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { initTelegram, getInitData, isInsideTelegram } from '../lib/telegram';
import { api, setToken, getToken } from '../lib/api';

const TelegramContext = createContext(null);

export function TelegramProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshProfile = async () => {
    try {
      const { user: profile } = await api.getProfile();
      setUser(profile);
      return profile;
    } catch (err) {
      setError(err.message);
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      initTelegram();

      // Defensive retry: on some Telegram client versions, initData can be
      // read a beat before the WebView bridge finishes attaching it, even
      // with the SDK script loaded via `beforeInteractive`. One short wait
      // avoids misclassifying a real launch as "opened outside Telegram."
      if (!isInsideTelegram()) {
        await new Promise((r) => setTimeout(r, 250));
      }

      if (!isInsideTelegram()) {
        setError('Please open this from the Bingo bot in Telegram (tap "Play" there, rather than opening this link directly).');
        setLoading(false);
        return;
      }

      try {
        if (!getToken()) {
          const initData = getInitData();
          const { token } = await api.loginWithTelegram(initData);
          setToken(token);
        }
        const profile = await refreshProfile();
        if (!cancelled && !profile) setError('Could not load your profile. Please reopen from the bot.');
      } catch (err) {
        if (cancelled) return;
        const friendly = err.message === 'initData is required'
          ? 'Please open this from the Bingo bot in Telegram (tap "Play" there, rather than opening this link directly).'
          : (err.message || 'Please register with the bot first by sending /start.');
        setError(friendly);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    boot();
    return () => { cancelled = true; };
  }, []);

  return (
    <TelegramContext.Provider value={{ user, loading, error, refreshProfile }}>
      {children}
    </TelegramContext.Provider>
  );
}

export function useTelegramUser() {
  const ctx = useContext(TelegramContext);
  if (!ctx) throw new Error('useTelegramUser must be used within TelegramProvider');
  return ctx;
}
