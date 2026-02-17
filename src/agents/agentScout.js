import { banner, sleep, fmt } from "./agentShared.js";

export async function agentScout({ quoteFn, input }) {
  // input: { chain, tokenIn, tokenOut, amountIn, slippageBps }
  console.log(banner("🤖 Agent 1: SCOUT (Planner)"));
  console.log("Scout: menerima brief swap…");
  await sleep(250);

  console.log(`Scout: chain=${input.chain}`);
  console.log(`Scout: tokenIn=${input.tokenIn}`);
  console.log(`Scout: tokenOut=${input.tokenOut}`);
  console.log(`Scout: amountIn=${input.amountIn}`);
  console.log(`Scout: slippage=${input.slippageBps} bps`);
  await sleep(250);

  console.log("Scout: fetching quote…");
  const q = await quoteFn(input); // expect { amountOut, minOut, path, warnings? }
  await sleep(200);

  console.log("Scout: quote received ✅");
  console.log(`Scout: estOut = ${fmt(q.amountOut)}`);
  console.log(`Scout: minOut = ${fmt(q.minOut)}`);
  console.log(`Scout: path   = ${q.path?.join(" -> ") || "-"}`);

  // Risk gate (basic + keliatan pro)
  const warnings = [];
  if (input.slippageBps > 300) warnings.push("Slippage > 3% (risky)");
  if (!q.path || q.path.length < 2) warnings.push("Route path invalid");
  if (q.warnings?.length) warnings.push(...q.warnings);

  console.log("\nScout: risk gate report:");
  if (!warnings.length) {
    console.log("Scout: ✅ PASS (no warnings)");
  } else {
    console.log("Scout: ⚠️ WARNINGS:");
    for (const w of warnings) console.log(`- ${w}`);
  }

  // Plan object buat handoff ke Executor
  const plan = {
    chain: input.chain,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    amountIn: input.amountIn,
    slippageBps: input.slippageBps,
    amountOut: q.amountOut,
    minOut: q.minOut,
    path: q.path,
    warnings,
  };

  console.log("\nScout: handoff plan → Executor ✅");
  return plan;
}
