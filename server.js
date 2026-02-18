import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/**
 * 🔒 SECURITY DEFAULT:
 * - binds to 127.0.0.1 (private) so NOT accessible via public IP:3000
 * - if you want public, set HOST=0.0.0.0 (not recommended)
 */
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

// Optional API key gate for sensitive endpoints (wallet actions)
const API_KEY = process.env.API_KEY || "";

function requireKey(req, res, next) {
  if (!API_KEY) return next(); // if no key set, allow
  const key = req.headers["x-api-key"];
  if (key && String(key) === String(API_KEY)) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// Serve UI (simple proof dashboard)
app.use(express.static("public"));

// ===== In-memory state (RAM only, resets on restart) =====
let SOL_WALLET = null; // { secret: string, loadedAt }
let EVM_WALLET = null; // { privateKey: string, loadedAt }

const WATCHLIST = new Map(); // address -> { address, note, addedAt }

// ===== HEALTH =====
app.get("/api/health", (req, res) => res.json({ ok: true, status: "online" }));

// ===== SOL SETUP (protected) =====
app.post("/api/sol/setup", requireKey, (req, res) => {
  const secret = String(req.body?.secret || "").trim();
  if (!secret) return res.status(400).json({ ok: false, error: "missing_secret" });
  SOL_WALLET = { secret, loadedAt: Date.now() };
  res.json({ ok: true, status: "sol_wallet_loaded" });
});

app.post("/api/sol/clear", requireKey, (req, res) => {
  SOL_WALLET = null;
  res.json({ ok: true, status: "sol_wallet_cleared" });
});

app.get("/api/sol/status", requireKey, (req, res) => {
  res.json({ ok: true, loaded: !!SOL_WALLET, loadedAt: SOL_WALLET?.loadedAt || null });
});

// ===== EVM SETUP (protected) =====
app.post("/api/evm/setup", requireKey, (req, res) => {
  const privateKey = String(req.body?.privateKey || "").trim();
  if (!privateKey) return res.status(400).json({ ok: false, error: "missing_privateKey" });
  EVM_WALLET = { privateKey, loadedAt: Date.now() };
  res.json({ ok: true, status: "evm_wallet_loaded" });
});

app.post("/api/evm/clear", requireKey, (req, res) => {
  EVM_WALLET = null;
  res.json({ ok: true, status: "evm_wallet_cleared" });
});

app.get("/api/evm/status", requireKey, (req, res) => {
  res.json({ ok: true, loaded: !!EVM_WALLET, loadedAt: EVM_WALLET?.loadedAt || null });
});

// ===== TOKEN TRACK (PUBLIC) =====
async function fetchDexToken(address) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`;
  const r = await fetch(url);
  const j = await r.json();
  const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
  return pairs;
}

function pickBestPair(pairs) {
  if (!pairs.length) return null;
  return pairs
    .slice()
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0];
}

app.get("/api/token/track", async (req, res) => {
  try {
    const address = String(req.query.address || "").trim();
    if (!address) return res.status(400).json({ ok: false, error: "address_required" });

    const pairs = await fetchDexToken(address);
    const best = pickBestPair(pairs);

    if (!best) return res.json({ ok: true, found: false, address, pairs: [] });

    res.json({
      ok: true,
      found: true,
      address,
      chainId: best.chainId,
      dexId: best.dexId,
      pairAddress: best.pairAddress,
      baseToken: best.baseToken,
      quoteToken: best.quoteToken,
      priceUsd: best.priceUsd,
      liquidityUsd: best?.liquidity?.usd,
      volume24h: best?.volume?.h24,
      priceChange24h: best?.priceChange?.h24,
      fdv: best?.fdv,
      url: best?.url
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "track_failed", message: String(e?.message || e) });
  }
});

// ===== TOKEN ANALYZE (PUBLIC) =====
function calcRisk(best) {
  const liq = Number(best?.liquidity?.usd || 0);
  const vol24 = Number(best?.volume?.h24 || 0);
  const change24 = Number(best?.priceChange?.h24 || 0);
  const fdv = Number(best?.fdv || 0);

  let score = 0;
  const reasons = [];

  // Liquidity
  if (liq < 2000) { score += 35; reasons.push("Liquidity very low (<$2k)"); }
  else if (liq < 10000) { score += 20; reasons.push("Liquidity low (<$10k)"); }
  else if (liq < 50000) { score += 10; reasons.push("Liquidity moderate (<$50k)"); }

  // Volume
  if (vol24 < 1000) { score += 15; reasons.push("Volume 24h very low (<$1k)"); }
  else if (vol24 < 10000) { score += 8; reasons.push("Volume 24h low (<$10k)"); }

  // Volatility
  if (Math.abs(change24) >= 80) { score += 15; reasons.push("Extreme 24h move (>=80%)"); }
  else if (Math.abs(change24) >= 40) { score += 8; reasons.push("High 24h move (>=40%)"); }

  // FDV / Liquidity heuristic
  if (fdv > 0 && liq > 0) {
    const ratio = fdv / liq;
    if (ratio > 500) { score += 20; reasons.push("FDV/Liquidity very high (>500x)"); }
    else if (ratio > 200) { score += 12; reasons.push("FDV/Liquidity high (>200x)"); }
    else if (ratio > 100) { score += 6; reasons.push("FDV/Liquidity elevated (>100x)"); }
  }

  score = Math.max(0, Math.min(100, score));

  let grade = "LOW";
  if (score >= 70) grade = "HIGH";
  else if (score >= 40) grade = "MEDIUM";

  const blocked = grade === "HIGH";
  const gate = blocked ? "BLOCKED" : (grade === "MEDIUM" ? "WARN" : "PASS");

  return {
    score,
    grade,
    gate,
    blocked,
    reasons,
    metrics: { liquidityUsd: liq, volume24h: vol24, priceChange24h: change24, fdv }
  };
}

app.get("/api/token/analyze", async (req, res) => {
  try {
    const address = String(req.query.address || "").trim();
    if (!address) return res.status(400).json({ ok: false, error: "address_required" });

    const pairs = await fetchDexToken(address);
    const best = pickBestPair(pairs);

    if (!best) return res.json({ ok: true, found: false, address });

    const risk = calcRisk(best);

    res.json({
      ok: true,
      found: true,
      address,
      chainId: best.chainId,
      dexId: best.dexId,
      baseToken: best.baseToken,
      quoteToken: best.quoteToken,
      priceUsd: best.priceUsd,
      url: best.url,
      risk
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "analyze_failed", message: String(e?.message || e) });
  }
});

// ===== WATCHLIST (PUBLIC ADD/REMOVE OK, NO SECRETS) =====
app.get("/api/watchlist", (req, res) => {
  res.json({ ok: true, items: Array.from(WATCHLIST.values()) });
});

app.post("/api/watchlist/add", (req, res) => {
  const address = String(req.body?.address || "").trim();
  const note = String(req.body?.note || "").trim();
  if (!address) return res.status(400).json({ ok: false, error: "address_required" });
  WATCHLIST.set(address, { address, note, addedAt: Date.now() });
  res.json({ ok: true, status: "added", address });
});

app.post("/api/watchlist/remove", (req, res) => {
  const address = String(req.body?.address || "").trim();
  if (!address) return res.status(400).json({ ok: false, error: "address_required" });
  WATCHLIST.delete(address);
  res.json({ ok: true, status: "removed", address });
});

// ===== AGENT ANALYZE (PUBLIC) =====
// Parses text like: "swap 0.01 SOL to USDC slippage 100 bps"
function parseAgentText(textRaw) {
  const text = String(textRaw || "").toLowerCase();

  // chain detect
  let chain = "unknown";
  if (text.includes("sol")) chain = "sol";
  if (text.includes("base")) chain = "base";
  if (text.includes("bsc")) chain = "bsc";
  if (text.includes("eth")) chain = "eth";

  // intent detect
  let intent = "unknown";
  if (text.includes("swap")) intent = "swap";
  if (text.includes("bridge")) intent = "bridge";

  // amount
  let amount = null;
  const amtMatch = text.match(/(\d+(\.\d+)?)/);
  if (amtMatch) amount = Number(amtMatch[1]);

  // slippage bps
  let slippageBps = null;
  const slpMatch = text.match(/slippage\s*(\d+)\s*bps/);
  if (slpMatch) slippageBps = Number(slpMatch[1]);

  // tokens (very simple heuristic)
  // examples: "sol to usdc", "eth to usdc"
  let fromToken = null;
  let toToken = null;
  const toMatch = text.match(/(\w+)\s+to\s+(\w+)/);
  if (toMatch) {
    fromToken = toMatch[1]?.toUpperCase();
    toToken = toMatch[2]?.toUpperCase();
  }

  return { intent, chain, amount, slippageBps, fromToken, toToken };
}

app.post("/api/agent/analyze", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "text_required" });

    const parsed = parseAgentText(text);

    // Risk gate suggestions (not blocking unless missing amount)
    const blocks = [];
    const warns = [];

    if (!parsed.amount || parsed.amount <= 0) blocks.push("Amount must be > 0");
    if (parsed.slippageBps != null && parsed.slippageBps > 300) warns.push("Slippage > 300 bps is very high");
    if (parsed.intent === "bridge") warns.push("Bridge risk is higher than swaps. Start small.");

    res.json({
      ok: true,
      parsed,
      gate: {
        blocked: blocks.length > 0,
        blocks,
        warns
      },
      autofill: {
        // these keys are meant for UI forms
        chain: parsed.chain,
        intent: parsed.intent,
        amount: parsed.amount,
        slippageBps: parsed.slippageBps ?? 100,
        fromToken: parsed.fromToken,
        toToken: parsed.toToken
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "agent_failed", message: String(e?.message || e) });
  }
});

// ===== START =====
app.listen(PORT, HOST, () => {
  console.log(`✅ ProMax API: http://${HOST}:${PORT}`);
  console.log(`🔒 Default is PRIVATE (HOST=127.0.0.1). Use SSH tunnel from phone to access safely.`);
});
