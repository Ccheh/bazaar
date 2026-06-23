// Bazaar — external-agent traction proof.
// A SEPARATE, independently-keyed agent (NOT the main buyer wallet) funds its OWN escrow and pays a
// Bazaar seller over the public Arc402 rail — proving the bring-your-own-agent path end-to-end on-chain.
// Honest scope: this is a distinct, self-funded wallet exercising the external path (not a literal third
// party); it puts a non-team-main address into the settlement loop. Run: NODE_USE_ENV_PROXY=1 npm run byoa:ext
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { account, BUYER_PK, CHAIN_ID, ESCROW, publicClient, txUrl, walletFor } from "../config.js";
import { ESCROW_ABI, escrowBalance, settleBatch, signClaim } from "../rail/escrow.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(here, "../../../.env");
const PRICE = parseEther(process.env.BYOA_EXT_AMOUNT ?? "0.002"); // sub-cent USDC per call

function appendEnv(key: string, value: string): void {
  if (!existsSync(ROOT_ENV) || !readFileSync(ROOT_ENV, "utf8").includes(`${key}=`)) appendFileSync(ROOT_ENV, `\n${key}=${value}`);
  process.env[key] = value;
}

async function main(): Promise<void> {
  if (!BUYER_PK) throw new Error("set PRIVATE_KEY (MAIN, funder) in ../.env");
  const sellerAddr = process.env.BAZAAR_SELLER_B_ADDR as Address;
  const sellerPk = process.env.BAZAAR_SELLER_B_PK as string;
  if (!sellerAddr || !sellerPk) throw new Error("need BAZAAR_SELLER_B_{ADDR,PK}");

  // 1. an independent external agent key (generated once, persisted)
  let extPk = process.env.BYOA_EXT_PK;
  if (!extPk) {
    extPk = generatePrivateKey();
    appendEnv("BYOA_EXT_PK", extPk);
    appendEnv("BYOA_EXT_ADDR", privateKeyToAccount(extPk as Hex).address);
  }
  const ext = walletFor(extPk);
  const extAddr = account(extPk).address;

  console.log("=== Bazaar · external-agent payment (independent key, public rail) ===");
  console.log(`external agent: ${extAddr}  (NOT the main buyer)`);
  console.log(`seller        : Bazaar seller B ${sellerAddr}\n`);

  // 2. MAIN funds the external agent's gas (a top-up, like onboarding any new agent)
  const need = PRICE + parseEther("0.02");
  if ((await publicClient.getBalance({ address: extAddr })) < need) {
    const main = walletFor(BUYER_PK);
    const h = await main.sendTransaction({ account: main.account!, chain: main.chain, to: extAddr, value: need });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log(`funded external agent gas: ${formatEther(need)} USDC`);
  }

  // 3. the external agent deposits its OWN USDC into the escrow rail
  const extEscBefore = await escrowBalance(publicClient, ESCROW, extAddr);
  if (extEscBefore < PRICE) {
    const dep = PRICE + parseEther("0.004");
    const h = await ext.writeContract({ account: ext.account!, chain: ext.chain, address: ESCROW, abi: ESCROW_ABI, functionName: "deposit", value: dep });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log(`external agent deposited ${formatEther(dep)} USDC into the rail (tx ${txUrl(h)})`);
  }

  // 4. external agent signs an off-chain claim authorizing the seller to pull payment
  const claim = await signClaim(ext, { escrow: ESCROW, chainId: CHAIN_ID, service: sellerAddr, amount: PRICE });
  console.log(`external agent SIGNED a ${formatEther(PRICE)} USDC claim for the seller (off-chain).`);

  // 5. the seller settles it on-chain (pulls from the external agent's escrow) — the public-rail proof
  const sellerBalBefore = await publicClient.getBalance({ address: sellerAddr });
  const extEscPre = await escrowBalance(publicClient, ESCROW, extAddr);
  const settleTx = await settleBatch(walletFor(sellerPk), publicClient, ESCROW, [claim]);
  const extEscPost = await escrowBalance(publicClient, ESCROW, extAddr);
  const sellerBalAfter = await publicClient.getBalance({ address: sellerAddr });

  console.log("\n===================== result =====================");
  console.log(`settled on-chain: ${txUrl(settleTx)}`);
  console.log(`external agent escrow: ${formatEther(extEscPre)} → ${formatEther(extEscPost)} USDC`);
  console.log(`seller balance:        ${formatEther(sellerBalBefore)} → ${formatEther(sellerBalAfter)} USDC`);
  console.log(`\nA non-team-main, independently-keyed agent paid a seller over the public rail — real on-chain.`);

  writeFileSync(resolve(here, "../../byoa-external.json"), JSON.stringify({ // in-repo (bazaar/) evidence
    externalAgent: extAddr, seller: sellerAddr, amountUsdc: formatEther(PRICE), settleTx,
    extEscrowBefore: formatEther(extEscPre), extEscrowAfter: formatEther(extEscPost),
  }, null, 2));
  console.log("artifact saved -> byoa-external.json");
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
