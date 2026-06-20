// Bazaar — multi-agent economy (slice 2).
// Spawns several competing seller services (one a DEGRADER), runs a memory-keeping buyer
// for N rounds, then batches all accepted claims on-chain. Routing AWAY from the degrader
// emerges from the buyer's own per-seller memory — the operator scripts none of it.
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { rmSync, appendFileSync } from "node:fs";
import { formatEther } from "viem";
import { account, publicClient, ESCROW, CHAIN_ID, BUYER_PK, SELLER_PK } from "../config.js";
import { escrowBalance } from "../rail/escrow.js";
import { buyerRound, type Memory, type Persona, type SellerRef } from "../agents/economyBuyer.js";
import { llmLabel } from "../agents/llm.js";

const QUEUE = resolve(process.cwd(), "pending-claims.jsonl");
const LEDGER = resolve(process.cwd(), "economy.ledger.jsonl");
const ROUNDS = Number(process.env.BAZAAR_ROUNDS ?? 6);

const SELLERS = [
  { name: "summarizer-A", port: 7421, price: "0.002", degrade: false, key: "A" },
  { name: "analyst-B", port: 7422, price: "0.003", degrade: false, key: "B" },
  { name: "cheapbot-C", port: 7423, price: "0.001", degrade: true, key: "C" }, // cheapest, but a degrader (shock lever)
];

function spawnRunner(script: string, extraEnv: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function startSeller(s: (typeof SELLERS)[number]): Promise<ChildProcess> {
  const sellerPk = process.env[`BAZAAR_SELLER_${s.key}_PK`];
  if (!sellerPk) throw new Error(`missing BAZAAR_SELLER_${s.key}_PK in ../.env`);
  const child = spawnRunner("src/runner/seller-proc.ts", {
    BAZAAR_SELLER_NAME: s.name,
    BAZAAR_SELLER_PORT: String(s.port),
    BAZAAR_PRICE: s.price,
    BAZAAR_DEGRADE: s.degrade ? "1" : "0",
    BAZAAR_SELLER_PK: sellerPk,
    BAZAAR_QUEUE: QUEUE,
  });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${s.name} not ready in 30s`)), 30_000);
    child.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("SELLER_READY")) {
        clearTimeout(timer);
        res(child);
      }
    });
    child.on("exit", (c) => {
      clearTimeout(timer);
      rej(new Error(`${s.name} exited early (${c})`));
    });
  });
}

function runSettler(): Promise<string> {
  return new Promise((res, rej) => {
    let out = "";
    const child = spawnRunner("src/runner/settler.ts", { BAZAAR_QUEUE: QUEUE });
    child.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    child.on("exit", () => res(out));
    child.on("error", rej);
  });
}

async function main(): Promise<void> {
  if (!BUYER_PK || !SELLER_PK) throw new Error("set PRIVATE_KEY and SERVICE_PRIVATE_KEY in ../.env");
  rmSync(QUEUE, { force: true });
  rmSync(LEDGER, { force: true });

  console.log("=== Bazaar · economy (slice 2) — competing sellers + memory-driven buyer ===");
  console.log(`agent brain: ${llmLabel()}   rounds: ${ROUNDS}`);
  console.log(`sellers: ${SELLERS.map((s) => `${s.name}@${s.price}${s.degrade ? "(degrader)" : ""}`).join(", ")}\n`);

  const children: ChildProcess[] = [];
  try {
    for (const s of SELLERS) children.push(await startSeller(s));
    const sellers: SellerRef[] = SELLERS.map((s) => ({ name: s.name, url: `http://127.0.0.1:${s.port}` }));

    const buyer: Persona = {
      name: "Frugal",
      pk: BUYER_PK,
      budgetUsdc: 0.05,
      task: "Summarize what Arc is in 3 bullet points.",
      style: "frugal but quality-aware; you hate paying for junk",
      qualityBar: 60,
    };

    const buyerAddr = account(BUYER_PK).address;
    const before = await escrowBalance(publicClient, ESCROW, buyerAddr);
    console.log(`buyer escrow before: ${formatEther(before)} USDC\n`);

    const mem: Memory = {};
    const spend = { paid: 0 };
    for (let i = 1; i <= ROUNDS; i++) {
      const r = await buyerRound(buyer, sellers, mem, ESCROW, CHAIN_ID, spend);
      const tag = r.bought ? `BUY ${r.chosen} @${r.priceUsdc} -> score ${r.score}` : `SKIP/none (${r.chosen ?? "-"})`;
      console.log(`round ${i} [${r.via}] ${tag}`);
      console.log(`   why: ${r.reason}${r.gradeReason ? ` | grade: ${r.gradeReason}` : ""}`);
      appendFileSync(LEDGER, JSON.stringify({ round: i, ...r }) + "\n");
    }

    console.log("\n=== emergent routing (buyer's learned memory per seller) ===");
    for (const s of SELLERS) {
      const m = mem[s.name];
      const note = s.degrade ? "  <- degrader" : "";
      console.log(`  ${s.name}: buys=${m?.buys ?? 0} avgScore=${m?.avgScore ?? "-"}${note}`);
    }

    console.log("\n=== on-chain settlement (REAL, batched) ===");
    const settlerOut = await runSettler();
    const m = settlerOut.match(/BATCH_SETTLED (0x[0-9a-fA-F]{64})/);
    if (m) {
      console.log(`settled ${spend.paid.toFixed(4)} USDC of calls in one tx: ${m[1]}`);
      const u = settlerOut.match(/https?:\/\/\S+/);
      if (u) console.log(`explorer: ${u[0]}`);
    } else {
      console.log(settlerOut.trim() || "(no claims settled)");
    }
    const after = await escrowBalance(publicClient, ESCROW, buyerAddr);
    console.log(`buyer escrow after: ${formatEther(after)} USDC (delta ${formatEther(before - after)})`);

    console.log("\n=== distinct seller wallets (on-chain native USDC) ===");
    for (const s of SELLERS) {
      const addr = process.env[`BAZAAR_SELLER_${s.key}_ADDR`] as `0x${string}`;
      const bal = await publicClient.getBalance({ address: addr });
      console.log(`  ${s.name} ${addr}: ${formatEther(bal)} USDC`);
    }
  } finally {
    for (const c of children) c.kill();
    rmSync(QUEUE, { force: true });
  }
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
