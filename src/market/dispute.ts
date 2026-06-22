// Slash a seller's USDC bond on-chain when it under-delivers (the enforcement step).
// Operator-coordinated for now: the runner holds both the buyer and seller keys, so it can
// open the Crucible dispute the seller would otherwise have to authorize. (Fully-trustless
// external slashing — seller standing-bond + a real commit-reveal resolver — is the roadmap.)
import { keccak256, toBytes, parseEther, type Hex } from "viem";
import { account, publicClient, walletFor, BUYER_PK } from "../config.js";
import { randomNonce } from "../rail/escrow.js";
import {
  MOCK_RESOLVER, signOpenAuth, openMarket, dispute, resolveDisputed,
  type OpenAuth, type SlashOutcome,
} from "../rail/crucible.js";
import { SLASH_BOND_LOCK } from "./fleet.js";

const SLASH_ESCROW = parseEther("0.001");

export async function slashSeller(key: string, scoreBps: number): Promise<SlashOutcome> {
  const pk = process.env[`BAZAAR_SELLER_${key}_PK`];
  const sellerAddr = process.env[`BAZAAR_SELLER_${key}_ADDR`] as Hex;
  if (!pk || !sellerAddr || !BUYER_PK) throw new Error(`missing keys to slash seller ${key}`);
  const seller = walletFor(pk);
  const buyer = walletFor(BUYER_PK);
  const now = Math.floor(Date.now() / 1000);
  const auth: OpenAuth = {
    service: sellerAddr,
    agent: account(BUYER_PK).address,
    resolver: MOCK_RESOLVER,
    amount: SLASH_ESCROW,
    bondLockAmount: SLASH_BOND_LOCK,
    commitmentHash: keccak256(toBytes(`bazaar:${key}:${now}`)),
    disputeWindow: 600n,
    nonce: randomNonce(),
    authExpiry: BigInt(now + 3600),
  };
  const sig = await signOpenAuth(seller, auth);
  const marketId = await openMarket(buyer, publicClient, auth, sig);
  await dispute(buyer, publicClient, marketId);
  return resolveDisputed(buyer, publicClient, marketId, Math.max(0, Math.min(10000, scoreBps)));
}
