async function setWallet() {
  const pk = document.getElementById("pk").value;

  const res = await fetch("/set-wallet", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ privateKey: pk })
  });

  const data = await res.json();

  document.getElementById("output").innerText =
    data.address || data.error;
}

async function generateWallet() {
  const res = await fetch("/generate-wallet");
  const data = await res.json();

  document.getElementById("output").innerText =
    `Address: ${data.address}\nPK: ${data.privateKey}`;
}

async function getBalance() {
  const res = await fetch("/balance");
  const data = await res.json();

  document.getElementById("output").innerText =
    data.evm ? `Balance: ${data.evm} ETH` : data.error;
}

async function swap() {
  const res = await fetch("/swap-evm", { method: "POST" });
  const data = await res.json();

  document.getElementById("output").innerText =
    data.tx || data.error;
}

async function autoTrade() {
  const res = await fetch("/auto-trade", { method: "POST" });
  const data = await res.json();

  document.getElementById("output").innerText =
    data.decision || data.error;
}
