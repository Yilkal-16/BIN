import Script from 'next/script';
import '../styles/globals.css';
import { TelegramProvider } from '../components/TelegramProvider';

export const metadata = {
  title: 'Bingo',
  description: '75-ball Bingo, live in Telegram'
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="font-body">
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
        <TelegramProvider>
          <div className="pb-24 min-h-screen">{children}</div>
        </TelegramProvider>
      </body>
    </html>
  );
}
