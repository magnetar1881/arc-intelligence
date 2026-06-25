# Arc Intelligence

A real-time on-chain intelligence platform for the Arc ecosystem.

Arc Intelligence monitors wallet activity, tracks large transfers, and indexes token movements across the Arc network.

---

## Vision

Arc is growing. But on-chain data is scattered, hard to read, and inaccessible to most users.

Arc Intelligence is being built to change that — starting with a whale tracker and expanding into a full ecosystem intelligence layer: who holds what, who is moving funds, which protocols are active, and where to swap or bridge on Arc.

The goal is not just to collect data, but to make it understandable.

---

## Current State

### On-Chain Scanner
- Real-time ERC20 Transfer event monitoring
- Decimal-aware, configurable whale detection threshold
- Mint, burn, and faucet filtering
- Per-token symbol and decimals caching (reduces RPC load)
- In-memory deduplication with TTL-based cleanup (no memory leaks)
- Optional token whitelist for targeted monitoring

### Database
- SQLite with WAL mode for concurrent read/write
- Wallet activity tracking and scoring
- Token transfer indexing
- Whale event history
- Multi-user subscription management

### Telegram Bot
- Real-time whale alerts sent to subscribers
- Multi-user subscription system — anyone can subscribe, no separate deployment needed
- Per-token subscriptions (`/subscribe <token_address>`)
- `/top` — top wallets by tracked volume
- `/wallet <address>` — wallet stats and recent activity
- `/digest [hours]` — on-demand summary of whale activity
- `/mysubs` — manage your subscriptions
- `/help` — list all commands

---

## Roadmap

### Phase 1 — Intelligence Layer (in progress)
- [x] Real-time whale scanner
- [x] Wallet scoring system
- [x] Telegram alert bot with multi-user subscriptions
- [x] On-demand digest and wallet lookup
- [ ] Web API (expose scanner data over HTTP)
- [ ] `/top tokens` command — most active tokens by volume

### Phase 2 — Web Platform (next)
- [ ] Ecosystem guide — curated list of Arc DEXs, bridges, and faucets (sourced from Arc official channels)
- [ ] Web dashboard — live charts: top holders, most active wallets, token volume
- [ ] Natural language interface — ask questions about Arc network activity and get answers backed by live on-chain data
- [ ] On-chain data integration — most-used contracts from Arc block explorer

### Phase 3 — Expansion
- [ ] Multi-chain support
- [ ] Anomaly detection (unusual wallet behavior)
- [ ] Smart money tracking
- [ ] Wallet reputation scoring

---

## Tech Stack

- Node.js
- ethers.js
- SQLite
- Telegram Bot API
- Arc RPC

---

## Installation

```bash
npm install
```

Create a `.env` file in the project root (see **Configuration** below), then run:

```bash
node src/app.js
```

Or with pm2 for persistent operation:

```bash
pm2 start src/app.js --name arc-intelligence
pm2 save
```

---

## Configuration

RPC_URL=

BOT_TOKEN=

CHAT_ID=

WHALE_THRESHOLD=100000

LARGE_TRANSFER_THRESHOLD=250000

COOLDOWN_MS=5000

MEMORY_TTL_MS=600000

TOKEN_WHITELIST=

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | yes | Arc testnet JSON-RPC endpoint |
| `BOT_TOKEN` | yes | Telegram bot token from @BotFather |
| `CHAT_ID` | no | Fixed chat ID that always receives alerts (admin/owner). Most users subscribe via `/subscribe` instead |
| `WHALE_THRESHOLD` | no (default 100000) | Minimum token amount (decimal-adjusted) to trigger a whale alert |
| `LARGE_TRANSFER_THRESHOLD` | no (default 250000) | Amount above which an alert is labeled LARGE — size-based label only, not a liquidity/TVL analysis |
| `COOLDOWN_MS` | no (default 5000) | Minimum time (ms) between processed transfers from the same wallet |
| `MEMORY_TTL_MS` | no (default 600000) | How often in-memory dedup and cooldown state is cleaned up |
| `TOKEN_WHITELIST` | no | Comma-separated token contract addresses to monitor; leave empty to watch all |

---

## Telegram Commands

- `/subscribe` — subscribe this chat to all whale alerts
- `/subscribe <token_address>` — subscribe to a specific token only
- `/unsubscribe` — remove all subscriptions for this chat
- `/unsubscribe <token_address>` — remove a specific token subscription
- `/mysubs` — list current subscriptions
- `/top` — top wallets by tracked volume
- `/wallet <address>` — wallet stats and recent whale transactions
- `/digest [hours]` — whale activity summary (default: last 24h)
- `/help` — list all commands

---

## Notes

- Whale detection uses a **size-based heuristic** (transfer amount vs. configurable threshold). This is not a liquidity-aware system it does not read DEX pool reserves, TVL, or slippage. True liquidity-aware filtering is planned for a later phase.
- Ecosystem resource recommendations (DEXs, bridges) will be sourced exclusively from Arc official channels (X, Discord). All recommendations will carry a disclaimer: *this information is for reference only always verify before transacting.*

---

## License

MIT
