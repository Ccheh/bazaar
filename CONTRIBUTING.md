# Contributing to Bazaar

Bazaar is testnet-only and welcomes small, reviewable contributions.

## Safe first check

No wallet or model key is needed to validate the repository and historical evidence:

```bash
git clone https://github.com/Ccheh/bazaar.git
cd bazaar
npm ci --ignore-scripts
npm run ci
npm run verify
```

The dependency lockfile pins the installed graph. Do not commit `.env`, private
keys, Circle entity secrets, recovery material, or token-bearing RPC URLs.

## Useful contributions

- run an independently controlled buyer against a temporary Bazaar seller;
- operate a validator under a key and model provider controlled by you;
- improve the reviewer flow without weakening the honest evidence labels;
- add tests around settlement, identity discovery, or adversarial resolution;
- report Circle/Arc RPC or developer-experience issues with reproducible details.

Before proposing a live experiment, open an issue and state which wallet and role
you control. Never send a private key or API key to another contributor.

## Pull requests

1. Keep changes narrowly scoped.
2. Run `npm run ci`.
3. Do not replace testnet evidence with simulated claims.
4. Document any new network endpoint and why it is required.
5. State whether a result is operator-run, separately keyed, or genuinely external.

Security reports should follow [SECURITY.md](SECURITY.md), not a public issue.
