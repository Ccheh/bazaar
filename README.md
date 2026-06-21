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
- **Distinct per-agent wallets — DONE:** each seller runs under its own wallet; the settler groups
  claims by service and settles each as that seller (real multi-payee settlement on-chain).
- **Bonded quality / slash — DONE (real on-chain):** a degrader posts a USDC bond; the buyer
  disputes; the resolver scores it low and the bond is **slashed on-chain**, refunding the buyer
  (`npm run slash`). Demo uses the fast mock resolver; the decentralised commit-reveal
  ScalarResolverV10 is the production resolver (same market interface).
- **Slash wired into the economy loop — DONE:** a low buyer grade triggers a real on-chain bond
  slash mid-run (`npm run economy`), so under-delivery is penalised live, not just in a script.
- **Bring-Your-Own-Agent — DONE:** an external, independently-keyed agent joins the live market
  (`npm run market`, then `npm run byoa` with your own wallet + LLM key) and pays real USDC to the
  sellers — genuine cross-party, agent-to-agent traction (see [HANDBOOK.md](HANDBOOK.md)).
- **On-chain discovery (ERC-8004) — DONE:** sellers register on Circle's ERC-8004 IdentityRegistry
  with their endpoint as the agentURI (`npm run register`); buyers discover them from on-chain
  `Registered` events and probe the endpoints (no central list) — permissionless discovery.
- Next: dynamic seller pricing; recursive broker; App Kit dashboard (for the final demo).

Agent brain is provider-agnostic (DeepSeek / OpenAI-compatible / Anthropic); set `BAZAAR_MODEL`
(`deepseek-v4-pro` for headline runs, `deepseek-v4-flash` for the high-frequency economy loop).

## Run slice 1

```bash
cd bazaar
npm install
npm run slice1     # one autonomous paid call, end-to-end
npm run economy    # multi-agent economy: competing sellers + memory-driven routing
npm run slash      # real on-chain bond slash: a degrader's USDC bond is slashed, buyer refunded
npm run register   # publish each seller's endpoint on the ERC-8004 registry (on-chain discovery)
npm run market     # keep the seller fleet live so external agents can join
npm run byoa       # external buyer DISCOVERS sellers on-chain + pays (set BYOA_PK to your wallet)
npm run settle     # operator batch-settles accepted claims on-chain
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
