# Bingo — 75-Ball Telegram Bingo Platform

A continuous, automated, real-money 75-ball Bingo platform built as a Telegram
Bot + Mini App. Implements PRD v7.1 end to end: single 10-Birr stake tier,
a `WAITING → ACTIVE → SETTLING → COMPLETED` game engine that runs forever
without manual intervention, a House Wallet ledger, deposit/withdrawal
flows, and an admin panel — all inside Telegram.

## Architecture

Two deployment targets, matching §2 of the PRD exactly:

| Component | Hosts | What it does |
|---|---|---|
| `webapp/` | **Vercel** | Next.js Mini App — the Lobby, Cartela Selection, Live Game, Winner, Wallet, History, and Profile screens. Talks to the backend over REST + a WebSocket. Stateless. |
| `backend/` | **Render** | *Everything else*, as one long-running Node process: the Telegram bot (Telegraf), the REST API (Express), the Socket.IO server, and the continuous game engine loop. This has to be a persistent process — the 3-second draw loop can't live on stateless serverless functions. |

Supporting infrastructure: **MongoDB Atlas** (all persistent data) and
**Upstash Redis** (distributed locks, rate limiting, admin PIN
attempt-tracking).

```
bingo-platform/
├── backend/         Node/Express/Socket.IO/Telegraf — deploy to Render
├── webapp/          Next.js — deploy to Vercel
├── scripts/         One-time setup scripts (cartela import, admin seed, webhook)
├── data/            The 600 pre-generated cartelas (cartelas.csv)
└── render.yaml       Render Blueprint for one-click backend deploy
```

## Prerequisites

- Node.js 18+
- A MongoDB Atlas cluster (the free M0 tier works — it's a replica set,
  which this project needs for multi-document transactions on deposits,
  withdrawals, and prize settlement)
- An Upstash Redis database (free tier)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- (Optional but recommended for automatic deposit verification) credentials
  for `@localpay/verification-engine` — see [Telebirr verification](#telebirr-verification-engine) below

## 1. Local Setup

```bash
git clone <this-repo>
cd bingo-platform

# Install both apps
npm run backend:install
npm run webapp:install

# Configure environment
cp backend/.env.example backend/.env      # fill in real values
cp webapp/.env.example webapp/.env.local  # fill in real values
```

Fill in `backend/.env` with your MongoDB URI, Upstash Redis credentials,
bot token, and an `ADMIN_ID` (your own Telegram numeric ID) + `ADMIN_PIN`.

## 2. Generate & Import the Cartela Set

600 unique, valid cartelas are already generated at `data/cartelas.csv`
(column ranges B 1-15 / I 16-30 / N 31-45 / G 46-60 / O 61-75, FREE center).
Regenerate it any time with:

```bash
npm run generate:cartelas
```

Import into MongoDB (idempotent — safe to re-run):

```bash
npm run import:cartelas
```

## 3. Run Locally

```bash
npm run backend:dev    # starts the bot + API + sockets + game engine on :5000
npm run webapp:dev     # starts the Next.js dev server on :3000
```

The game engine starts drawing automatically the moment the backend boots
— there's no "start game" button. To actually play locally you'll need a
way for Telegram to reach your machine (e.g. `ngrok http 5000`) since
Telegram webhooks and the Mini App both require HTTPS.

## 4. Deploy

### 4.1 MongoDB Atlas & Upstash Redis
Create both, grab their connection strings/tokens, and note them for the
next steps.

### 4.2 Backend → Render
Either:
- **Blueprint (recommended):** Render Dashboard → New → Blueprint → point
  at this repo. `render.yaml` provisions the service; you'll fill in the
  `sync: false` secrets (Mongo URI, Redis creds, bot token, admin id/pin,
  deposit phone, frontend/backend URLs) in the dashboard afterward.
- **Manual:** New Web Service → Root Directory `backend` → Build
  `npm install` → Start `npm start` → add all vars from
  `backend/.env.example`.

Either way, start on the **Starter** plan, not Free — the free tier spins
down on inactivity, which would kill mid-round games and the always-on
draw loop. This is a real-money system; don't run it on a tier that sleeps.

### 4.3 Webapp → Vercel
New Project → point at this repo → **Root Directory: `webapp`** (Vercel
auto-detects Next.js). Add the vars from `webapp/.env.example`, pointed at
your Render backend's URL.

### 4.4 Cartelas & Admin
From your own machine, pointed at the production `MONGODB_URI`:
```bash
npm run import:cartelas
npm run seed:admin
```

### 4.5 Telegram Webhook
```bash
BACKEND_URL=https://your-backend.onrender.com npm run set:webhook
```

### 4.6 Fund the House Wallet
The house wallet needs real starting capital to cover admin
auto-allocated cartelas before commission earnings replenish it —
`HOUSE_WALLET_INITIAL_BALANCE` seeds this automatically on first boot.
Size it to your expected traffic: at defaults (150 cartelas × 10 Birr),
a single low-turnout round can cost the house up to ~1,490 Birr.

## Testing

```bash
npm run backend:test
```

Runs the Jest suite covering winner-detection pattern matching and the
prize-rounding / minimum-cartelas formulas — the parts of the system where
a subtle bug would mean real money paid out incorrectly. These are pure
logic tests (no database required).

The wallet/settlement flows (deposit idempotency, withdrawal hold/release,
and the full House Wallet accounting across organic rounds, auto-allocated
rounds, and admin-cartela-wins rounds) were verified end-to-end during
development against a simulated database. Before going live with real
money, run a manual smoke test against your actual Atlas cluster: register
a test account, deposit, play a round, and confirm withdrawal hold/release
behaves as expected.

## Operational Notes

- **Single active game at a time.** v7.1 runs one 10-Birr stake tier; the
  engine cycles through rounds continuously and needs no manual triggering.
- **Admin PIN is env-based, not stored in the database**, and is
  rate-limited (5 attempts / 15 minutes) via Redis.
- **The `/api/admin/game/stop` and `/api/admin/game/start` endpoints pause
  and resume** the engine between rounds — the in-progress round always
  finishes normally; pausing only prevents the *next* one from starting.
- **House Wallet accounting** is documented in detail in
  `backend/src/services/walletService.js` — read the comment at the top of
  that file before changing anything financial. In short: `GAME_PURCHASE`
  and `WINNING` don't touch the House Wallet directly (that money lives in
  the round's own escrow, tracked on the `Game` document); only genuinely
  house-owned-money events (`ADMIN_AUTO_PURCHASE`, `HOUSE_COMMISSION`,
  `HOUSE_FRACTIONAL`, `HOUSE_WINNING`, `ADMIN_CREDIT`) move its balance.
  Every transaction type is still recorded for a full audit trail either way.
- **Referrals and Coins are Phase 2** (§18 of the PRD) — the `coins` /
  `referralCode` / `referredBy` fields exist on the User model for
  forward compatibility, but there's no reward logic wired up. Don't be
  surprised that inviting a friend does nothing yet; it's intentionally
  out of scope for this release.

### Telebirr Deposit Verification
Fully self-contained — no third-party package required. The flow:

1. User pastes the entire Telebirr confirmation SMS (a bare receipt link or transaction number still works, just with less redundancy in the checks).
2. `backend/src/services/telebirrVerification.js` extracts the transaction ID and the official `transactioninfo.ethiotelecom.et` receipt URL from it.
3. The backend fetches that URL directly (a normal server-to-server request — Telebirr's `robots.txt` tells search crawlers not to index these pages for privacy reasons, which has nothing to do with a merchant backend fetching one specific receipt it was just handed a direct link to).
4. The fetched page is checked for: the expected transaction ID appearing on it, an ETB amount matching what the user claimed, and our own Telebirr number's last 4 digits appearing as the recipient.
5. Only credited automatically if **all** of those pass. Anything uncertain — fetch failure, unparseable input, mismatched amount — falls back to manual admin review rather than guessing in either direction.

**Known limitation:** the SMS parser is tested against a real sample and is trustworthy. The *receipt page* parser (`parseReceiptText` in the same file) could not be developed against a real page — automated fetching of that domain is blocked by `robots.txt` for tooling that respects it, which prevented inspecting the actual HTML during development. It's written to be structure-agnostic (checking whether expected *values* appear in the plain text, rather than depending on specific CSS selectors or labels), which should be reasonably robust to markup you haven't seen — but validate it against one real receipt page before fully trusting the automatic path in production. Until then, manual review (already the fallback for anything inconclusive) covers you completely — no deposit is ever lost or blocked, just occasionally reviewed by a human instead of auto-approved.

## API Overview

See inline JSDoc-style comments in `backend/src/api/*.js` for the full
contract. All endpoints return `{ success, data }` or
`{ success: false, error: { code, message, details, timestamp } }`
(§11.1). List endpoints accept `limit` (default 20, max 100) and `offset`
query params.

## WebSocket Events

Authenticate the handshake with `io(WS_URL, { auth: { token: jwt } })` —
see `backend/src/sockets/index.js`. Event names and payloads match §2.3 of
the PRD; `backend/src/sockets/gameHandlers.js` and
`webapp/hooks/useGameState.js` are the two ends of that contract.
