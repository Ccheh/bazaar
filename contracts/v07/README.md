# Crucible v0.7 contracts (the trustless slash core)

These are the **exact, already-deployed** Solidity contracts that `npm run trustless` drives — copied here
so the novel logic (calibration-weighted-median consensus, outlier slashing, staker-participant decoupling,
pre-committed `criteriaHash`) is **auditable in-repo**, not just asserted. They were authored in prior work
(reused this hackathon — zero new Solidity); the TypeScript client is in [`../../src/rail/crucible-v7.ts`](../../src/rail/crucible-v7.ts).

Deployed + in use on **Arc Testnet** (chain 5042002, native token = USDC, 18 decimals):

| Contract | Address | Role |
|---|---|---|
| `CrucibleMarketV7` | `0x9934bAF33bcF0dfD14040f8ddd5DdF18eCfEFb59` | bonded graded-resolution market: EIP-712 `OpenAuth` carries both `commitmentHash` (deliverable) and a pre-committed `criteriaHash` (rubric); typed `DisputeKind`; settles escrow + bond by the resolver's score |
| `ScalarResolverV10` | `0xb377B32A65166bcA3d9b14b8C5C1b636817F4c01` | staked-validator commit-reveal resolver: **calibration-weighted median** in [0,10000], **outlier slashing** (distance > `TOLERANCE_BPS` 1500 → up to `MAX_SLASH_BPS` 1000), `MIN_STAKE` 0.1, 30min commit + 30min reveal, staker-participant decoupling via `onDispute` |

Verify the key claims directly in source:
- **No operator sets the score** — `ScalarResolverV10.resolve()` computes the calibration-weighted median of revealed votes; the market's `resolveDisputed()` only reads `IResolver(resolver).resolve(...)`.
- **Outlier validators are slashed** — `resolve()` pass 4: `distance > TOLERANCE_BPS` → `slashAmt = stk * slashBps / 10000`, emits `ValidatorSlashed`.
- **A lying buyer can't slash an honest seller** — `CrucibleMarketV7._settle()`: `bondSlash = bondLocked*(10000-score)/10000` (≈0 at high score) and `bondToService = disputeBond*score/10000` (the disputer's bond flows to the seller at high score).
