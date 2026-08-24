# Changelog

All notable changes to Bazaar are recorded here. Dates use UTC.

## 0.2.0 - 2026-08-25

Post-Lepton maintenance release.

- Replaced the single-endpoint, sequential receipt checker with a concurrent
  multi-RPC verifier. It now distinguishes an absent transaction from an RPC
  outage instead of reporting both as `not-found`.
- Reduced a full eight-receipt verification from repeated multi-minute stalls
  to a few seconds under the current Arc Testnet RPC conditions.
- Added deterministic tests for evidence extraction, RPC failover, receipt
  classification, and outage handling.
- Added a GitHub Actions quality gate using Node 22 and `npm ci --ignore-scripts`.
- Updated the public evidence page and documentation to distinguish
  separately-keyed operator demos from genuine third-party usage.
- Kept all runtime dependencies pinned to exact versions.

## 0.1.0 - 2026-06-23

- Shipped the Lepton submission: sub-cent Arc payments, ERC-8004 discovery,
  Circle Developer-Controlled Wallet execution, and bonded quality resolution.
- Published eight independently verifiable Arc Testnet payment and slash receipts.
- Published the evidence dashboard and the 2:35 demo video.
