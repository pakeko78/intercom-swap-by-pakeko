import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { ethers } from "ethers";
import { Connection } from "@solana/web3.js";

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const PORT = 3000;

// ================= CONFIG =================
const GROQ_API_KEY = "ISI_GROQ_API_KEY";

// EVM
const EVM_RPC = "https://rpc.ankr.com/eth";
const EVM_PRIVATE_KEY = "ISI_PRIVATE_KEY";
const EVM_ADDRESS = "ADDRESS_EVM";

// SOL
const SOL_RPC = "https://api.mainnet-beta.solana.com";
const SOL_ADDRESS = "ADDRESS_SOL";

// INIT
const provider = new ethers.JsonRpcProvider(EVM_RPC);
const wallet = new ethers.Wallet(EVM_PRIVATE_KEY, provider);
const connection = new Connection(SOL_RPC);

// ================= AI =================
async function aiDecision(token) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "llama3-70b-8192",
      messages: [
        {
          role: "user",
          content: `Analyze ${token}. Answer BUY / SELL / SKIP`
        }
      ]
    })
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

// ================= BALANCE =================
app.get("/balance", async (req, res) => {
  try {
    const evmBal = await provider.getBalance(EVM_ADDRESS);
    const solBal = await connection.getBalance(SOL_ADDRESS);

    res.json({
      evm: ethers.formatEther(evmBal),
      sol: solBal / 1e9
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ================= TRENDING =================
app.get("/trending", async (req, res) => {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/solana");
    const data = await r.json();

    res.json(data.pairs.slice(0, 5));
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ================= SWAP EVM =================
app.post("/swap-evm", async (req, res) => {
  try {
    const r = await fetch("https://li.quest/v1/quote", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        fromChain: 1,
        toChain: 1,
        fromToken: "USDC",
        toToken: "ETH",
        fromAmount: "1000000",
        fromAddress: EVM_ADDRESS
      })
    });

    const data = await r.json();
    const tx = data.transactionRequest;

    const txResponse = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value
    });

    res.json({ tx: txResponse.hash });

  } catch (e) {
    res.json({ error: e.message });
  }
});

// ================= AUTO TRADE =================
app.post("/auto-trade", async (req, res) => {
  try {
    const token = "SOL";
    const decision = await aiDecision(token);

    res.json({ decision });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 RUNNING: http://localhost:${PORT}`);
});
