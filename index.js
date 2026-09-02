// index.js — VortexoFunZK relayer
//
// Matches the ACTUAL live code paths in this repo:
//   - src/lib/zkClient.ts   -> generateWithdrawalProof() produces
//       { proof: { _pA, _pB, _pC }, publicSignals: string[6] }
//       (pi_b is ALREADY swapped into Solidity order here — not raw snarkjs shape)
//   - src/lib/ethereum.ts   -> withdrawZK() submits with:
//       withdraw(_pA, _pB, _pC, toHex32(root), toHex32(nullifierHash),
//                recipient, relayer, fee, denom)
//
// This relayer accepts exactly what generateWithdrawalProof() returns, plus
// the recipient/relayer/fee/denom the client already has — the same shape
// ethereum.ts's withdrawZK() takes — so a frontend integration is a straight
// swap of "submit locally" for "POST to relayer" with no reshaping needed.
//
// The relayer NEVER receives `secret` or `nullifier` — only the proof and
// public signals. It cannot deanonymize, redirect funds, or steal fees; the
// fee destination is a public signal baked INSIDE the proof itself, so
// neither this relayer nor anyone who copies the transaction can change it.

const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const MIN_PROFIT_WEI = ethers.parseEther(process.env.MIN_PROFIT || "0.0005");
const GAS_LIMIT_BUFFER_PCT = BigInt(process.env.GAS_LIMIT_BUFFER_PCT || "20");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 20);

// Relayer fee tier, chosen at registration time on-chain (1 = 0.1%,
// 2 = 0.2%, 3 = 0.3% max). This MUST match the `feeTier` stored for this
// relayer's wallet in the contract's relayer registry — the fee is a public
// signal baked into every proof, and the on-chain withdraw() enforces
// fee == denominationValue * tier / 1000 exactly. A mismatch means every
// relayer-assisted withdrawal reverts on-chain.
const RELAYER_FEE_TIER = Math.floor(Number(process.env.RELAYER_FEE_TIER || "3"));
if (!Number.isInteger(RELAYER_FEE_TIER) || RELAYER_FEE_TIER < 1 || RELAYER_FEE_TIER > 3) {
  console.error("FATAL: RELAYER_FEE_TIER must be 1 (0.1%), 2 (0.2%) or 3 (0.3%) in .env");
  process.exit(1);
}

if (!RELAYER_PRIVATE_KEY || RELAYER_PRIVATE_KEY === "0xYOUR_PRIVATE_KEY") {
  console.error("FATAL: RELAYER_PRIVATE_KEY is not set in .env");
  process.exit(1);
}

const VERIFICATION_KEY = JSON.parse(
  fs.readFileSync(path.join(__dirname, "verification_key.json"), "utf8")
);

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Exact signature from src/lib/ethereum.ts (line 79).
const VORTEXO_ABI = [
  "function withdraw(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint256 root, bytes32 nullifierHash, address payable recipient, address payable relayer, uint256 fee, uint8 denom) external",
  "function isSpent(bytes32 nullifierHash) external view returns (bool)",
  "function isKnownRoot(uint256 root, uint8 denom) external view returns (bool)",
  "function getDenominationValue(uint8 denom) external pure returns (uint256)",
  // ── Relayer registry (read-only here; registration happens in the dApp) ──
  "function relayers(address) external view returns (uint8 feeTier, string endpoint, bool active)",
  "function getRelayerInfo(address relayer) external view returns (uint8 feeTier, string endpoint, bool active)",
];

// Per-chain config via env, e.g.:
//   CONTRACT_ADDRESS_11155111=0x...
//   RPC_URL_11155111=https://...
function loadChains() {
  const chains = {};
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^CONTRACT_ADDRESS_(\d+)$/);
    if (!m) continue;
    const chainId = m[1];
    const address = process.env[key];
    const rpcUrl = process.env[`RPC_URL_${chainId}`];
    if (!address || !rpcUrl) {
      console.warn(`Skipping chain ${chainId}: missing RPC_URL_${chainId} or empty address`);
      continue;
    }
    if (!ethers.isAddress(address)) {
      console.warn(`Skipping chain ${chainId}: CONTRACT_ADDRESS_${chainId} is not a valid address`);
      continue;
    }
    chains[chainId] = { chainId: Number(chainId), address, rpcUrl };
  }
  return chains;
}

const CHAINS = loadChains();
if (Object.keys(CHAINS).length === 0) {
  console.error("FATAL: no chains configured. Set CONTRACT_ADDRESS_<chainId> and RPC_URL_<chainId> in .env");
  process.exit(1);
}

const chainClients = {};
function getChainClient(chainId) {
  const key = String(chainId);
  if (chainClients[key]) return chainClients[key];
  const cfg = CHAINS[key];
  if (!cfg) return null;

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(cfg.address, VORTEXO_ABI, wallet);

  chainClients[key] = { provider, wallet, contract, config: cfg };
  return chainClients[key];
}

const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY);
console.log("Relayer address:", relayerWallet.address);
console.log("Fee tier:", `${RELAYER_FEE_TIER} (${(RELAYER_FEE_TIER / 10).toFixed(1)}% of each withdrawal)`);
console.log("Configured chains:", Object.keys(CHAINS).join(", "));

// Reads this relayer's on-chain registry entry on every configured chain.
// Registration happens in the dApp (pay 0.01 ETH); here we only report it —
// the frontend uses this to show users whether this relayer is live/active.
async function getRegistrationStatus() {
  const registration = {};
  await Promise.all(
    Object.keys(CHAINS).map(async (chainId) => {
      try {
        const client = getChainClient(chainId);
        const [feeTier, endpoint, active] = await client.contract.getRelayerInfo(relayerWallet.address);
        registration[chainId] = {
          registered: active || feeTier > 0,
          active,
          onChainFeeTier: Number(feeTier),
          endpoint,
          matchesConfiguredTier: Number(feeTier) === RELAYER_FEE_TIER,
        };
      } catch (err) {
        // Registry read can fail on chains where an older contract version is
        // deployed (no registry). Report it rather than crashing /health.
        registration[chainId] = { registered: false, error: err.shortMessage || err.message };
      }
    })
  );
  return registration;
}

// Warn at startup if this wallet isn't an active registered relayer — the
// on-chain withdraw() will reject every submission until it registers.
getRegistrationStatus()
  .then((registration) => {
    for (const [chainId, reg] of Object.entries(registration)) {
      if (reg.error) {
        console.warn(`Chain ${chainId}: could not read relayer registry (${reg.error})`);
      } else if (!reg.active) {
        console.warn(`Chain ${chainId}: this wallet is NOT an active registered relayer — register in the dApp (0.01 ETH) or withdrawals will revert on-chain.`);
      } else if (!reg.matchesConfiguredTier) {
        console.warn(
          `Chain ${chainId}: on-chain fee tier (${reg.onChainFeeTier}) differs from RELAYER_FEE_TIER (${RELAYER_FEE_TIER}) — ` +
          `update RELAYER_FEE_TIER in .env or call updateRelayerFee() — otherwise every withdrawal reverts.`
        );
      }
    }
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "256kb" }));

app.use(
  cors(
    ALLOWED_ORIGINS.length > 0
      ? {
          origin: (origin, cb) => {
            if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
            cb(new Error("Origin not allowed"));
          },
        }
      : {}
  )
);
if (ALLOWED_ORIGINS.length === 0) {
  console.warn("WARNING: ALLOWED_ORIGINS not set — CORS is wide open. Set it before production use.");
}

// --- minimal in-memory per-IP rate limiter ---------------------------------
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const arr = (hits.get(ip) || []).filter((t) => t > windowStart);
  if (arr.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests, slow down." });
  }
  arr.push(now);
  hits.set(ip, arr);
  next();
}
setInterval(() => {
  const windowStart = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, arr] of hits.entries()) {
    const kept = arr.filter((t) => t > windowStart);
    if (kept.length === 0) hits.delete(ip);
    else hits.set(ip, kept);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidFieldElementString(s) {
  if (typeof s !== "string" && typeof s !== "number") return false;
  try {
    const v = BigInt(s);
    return v >= 0n && v < FIELD_SIZE;
  } catch {
    return false;
  }
}

// Same helper as ethereum.ts's toHex32(): decimal field-element string -> 0x + 32 bytes.
function toHex32(value) {
  let bn;
  try {
    bn = BigInt(value);
  } catch {
    throw new Error(`Invalid numeric input for hex encoding: ${value}`);
  }
  if (bn < 0n) throw new Error(`Negative value not allowed in field element: ${bn}`);
  return ethers.toBeHex(bn, 32);
}

function addressToField(addr) {
  return (BigInt(addr) % FIELD_SIZE).toString();
}

function isValidZkProofShape(proof) {
  if (!proof || typeof proof !== "object") return false;
  const isPair = (a) => Array.isArray(a) && a.length === 2 && isValidFieldElementString(a[0]) && isValidFieldElementString(a[1]);
  if (!isPair(proof._pA)) return false;
  if (!Array.isArray(proof._pB) || proof._pB.length !== 2 || !isPair(proof._pB[0]) || !isPair(proof._pB[1])) return false;
  if (!isPair(proof._pC)) return false;
  return true;
}

// Reverses zkClient.ts's swap so we can run snarkjs's own (raw-format) local
// verifier. Confirmed correct against a freshly generated, genuinely valid
// proof — do not "simplify" this without re-checking against a real proof.
function toRawSnarkjsProof(zkProof) {
  return {
    pi_a: [zkProof._pA[0], zkProof._pA[1], "1"],
    pi_b: [
      [zkProof._pB[0][1], zkProof._pB[0][0]],
      [zkProof._pB[1][1], zkProof._pB[1][0]],
      ["1", "0"],
    ],
    pi_c: [zkProof._pC[0], zkProof._pC[1], "1"],
    protocol: "groth16",
    curve: "bn128",
  };
}

// Not negotiable, not a minimum, not a range — a request proposing any
// other fee is rejected outright. This must match EXACTLY what the
// frontend computes when generating the proof (the fee is a public signal
// baked into the proof itself), or every relayer withdrawal will fail
// local verification before even reaching this check.
// RELAYER_FEE_TIER itself is defined in the config section at the top.
const RELAYER_FEE_NUMERATOR = BigInt(RELAYER_FEE_TIER);
const RELAYER_FEE_DENOMINATOR = 1000n; // tier/1000 → 0.1% / 0.2% / 0.3%

function computeRequiredFee(denomValue) {
  return (denomValue * RELAYER_FEE_NUMERATOR) / RELAYER_FEE_DENOMINATOR;
}

function extractRevertReason(err) {
  return err.shortMessage || err.reason || err.message || "unknown revert";
}

function validateWithdrawBody(body) {
  const errors = [];
  const { proof, publicSignals, recipient, relayer, fee, denom, chainId } = body || {};

  if (!isValidZkProofShape(proof)) errors.push("proof is missing or malformed (expected { _pA, _pB, _pC })");
  if (!Array.isArray(publicSignals) || publicSignals.length !== 6 || !publicSignals.every(isValidFieldElementString)) {
    errors.push("publicSignals must be an array of exactly 6 valid field elements [root, nullifierHash, recipient, relayer, fee, denom]");
  }
  if (!ethers.isAddress(recipient)) errors.push("recipient is not a valid address");
  if (!ethers.isAddress(relayer)) errors.push("relayer is not a valid address");
  if (!isValidFieldElementString(fee)) errors.push("fee is missing or not a valid non-negative integer");
  if (![1, 2, 3, 4].includes(Number(denom))) errors.push("denom must be an integer between 1 and 4");
  if (!chainId || !CHAINS[String(chainId)]) {
    errors.push(`chainId is missing or not supported. Supported: ${Object.keys(CHAINS).join(", ")}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", async (req, res) => {
  let registration;
  try {
    registration = await getRegistrationStatus();
  } catch {
    registration = {};
  }
  res.json({
    status: "ok",
    relayerAddress: relayerWallet.address,
    feeTier: RELAYER_FEE_TIER,
    feePercent: RELAYER_FEE_TIER / 10,
    supportedChains: Object.keys(CHAINS).map(Number),
    registration,
  });
});

app.get("/status/:chainId", async (req, res) => {
  const client = getChainClient(req.params.chainId);
  if (!client) {
    return res.status(404).json({ error: `Unsupported chainId. Supported: ${Object.keys(CHAINS).join(", ")}` });
  }
  try {
    const [balance, feeData, network] = await Promise.all([
      client.provider.getBalance(relayerWallet.address),
      client.provider.getFeeData(),
      client.provider.getNetwork(),
    ]);
    res.json({
      chainId: client.config.chainId,
      contractAddress: client.config.address,
      networkChainId: network.chainId.toString(),
      relayerAddress: relayerWallet.address,
      feeTier: RELAYER_FEE_TIER,
      feePercent: RELAYER_FEE_TIER / 10,
      relayerBalanceEth: ethers.formatEther(balance),
      maxFeePerGasWei: feeData.maxFeePerGas ? feeData.maxFeePerGas.toString() : null,
      gasPriceWei: feeData.gasPrice ? feeData.gasPrice.toString() : null,
    });
  } catch (err) {
    console.error(`/status/${req.params.chainId} error:`, err.message);
    res.status(502).json({ error: "Failed to reach RPC for this chain", detail: err.message });
  }
});

// Body shape mirrors ethereum.ts's withdrawZK() args exactly:
//   { chainId, proof: {_pA,_pB,_pC}, publicSignals, recipient, relayer, fee, denom }
app.post("/withdraw", rateLimit, async (req, res) => {
  const validationErrors = validateWithdrawBody(req.body);
  if (validationErrors.length > 0) {
    return res.status(400).json({ error: "Invalid request", details: validationErrors });
  }

  const { proof, publicSignals, recipient, relayer, fee, denom, chainId } = req.body;
  const client = getChainClient(chainId);
  const denomNum = Number(denom);

  try {
    // 1) This relayer only submits withdrawals that pay ITS OWN fee. The fee
    //    destination is fixed inside the proof, so this is a business-logic
    //    guard (don't waste our gas paying someone else's fee), not a
    //    security check.
    if (relayer.toLowerCase() !== relayerWallet.address.toLowerCase()) {
      return res.status(400).json({
        error: "The `relayer` field does not match this relayer's address.",
        expected: relayerWallet.address,
        got: relayer,
      });
    }

    // 2) Cross-check the named fields against publicSignals. The contract
    //    would catch a mismatch anyway (proof verification would simply
    //    fail), but this gives a clear, cheap, specific error instead of a
    //    generic on-chain revert.
    const [root, nullifierHashDec, recipientField, relayerField, feeField, denomField] = publicSignals;
    const expected = [root, nullifierHashDec, addressToField(recipient), addressToField(relayer), fee.toString(), denomNum.toString()];
    const actual = [root, nullifierHashDec, recipientField, relayerField, feeField, denomField];
    for (let i = 2; i < 6; i++) {
      if (expected[i] !== actual[i]) {
        return res.status(400).json({
          error: `publicSignals[${i}] does not match the corresponding named field`,
          expected: expected[i],
          got: actual[i],
        });
      }
    }

    // 3) Verify the proof locally — free, no gas, catches every malformed
    //    or forged submission before we ever touch the chain.
    const rawProof = toRawSnarkjsProof(proof);
    const isValidProof = await snarkjs.groth16.verify(VERIFICATION_KEY, publicSignals, rawProof);
    if (!isValidProof) {
      return res.status(400).json({ error: "Proof failed local verification" });
    }

    const nullifierHex = toHex32(nullifierHashDec);
    const rootHex = toHex32(root);

    // 4) Cheap on-chain reads to reject dead requests before spending gas.
    const [alreadySpent, knownRoot, denomValue] = await Promise.all([
      client.contract.isSpent(nullifierHex),
      client.contract.isKnownRoot(BigInt(root), denomNum),
      client.contract.getDenominationValue(denomNum),
    ]);
    if (alreadySpent) return res.status(409).json({ error: "This note has already been withdrawn" });
    if (!knownRoot) return res.status(409).json({ error: "Merkle root is unknown or too old — refresh and regenerate the proof" });

    const feeWei = BigInt(fee);
    const requiredFee = computeRequiredFee(denomValue);
    if (feeWei !== requiredFee) {
      return res.status(400).json({
        error: `This relayer only accepts its registered tier fee of ${RELAYER_FEE_TIER / 10}% — no other amount.`,
        requiredFeeWei: requiredFee.toString(),
        gotFeeWei: feeWei.toString(),
      });
    }

    // 5) Profitability check.
    const feeData = await client.provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!maxFeePerGas) {
      return res.status(502).json({ error: "Could not determine gas price from RPC" });
    }

    const callArgs = [proof._pA, proof._pB, proof._pC, rootHex, nullifierHex, recipient, relayer, fee.toString(), denomNum];

    // 6) Dry-run via estimateGas — simulates the whole call (including the
    //    on-chain proof check) without spending real gas. This is what
    //    actually stops someone from draining our balance with bad requests.
    let gasEstimate;
    try {
      gasEstimate = await client.contract.withdraw.estimateGas(...callArgs);
    } catch (err) {
      return res.status(400).json({ error: "Transaction would revert on-chain", detail: extractRevertReason(err) });
    }

    const estimatedGasCost = gasEstimate * maxFeePerGas;
    if (feeWei < estimatedGasCost + MIN_PROFIT_WEI) {
      // The fee is fixed at 0.3% — there's no "send a higher fee" option
      // here. If gas prices have risen enough that 0.3% of this
      // denomination no longer covers gas + minimum profit, the honest
      // answer is that relayer-assisted withdrawal isn't available for
      // this denomination right now, not that the user should propose
      // a different amount. Self-withdrawal (paying gas directly) is
      // unaffected by this and remains available regardless.
      return res.status(503).json({
        error: `Relayer-assisted withdrawal is temporarily unavailable for this denomination — the ${RELAYER_FEE_TIER / 10}% fee doesn't currently cover gas costs. Try self-withdrawal instead, another relayer, or try again once gas prices drop.`,
        fixedFeeWei: feeWei.toString(),
        estimatedGasCostWei: estimatedGasCost.toString(),
        minProfitWei: MIN_PROFIT_WEI.toString(),
      });
    }

    // 7) Broadcast for real, with a bounded buffer over the estimate.
    const gasLimit = (gasEstimate * (100n + GAS_LIMIT_BUFFER_PCT)) / 100n;
    const tx = await client.contract.withdraw(...callArgs, {
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
    });

    console.log(`Submitted withdraw tx ${tx.hash} on chain ${chainId} (nullifier ${nullifierHex})`);
    const receipt = await tx.wait();

    return res.json({
      success: true,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      status: receipt.status === 1 ? "confirmed" : "failed",
    });
  } catch (err) {
    console.error("Unexpected /withdraw error:", err);
    return res.status(500).json({ error: "Internal relayer error", detail: extractRevertReason(err) });
  }
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

app.listen(PORT, () => {
  console.log(`VortexoFunZK relayer listening on port ${PORT}`);
});
