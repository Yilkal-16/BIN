'use client';
import { useEffect, useState, useCallback } from 'react';

const LETTERS = ['B', 'I', 'N', 'G', 'O'];
export function letterFor(number) {
  return LETTERS[Math.floor((number - 1) / 15)];
}

/**
 * Joins a game room and keeps local state in sync with every server-pushed
 * event (§2.3). One hook instance = one game room subscription.
 */
export function useGameState(socket, connected, gameId) {
  const [status, setStatus] = useState(null);
  const [stake, setStake] = useState(10);
  const [playersCount, setPlayersCount] = useState(0);
  const [totalCartelas, setTotalCartelas] = useState(0);
  const [prizePool, setPrizePool] = useState(null);
  const [grossPrizePool, setGrossPrizePool] = useState(0);
  const [calledNumbers, setCalledNumbers] = useState([]);
  const [lastCalled, setLastCalled] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [winners, setWinners] = useState(null);
  const [cartelaEvents, setCartelaEvents] = useState({}); // cartelaId -> status

  useEffect(() => {
    if (!socket || !connected || !gameId) return undefined;

    socket.emit('join_game', { gameId });

    const onState = (payload) => {
      if (payload.gameId && payload.gameId !== gameId) return;
      setStatus(payload.status);
      setStake(payload.stake ?? 10);
      setPlayersCount(payload.playersCount ?? 0);
      setTotalCartelas(payload.totalCartelas ?? 0);
      setPrizePool(payload.prizePool ?? null);
      setGrossPrizePool(payload.grossPrizePool ?? 0);
    };
    const onNumberDrawn = (payload) => {
      setLastCalled(payload);
      setCalledNumbers((prev) => (prev.includes(payload.number) ? prev : [...prev, payload.number]));
    };
    const onCountdown = (payload) => setCountdown(payload.remainingSeconds);
    const onCartelaUpdate = (payload) => {
      const ids = payload.cartelaIds || (payload.cartelaId != null ? [payload.cartelaId] : []);
      setCartelaEvents((prev) => {
        const next = { ...prev };
        ids.forEach((id) => { next[id] = payload.status; });
        return next;
      });
    };
    const onWinner = (payload) => setWinners(payload);
    const onCycle = () => setCalledNumbers([]);

    socket.on('game_state_update', onState);
    socket.on('number_drawn', onNumberDrawn);
    socket.on('countdown_update', onCountdown);
    socket.on('cartela_update', onCartelaUpdate);
    socket.on('winner_announcement', onWinner);
    socket.on('game_cycle_update', onCycle);

    return () => {
      socket.emit('leave_game', { gameId });
      socket.off('game_state_update', onState);
      socket.off('number_drawn', onNumberDrawn);
      socket.off('countdown_update', onCountdown);
      socket.off('cartela_update', onCartelaUpdate);
      socket.off('winner_announcement', onWinner);
      socket.off('game_cycle_update', onCycle);
    };
  }, [socket, connected, gameId]);

  const refresh = useCallback(() => {
    if (socket && gameId) socket.emit('refresh_state', { gameId });
  }, [socket, gameId]);

  return {
    status, stake, playersCount, totalCartelas, prizePool, grossPrizePool,
    calledNumbers, lastCalled, countdown, winners, cartelaEvents, refresh
  };
}
