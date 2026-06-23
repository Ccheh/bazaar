// Bazaar — the TRUSTLESS accountability core (real, on-chain, no operator-set score).
//
// What this proves, end to end on Arc Testnet, with nobody trusted:
//   1. A seller stakes a USDC bond on CrucibleMarketV7 for a specific delivery.
//   2. An independent set of STAKED validators (ScalarResolverV10) each grade the delivery
//      with their OWN LLM, commit-reveal their scores; the on-chain calibration-weighted
//      MEDIAN — not the operator — decides the outcome. Outlier validators are slashed.
//   3. BAD delivery  -> consensus low  -> seller's bond is slashed, buyer refunded.
//   4. GOOD delivery + a LYING buyer who disputes it -> consensus high -> seller's bond is
//      PROTECTED and the liar FORFEITS its dispute bond to the seller.  <-- adversarial test
//
// The run takes ~60 min of wall clock because the resolver enforces a 30-min commit + 30-min
// reveal window (admin-keyless; no one can shortcut it). State is persisted after every step,
// so if the process dies during a window it resumes exactly where it left off:  npm run trustless
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatEther, keccak256, parseEther, toBytes, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { account, BUYER_PK, publicClient, SELLER_KEYS, txUrl, walletFor } from "../config.js";
import { doWork } from "../market/work.js";
import { validatorGrade, type Grade } from "../agents/validator.js";
import {
  RESOLVER_V10, bondAvailableV7, canResolve, chainNow, commitVote, computeVoteHash, depositBondV7, allowResolverV7,
  disputeV7, hasCommitted, hasRevealedVote, isAlreadyDone, marketStatus, minStake, openMarketV7, randomSalt,
  requiredDisputeBond, resolveDisputedV7, resolverMarket, revealVote, signOpenAuthV7, stakeValidator, validatorStake,
  type OpenAuthV7, type ResolveOutcome,
} from "../rail/crucible-v7.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(here, "../../../.env");
const STATE_FILE = resolve(here, "../../.trustless-state.json");

const TASK = "Explain the main trade-offs between optimistic and ZK rollups in 3 concise bullet points.";
const CRITERIA =
  "Award a high score ONLY if the answer: (a) addresses BOTH optimistic and ZK rollups; " +
  "(b) gives at least 3 distinct, concrete trade-offs (e.g. proof/verification cost, finality & " +
  "withdrawal latency, EVM compatibility/maturity, security/trust assumptions); and (c) is accurate. " +
  "Penalize vagueness, fewer than 3 real points, padding, or factual errors. A one-line non-answer scores near 0.";

const ESCROW = parseEther("0.01");      // agent's per-call escrow (msg.value at open)
const BOND_LOCK = parseEther("0.02");   // seller's at-risk bond for THIS delivery
const DISPUTE_BPS = 1000;               // 10% of escrow posted by the disputer
const STAKE_HEADROOM = parseEther("0.04"); // gas headroom funded to each validator on top of stake
const N_VALIDATORS = 3;

// Each validator runs a DISTINCT model so independence is real (not one model queried N times).
const VALIDATOR_MODELS = (process.env.BAZAAR_VALIDATOR_MODELS ?? "deepseek-v4-pro,deepseek-v4-flash,deepseek-chat")
  .split(",").map((s) => s.trim());
// Optional demo of validator accountability: force one validator to vote off-consensus so it is slashed.
// Format "<index>:<scoreBps>", e.g. BAZAAR_OUTLIER="3:9000" makes V3 vote 9000 on every market.
const OUTLIER = process.env.BAZAAR_OUTLIER;

interface Val { name: string; address: Address; pk: string; model?: string; index: number }

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (w: bigint) => Number(formatEther(w)).toFixed(5);

interface VoteState { scoreBps: number; salt: Hex; reason: string; via: string; committed: boolean; revealed: boolean }
interface MarketState {
  label: "BAD" | "GOOD";
  scenario: string;
  delivery: string;
  nonce: string;
  marketId?: Hex;
  disputed?: boolean;
  commitDeadline?: number;
  revealDeadline?: number;
  votes: Record<string, VoteState>; // validatorAddr -> vote
  outcome?: { scoreBps: number; paidToService: string; paidToAgent: string; bondSlashed: string; disputeBondToService: string; txHash: string; slashedValidators?: { validator: string; amount: string }[] };
}
interface State {
  validators: { name: string; address: Address }[];
  markets: Record<string, MarketState>;
  serviceAddr?: Address;
  agentAddr?: Address;
}

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  return { validators: [], markets: {} };
}
function saveState(s: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function appendEnv(key: string, value: string): void {
  if (!existsSync(ROOT_ENV) || !readFileSync(ROOT_ENV, "utf8").includes(`${key}=`)) {
    appendFileSync(ROOT_ENV, `\n${key}=${value}`);
  }
  process.env[key] = value;
}

// ---- validators: generate (once), fund, stake ----
async function ensureValidators(state: State, agentPk: string) {
  const funder = walletFor(agentPk);
  const min = await minStake(publicClient);
  const vals: Val[] = [];
  for (let i = 1; i <= N_VALIDATORS; i++) {
    let pk = process.env[`BAZAAR_VALIDATOR_${i}_PK`];
    if (!pk) {
      pk = generatePrivateKey();
      const addr = privateKeyToAccount(pk as Hex).address;
      appendEnv(`BAZAAR_VALIDATOR_${i}_PK`, pk);
      appendEnv(`BAZAAR_VALIDATOR_${i}_ADDR`, addr);
      log(`generated validator V${i} ${addr} (fresh testnet key)`);
    }
    vals.push({ name: `V${i}`, address: privateKeyToAccount(pk as Hex).address, pk, model: VALIDATOR_MODELS[(i - 1) % VALIDATOR_MODELS.length], index: i });
  }
  state.validators = vals.map((v) => ({ name: v.name, address: v.address }));
  saveState(state);

  const need = min + STAKE_HEADROOM;
  for (const v of vals) {
    const bal = await publicClient.getBalance({ address: v.address });
    if (bal < need) {
      const top = need - bal;
      log(`funding ${v.name} ${v.address} with ${fmt(top)} USDC`);
      const h = await funder.sendTransaction({ account: funder.account!, chain: funder.chain, to: v.address, value: top });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    const staked = await validatorStake(publicClient, v.address);
    if (staked < min) {
      log(`${v.name} staking ${fmt(min)} USDC on ScalarResolverV10…`);
      const h = await stakeValidator(walletFor(v.pk), publicClient, min);
      log(`   staked: ${txUrl(h)}`);
    } else {
      log(`${v.name} already staked ${fmt(staked)} USDC`);
    }
  }
  return vals;
}

// ---- service bond + resolver whitelist ----
async function ensureServiceBond(servicePk: string, serviceAddr: Address) {
  const sw = walletFor(servicePk);
  log(`service ${serviceAddr}: allowing resolver V10 + funding bond pool…`);
  await allowResolverV7(sw, publicClient);
  const avail = await bondAvailableV7(publicClient, serviceAddr);
  const want = BOND_LOCK * BigInt(2);
  if (avail < want) {
    const top = want - avail + parseEther("0.005");
    log(`   depositing ${fmt(top)} USDC bond`);
    const h = await depositBondV7(sw, publicClient, top);
    log(`   bond deposited: ${txUrl(h)}`);
  } else {
    log(`   bond pool already has ${fmt(avail)} USDC free`);
  }
}

async function ensureOpened(m: MarketState, servicePk: string, serviceAddr: Address, agentPk: string, agentAddr: Address) {
  if (m.marketId && (await marketStatus(publicClient, m.marketId)) !== 0) return;
  const auth: OpenAuthV7 = {
    service: serviceAddr,
    agent: agentAddr,
    resolver: RESOLVER_V10,
    amount: ESCROW,
    bondLockAmount: BOND_LOCK,
    disputeBondBps: DISPUTE_BPS,
    commitmentHash: keccak256(toBytes(m.delivery)),
    criteriaHash: keccak256(toBytes(CRITERIA)),
    disputeWindow: BigInt(3600),
    nonce: BigInt(m.nonce),
    authExpiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const sig = await signOpenAuthV7(walletFor(servicePk), auth);
  log(`[${m.label}] opening market (escrow ${fmt(ESCROW)}, seller bond ${fmt(BOND_LOCK)})…`);
  m.marketId = await openMarketV7(walletFor(agentPk), publicClient, auth, sig);
  log(`[${m.label}] marketId ${m.marketId}`);
}

async function ensureDisputed(m: MarketState, agentPk: string) {
  if (!m.marketId) throw new Error("no marketId");
  if ((await marketStatus(publicClient, m.marketId)) >= 2) { m.disputed = true; }
  if (!m.disputed) {
    const bond = await requiredDisputeBond(publicClient, m.marketId);
    log(`[${m.label}] ${m.scenario} — disputing (bond ${fmt(bond)})…`);
    const h = await disputeV7(walletFor(agentPk), publicClient, m.marketId, bond, 2);
    log(`[${m.label}] disputed: ${txUrl(h)}`);
    m.disputed = true;
  }
  const rm = await resolverMarket(publicClient, m.marketId);
  m.commitDeadline = rm.commitDeadline;
  m.revealDeadline = rm.revealDeadline;
  if (!rm.commitDeadline) throw new Error(`[${m.label}] voting window did NOT open — resolver/market mismatch`);
}

async function ensureCommitted(m: MarketState, vals: Val[]) {
  if (!m.marketId) throw new Error("no marketId");
  for (const v of vals) {
    const existing = m.votes[v.address];
    // Source of truth is the chain: if a commit is already recorded (e.g. a crash after the tx
    // but before saveState), reconcile the flag and skip — never re-send into an AlreadyCommitted revert.
    if (existing?.committed || (existing && (await hasCommitted(publicClient, m.marketId, v.address)))) {
      if (existing && !existing.committed) { existing.committed = true; saveState(stateRef); }
      continue;
    }
    const forced = OUTLIER && OUTLIER.startsWith(`${v.index}:`) ? Number(OUTLIER.split(":")[1]) : undefined;
    const g: Grade = forced !== undefined
      ? { scoreBps: forced, reason: `forced off-consensus (accountability demo)`, via: "forced-outlier" }
      : await validatorGrade(v.name, TASK, CRITERIA, m.delivery, v.model);
    const salt = randomSalt();
    const voteHash = computeVoteHash(g.scoreBps, salt, m.marketId, v.address);
    m.votes[v.address] = { scoreBps: g.scoreBps, salt, reason: g.reason, via: g.via, committed: false, revealed: false };
    saveState(stateRef); // persist salt BEFORE the on-chain commit, so a crash never loses it
    try {
      const h = await commitVote(walletFor(v.pk), publicClient, m.marketId, voteHash);
      log(`[${m.label}] ${v.name} committed ${(g.scoreBps / 100).toFixed(0)}/100 via ${g.via} — "${g.reason}"  ${txUrl(h)}`);
    } catch (e) {
      if (!isAlreadyDone(e)) throw e;
      log(`[${m.label}] ${v.name} commit already on-chain — reconciled`);
    }
    m.votes[v.address].committed = true;
    saveState(stateRef);
  }
}

async function ensureRevealed(m: MarketState, vals: Val[]) {
  if (!m.marketId) throw new Error("no marketId");
  for (const v of vals) {
    const vote = m.votes[v.address];
    if (!vote || vote.revealed) continue;
    if (await hasRevealedVote(publicClient, m.marketId, v.address)) { vote.revealed = true; saveState(stateRef); continue; }
    try {
      const h = await revealVote(walletFor(v.pk), publicClient, m.marketId, vote.scoreBps, vote.salt);
      log(`[${m.label}] ${v.name} revealed ${(vote.scoreBps / 100).toFixed(0)}/100  ${txUrl(h)}`);
    } catch (e) {
      if (!isAlreadyDone(e)) throw e;
      log(`[${m.label}] ${v.name} reveal already on-chain — reconciled`);
    }
    vote.revealed = true;
    saveState(stateRef);
  }
}

async function waitUntilChain(ts: number, label: string) {
  for (;;) {
    const now = await chainNow(publicClient);
    if (now > ts) return;
    const left = ts - now;
    log(`${label}: ~${Math.ceil(left / 60)} min left (chain clock)`);
    await sleep(Math.min(left + 5, 60) * 1000);
  }
}

let stateRef: State; // for saveState inside helpers

async function main() {
  if (!BUYER_PK) throw new Error("set PRIVATE_KEY (MAIN) in ../.env");
  if (SELLER_KEYS.length === 0) throw new Error("need BAZAAR_SELLER_A_{ADDR,PK} in ../.env");
  const agentPk = BUYER_PK;
  const agentAddr = account(agentPk).address;
  const service = SELLER_KEYS[0];
  const servicePk = service.pk;
  const serviceAddr = service.address;

  const state = loadState();
  stateRef = state;
  state.agentAddr = agentAddr;
  state.serviceAddr = serviceAddr;

  console.log("==================================================================");
  console.log(" Bazaar — TRUSTLESS slash: staked validators decide, not the operator");
  console.log("==================================================================\n");
  log(`agent(buyer)=${agentAddr}  service(seller)=${serviceAddr}`);
  log(`market=CrucibleMarketV7  resolver=ScalarResolverV10 ${RESOLVER_V10}\n`);

  // Deliveries: generate REAL work once, then reuse (so the on-chain commitmentHash matches).
  if (!state.markets.BAD || !state.markets.GOOD) {
    log("generating real deliveries (good seller + lazy seller)…");
    const good = await doWork("analyst", TASK, false);
    const bad = await doWork("cheapbot", TASK, true);
    const goodText = good.output ?? `${good.summary} ${(good.points ?? []).join("; ")}`;
    const badText = bad.output ?? bad.summary ?? "Rollups are good. Use them.";
    const base = Date.now();
    state.markets.BAD ??= { label: "BAD", scenario: "lazy seller, justified dispute", delivery: badText, nonce: String(base + 1), votes: {} };
    state.markets.GOOD ??= { label: "GOOD", scenario: "honest seller, a LYING buyer disputes good work", delivery: goodText, nonce: String(base + 2), votes: {} };
    saveState(state);
  }
  const markets = [state.markets.BAD, state.markets.GOOD];

  // 1. validators + service bond
  const vals = await ensureValidators(state, agentPk);
  await ensureServiceBond(servicePk, serviceAddr);

  // 2. open + 3. dispute both (opens the 30+30 min windows)
  for (const m of markets) {
    await ensureOpened(m, servicePk, serviceAddr, agentPk, agentAddr);
    saveState(state);
  }
  for (const m of markets) {
    await ensureDisputed(m, agentPk);
    saveState(state);
  }

  // 4. validators independently grade + commit (within the commit window)
  const now0 = await chainNow(publicClient);
  for (const m of markets) {
    if (m.commitDeadline && now0 < m.commitDeadline) await ensureCommitted(m, vals);
    else log(`[${m.label}] commit window already closed — skipping new commits`);
  }

  // 5. wait out the commit window, then reveal
  const commitEnd = Math.max(...markets.map((m) => m.commitDeadline ?? 0));
  await waitUntilChain(commitEnd, "commit window");
  for (const m of markets) await ensureRevealed(m, vals);

  // 6. wait out the reveal window, then resolve (consensus median settles + slashes)
  const revealEnd = Math.max(...markets.map((m) => m.revealDeadline ?? 0));
  await waitUntilChain(revealEnd, "reveal window");

  for (const m of markets) {
    if (!m.marketId) continue;
    if ((await marketStatus(publicClient, m.marketId)) === 3) { log(`[${m.label}] already resolved`); continue; }
    if (!(await canResolve(publicClient, m.marketId))) { log(`[${m.label}] resolver not ready (no reveals?) — skipping`); continue; }
    log(`[${m.label}] resolving via consensus…`);
    const o: ResolveOutcome = await resolveDisputedV7(walletFor(agentPk), publicClient, m.marketId);
    m.outcome = {
      scoreBps: o.scoreBps, paidToService: o.paidToService.toString(), paidToAgent: o.paidToAgent.toString(),
      bondSlashed: o.bondSlashed.toString(), disputeBondToService: o.disputeBondToService.toString(), txHash: o.txHash,
      slashedValidators: o.slashedValidators.map((s) => ({ validator: s.validator, amount: s.amount.toString() })),
    };
    saveState(state);
    log(`[${m.label}] consensus score ${(o.scoreBps / 100).toFixed(0)}/100 — bondSlashed ${fmt(o.bondSlashed)} — ${txUrl(o.txHash)}`);
    for (const s of o.slashedValidators) log(`[${m.label}] ⚖ validator ${s.validator.slice(0, 10)} SLASHED ${fmt(s.amount)} USDC for deviating ${(Number(s.distance) / 100).toFixed(0)} pts from consensus`);
  }

  // 7. report + adversarial assertion
  report(markets);
}

function report(markets: MarketState[]) {
  const bad = markets.find((m) => m.label === "BAD")!;
  const good = markets.find((m) => m.label === "GOOD")!;
  console.log("\n===================== TRUSTLESS RESULT =====================");
  for (const m of markets) {
    console.log(`\n[${m.label}] ${m.scenario}`);
    const votes = Object.entries(m.votes).map(([a, v]) => `${a.slice(0, 8)}=${(v.scoreBps / 100).toFixed(0)}`).join("  ");
    console.log(`  independent validator votes: ${votes}`);
    if (m.outcome) {
      console.log(`  CONSENSUS score:        ${(m.outcome.scoreBps / 100).toFixed(0)}/100`);
      console.log(`  seller bond slashed:    ${fmt(BigInt(m.outcome.bondSlashed))} USDC`);
      console.log(`  to seller (escrow+bond):${fmt(BigInt(m.outcome.paidToService))} USDC`);
      console.log(`  to buyer  (escrow refund + slashed bond + own dispute-bond back): ${fmt(BigInt(m.outcome.paidToAgent))} USDC`);
      console.log(`  disputer's bond to seller:${fmt(BigInt(m.outcome.disputeBondToService))} USDC`);
      for (const s of m.outcome.slashedValidators ?? [])
        console.log(`  ⚖ validator ${s.validator.slice(0, 10)} SLASHED ${fmt(BigInt(s.amount))} USDC (deviated from consensus)`);
      console.log(`  proof: ${txUrl(m.outcome.txHash)}`);
    } else {
      console.log("  (not resolved)");
    }
  }

  if (bad.outcome && good.outcome) {
    const badScore = bad.outcome.scoreBps, goodScore = good.outcome.scoreBps;
    const badSlash = BigInt(bad.outcome.bondSlashed), goodSlash = BigInt(good.outcome.bondSlashed);
    const liarLost = BigInt(good.outcome.disputeBondToService);
    const pass =
      badScore < 3000 &&            // bad work scored low by independent consensus
      goodScore > 7000 &&           // good work scored high
      goodSlash < badSlash &&       // honest seller's bond largely protected
      liarLost > BigInt(0);         // the lying buyer forfeited its dispute bond
    console.log("\n----------------- ADVERSARIAL TEST -----------------");
    console.log(`  bad delivery   -> consensus ${(badScore / 100).toFixed(0)}/100, seller bond slashed ${fmt(badSlash)}`);
    console.log(`  good delivery  -> consensus ${(goodScore / 100).toFixed(0)}/100, seller bond slashed only ${fmt(goodSlash)}`);
    console.log(`  the LYING buyer who disputed good work FORFEITED ${fmt(liarLost)} USDC of its dispute bond to the seller`);
    console.log(`\n  ==> A dishonest buyer CANNOT slash an honest seller. It loses its own stake.`);
    console.log(`  ==> ${pass ? "PASS ✅" : "INCONCLUSIVE ⚠ (check validator scores above)"}`);
  }
  console.log("\nNo operator set these scores. Independent staked validators did, via commit-reveal,");
  console.log("and the chain enforced the settlement. (npm run trustless resumes if interrupted.)");
}

main().catch((e) => {
  console.error(e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
