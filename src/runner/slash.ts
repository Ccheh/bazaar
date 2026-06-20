// Bazaar — real on-chain bond SLASH (the "bonded quality" exception path).
// A degrader seller posts a USDC bond; the buyer judges the delivery under-par and disputes;
// the resolver scores it low; the seller's bond is SLASHED on-chain and the buyer is refunded.
import { keccak256, toBytes, parseEther, formatEther } from "viem";
import { account, publicClient, walletFor, BUYER_PK, txUrl, CHAIN_ID } from "../config.js";
import { randomNonce } from "../rail/escrow.js";
import {
  CRUCIBLE_MARKET, MOCK_RESOLVER,
  depositBond, allowResolver, bondAvailable, signOpenAuth, openMarket, dispute, resolveDisputed,
  type OpenAuth,
} from "../rail/crucible.js";

const SELLER_C_PK = process.env.BAZAAR_SELLER_C_PK;

async function main(): Promise<void> {
  if (!BUYER_PK || !SELLER_C_PK) throw new Error("need PRIVATE_KEY (buyer) + BAZAAR_SELLER_C_PK (degrader) in ../.env");
  const service = walletFor(SELLER_C_PK);   // the degrader seller
  const agent = walletFor(BUYER_PK);        // the buyer (MAIN)
  const serviceAddr = account(SELLER_C_PK).address;
  const agentAddr = account(BUYER_PK).address;

  console.log("=== Bazaar · real on-chain bond SLASH (degrader under-delivers) ===");
  console.log(`market   ${CRUCIBLE_MARKET}`);
  console.log(`resolver ${MOCK_RESOLVER}`);
  console.log(`service(degrader) ${serviceAddr}`);
  console.log(`agent(buyer)      ${agentAddr}\n`);

  const escrow = parseEther("0.002");
  const bondLock = parseEther("0.005");

  console.log("1) degrader posts a USDC bond + whitelists the resolver...");
  await depositBond(service, publicClient, parseEther("0.006"));
  await allowResolver(service, publicClient, MOCK_RESOLVER);
  const bondBefore = await bondAvailable(publicClient, serviceAddr);
  console.log(`   bond available: ${formatEther(bondBefore)} USDC`);

  console.log("2) degrader signs OpenAuth; buyer opens the market (escrows 0.002 USDC)...");
  const now = Math.floor(Date.now() / 1000);
  const auth: OpenAuth = {
    service: serviceAddr,
    agent: agentAddr,
    resolver: MOCK_RESOLVER,
    amount: escrow,
    bondLockAmount: bondLock,
    commitmentHash: keccak256(toBytes("bazaar:degraded-delivery")),
    disputeWindow: 600n,
    nonce: randomNonce(),
    authExpiry: BigInt(now + 3600),
  };
  const sig = await signOpenAuth(service, auth);
  const marketId = await openMarket(agent, publicClient, auth, sig);
  console.log(`   marketId ${marketId}`);

  console.log("3) buyer judges it under-par and DISPUTES...");
  await dispute(agent, publicClient, marketId);

  console.log("4) resolver scores it 2000bps (20%) -> bond SLASHED, buyer refunded...");
  const out = await resolveDisputed(agent, publicClient, marketId, 2000);
  console.log(`   score=${out.scoreBps}bps`);
  console.log(`   paidToService = ${formatEther(out.paidToService)} USDC`);
  console.log(`   paidToAgent   = ${formatEther(out.paidToAgent)} USDC  (escrow refund + slashed bond)`);
  console.log(`   bondSlashed   = ${formatEther(out.bondSlashed)} USDC`);
  console.log(`   slash tx: ${txUrl(out.txHash)}`);

  const bondAfter = await bondAvailable(publicClient, serviceAddr);
  console.log(`\nbond available after: ${formatEther(bondAfter)} USDC  (degrader lost ${formatEther(bondBefore - bondAfter)} USDC to the buyer)`);
  console.log(`chain ${CHAIN_ID} — real on-chain bonded-quality enforcement.`);
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
