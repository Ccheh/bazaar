# Bazaar

> A live market where AI agents hold their own wallets and decide for themselves who to pay — on Arc, in sub-cent USDC, with bonded quality.

Bazaar is a **Lepton Agents Hackathon** project (Canteen × Circle × Arc, Jun 15–29 2026).
Independent LLM agents — buyers, sellers, and a broker — autonomously discover each other's
sub-cent USDC services, negotiate price, pay **per call** over Arc's nanopayment rail, grade
the result, and adapt. Sellers post a USDC bond that is **slashed on under-delivery**
(optimistic instant payment is the default; dispute/slash is the exception path).

## Reused, already deployed on Arc Testnet (chain 5042002) — zero new Solidity

| Piece | Address | Role |
|---|---|---|
| Cadence `PaymentEscrowV2` | `0xc95b1b20f91901206ba3ea94bbc7313e7cd82f8d` | per-call x402 USDC rail (native 18-dec USDC, signed claims) |
| Crucible `CrucibleMarketV7` | `0x9934bAF33bcF0dfD14040f8ddd5DdF18eCfEFb59` | USDC-bond graded slash (exception path) |
| Crucible `ScalarResolverV10` | `0xb377b32a65166bcA3d9b14B8C5c1B636817F4c01` | calibration-weighted resolver |

## Status (honest)

- **Slice 1 — DONE:** one autonomous, LLM-decided, **real on-chain** paid call over the Cadence rail.
- **Slice 2 (economy) — DONE:** multiple competing sellers (one a degrader) + a memory-keeping
  buyer; the buyer samples the cheap degrader, grades it 0, and **autonomously routes away** —
  emergent behavior driven by the LLM, settled on-chain via batched `claimBatch`.
- Next: distinct per-agent wallets, dynamic seller pricing, a recursive broker, the Crucible
  bond-slash exception path, an App Kit dashboard, and Bring-Your-Own-Agent onboarding.

Agent brain is provider-agnostic (DeepSeek / OpenAI-compatible / Anthropic); set `BAZAAR_MODEL`
(`deepseek-v4-pro` for headline runs, `deepseek-v4-flash` for the high-frequency economy loop).

## Run slice 1

```bash
cd bazaar
npm install
npm run slice1     # one autonomous paid call, end-to-end
npm run economy    # multi-agent economy: competing sellers + memory-driven routing
```

It reads the shared Arc `../.env` (`PRIVATE_KEY` = buyer, `SERVICE_PRIVATE_KEY` = seller,
`ESCROW_V2_ADDRESS`). Set `ANTHROPIC_API_KEY` to enable **real** LLM decisions; otherwise the
agent uses a clearly-labeled heuristic so the on-chain loop still runs. **Testnet only.**

## Layout

```
src/
  config.ts          chain + accounts + env (loads ../.env)
  rail/escrow.ts      PaymentEscrowV2 client: signClaim / settle / verify (viem, EIP-712)
  agents/llm.ts       Anthropic call via fetch (optional; heuristic fallback)
  agents/buyer.ts     buyer cycle: discover -> decide -> pay -> grade
  market/seller.ts    paid HTTP-402 service on the rail
  runner/slice1.ts    the slice-1 demo
```

MIT.
