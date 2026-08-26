# Lensora

AI-powered on-chain intelligence platform for the Arc ecosystem.

**Live:** https://lensora.xyz | **Telegram:** https://t.me/+fSxMt-IJaWQ3ZGJk

---

## What It Does

- Monitors ERC-20 activity on Arc in real time
- Tracks whale wallet movements and classifies wallet behavior (holder / trader / exited)
- Ask Lensora – AI-powered natural language interface for live on-chain data
- AI-generated whale analysis directly in Telegram
- Arc ecosystem directory (DEXs, bridges, wallets, oracles)
- Telegram alerts with multi-user subscriptions
- Bridge & Swap interface powered by Circle App Kit (execution will be enabled once browser wallet support is available)

---

## Circle Tools Used

- Circle App Kit
- Gateway
- Unified Balance Kit

## Stack

Node.js · Express · ethers.js · SQLite · Circle App Kit · Groq/Llama · Telegram Bot API


---

## Quick Start

```bash
npm install
cp .env.example .env

# fill in:
# RPC_URL
# BOT_TOKEN
# GROQ_API_KEY
# CIRCLE_KIT_KEY

node src/app.js
```

---

## Key Config (.env)

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | yes | Arc RPC endpoint |
| `BOT_TOKEN` | yes | Telegram bot token |
| `GROQ_API_KEY` | yes | Groq API key (Ask Arc) |
| `CIRCLE_KIT_KEY` | yes | Circle App Kit key |
| `SCANNER_ENABLED` | no | `true` to start scanner (default: false) |
| `WHALE_THRESHOLD` | no | Min token amount for whale alert (default: 1000000) |

---

## Roadmap

### Near Term

#### Data Intelligence
- Anomaly detection
- Smart money tracking 
- Token risk scoring ✓
- Smart Money Score ✓
- AI transaction explanation

#### AI Layer
- Portfolio tracking
- Watchlists
- AI daily market summaries
- Whale signal context ✓

#### Ecosystem
- Swap & Bridge execution on mainnet
- DEX liquidity monitoring
- Stablecoin flow analysis (USDC / EURC)

---

### Long Term

#### AI Layer
- Agentic Ask Lensora
- Agent Mode (AI tasks & automation)
- Wallet Memory
- AI Compare
- AI-assisted on-chain execution

#### Payments
- x402 micro-payments for premium AI features

#### Ecosystem
- Cross-chain portfolio tracking
- Yield discovery across Arc
- Ecosystem analytics & protocol insights

---

## License

MIT — Built on Arc Network
