// Drain a remote (keyless) public market's accepted-claims queue and settle them on-chain
// HERE, with the seller keys (which never leave this trusted machine). Then clear the remote queue.
import { publicClient, walletFor, keyForService, ESCROW, txUrl } from "../config.js";
import { decodeClaim, settleBatch, type Claim } from "../rail/escrow.js";

const MARKET = (process.env.BAZAAR_MARKET_URL ?? "http://127.0.0.1:5051").replace(/\/$/, "");

async function main(): Promise<void> {
  const text = await (await fetch(`${MARKET}/pending`)).text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    console.log(`no pending claims at ${MARKET}`);
    return;
  }
  const groups = new Map<string, Claim[]>();
  for (const c of lines.map(decodeClaim)) {
    const key = c.service.toLowerCase();
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  let settled = 0;
  for (const [service, claims] of groups) {
    const pk = keyForService(service);
    if (!pk) {
      console.log(`no key for service ${service} — skipping ${claims.length} claim(s)`);
      continue;
    }
    const tx = await settleBatch(walletFor(pk), publicClient, ESCROW, claims);
    settled += claims.length;
    console.log(`BATCH_SETTLED service=${service} claims=${claims.length} ${tx}`);
    console.log(txUrl(tx));
  }
  if (settled > 0) {
    await fetch(`${MARKET}/clear`, { method: "POST" });
    console.log(`cleared ${settled} settled claim(s) from ${MARKET}`);
  }
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
