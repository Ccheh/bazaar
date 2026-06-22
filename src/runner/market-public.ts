// Bazaar — KEYLESS public market (for hosting on a server / behind a tunnel).
// Serves several sellers under one port with path prefixes (/a, /b, /c). Holds NO private
// keys: it only knows each seller's ADDRESS, verifies the buyer's EIP-712 claim signature,
// delivers the work, and ENQUEUES the claim. A trusted operator drains /pending and settles
// on-chain elsewhere (remote-settler) with the keys — so a compromised host can't move funds.
import express, { type Request, type Response } from "express";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEther, formatEther, type Address } from "viem";
import { CHAIN_ID, ESCROW } from "../config.js";
import { decodeClaim, encodeClaim, recoverClaimSigner, type Claim } from "../rail/escrow.js";
import { doWork } from "../market/work.js";

const PORT = Number(process.env.PORT ?? process.env.BAZAAR_PORT ?? 5051);
const QUEUE = process.env.BAZAAR_QUEUE ?? resolve(process.cwd(), "pending-claims.jsonl");

interface PublicSeller { path: string; name: string; address: Address; priceWei: bigint; degrade: boolean }

const SELLERS: PublicSeller[] = [
  { path: "a", name: "summarizer-A", address: process.env.BAZAAR_SELLER_A_ADDR as Address, priceWei: parseEther(process.env.BAZAAR_PRICE_A ?? "0.002"), degrade: false },
  { path: "b", name: "analyst-B", address: process.env.BAZAAR_SELLER_B_ADDR as Address, priceWei: parseEther(process.env.BAZAAR_PRICE_B ?? "0.003"), degrade: false },
  { path: "c", name: "cheapbot-C", address: process.env.BAZAAR_SELLER_C_ADDR as Address, priceWei: parseEther(process.env.BAZAAR_PRICE_C ?? "0.001"), degrade: true },
];

const app = express();
app.use(express.json());

app.get("/", (_req: Request, res: Response) => {
  res.json({
    market: "Bazaar public market",
    chainId: CHAIN_ID,
    escrow: ESCROW,
    sellers: SELLERS.filter((s) => s.address).map((s) => ({ name: s.name, path: `/${s.path}`, priceUsdc: formatEther(s.priceWei), service: s.address })),
  });
});

for (const s of SELLERS) {
  if (!s.address) {
    console.warn(`seller ${s.name}: missing BAZAAR_SELLER_${s.path.toUpperCase()}_ADDR — skipping`);
    continue;
  }
  app.get(`/${s.path}/price`, (_req: Request, res: Response) => {
    res.json({ name: s.name, service: s.address, amountWei: s.priceWei.toString(), escrow: ESCROW });
  });
  app.post(`/${s.path}/work`, async (req: Request, res: Response) => {
    const header = req.header("x-bazaar-claim");
    if (!header) return res.status(402).json({ error: "payment required", name: s.name, service: s.address, amountWei: s.priceWei.toString(), escrow: ESCROW });
    let claim: Claim;
    try { claim = decodeClaim(header); } catch { return res.status(400).json({ error: "malformed claim" }); }
    if (claim.service.toLowerCase() !== s.address.toLowerCase()) return res.status(400).json({ error: "claim is for a different service" });
    if (claim.amount < s.priceWei) return res.status(402).json({ error: "claim amount below price", amountWei: s.priceWei.toString() });
    try {
      const signer = await recoverClaimSigner(claim, ESCROW, CHAIN_ID);
      if (signer.toLowerCase() !== claim.agent.toLowerCase()) return res.status(400).json({ error: "claim signature does not match agent" });
    } catch { return res.status(400).json({ error: "claim signature unrecoverable" }); }
    const input = String(req.body?.input ?? "");
    const result = await doWork(s.name, input, s.degrade); // REAL LLM work
    appendFileSync(QUEUE, encodeClaim(claim) + "\n"); // no on-chain write here — settled elsewhere
    res.json({ result, queued: true, service: s.address, amountWei: claim.amount.toString() });
  });
}

// Operator-facing: drain accepted claims for off-host settlement, then clear.
app.get("/pending", (_req: Request, res: Response) => {
  res.type("text/plain").send(existsSync(QUEUE) ? readFileSync(QUEUE, "utf8") : "");
});
app.post("/clear", (_req: Request, res: Response) => {
  writeFileSync(QUEUE, "");
  res.json({ cleared: true });
});

app.listen(PORT, () => {
  console.log(`Bazaar public market on :${PORT}`);
  for (const s of SELLERS) if (s.address) console.log(`  ${s.name.padEnd(14)} /${s.path}  ${formatEther(s.priceWei)} USDC  ${s.address}${s.degrade ? "  (degrader)" : ""}`);
  console.log(`queue: ${QUEUE}  (operator: GET /pending then POST /clear)`);
});
