const out = document.getElementById("out");
const apikey = document.getElementById("apikey");
const secret = document.getElementById("secret");

function log(x){
  out.textContent = typeof x === "string" ? x : JSON.stringify(x, null, 2);
}

async function req(url, method = "GET", body) {
  const headers = { "Content-Type": "application/json" };
  const key = apikey.value.trim();
  if (key) headers["x-api-key"] = key;

  const r = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  return r.json().catch(() => ({ ok:false, error:"Invalid JSON response" }));
}

async function status() {
  const r = await req("/api/sol/status");
  log(r);
}

async function setup() {
  const r = await req("/api/sol/setup", "POST", { secret: secret.value });
  log(r);
}

async function clearWallet() {
  const r = await req("/api/sol/clear", "POST", {});
  log(r);
}

async function balance() {
  const r = await req("/api/sol/balance");
  log(r);
}

async function swap() {
  const inputMint = document.getElementById("inMint").value.trim();
  const outputMint = document.getElementById("outMint").value.trim();
  const amount = document.getElementById("amount").value.trim();
  const slippageBps = Number(document.getElementById("slip").value.trim() || "50");

  const r = await req("/api/sol/swap-execute", "POST", {
    inputMint,
    outputMint,
    amount,
    slippageBps
  });

  log(r);
}

window.status = status;
window.setup = setup;
window.clearWallet = clearWallet;
window.balance = balance;
window.swap = swap;

status();
