import readline from "readline";
import chalk from "chalk";
import ora from "ora";
import boxen from "boxen";
import dotenv from "dotenv";

import { agentScout } from "../agents/scout.js";
import { agentAnalyst } from "../agents/analyst.js";
import { agentRiskGate } from "../agents/riskgate.js";
import { agentExecutor } from "../agents/executor.js";

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (q) => new Promise(res => rl.question(q, res));

// ================= HEADER =================

function header() {
  console.clear();
  console.log(
    boxen(
      chalk.greenBright(`
INTERCOM SWAP BY PAK EKO 🚀
      `),
      {
        padding: 1,
        borderColor: "green",
        borderStyle: "round"
      }
    )
  );
}

// ================= MENU =================

function menuUI() {
  console.log(chalk.cyan(`
1. Quote (Preview)
2. Swap (Execute)
3. Agent (AI)
4. Exit
`));
}

// ================= PIPELINE =================

async function runPipeline(input, opts = {}) {
  const spinner = ora("Running pipeline...").start();

  try {
    const s = await agentScout(input);
    const a = agentAnalyst(s);
    const r = agentRiskGate(a);

    spinner.text = "Executing...";

    const ex = await agentExecutor(r, opts);

    spinner.succeed("Done ✅");

    console.log(
      boxen(
        chalk.greenBright(JSON.stringify({
          ...r,
          txid: ex.txid,
          status: "success"
        }, null, 2)),
        { padding: 1, borderColor: "green" }
      )
    );

    return ex;

  } catch (e) {
    spinner.fail("Error ❌");
    console.log(chalk.red(e.message));
  }
}

// ================= MENU FLOW =================

async function menu() {
  header();
  menuUI();

  const choice = await ask(chalk.yellow("Pilih menu: "));

  // ===== QUOTE =====
  if (choice === "1") {
    const tokenIn = await ask("Token In: ");
    const tokenOut = await ask("Token Out: ");
    const amount = await ask("Amount: ");

    console.log(chalk.blue("\n📊 Getting quote...\n"));

    await runPipeline({
      chain: "sol",
      tokenIn,
      tokenOut,
      amount,
      slippageBps: 50
    }, { dryRun: true });

    return back();
  }

  // ===== SWAP =====
  if (choice === "2") {
    const tokenIn = await ask("Token In: ");
    const tokenOut = await ask("Token Out: ");
    const amount = await ask("Amount: ");

    console.log(chalk.blue("\n📊 Preview first...\n"));

    await runPipeline({
      chain: "sol",
      tokenIn,
      tokenOut,
      amount,
      slippageBps: 50
    }, { dryRun: true });

    const confirm = await ask(chalk.red("Execute swap? (y/n): "));

    if (confirm.toLowerCase() === "y") {
      console.log(chalk.green("\n💸 Executing real swap...\n"));

      await runPipeline({
        chain: "sol",
        tokenIn,
        tokenOut,
        amount,
        slippageBps: 50
      });
    } else {
      console.log(chalk.gray("Cancelled."));
    }

    return back();
  }

  // ===== AGENT =====
  if (choice === "3") {
    const prompt = await ask("AI Command: ");

    await runPipeline({ prompt });

    return back();
  }

  // ===== EXIT =====
  if (choice === "4") {
    console.log(chalk.green("Bye 🚀"));
    rl.close();
    process.exit(0);
  }

  console.log(chalk.red("Invalid choice"));
  return back();
}

// ================= NAV =================

async function back() {
  await ask(chalk.gray("\nEnter untuk kembali..."));
  return menu();
}

// START
menu();
