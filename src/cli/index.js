import yargs from "yargs";
import dotenv from "dotenv";

import { agentScout } from "../agents/scout.js";
import { agentAnalyst } from "../agents/analyst.js";
import { agentRiskGate } from "../agents/riskgate.js";
import { agentExecutor } from "../agents/executor.js";

dotenv.config();

async function run(input, opts = {}) {
  try {
    const s = await agentScout(input);
    const a = agentAnalyst(s);
    const r = agentRiskGate(a);
    const ex = await agentExecutor(r, opts);

    console.log(JSON.stringify({
      ...r,
      txid: ex.txid,
      status: "success"
    }, null, 2));

  } catch (e) {
    console.error("❌", e.message);
  }
}

yargs(process.argv.slice(2))
.command("swap", "execute", y=>y, argv=>{
  run(argv);
})
.command("agent", "ai", y=>y, argv=>{
  run({prompt:argv.prompt});
})
.parse();
