'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/game/lobby', label: 'Game', icon: GameIcon },
  { href: '/history', label: 'History', icon: HistoryIcon },
  { href: '/wallet', label: 'Wallet', icon: WalletIcon },
  { href: '/profile', label: 'Profile', icon: ProfileIcon }
];

export default function Navigation() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[560px] bg-surface/95 backdrop-blur border-t border-line flex justify-around py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = pathname?.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex flex-col items-center gap-1 px-4 py-1 rounded-chip transition-colors ${active ? 'text-gold' : 'text-mute'}`}
          >
            <Icon active={active} />
            <span className="text-[11px] font-medium">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function GameIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="7" height="7" rx="2" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" />
      <rect x="14" y="3" width="7" height="7" rx="2" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" />
      <rect x="3" y="14" width="7" height="7" rx="2" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" />
      <circle cx="17.5" cy="17.5" r="3.5" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" />
    </svg>
  );
}
function HistoryIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" />
      <path d="M12 7v5l3.5 2" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function WalletIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="6" width="18" height="13" rx="2.5" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" />
      <path d="M3 10h18" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" />
      <circle cx="16.5" cy="14" r="1.4" fill={active ? '#E8A93B' : '#8B93A3'} />
    </svg>
  );
}
function ProfileIcon({ active }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8.5" r="3.5" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" />
      <path d="M4.5 20c1.5-4 4.2-6 7.5-6s6 2 7.5 6" stroke={active ? '#E8A93B' : '#8B93A3'} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
