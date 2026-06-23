# Bazaar — Lepton Agents Hackathon submission

**Checklist (forms.gle):**
- [x] Public GitHub repo — https://github.com/Ccheh/bazaar (clone runs; `npm run verify` = 8/8 on-chain)
- [x] **Demo video link** (<3 min): **https://youtu.be/loRvV3yG28c** — YouTube *unlisted*, 2:35 (also in README)
- [ ] **Traction questionnaire** — paste the answer below
- [ ] (optional, highest-leverage) one genuine third-party tx — have someone outside the team run `npm run byoa` with their own wallet+key and pay a seller; add that tx

Live, no-install proof for judges: **https://ccheh.github.io/bazaar/** (browser confirms all 8 txs live) · or `npm run verify`.

---

## Traction questionnaire (ready to paste — honest by design)

**Users onboarded.** 5+ distinct on-chain agent identities transacted real sub-cent USDC on Arc Testnet,
each under its own key: the buyer agent; an independently-keyed external agent (`0x19D1…525F`); a
Claude-powered "beginner" newcomer with its own fresh wallet (`0xD8D5…61Fb`); a Circle Developer-Controlled
wallet (`0x9608…e2a2`); and 3 staked validator identities (V1/V2/V3) that each put their own USDC at risk
grading deliveries. **Stated plainly: all wallets are currently team/self-funded on testnet** — this proves
the mechanism end-to-end across distinct keys and distinct models, **not external paying customers yet**. The
named open gaps are one genuine third-party agent and an outside operator staking as a validator.

**Problems solved (8 real on-chain txs — verify with `npm run verify` or the browser dashboard, no keys):**
1. A lazy delivery graded **5/100** by independent staked validators → seller USDC bond **slashed 0.019**,
   buyer refunded 0.02925 (`0x58955ae2`).
2. A **lying buyer** disputing genuinely-good (100/100) work → **forfeits its 0.001 dispute bond** to the
   honest seller (`0xe313a902`).
3. A deviating validator (V3) **itself slashed 0.01308** for going off-consensus.
4. A Circle DCW **sub-cent nanopayment**, seller +0.002 USDC (`0x4c6db2f9`).
5. A Circle wallet driving the **full open→dispute→resolve loop through the bonded rail**, 0.03079 USDC
   refunded to it (`0x7c9b913b` / `0xf7ea1cbb` / `0xf9dadc5e`).
6. External + beginner agent payments (`0xac74ffee` / `0x478a2402`).

**Why it fits "paid by the fraction."** Payments are sub-cent USDC per call (native 18-dec USDC on Arc), and —
uniquely — bad work is refunded automatically by an **operator-free staked-validator consensus** that slashes
the seller's bond on-chain. No platform holds funds or arbitrates. The mechanism is permissionless and
stake-secured; the honest remaining step is moving from a faithful team-operated validator set to a live
multi-party one.

---

## Honest scope (also in the README Trust model + the video honesty card)
Testnet only · validators distinct-model + distinct-key but team-operated today (mechanism permissionless;
outside validator set is the open gap; per-model not per-provider) · the headline run's deviating validator
is a *forced* outlier to show the slash path deterministically (organic 3-model run = `npm run circle:trustless`) ·
external/beginner agents independently-keyed but self-funded · discovery is a published agentId directory ·
zero new Solidity this hackathon (the contracts are reused, but in-repo + auditable in `contracts/v07`).
