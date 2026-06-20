// Settler process (NO server): reads the claim queue and settles them on-chain in ONE
// claimBatch tx, as the service. This is the batched-settlement path of the nanopayment rail.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { publicClient, walletFor, keyForService, ESCROW, txUrl } from "../config.js";
import { decodeClaim, settleBatch, type Claim } from "../rail/escrow.js";

const queueFile = process.env.BAZAAR_QUEUE ?? resolve(process.cwd(), "pending-claims.jsonl");

async function main(): Promise<void> {
  if (!existsSync(queueFile)) {
    console.log("no pending claims");
    return;
  }
  const lines = readFileSync(queueFile, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    console.log("no pending claims");
    return;
  }
  // Group claims by the service they name; each service settles its OWN claims (it is msg.sender).
  const groups = new Map<string, Claim[]>();
  for (const c of lines.map(decodeClaim)) {
    const key = c.service.toLowerCase();
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  for (const [service, claims] of groups) {
    const pk = keyForService(service);
    if (!pk) {
      console.log(`no key for service ${service} — skipping ${claims.length} claim(s)`);
      continue;
    }
    const tx = await settleBatch(walletFor(pk), publicClient, ESCROW, claims);
    console.log(`BATCH_SETTLED service=${service} claims=${claims.length} ${tx}`);
    console.log(txUrl(tx));
  }
  writeFileSync(queueFile, ""); // clear settled claims
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
