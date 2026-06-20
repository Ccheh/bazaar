// Settler process (NO server): reads the claim queue and settles them on-chain in ONE
// claimBatch tx, as the service. This is the batched-settlement path of the nanopayment rail.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { publicClient, walletFor, ESCROW, SELLER_PK, txUrl } from "../config.js";
import { decodeClaim, settleBatch, type Claim } from "../rail/escrow.js";

const queueFile = process.env.BAZAAR_QUEUE ?? resolve(process.cwd(), "pending-claims.jsonl");

async function main(): Promise<void> {
  if (!SELLER_PK) throw new Error("set SERVICE_PRIVATE_KEY in ../.env");
  if (!existsSync(queueFile)) {
    console.log("no pending claims");
    return;
  }
  const lines = readFileSync(queueFile, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    console.log("no pending claims");
    return;
  }
  const claims: Claim[] = lines.map(decodeClaim);
  console.log(`settling ${claims.length} claim(s) via claimBatch...`);
  const tx = await settleBatch(walletFor(SELLER_PK), publicClient, ESCROW, claims);
  console.log(`BATCH_SETTLED ${tx}`);
  console.log(txUrl(tx));
  writeFileSync(queueFile, ""); // clear settled claims
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
