// Bazaar — DEMO (plain English, end-to-end, real on-chain).
// Your AI tries competing AI services, shows you the ACTUAL answers, pays a fraction of a cent
// for the good ones, and SLASHES the bad one's bond (money back to you). No jargon.
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { formatEther, type Address, type WalletClient } from "viem";
import { account, publicClient, walletFor, ESCROW, CHAIN_ID, BUYER_PK, txUrl } from "../config.js";
import { signClaim, encodeClaim, escrowBalance } from "../rail/escrow.js";
import { askLLM, extractJson, llmLabel } from "../agents/llm.js";
import { QUEUE, SELLER_FLEET, startSeller, ensureBonded, spawnRunner } from "../market/fleet.js";
import { slashSeller } from "../market/dispute.js";

const TASK = process.env.BAZAAR_TASK ?? "Explain the main trade-offs between optimistic and ZK rollups in 3 concise bullet points.";
const BAR = 30; // grade below this = under-delivery → slash

function runSettler(): Promise<string> {
  return new Promise((res) => {
    let out = "";
    const c = spawnRunner("src/runner/settler.ts", { BAZAAR_QUEUE: QUEUE });
    c.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    c.on("exit", () => res(out));
    c.on("error", () => res(out));
  });
}

async function buyOnce(url: string, buyer: WalletClient): Promise<{ answer: string; priceUsdc: number }> {
  const quote = (await (await fetch(`${url}/price`)).json()) as { service: Address; amountWei: string };
  const claim = await signClaim(buyer, { escrow: ESCROW, chainId: CHAIN_ID, service: quote.service, amount: BigInt(quote.amountWei) });
  const work = (await (await fetch(`${url}/work`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bazaar-claim": encodeClaim(claim) },
    body: JSON.stringify({ input: TASK }),
  })).json()) as { result?: { output?: string; summary?: string } };
  const r = work.result ?? {};
  return { answer: String(r.output ?? r.summary ?? JSON.stringify(r)), priceUsdc: Number(formatEther(BigInt(quote.amountWei))) };
}

async function grade(answer: string): Promise<{ score: number; reason: string }> {
  const sys = `Grade this answer 0-100 for the task "${TASK}". Reply ONLY JSON: {"score":number,"reason":"<one short sentence>"}.`;
  return (
    extractJson<{ score: number; reason: string }>(await askLLM(sys, `Answer: ${answer.slice(0, 1500)}`, { json: true })) ??
    { score: answer.replace(/\s/g, "").length > 60 ? 80 : 10, reason: "(heuristic fallback — set an LLM key)" }
  );
}

async function main(): Promise<void> {
  if (!BUYER_PK) throw new Error("set PRIVATE_KEY in ../.env");
  rmSync(QUEUE, { force: true });
  const buyer = walletFor(BUYER_PK);
  const buyerAddr = account(BUYER_PK).address;

  console.log("==================================================================");
  console.log(" Bazaar — your AI pays other AIs per answer. Bad work? Money back.");
  console.log("==================================================================\n");
  console.log(`Your assistant needs:\n   "${TASK}"\n`);
  console.log(`It will try competing AI services, pay a fraction of a cent each, read the\nanswers, and refuse to pay for junk.  (AI brain: ${llmLabel()})\n`);

  const children: ChildProcess[] = [];
  for (const s of SELLER_FLEET) children.push(await startSeller(s));
  for (const s of SELLER_FLEET) await ensureBonded(s.key);

  const escBefore = await escrowBalance(publicClient, ESCROW, buyerAddr);
  console.log(`Your prepaid balance: ${formatEther(escBefore)} USDC  (real testnet money — no real value)\n`);

  let goodCount = 0, goodPaid = 0, slashedBack = 0, toWallet = 0;
  const proofs: string[] = [];
  try {
    for (const s of SELLER_FLEET) {
      console.log(`— trying "${s.name}"  (${s.price} USDC/answer) —`);
      const { answer, priceUsdc } = await buyOnce(`http://127.0.0.1:${s.port}`, buyer);
      console.log(`   it answered: ${answer.replace(/\s+/g, " ").slice(0, 200)}${answer.length > 200 ? "…" : ""}`);
      const g = await grade(answer);
      console.log(`   your AI's verdict: ${g.score}/100 — ${g.reason}`);
      if (g.score < BAR) {
        const out = await slashSeller(s.key, g.score * 100);
        slashedBack += Number(formatEther(out.bondSlashed));
        toWallet += Number(formatEther(out.paidToAgent));
        proofs.push(out.txHash);
        console.log(`   👎 bad answer → "${s.name}"'s bond was SLASHED ${formatEther(out.bondSlashed)} USDC;`);
        console.log(`      ${formatEther(out.paidToAgent)} USDC total returned to your wallet (its slashed bond + your dispute deposit back).`);
        console.log(`      proof: ${txUrl(out.txHash)}`);
      } else {
        goodCount++; goodPaid += priceUsdc;
        console.log(`   👍 good answer → worth paying ${priceUsdc} USDC.`);
      }
      console.log("");
    }

    console.log("settling the calls on-chain…\n");
    const settlerOut = await runSettler();
    for (const m of settlerOut.matchAll(/(0x[0-9a-fA-F]{64})/g)) proofs.push(m[1]);
    const escAfter = await escrowBalance(publicClient, ESCROW, buyerAddr);

    console.log("===================== the money story =====================");
    console.log(`Good answers kept:        ${goodCount}  (paid ${goodPaid.toFixed(4)} USDC for them)`);
    console.log(`Prepaid balance:          ${formatEther(escBefore)} → ${formatEther(escAfter)} USDC  (it went DOWN by what you paid)`);
    console.log(`Refunded to your wallet:  ${toWallet.toFixed(4)} USDC  (the bad seller's slashed bond + your dispute deposit)`);
    console.log(`Net: the bad seller LOST its bond; you kept the good answers AND got money back.`);
    console.log(`\nReal & on-chain — proof:`);
    for (const p of [...new Set(proofs)]) console.log(`   ${txUrl(p)}`);
    console.log(`\n⚠ honest note: today this is OPERATOR-COORDINATED — one runner holds the keys and a`);
    console.log(`  mock resolver records the grade, so it can't yet stop a dishonest operator. A trustless`);
    console.log(`  independent grader + at-risk seller bond is the roadmap (see README "Trust model").`);
  } finally {
    for (const c of children) c.kill();
    rmSync(QUEUE, { force: true });
  }
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
