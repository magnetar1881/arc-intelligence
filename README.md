# Arc Intelligence

Real-time on-chain intelligence platform for Arc Network.

**Live:** https://lensora.xyz | **Telegram:** https://t.me/+fSxMt-IJaWQ3ZGJk

---

## What It Does

- Monitors ERC-20 activity on Arc in real time
- Tracks whale wallet movements and classifies behavior (holder / trader / exited)
- **Ask Arc** - natural language AI interface: ask questions, get answers from live on-chain data
- Arc ecosystem directory (DEXs, bridges, wallets, oracles)
- Telegram alerts with multi-user subscriptions
- Bridge & Swap pages with MetaMask wallet connect (Circle App Kit)

---

## Stack

Node.js · ethers.js · SQLite · Express · Circle App Kit · Groq/Llama · Telegram Bot API

---

## Quick Start

```bash
npm install
cp .env.example .env
# fill in RPC_URL, BOT_TOKEN, GROQ_API_KEY, CIRCLE_KIT_KEY
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
| `WHALE_THRESHOLD` | no | Min token amount for whale alert (default: 100000) |

---

## Roadmap

**Data Intelligence**
- Anomaly detection - unusual wallet behavior alerts
- Smart money tracking - follow wallets with proven track records
- Token risk scoring - automatic spam detection

**AI Layer**
- Agentic Ask Arc - complex on-chain queries
- Portfolio tracking - monitor any wallet, get movement alerts
- Whale signal context - behavioral history on movements

**Ecosystem**
- DEX liquidity monitoring
- Stablecoin flow analysis (USDC/EURC)
- Swap & Bridge execution on mainnet (Circle App Kit)

---

## License

MIT — Built on Arc Network
