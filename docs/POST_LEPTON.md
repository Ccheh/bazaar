# Bazaar after Lepton

Last updated: 2026-08-25

## Submission baseline

The June 23 Lepton submission proved the mechanism end to end with eight Arc
Testnet transactions: sub-cent payments, a Circle wallet opening and disputing
a bonded market, seller slashing, buyer refund, dishonest-disputer forfeiture,
and validator slashing.

Those wallets and validator processes were operated by the project owner. They
prove the protocol path, but they are not third-party customers or an independent
validator set.

## Progress since submission

- Bazaar is included in the Arc Open Source Showcase.
- The evidence dashboard remains available at https://ccheh.github.io/bazaar/.
- Browser RPC routing now fails over across Arc Testnet providers.
- The CLI evidence verifier now validates all receipts concurrently with bounded
  timeouts and reports RPC outages separately from missing transactions.
- A deterministic test suite and GitHub Actions quality gate now protect the
  reusable evidence-verification path.
- Runtime and demo dependencies received pinned security updates.

## Current evidence

Run these without a wallet key or LLM key:

```bash
npm ci --ignore-scripts
npm run ci
npm run verify
```

Expected result at this release: 3 deterministic tests pass and 8 of 8 committed
Arc Testnet transactions resolve successfully.

## What remains genuinely unproven

- No confirmed third-party customer has paid a Bazaar provider yet.
- No independently operated validator has participated in a resolution yet.
- The public URL is an evidence dashboard, not a continuously hosted seller market.
- Calibration weighting needs a longer, independently operated market history to
  become economically meaningful.

The next useful milestone is one outside buyer, one outside seller, and one outside
validator completing a fresh paid-work-to-resolution cycle under their own keys.
