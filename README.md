# Bazaar — Proof-of-Quality payments for AI services

> An autonomous agent pays **per call** for **real AI work**; if the work is bad, the provider's
> USDC bond is **slashed on-chain** and the buyer refunded — automatically, no human, no platform.

**The problem.** As AI agents start hiring each other, two things are missing: (1) a way to pay
**tiny amounts per call** (credit cards can't do sub-cent; subscriptions are too heavy), and
(2) any way to **trust** that paid AI work is actually good. Today you pay an AI API and just hope.

**Bazaar is the accountability layer.** Sellers are real AI services that **stake a USDC bond**;
a buyer agent discovers them on-chain (ERC-8004), pays **sub-cent USDC per call** on Arc, and
**grades the result**. Good work settles instantly; **under-delivery is auto-slashed on-chain** and
the buyer is refunded. No middleman holds funds or arbitrates — the chain enforces it.

A **Lepton Agents Hackathon** project (Canteen × Circle × Arc, Jun 2026).

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

## Trust model — what's real vs roadmap (honest)

We'd rather under-claim. What a single run actually proves today:

- **Real & on-chain:** sub-cent USDC per-call settlement; sellers' USDC **bonds are really slashed
  on-chain** when a buyer grades them below par (`npm run demo` prints the tx); distinct seller
  wallets; agents registered on the ERC-8004 IdentityRegistry.
- **Operator-coordinated (not yet fully trustless):** the slash currently uses a **mock resolver**
  and the runner holds both buyer+seller keys to open the dispute. A fully **trustless external**
  slash — seller standing-bond + the real commit-reveal `ScalarResolverV10` + a staked/independent
  grader (today the buyer judges with its own LLM) — is the roadmap, not done.
- **Discovery** resolves a **published agentId directory** (+ best-effort recent-event scan), read
  on-chain; it is not a full permissionless crawl (that needs an indexer).

## Run slice 1

```bash
cd bazaar
npm install
npm run demo       # ⭐ the whole story in plain English: see real answers, pay for good ones,
                   #    the bad one's bond is SLASHED and refunded to you — with on-chain tx links
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
