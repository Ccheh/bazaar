// Bazaar × Circle — an agent pays for AI work from a Circle Developer-Controlled Wallet.
// The buyer agent (a Circle-managed wallet on ARC-TESTNET) hires a Bazaar seller, gets REAL LLM
// work, then pays a sub-cent USDC nanopayment via Circle's developer-controlled transfer API.
// Everything is real + on-chain; Circle signs & broadcasts (we never hold this wallet's key).
// Run:  NODE_USE_ENV_PROXY=1 npm run circle:pay
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, type Address } from "viem";
import { publicClient, txUrl } from "../config.js";
import { askLLM, llmLabel } from "../agents/llm.js";
import { circleEnabled, circleWallets, nativeTokenId, transfer, waitForTx } from "../rail/circle.js";

const SELLER = (process.env.BAZAAR_SELLER_A_ADDR ?? "") as Address;
const PRICE = process.env.CIRCLE_PAY_AMOUNT ?? "0.002"; // sub-cent USDC per call
const TASK = process.env.BAZAAR_TASK ?? "Explain the main trade-offs between optimistic and ZK rollups in 3 concise bullet points.";

async function bal(a: Address): Promise<string> {
  return formatEther(await publicClient.getBalance({ address: a }));
}

async function main(): Promise<void> {
  if (!circleEnabled()) throw new Error("set CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET in ../.env");
  if (!SELLER) throw new Error("set BAZAAR_SELLER_A_ADDR in ../.env");
  const buyer = circleWallets()[0];

  console.log("==================================================================");
  console.log(" Bazaar × Circle — agent pays for AI work from a Circle wallet");
  console.log("==================================================================\n");
  console.log(`buyer  : Circle Developer-Controlled wallet ${buyer.address} (${buyer.blockchain}, ${buyer.accountType})`);
  console.log(`seller : Bazaar seller A ${SELLER}`);
  console.log(`brain  : ${llmLabel()}\n`);

  // 1. real work
  console.log(`task: "${TASK}"\nhiring the seller…`);
  // generous cap: deepseek-v4-pro is a thinking model (reasoning chain precedes the answer), so a
  // small cap can truncate the final text to empty.
  const answer = await askLLM(`You are "seller-A", a careful expert AI service. Complete the task accurately and concisely as 3 short bullet points. No preamble.`, TASK, { maxTokens: 1500 });
  console.log(`\nseller delivered:\n${(answer ?? "(no LLM key — set DEEPSEEK_API_KEY)").trim()}\n`);

  // 2. pay via Circle (sub-cent USDC nanopayment, signed + broadcast by Circle)
  const sellerBefore = await bal(SELLER);
  const tokenId = await nativeTokenId(buyer.id);
  console.log(`paying ${PRICE} USDC  ${buyer.address} → ${SELLER}  via Circle DCW transfer API…`);
  const t = await transfer(buyer.id, SELLER, PRICE, tokenId);
  console.log(`Circle transaction id: ${t.id}  (state: ${t.state})`);

  // 3. wait for Circle to sign + broadcast + confirm on Arc
  const done = await waitForTx(t.id, (s) => console.log(`   …${s.state}${s.txHash ? `  ${s.txHash}` : ""}`));
  const sellerAfter = await bal(SELLER);

  console.log("\n===================== result =====================");
  console.log(`Circle tx id : ${done.id}`);
  console.log(`final state  : ${done.state}`);
  if (done.txHash) console.log(`on-chain tx  : ${txUrl(done.txHash)}`);
  console.log(`seller balance: ${sellerBefore} → ${sellerAfter} USDC`);
  console.log(`\nThe payment was signed & broadcast by Circle's Developer-Controlled Wallet API —`);
  console.log(`Bazaar never held this wallet's key. A real sub-cent USDC nanopayment on Arc, agent-to-agent.`);

  // Persist the artifact (committed proof, like the trustless run's state file).
  const here = dirname(fileURLToPath(import.meta.url));
  const artifact = {
    buyerWallet: buyer.address, buyerWalletId: buyer.id, blockchain: buyer.blockchain,
    seller: SELLER, amountUsdc: PRICE, circleTxId: done.id, state: done.state, txHash: done.txHash,
    sellerBalanceBefore: sellerBefore, sellerBalanceAfter: sellerAfter, task: TASK,
  };
  writeFileSync(resolve(here, "../../circle-pay.json"), JSON.stringify(artifact, null, 2)); // in-repo (bazaar/) evidence
  console.log(`\nartifact saved -> circle-pay.json`);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
