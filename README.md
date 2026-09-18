# Lensora

On-chain radar for Arc mainnet: whale moves, stablecoin signals, Telegram strategies, free signals API.

**Live:** https://lensora.xyz
**Repo:** magnetar1881/arc-intelligence

Lensora does not spend its own USDC. Swap and bridge are signed in the user's MetaMask. Server `POST /api/swap/execute` and `POST /api/bridge/execute` return 403.

## Network

| | |
|---|---|
| Chain | Arc mainnet |
| Chain ID | **5042** (`ethers` `getNetwork()` → `5042 unknown` is correct) |
| RPC | `https://rpc.mainnet.arc.io` |
| Do not use | Testnet `5042002` |

### Tokens we index

| Asset | Address | Decimals | Notes |
|---|---|---|---|
| USDC (native Transfer) | `0xfff…ffe` | 18 | Count this |
| USDC ERC-20 | `0x3600…000` | 6 | Duplicate log — skip |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | 6 | Mainnet only |

Whale threshold: **100,000** human units (USDC ≈ USD).

## Quick start

```bash
npm install
cp .env.example .env
# fill RPC_URL, BOT_TOKEN, GROQ_API_KEY, CIRCLE_KIT_KEY
# SCANNER_ENABLED=true
node src/app.js

---

## Roadmap

### Near Term

#### Data Intelligence
- Anomaly detection ✓
- Smart money tracking ✓ 
- Token risk scoring ✓
- Smart Money Score ✓
- AI transaction explanation ✓

#### AI Layer
- Portfolio tracking ✓
- Watchlists ✓
- AI daily market summaries
- Whale signal context ✓

#### Ecosystem
- Swap & Bridge execution on mainnet ✓
- DEX liquidity monitoring ✓
- Stablecoin flow analysis (USDC / EURC) ✓

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
- Yield discovery across Arc
- Ecosystem analytics & protocol insights

---

## License

MIT — Built on Arc Network
