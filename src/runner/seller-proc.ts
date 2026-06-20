// Seller process entrypoint: runs one paid HTTP-402 service and enqueues accepted claims.
// Does NOT write on-chain (a separate settler batches). Env-configurable so the orchestrator
// (or a friend's terminal) can spin up differently-priced / degrading sellers.
import { resolve } from "node:path";
import { parseEther } from "viem";
import { createSeller } from "../market/seller.js";
import { SELLER_PK, ESCROW } from "../config.js";

const PORT = Number(process.env.BAZAAR_SELLER_PORT ?? 7411);
const queueFile = process.env.BAZAAR_QUEUE ?? resolve(process.cwd(), "pending-claims.jsonl");

// Each seller runs under its OWN wallet (distinct on-chain identity) when given one.
const pk = process.env.BAZAAR_SELLER_PK ?? SELLER_PK;
if (!pk) throw new Error("set BAZAAR_SELLER_PK or SERVICE_PRIVATE_KEY in ../.env");

const { app, service } = createSeller({
  name: process.env.BAZAAR_SELLER_NAME ?? "summarizer-A",
  pk,
  priceWei: parseEther(process.env.BAZAAR_PRICE ?? "0.005"),
  escrow: ESCROW,
  degrade: process.env.BAZAAR_DEGRADE === "1",
  queueFile,
});

app.listen(PORT, () => {
  console.log(`SELLER_READY ${service} :${PORT} queue=${queueFile}`);
});
