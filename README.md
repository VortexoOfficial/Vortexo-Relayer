# Vortexo Relayer — Setup Guide

**Become a relayer. Earn 0.1% – 0.3% on every withdrawal you process.**

A relayer is anyone who runs this small server and pays gas for other users'
withdrawals. In exchange, the user pays you a fee — enforced by the smart
contract itself — on top of the gas refund. No permission needed from
anyone: you pay a one-time registration fee, run this server, and appear in
every user's relayer list.

---

## 1. How you earn (and why you can't cheat, and can't be cheated)

| Rule | Enforced by |
|---|---|
| You earn **exactly** `denomination × yourTier / 1000` per withdrawal (tier 1 = 0.1%, 2 = 0.2%, 3 = 0.3% max) | The smart contract — a wrong fee makes the withdrawal revert |
| You can never charge more than 0.3% | Same check — `MAX_FEE_TIER = 3` on-chain |
| The user can never pay you less than your tier | Same check — the fee is baked into their zk-proof |
| You always profit: `fee ≥ gas cost + MIN_PROFIT` | This server — it refuses (HTTP 503) any withdrawal that isn't profitable |
| Nobody can redirect your fee | The fee destination is a public signal **inside** the zk-proof — changing it invalidates the proof |
| You never learn users' secrets | You only ever receive proofs + public signals, never the note's secret/nullifier |

The fee arrives **inside the same transaction** that submits the withdrawal —
no claiming, no waiting, no trust involved. You pay gas, the contract
instantly refunds the gas + your fee to your wallet.

**Registration:** a one-time **0.01 ETH** (native token of each chain) fee,
paid on-chain to the protocol owner. Registration is for life — going
offline/online again is free.

---

## 2. Requirements

- A wallet (e.g. MetaMask account) used **only** for relaying — treat it as a
  **hot wallet**: keep only gas money in it, never main funds
- Gas money on every chain you serve (a few dollars' worth is plenty on L2s)
- A machine that stays online: a ~$5/month VPS is ideal; a home PC also works
- ~5 minutes of setup

---

## 3. Step-by-step setup

### Step 1 — Get the folder and install

Download/copy the `relayer` folder from this project, then inside it:

```
npm install
```

### Step 2 — Configure `.env`

Copy `.env` (or create it) and set:

```
# Your dedicated relayer wallet's private key (NOT your main wallet!)
RELAYER_PRIVATE_KEY=0x...

# Your fee tier — must match what you register on-chain:
#   1 = 0.1%, 2 = 0.2%, 3 = 0.3% (maximum allowed)
RELAYER_FEE_TIER=3

# One pair per chain you want to serve:
CONTRACT_ADDRESS_1=0x...   # e.g. Ethereum
RPC_URL_1=https://ethereum-rpc.publicnode.com
# Add more: 56 (BNB), 8453 (Base), 42161 (Arbitrum), 1 (Ethereum)...
```

The contract address is the deployed `VortexoFunZK` contract on that chain —
check the dApp or the deployment docs for current addresses.

### Step 3 — Start the server

```
npm start
```

You should see:

```
Relayer address: 0x...        ← must match the wallet you register with!
Fee tier: 3 (0.3% of each withdrawal)
Configured chains: 1
VortexoFunZK relayer listening on port 3001
```

If you see a warning like *"this wallet is NOT an active registered
relayer"* — register first (Step 5). If it says the on-chain tier differs
from `RELAYER_FEE_TIER` — fix the tier in `.env` or via the dApp, or every
withdrawal will revert on-chain.

### Step 4 — Get a free public HTTPS URL

The dApp (HTTPS) can only talk to your relayer over HTTPS. No domain needed:

```
cloudflared tunnel --url http://localhost:3001
```

Install once with `winget install Cloudflare.cloudflared` (Windows) or see
[Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/).

It prints a URL like `https://xxxx-yyyy.trycloudflare.com` — that's your
public relayer address. (See §5 for fixed-URL options.)

### Step 5 — Register on-chain

1. Open the Vortexo dApp → connect the **same wallet** whose key is in
   `.env` (the address must match `Relayer address:` from Step 3)
2. **★ RELAYER** tab → pick your fee tier (must equal `RELAYER_FEE_TIER`)
3. Paste your tunnel URL into **Server URL** → **REGISTER** → confirm the
   0.01 ETH transaction
4. Done. Your wallet now appears in every user's relayer list on every chain
   you configured.

---

## 4. Staying online & getting paid

- **Earnings arrive instantly** — inside each withdrawal transaction
- **Going offline is safe** — nothing breaks; users just see you offline and
  pick someone else. No funds at risk, ever.
- **Tunnel restarted → new URL?** RELAYER tab → *Move server endpoint* →
  paste the new URL → one transaction. (`updateRelayerEndpoint` on-chain)
- **Change your fee?** RELAYER tab → *Change fee tier* — and update
  `RELAYER_FEE_TIER` in `.env` to match, then restart the server.
- **Serve more chains?** Add `CONTRACT_ADDRESS_<chainId>` + `RPC_URL_<chainId>`
  pairs to `.env`, fund the wallet on that chain, register on that chain,
  restart.

### Troubleshooting

| Symptom | Cause & fix |
|---|---|
| You don't appear in users' picker | Server offline, tunnel down, URL changed (→ update endpoint), or the registered wallet ≠ server wallet |
| `503` responses | Fee doesn't cover gas right now — wait, serve cheaper chains, or lower… you can't lower below gas; this chain/denomination is simply unprofitable at the moment |
| Startup warning: tier mismatch | On-chain tier ≠ `RELAYER_FEE_TIER` — align them or withdrawals revert |
| Startup warning: not registered | Register in the dApp first (Step 5) |
| Withdrawals revert with `VF: relayer not registered` | Server points at the wrong contract — check `CONTRACT_ADDRESS_<chainId>` |

---

## 5. Production tips

- **Fixed URL:** quick tunnels change URL on every restart. For a permanent
  address use a named Cloudflare Tunnel with your own domain (free, still no
  hosting), or any VPS + reverse proxy + Let's Encrypt.
- **VPS > home PC:** always-on, isolated from your personal files. Any $5
  Ubuntu box works: install Node 18+, copy the folder, `npm install`,
  `pm2 start index.js`, reverse-proxy port 3001.
- **Keep the hot wallet light:** top up gas money as needed. The only keys
  that should ever be in `.env` are relayer keys.
- **Set `ALLOWED_ORIGINS`** in `.env` to your dApp's domain(s) if you want to
  restrict who can route withdrawals through you (optional — unprofitable
  requests can't cost you money anyway).
- **Monitor:** `GET /health` shows balance/registration; `GET /status/:chainId`
  shows gas price + balance per chain.

---

## 6. FAQ

**Why 0.01 ETH registration?** It pays for the protocol (goes to the
contract) and filters serious relayers from spam. Paid once per chain,
per wallet, forever.

**Can I run multiple relayers?** Yes — one wallet + one server each. Each
registers separately and competes in the marketplace.

**Can users steal my gas?** No. Every submission must pass local proof
verification, profitability check, and a dry-run simulation before any gas
is spent. Valid requests earn you the fee — that's the worst case.

**Do I see users' notes?** No. You receive a zk-proof and public signals
(root, nullifier hash, recipient, relayer, fee, denomination). The secret
never leaves the user's browser.

**Which chains can I serve?** Any EVM chain where VortexoFunZK is deployed.
Just add the `.env` pair — the frontend automatically shows you to users on
that chain.
