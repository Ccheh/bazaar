# Build the Bazaar demo with HyperFrames — guide for Codex

**Goal:** a sharper, animated demo video by authoring it in **HTML/CSS/GSAP** and rendering with
**[HyperFrames](https://github.com/heygen-com/hyperframes)** (HeyGen's open-source HTML→video engine:
headless Chrome seeks each frame, FFmpeg encodes; deterministic, agent-authored). Replaces the PIL
slide pipeline. The shot list, timing, VO, and honesty rules stay the same — see **`DEMO_SCRIPT.md`**.

**Why it's a win here:** our content is text/data/motion-graphics — exactly HyperFrames' sweet spot —
and we already have HTML assets. Crucially, instead of *screenshotting* Arcscan/the dashboard (the part
that failed in headless capture), we **rebuild the evidence as native HTML** with the real tx hashes and
animate the badges to "✓ confirmed". No flaky capture, pixel-crisp, 100% accurate.

## 0) Security first (project policy — do this before installing)
- HyperFrames installs via `npx skills add heygen-com/hyperframes` / `npx hyperframes`. **Do NOT run
  `npx -y` against latest.** First read the skill source on GitHub (heygen-com/hyperframes), then **pin a
  specific version/commit** and install that. It runs headless Chrome + FFmpeg locally; **no private keys
  are involved** (the video only uses public tx hashes + the committed evidence). Keep it that way.

## 1) Setup (Node 22+, FFmpeg required)
```bash
# audit + pin first (see §0), then:
npx hyperframes init bazaar-video      # scaffolds a composition project
cd bazaar-video
# optional media skill for TTS + captions:
npx skills add heygen-com/hyperframes  # (+ /hyperframes-media for TTS/transcription)
npx hyperframes preview                # live-reload browser preview while authoring
npx hyperframes render --output ../build/bazaar_demo_hf.mp4
```

## 2) The composition model (single HTML file)
- Root: `<div data-composition-id="bazaar" data-width="1920" data-height="1080">`.
- Each beat is a **clip**: `class="clip" data-start="<sec>" data-duration="<sec>" data-track-index="0"`.
- Animations: **GSAP** (preferred), CSS, WAAPI, Lottie, Three.js — must be **seekable & frame-accurate**.
  For GSAP, build a `paused` timeline and expose it: `window.__timelines["bazaar"] = tl;`.
- Audio: `<audio data-start="<s>" data-duration="<s>" data-track-index="2" data-volume="1" src="vo/scene01.wav">`.
- **Total of all `data-duration` on the visual track MUST sum to < 180s — target 2:35–2:45 (155–165s).**
  Stopwatch the EXPORTED mp4, not the sum.

## 3) Map our cut sheet → clips
Use **`DEMO_SCRIPT.md`** as the canonical 13-beat shot list (timecodes, VO, captions, criterion). For each
beat, make one `.clip` with the visual grammar from the cut sheet:
- Dark monospace terminal theme · **GREEN = paid/protected, RED = slashed/forfeit, AMBER = the twist**.
- Persistent top-bar claim strip + a lower-third tx-chip mirroring the on-screen hash.
- ≤1 technical term per on-screen caption (rest in VO). Founder credit = **text lower-third only, no face**.

Reuse our assets:
- **Architecture (scenes ~3/5):** inline `architecture.svg`, or rebuild it as an animated HTML diagram and
  highlight the amber ⭐ CORE box (the one idea to spotlight).
- **The slash "receipt" (cold open + scene 6/8):** rebuild a clean Arcscan-style card in HTML — real tx
  hash, the value flow, a red **BOND SLASHED** stamp — instead of a screenshot. Sharper + always accurate.
- **The finale (scene 13):** rebuild the evidence dashboard as HTML and animate the 8 badges flipping to
  **"✓ confirmed · block N"**, landing on **"✅ 8/8 confirmed live on Arc Testnet"** + the repo URL. (You may
  even do the real read-only RPC at render time, or hardcode the committed block numbers — both are honest.)

## 4) Use EXACTLY this on-chain data (matches the committed evidence + `npm run verify` 8/8)
| What | tx | numbers |
|---|---|---|
| BAD → seller bond slashed | `0x58955ae2…` | consensus **5/100** · bond **−0.019** · buyer **+0.02925** · validator V3 slashed **0.01308** |
| GOOD + lying buyer | `0xe313a902…` | **100/100** · seller protected · liar forfeits **0.001** |
| Circle opens bonded market | `0x7c9b913b…` | via Circle contractExecution |
| Circle disputes | `0xf7ea1cbb…` | |
| Circle resolve → refund to Circle wallet | `0xf9dadc5e…` | seller slashed, **0.03079** refunded to the Circle wallet |
| Circle DCW nanopayment | `0x4c6db2f9…` | **0.002** USDC |
| Beginner agent (Claude) pays | `0x478a2402…` | own wallet |
| External independent agent pays | `0xac74ffee…` | own key |

Block numbers (for the badges): slash 48,278,909 · good 48,278,916 · circle-pay 48,241,615 ·
circle-resolve 48,261,172 · circle-open 48,254,126 · circle-dispute 48,254,147 · external 48,234,001 ·
beginner 48,253,629. (Confirm anytime with `npm run verify` or the live dashboard https://ccheh.github.io/bazaar/.)

## 5) Voiceover (no on-camera person)
- **Fast path:** reuse the per-sentence Edge-TTS clips already generated in `build/audio_sent/` — add each as
  an `<audio data-track-index="2">` aligned to its beat's `data-start`.
- **Or** use the `/hyperframes-media` TTS skill to regenerate VO from the DEMO_SCRIPT VO lines.

## 6) Honesty guardrails (KEEP — judges verify; full list in `DEMO_SCRIPT.md`)
- V3 is a **forced** outlier (say so on the validator-slash beat). Circle = open + dispute + resolve (full loop).
- Keep the **scope card** (testnet · validators team-operated · self-funded agents · zero new Solidity).
- Human-readable USDC over the 18-dec wei. Don't claim beyond the 8 verified txs. No face anywhere.

## 7) Finalize
`npx hyperframes render --output ../build/bazaar_demo_hf.mp4` → **stopwatch it: must be < 3:00** (target 2:35–2:45).
A starter composition is in **`demo/hyperframes/composition.html`** — extend it to all 13 beats from `DEMO_SCRIPT.md`.
