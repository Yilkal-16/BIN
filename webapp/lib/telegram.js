/**
 * Thin, SSR-safe wrapper around the Telegram WebApp JS SDK
 * (https://telegram.org/js/telegram-web-app.js, loaded via <Script> in
 * layout.js). Every function no-ops gracefully outside Telegram (e.g. during
 * local development in a plain browser tab).
 */

function getWebApp() {
  if (typeof window === 'undefined') return null;
  return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
}

export function initTelegram() {
  const webApp = getWebApp();
  if (!webApp) return null;
  webApp.ready();
  webApp.expand();
  return webApp;
}

export function getInitData() {
  const webApp = getWebApp();
  return webApp ? webApp.initData : '';
}

export function getTelegramUser() {
  const webApp = getWebApp();
  return webApp && webApp.initDataUnsafe ? webApp.initDataUnsafe.user : null;
}

export function hapticFeedback(style = 'light') {
  const webApp = getWebApp();
  if (webApp && webApp.HapticFeedback) webApp.HapticFeedback.impactOccurred(style);
}

export function notifyHaptic(type = 'success') {
  const webApp = getWebApp();
  if (webApp && webApp.HapticFeedback) webApp.HapticFeedback.notificationOccurred(type);
}

export function closeWebApp() {
  const webApp = getWebApp();
  if (webApp) webApp.close();
}

export function isInsideTelegram() {
  return !!getWebApp();
}
