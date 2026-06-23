// Bazaar — a BEGINNER's agent joins the market with its own wallet.
// Stand-in for a real newcomer who wants to try Bazaar but doesn't have an agent yet: a separate,
// independently-keyed agent, powered by Claude (via the configured relay), role-playing a cautious
// beginner who reasons about which cheap AI service to try and then PAYS on-chain over the public
// Arc402 rail. Honest scope: this is a simulated newcomer (not the real person), but the SAME script
// runs with anyone's own key — it is the literal onboarding path. Run: NODE_USE_ENV_PROXY=1 npm run beginner
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { account, BUYER_PK, CHAIN_ID, ESCROW, publicClient, txUrl, walletFor } from "../config.js";
import { ESCROW_ABI, escrowBalance, settleBatch, signClaim } from "../rail/escrow.js";
import { askLLM, extractJson, llmLabel } from "../agents/llm.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(here, "../../../.env");

function appendEnv(key: string, value: string): void {
  if (!existsSync(ROOT_ENV) || !readFileSync(ROOT_ENV, "utf8").includes(`${key}=`)) appendFileSync(ROOT_ENV, `\n${key}=${value}`);
  process.env[key] = value;
}

interface SellerOpt { tag: string; name: string; priceUsdc: string; addr: Address; pk: string; note: string }

async function main(): Promise<void> {
  if (!BUYER_PK) throw new Error("set PRIVATE_KEY (MAIN funder) in ../.env");
  const sellers: SellerOpt[] = [
    { tag: "A", name: "summarizer-A", priceUsdc: "0.002", addr: process.env.BAZAAR_SELLER_A_ADDR as Address, pk: process.env.BAZAAR_SELLER_A_PK as string, note: "a bit pricier, good reviews" },
    { tag: "C", name: "cheapbot-C", priceUsdc: "0.001", addr: process.env.BAZAAR_SELLER_C_ADDR as Address, pk: process.env.BAZAAR_SELLER_C_PK as string, note: "cheapest, but known to cut corners" },
  ].filter((s) => s.addr && s.pk);
  if (sellers.length < 2) throw new Error("need BAZAAR_SELLER_A and _C in ../.env");

  // 1. the beginner's own fresh wallet (persisted; the real person can swap in their own key)
  let pk = process.env.BEGINNER_PK;
  if (!pk) {
    pk = generatePrivateKey();
    appendEnv("BEGINNER_PK", pk);
    appendEnv("BEGINNER_ADDR", privateKeyToAccount(pk as Hex).address);
  }
  const me = walletFor(pk);
  const myAddr = account(pk).address;

  console.log("=== Bazaar · a beginner tries the market (own wallet, Claude brain) ===");
  console.log(`brain : ${llmLabel()}`);
  console.log(`wallet: ${myAddr}  (a newcomer's own key — not the team buyer)\n`);

  // 2. the beginner reasons (in a nervous-newcomer voice) about which cheap service to try
  const task = "I just want a 2-sentence plain-English explainer of what a 'rollup' is.";
  const menu = sellers.map((s) => `  [${s.tag}] ${s.name} — ${s.priceUsdc} USDC/answer (${s.note})`).join("\n");
  const sys =
    "You are a COMPLETE BEGINNER to crypto and AI agents — curious but nervous about wasting even a fraction of a " +
    "cent, not technical. You have ~0.005 testnet USDC. Pick ONE service to try and explain your thinking in a " +
    "genuine first-timer voice. Reply ONLY JSON: {\"choose\":\"A\"|\"C\",\"reason\":\"<1-2 sentences, beginner voice>\"}.";
  const decision = extractJson<{ choose: string; reason: string }>(
    await askLLM(sys, `Task I need done:\n${task}\n\nServices on offer:\n${menu}`, { json: true }),
  ) ?? { choose: "A", reason: "(fallback) I'll try the one with good reviews to be safe." };
  const chosen = sellers.find((s) => s.tag === decision.choose) ?? sellers[0];
  console.log(`the beginner thinks: "${decision.reason}"`);
  console.log(`→ decides to try ${chosen.name} (${chosen.priceUsdc} USDC)\n`);

  // 3. fund the newcomer's wallet (gas) + it deposits its OWN escrow
  const price = parseEther(chosen.priceUsdc);
  if ((await publicClient.getBalance({ address: myAddr })) < price + parseEther("0.02")) {
    const main = walletFor(BUYER_PK);
    const h = await main.sendTransaction({ account: main.account!, chain: main.chain, to: myAddr, value: price + parseEther("0.02") });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log("(funded the newcomer's gas — like topping up a fresh wallet)");
  }
  if ((await escrowBalance(publicClient, ESCROW, myAddr)) < price) {
    const h = await me.writeContract({ account: me.account!, chain: me.chain, address: ESCROW, abi: ESCROW_ABI, functionName: "deposit", value: price + parseEther("0.003") });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log(`the beginner deposited its own USDC into the rail (tx ${txUrl(h)})`);
  }

  // 4. sign a claim + the seller settles on-chain (real payment by a brand-new participant)
  const claim = await signClaim(me, { escrow: ESCROW, chainId: CHAIN_ID, service: chosen.addr, amount: price });
  const escBefore = await escrowBalance(publicClient, ESCROW, myAddr);
  const settleTx = await settleBatch(walletFor(chosen.pk), publicClient, ESCROW, [claim]);
  const escAfter = await escrowBalance(publicClient, ESCROW, myAddr);

  console.log("\n===================== result =====================");
  console.log(`a first-time agent paid ${chosen.priceUsdc} USDC to ${chosen.name} — on-chain: ${txUrl(settleTx)}`);
  console.log(`the beginner's escrow: ${formatEther(escBefore)} → ${formatEther(escAfter)} USDC`);
  console.log(`\nA brand-new, independently-keyed participant transacted on Bazaar. (Simulated newcomer powered by`);
  console.log(`Claude; the same script runs with a real person's own key — this is the onboarding path.)`);

  writeFileSync(resolve(here, "../../beginner-agent.json"), JSON.stringify({
    beginnerWallet: myAddr, brain: llmLabel(), chose: chosen.name, reason: decision.reason,
    amountUsdc: chosen.priceUsdc, settleTx, escrowBefore: formatEther(escBefore), escrowAfter: formatEther(escAfter),
  }, null, 2));
  console.log("artifact saved -> beginner-agent.json");
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
