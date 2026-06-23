# Prompt for Codex — edit the Bazaar hackathon demo video

Paste the prompt below to Codex, and give it the files in this `demo/` folder.

---

## PROMPT

You are editing a **hackathon demo video** for **Bazaar** (Lepton Agents Hackathon — Canteen × Circle × Arc).
Cut the video strictly from the shot-by-shot in **`DEMO_SCRIPT.md`** (this folder).

**Hard rules (a miss = disqualification or lost credibility):**
- **Length: UNDER 3:00. This is an auto-reject cap.** The cut sheet sums to ~2:49 — **export at 2:35–2:40 for margin, and stopwatch the EXPORTED .mp4, not the cut-sheet sum.**
- **No on-camera person.** Screen-recording + voiceover only. Founder credibility appears once as a **text lower-third** (e.g. "Builder: prior Arc-hackathon winner · MSc Data Science, Sheffield") — never a face/webcam.
- **Every figure must match the on-chain truth.** Don't invent numbers; overlay human-readable USDC over the 18-decimal wei on Arcscan rows. Only drop a green ✓ "truth-stamp" AFTER an Arcscan receipt visibly resolves on screen.
- **Honesty guardrails** (a sharp judge verifies the repo — do not cross them): they're listed at the bottom of `DEMO_SCRIPT.md`. Key ones: the validator-slash uses a *forced* outlier (say so on scene 9); Circle's role is open + dispute + resolve (full loop); beginner-agent reason text is verbatim; testnet + team-operated-validators scope card (scene 12) stays.

**Structure & grammar (from `DEMO_SCRIPT.md`):**
- Proof-first: cold-open on a real Arcscan slash tx, then mechanism, then the Circle loop, then the verify/dashboard finale.
- One monospace dark terminal theme · persistent top-bar caption strip (current claim) · persistent lower-third tx-chip mirroring the on-screen hash · **GREEN = paid/protected, RED = slashed/forfeit, AMBER = the twist**.
- Say each jargon term (commit-reveal, calibration-weighted median) exactly once, plainly, with the term as a caption; keep **≤1 technical term per on-screen caption** (rest goes to VO). VO ≤ 2.7 words/sec.
- For the 0:44–1:33 mechanism stretch, break monotony by swapping one terminal beat for the **`architecture.svg`** (this folder) animated — the amber "CORE" box is the one idea to spotlight.
- Music: subtle bed; **kill it under scene 12 (the honesty card)** so it reads sober.
- **Finale (scene 13):** the live dashboard at `https://ccheh.github.io/bazaar/` loading and badges flipping to "✓ confirmed · block N", landing on **"✅ 8/8 confirmed live on Arc Testnet"**. Keep a fallback "already-green" capture in case the live RPC is slow at record time.

**Deliverable:** one `.mp4`, **< 3:00**, captions burned in, 1080p, ending on the dashboard "8/8 confirmed" card + the repo URL `github.com/Ccheh/bazaar`.

---

## Assets in this folder
- **`DEMO_SCRIPT.md`** — the shot-by-shot cut sheet (timecodes, on-screen action, VO, captions, criterion per beat) + capture checklist + honesty guardrails + editing notes. **This is the source of truth.**
- **`architecture.svg`** — the architecture diagram; the amber "⭐ CORE INNOVATION" box is the one idea to spotlight (use in the early mechanism beats).
- Founder provides the **screen recordings** listed in the cut sheet's "Capture checklist" (terminal runs of `npm run trustless` / `circle:trustless` / `circle:pay` / `beginner` / `byoa:ext` / `verify`, the live dashboard, and the Arcscan tx pages).

> Note on tx hashes: a cleaner trustless re-run is finalizing; use the hashes exactly as they appear in the **latest `DEMO_SCRIPT.md`** and on the **live dashboard** (they are the source of truth, not this prompt).
