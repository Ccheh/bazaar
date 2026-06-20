// Bazaar — Slice 1: one autonomous, LLM-decided, REAL on-chain paid call.
// Architecture-faithful: a seller SERVER process accepts the claim optimistically, the
// buyer decides/pays/grades, and a separate SETTLER process batches the claim on-chain.
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { parseEther, formatEther } from "viem";
import { account, publicClient, ESCROW, CHAIN_ID, BUYER_PK, SELLER_PK } from "../config.js";
import { escrowBalance } from "../rail/escrow.js";
import { buyerCycle } from "../agents/buyer.js";
import { llmLabel } from "../agents/llm.js";

const PORT = 7411;
const QUEUE = resolve(process.cwd(), "pending-claims.jsonl");

// Spawn child runners as `node --import tsx <script>` (no shell → no arg-escaping risk).
function spawnRunner(script: string, extraEnv: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function startSeller(): Promise<ChildProcess> {
  rmSync(QUEUE, { force: true });
  const child = spawnRunner("src/runner/seller-proc.ts", {
    BAZAAR_SELLER_PORT: String(PORT),
    BAZAAR_QUEUE: QUEUE,
  });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("seller did not become ready in 30s")), 30_000);
    child.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("SELLER_READY")) {
        clearTimeout(timer);
        res(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`seller process exited early (${code})`));
    });
  });
}

function runSettler(): Promise<string> {
  return new Promise((res, rej) => {
    let out = "";
    const child = spawnRunner("src/runner/settler.ts", { BAZAAR_QUEUE: QUEUE });
    child.stdout!.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.on("exit", () => res(out));
    child.on("error", rej);
  });
}

async function main(): Promise<void> {
  if (!BUYER_PK || !SELLER_PK) {
    throw new Error("set PRIVATE_KEY (buyer) and SERVICE_PRIVATE_KEY (seller) in ../.env");
  }
  const buyerAddr = account(BUYER_PK).address;

  console.log("=== Bazaar · slice 1 — one autonomous paid call on Arc ===");
  console.log(`agent brain: ${llmLabel()}`);
  console.log(`buyer:  ${buyerAddr}`);

  const seller = await startSeller();
  try {
    const url = `http://127.0.0.1:${PORT}`;
    const before = await escrowBalance(publicClient, ESCROW, buyerAddr);
    console.log(`buyer escrow balance before: ${formatEther(before)} USDC\n`);

    const trace = await buyerCycle(
      {
        name: "Frugal",
        pk: BUYER_PK,
        budgetUsdc: 0.5,
        task: "Summarize what Arc is in 3 bullet points.",
        style: "frugal, cost-sensitive",
        qualityBar: 60,
      },
      url,
      ESCROW,
      CHAIN_ID,
    );

    console.log("--- decision ---");
    console.log(`[${trace.decision.via}] buy=${trace.decision.buy} maxPrice=${trace.decision.maxPriceUsdc} USDC`);
    console.log(`reason: ${trace.decision.reason}`);

    if (!trace.bought) {
      console.log("\nbuyer walked away — no payment made.");
      return;
    }

    console.log(`\n--- delivery + grade ---`);
    console.log(`paid ${trace.priceUsdc} USDC -> ${trace.seller} (claim accepted, queued for batch settlement)`);
    console.log(`[${trace.grade?.via}] score=${trace.grade?.score} (bar 60) — ${trace.grade?.reason}`);

    console.log(`\n--- on-chain settlement (REAL, Arc Testnet) ---`);
    const settlerOut = await runSettler();
    const m = settlerOut.match(/BATCH_SETTLED (0x[0-9a-fA-F]{64})/);
    if (m) {
      console.log(`settled tx: ${m[1]}`);
      const url2 = settlerOut.match(/https?:\/\/\S+/);
      if (url2) console.log(`explorer:   ${url2[0]}`);
    } else {
      console.log(settlerOut.trim() || "(settler produced no tx)");
    }

    const after = await escrowBalance(publicClient, ESCROW, buyerAddr);
    console.log(`\nbuyer escrow balance after: ${formatEther(after)} USDC  (delta ${formatEther(before - after)} USDC)`);
  } finally {
    seller.kill();
    rmSync(QUEUE, { force: true });
  }
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
