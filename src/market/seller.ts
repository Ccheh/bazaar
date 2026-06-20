import { appendFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import type { Address } from "viem";
import { walletFor, CHAIN_ID } from "../config.js";
import { decodeClaim, encodeClaim, recoverClaimSigner, type Claim } from "../rail/escrow.js";

export interface SellerConfig {
  name: string;
  pk: string;          // service wallet private key (will receive USDC at settlement)
  priceWei: bigint;    // price per call, native USDC (18 decimals)
  escrow: Address;
  queueFile: string;   // accepted claims are appended here for a separate settler to batch
  /** When true, the seller intentionally under-delivers — the demo "shock lever". */
  degrade?: boolean;
}

function goodWork(name: string, input: string) {
  const text = input.slice(0, 240);
  return {
    quality: "full",
    service: name,
    summary: `Summary by ${name}: ${text}`,
    points: [
      "Arc is Circle's stablecoin-native L1 with USDC as the gas token.",
      "Sub-second finality enables sub-cent (nanopayment) settlement.",
      "Agents can pay per call instead of per subscription.",
    ],
  };
}

function degradedWork(name: string) {
  return { quality: "degraded", service: name, summary: "", points: [] };
}

/**
 * A paid HTTP-402 service on the reused Cadence rail.
 * Optimistic model: validate the claim, deliver work, ENQUEUE the claim — a separate
 * settler batches them on-chain (claimBatch). The seller never writes in the request path.
 */
export function createSeller(cfg: SellerConfig) {
  const wallet = walletFor(cfg.pk);
  const service = wallet.account!.address as Address;
  const app = express();
  app.use(express.json());

  app.get("/price", (_req: Request, res: Response) => {
    res.json({ name: cfg.name, service, amountWei: cfg.priceWei.toString(), escrow: cfg.escrow });
  });

  app.post("/work", async (req: Request, res: Response) => {
    const header = req.header("x-bazaar-claim");
    if (!header) {
      return res.status(402).json({
        error: "payment required",
        name: cfg.name,
        service,
        amountWei: cfg.priceWei.toString(),
        escrow: cfg.escrow,
      });
    }

    let claim: Claim;
    try {
      claim = decodeClaim(header);
    } catch {
      return res.status(400).json({ error: "malformed claim" });
    }

    if (claim.service.toLowerCase() !== service.toLowerCase()) {
      return res.status(400).json({ error: "claim is for a different service" });
    }
    if (claim.amount < cfg.priceWei) {
      return res.status(402).json({ error: "claim amount below price", amountWei: cfg.priceWei.toString() });
    }
    try {
      const signer = await recoverClaimSigner(claim, cfg.escrow, CHAIN_ID);
      if (signer.toLowerCase() !== claim.agent.toLowerCase()) {
        return res.status(400).json({ error: "claim signature does not match agent" });
      }
    } catch {
      return res.status(400).json({ error: "claim signature unrecoverable" });
    }

    // Do the work, then enqueue the claim for batched settlement (optimistic).
    const input = String(req.body?.input ?? "");
    const result = cfg.degrade ? degradedWork(cfg.name) : goodWork(cfg.name, input);
    appendFileSync(cfg.queueFile, encodeClaim(claim) + "\n");

    res.json({ result, queued: true, service, amountWei: claim.amount.toString() });
  });

  return { app, service };
}
