// Diagnostic: settle a claim via viem with NO Express server running.
// Isolates whether the write-path RPC failure is the in-process server or viem+proxy.
import { parseEther } from "viem";
import { walletFor, publicClient, ESCROW, CHAIN_ID, BUYER_PK, SELLER_PK, account, txUrl } from "../src/config.js";
import { signClaim, settle, escrowBalance } from "../src/rail/escrow.js";

const buyer = walletFor(BUYER_PK);
const sellerAddr = account(SELLER_PK).address;
const buyerAddr = account(BUYER_PK).address;

console.log("signing claim (offline)...");
const claim = await signClaim(buyer, { escrow: ESCROW, chainId: CHAIN_ID, service: sellerAddr, amount: parseEther("0.005") });

const before = await escrowBalance(publicClient, ESCROW, buyerAddr);
console.log("escrow before:", before.toString());

console.log("settling via viem (no server)...");
const tx = await settle(walletFor(SELLER_PK), publicClient, ESCROW, claim);
console.log("SETTLED:", tx);
console.log("url:", txUrl(tx));

const after = await escrowBalance(publicClient, ESCROW, buyerAddr);
console.log("escrow after:", after.toString(), "delta:", (before - after).toString());
