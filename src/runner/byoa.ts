// Bazaar — Bring-Your-Own-Agent: an EXTERNAL buyer agent joins the live market.
// Run this with YOUR OWN testnet wallet (BYOA_PK) and YOUR OWN LLM key. It discovers the
// sellers, reasons about which to buy under budget, pays sub-cent USDC per call over the
// Cadence rail, and grades results — the same handbook contract external agents follow.
// Settlement of the accepted claims is done by the market operator (`npm run settle`).
import { formatEther } from "viem";
import { account, publicClient, walletFor, ESCROW, CHAIN_ID } from "../config.js";
import { escrowBalance } from "../rail/escrow.js";
import { buyerRound, type Memory, type Persona, type SellerRef } from "../agents/economyBuyer.js";
import { discoverBazaarSellers } from "../market/discovery.js";
import { llmLabel } from "../agents/llm.js";

const PK = process.env.BYOA_PK ?? process.env.PRIVATE_KEY;
const ROUNDS = Number(process.env.BYOA_ROUNDS ?? 4);

async function discoverByUrls(urls: string[]): Promise<SellerRef[]> {
  const found: SellerRef[] = [];
  for (const raw of urls) {
    const url = raw.trim().replace(/\/$/, "");
    if (!url) continue;
    try {
      const q = (await (await fetch(`${url}/price`)).json()) as { name: string };
      found.push({ name: q.name, url });
    } catch {
      /* unreachable seller — skip */
    }
  }
  return found;
}

async function main(): Promise<void> {
  if (!PK) throw new Error("set BYOA_PK to your own testnet wallet private key");
  const addr = account(PK).address;

  console.log("=== Bazaar · Bring-Your-Own-Agent (external buyer) ===");
  console.log(`brain:  ${llmLabel()}`);
  console.log(`wallet: ${addr}`);

  let sellers: SellerRef[];
  if (process.env.BYOA_SELLERS) {
    sellers = await discoverByUrls(process.env.BYOA_SELLERS.split(","));
    console.log(`discovery: explicit BYOA_SELLERS -> ${sellers.length} live`);
  } else {
    console.log("discovery: scanning the ERC-8004 IdentityRegistry on-chain...");
    sellers = await discoverBazaarSellers(publicClient);
    console.log(`discovery: ${sellers.length} live seller(s) found on-chain`);
  }
  if (sellers.length === 0) throw new Error("no live sellers discovered — is the market running + registered?");
  console.log(`market: ${sellers.map((s) => s.name).join(", ")}`);

  const before = await escrowBalance(publicClient, ESCROW, addr);
  console.log(`escrow before: ${formatEther(before)} USDC\n`);
  if (before === 0n) {
    console.log("(your escrow balance is 0 — deposit testnet USDC into the rail before buying)");
  }

  const persona: Persona = {
    name: process.env.BYOA_NAME ?? "GuestAgent",
    pk: PK,
    budgetUsdc: Number(process.env.BYOA_BUDGET ?? 0.03),
    task: process.env.BYOA_TASK ?? "Summarize what Arc is in 3 bullet points.",
    style: process.env.BYOA_STYLE ?? "independent, value-seeking; avoid sellers that under-deliver",
    qualityBar: 60,
  };

  const mem: Memory = {};
  const spend = { paid: 0 };
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await buyerRound(persona, sellers, mem, ESCROW, CHAIN_ID, spend);
    const tag = r.bought ? `BUY ${r.chosen} @${r.priceUsdc} -> score ${r.score}` : `SKIP (${r.chosen ?? "-"})`;
    console.log(`round ${i} [${r.via}] ${tag}`);
    console.log(`   why: ${r.reason}${r.gradeReason ? ` | grade: ${r.gradeReason}` : ""}`);
  }

  const after = await escrowBalance(publicClient, ESCROW, addr);
  console.log(`\nauthorized ${spend.paid.toFixed(4)} USDC across ${ROUNDS} rounds (claims signed + queued).`);
  console.log(`escrow now: ${formatEther(after)} USDC (debits when the operator settles via npm run settle).`);
  console.log(`learned memory: ${JSON.stringify(mem)}`);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
