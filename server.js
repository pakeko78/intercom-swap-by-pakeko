import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// ===== SOLANA CONFIG =====
const SOL_RPC = process.env.SOL_RPC || "https://api.mainnet-beta.solana.com";
const solConn = new Connection(SOL_RPC, "confirmed");

// ===== OPTIONAL API KEY (recommended) =====
const API_KEY = (process.env.API_KEY || "").trim();

// ===== IN-MEMORY SOL WALLET (RUNTIME SETUP) =====
let SOL_KP = null;

// ---------------- Helpers ----------------
function ok(res, data) {
  res.json({ ok: true, ...data });
}
function fail(res, msg, extra = {}) {
  res.status(400).json({ ok: false, error: msg, ...extra });
}
function mask(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
function requireApiKey(req, res) {
  if (!API_KEY) return true; // unlocked if not set
  const got = req.headers["x-api-key"];
  if (got !== API_KEY) {
    res
      .status(401)
      .json({ ok: false, error: "Unauthorized (missing/invalid x-api-key)" });
    return false;
  }
  return true;
}
function parseSolSecret(secretRaw) {
  const s = String(secretRaw || "").trim();
  if (!s) throw new Error("Secret key kosong");

  // JSON array: [12,34,...]
  if (s.startsWith("[")) {
    const arr = JSON.parse(s);
    const u8 = Uint8Array.from(arr);
    return Keypair.fromSecretKey(u8);
  }

  // Base58 string
  const u8 = bs58.decode(s);
  return Keypair.fromSecretKey(u8);
}

// serve UI
app.use(express.static(path.join(__dirname, "public")));

// ---------------- Status ----------------
app.get("/api/health", (_req, res) => {
  ok(res, {
    status: "up",
    solRpc: SOL_RPC,
    apiKeyEnabled: !!API_KEY,
    hasSolWallet: !!SOL_KP,
    address: SOL_KP ? SOL_KP.publicKey.toBase58() : null,
  });
});

app.get("/api/sol/status", (_req, res) => {
  ok(res, {
    rpc: SOL_RPC,
    apiKeyEnabled: !!API_KEY,
    hasWallet: !!SOL_KP,
    address: SOL_KP ? SOL_KP.publicKey.toBase58() : null,
    addressMasked: SOL_KP ? mask(SOL_KP.publicKey.toBase58()) : null,
    note: SOL_KP
      ? "Wallet aktif (disimpan RAM)."
      : "Wallet belum diset. Paste secret di UI > Set Wallet.",
  });
});

// ---------------- Setup/Clear wallet ----------------
app.post("/api/sol/setup", (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const secret = req.body?.secret;
    const kp = parseSolSecret(secret);
    SOL_KP = kp;

    const address = kp.publicKey.toBase58();
    ok(res, {
      address,
      addressMasked: mask(address),
      note: "SOL wallet terset (disimpan di RAM). Restart server = set ulang.",
    });
  } catch (e) {
    fail(res, e.message || "Gagal setup SOL wallet");
  }
});

app.post("/api/sol/clear", (req, res) => {
  if (!requireApiKey(req, res)) return;
  SOL_KP = null;
  ok(res, { note: "SOL wallet dihapus dari memory." });
});

// ---------------- Balance ----------------
app.get("/api/sol/balance", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    if (!SOL_KP)
      return fail(res, "SOL wallet belum diset. Setup dulu di UI.");

    const lamports = await solConn.getBalance(SOL_KP.publicKey, "confirmed");
    ok(res, {
      address: SOL_KP.publicKey.toBase58(),
      sol: lamports / 1e9,
      lamports,
    });
  } catch (e) {
    fail(res, e.message || "Gagal ambil SOL balance");
  }
});

// ---------------- Jupiter SWAP EXECUTE (server signs) ----------------
// inputMint/outputMint: mint address
// amount: base units (lamports utk SOL/wSOL, atau token base units)
// slippageBps: default 50 (0.5%)
app.post("/api/sol/swap-execute", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    if (!SOL_KP)
      return fail(res, "SOL wallet belum diset. Setup dulu di UI.");

    const { inputMint, outputMint, amount, slippageBps = 50 } = req.body || {};
    if (!inputMint || !outputMint)
      return fail(res, "inputMint/outputMint kosong");
    if (!amount) return fail(res, "amount kosong (base units/lamports)");

    const userPublicKey = SOL_KP.publicKey.toBase58();

    // 1) Quote
    const qUrl = new URL("https://quote-api.jup.ag/v6/quote");
    qUrl.searchParams.set("inputMint", inputMint);
    qUrl.searchParams.set("outputMint", outputMint);
    qUrl.searchParams.set("amount", String(amount));
    qUrl.searchParams.set("slippageBps", String(slippageBps));

    const quoteRes = await fetch(qUrl.toString());
    const quoteJson = await quoteRes.json();

    if (!quoteJson?.routePlan) {
      return fail(res, "Quote gagal / pair tidak ditemukan", { raw: quoteJson });
    }

    // 2) Build swap tx
    const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteJson,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
    });

    const swapJson = await swapRes.json();
    if (!swapJson?.swapTransaction) {
      return fail(res, "Swap TX gagal dibuat", { raw: swapJson });
    }

    // 3) Deserialize -> sign -> broadcast
    const txBytes = Buffer.from(swapJson.swapTransaction, "base64");
    const vtx = VersionedTransaction.deserialize(txBytes);

    vtx.sign([SOL_KP]);

    const sig = await solConn.sendRawTransaction(vtx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    const conf = await solConn.confirmTransaction(sig, "confirmed");

    ok(res, {
      signature: sig,
      confirmation: conf?.value || null,
      quote: {
        inAmount: quoteJson.inAmount,
        outAmount: quoteJson.outAmount,
        priceImpactPct: quoteJson.priceImpactPct,
      },
      note: "EXECUTED: tx ditandatangani server + broadcast ke jaringan.",
    });
  } catch (e) {
    fail(res, e.message || "Swap execute error");
  }
});

app.listen(PORT, () => {
  console.log(`✅ Running on http://0.0.0.0:${PORT}`);
});
