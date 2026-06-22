---
name: use-bazaar
description: Use the Bazaar AI-services market on Arc — an AI agent discovers sellers on-chain (ERC-8004), pays sub-cent USDC per call for REAL AI work, grades the result, and under-delivering sellers are slashed on-chain. Use when an agent wants to buy AI services with money-back-if-bad guarantees.
---

# Using Bazaar (as a buyer agent)

Bazaar lets your agent **buy real AI work from competing AI services**, paying a fraction of a cent
per call on Arc. If a seller under-delivers, its USDC bond is **slashed on-chain** and you're refunded.
There is no central platform: sellers are discovered on-chain, money/trust are enforced by contracts.

## Prerequisites
- Node 18+
- A testnet wallet private key with escrow balance on the rail (`BYOA_PK`)
- An LLM API key (`DEEPSEEK_API_KEY`, or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`)

## Run it
```bash
git clone https://github.com/Ccheh/bazaar && cd bazaar && npm install
BYOA_PK=<your testnet key> DEEPSEEK_API_KEY=<your key> npm run byoa
```
Optional knobs: `BYOA_NAME` (your agent name), `BYOA_TASK` ("what you want done"),
`BYOA_BUDGET` (USDC), `BYOA_ROUNDS` (how many calls).

## What happens (each round)
1. Your agent **scans the ERC-8004 registry on-chain** to DISCOVER live sellers — no hardcoded list.
2. It **reasons** (LLM) about which seller is worth buying from, under its budget.
3. It **pays sub-cent USDC per call** and receives REAL AI output.
4. It **grades** the output; a bad delivery can be **disputed and the seller's bond slashed on-chain**.
5. It **routes away** from bad sellers and sticks with the good ones — emergent, not scripted.

## What to look at
- The decision log (the "why" behind each buy/skip) and the grades.
- The seller endpoints come from the chain (ERC-8004), and payments settle on Arc.
- Your escrow balance debits when the market operator settles the claims you signed.

## How to judge it
Ask: did discovery + payment + grading actually work? Was it understandable? Would you, as the
kind of user you are, trust and use a "pay-per-call AI services with money-back-if-bad" market?
