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

      if (!isInsideTelegram()) {
        setError('Please open this from the Bingo bot in Telegram.');
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
        if (!cancelled) setError(err.message || 'Please register with the bot first by sending /start.');
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
