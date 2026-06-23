"""
Generate a Bazaar hackathon demo rough cut.

This is an editing pipeline, not an on-chain runner. It reads committed Bazaar
evidence files, optionally captures public Arcscan/dashboard pages, synthesizes
sentence-level voiceover, burns captions into 1080p frames, and exports an MP4.

Network behavior:
  - edge_tts sends only narration text to Microsoft's Edge read-aloud endpoint.
  - optional web capture opens public Arcscan, GitHub Pages, and the public Arc
    Testnet RPC from a fresh Playwright context.
No private keys are read, signed with, or broadcast by this script.

Run from repo root:
  python bazaar/demo/generate_bazaar_demo.py --capture-web

Output:
  bazaar/demo/build/bazaar_demo_roughcut.mp4
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import subprocess
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional

import edge_tts
import imageio_ffmpeg
from moviepy import AudioFileClip
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[2]
BAZAAR = ROOT / "bazaar"
DEMO = BAZAAR / "demo"
BUILD = DEMO / "build"
CAPTURE_DIR = BUILD / "captures"
SLIDE_DIR = BUILD / "slides"
AUDIO_DIR = BUILD / "audio"
SENT_DIR = BUILD / "audio_sent"
SEGMENT_DIR = BUILD / "segments"

W, H = 1920, 1080
FPS = 30
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

VOICE = "en-US-AndrewMultilingualNeural"
RATE = "+4%"
VOLUME = "+0%"

BG = (10, 12, 15)
PANEL = (18, 21, 26)
PANEL_2 = (27, 31, 38)
TEXT = (234, 238, 242)
MUTED = (146, 156, 170)
DIM = (83, 91, 105)
GREEN = (68, 199, 117)
RED = (238, 82, 82)
AMBER = (247, 168, 52)
BLUE = (83, 176, 255)


TX = {
    "slash": "0x58955ae21a4392721d59b75c8a144874b5457e1ff8b57013fb08bdb1cec9bafb",
    "liar": "0xe313a9024fcd58b3debcdfb1955f1b6b3bc4eb9727ce6f278b4c1af0b93a64d3",
    "circle_open": "0x7c9b913b8b98e0234c07a50210e70368f5d76bb3ff218274648ffd98b216330f",
    "circle_dispute": "0xf7ea1cbb0ad4111a384e58d936782207b826a38beba4678a8cde36d1e43f4cd0",
    "circle_resolve": "0xf9dadc5ea3babacb618ea7a4e4548692d9d8832b2705d2d192467161c3055ee3",
    "circle_pay": "0x4c6db2f95bcec0ff88a7578dda06228776527e5cd488a14a295b879c597c094f",
    "beginner": "0x478a24023ea97b276b3c811e63efb18074a4009dfca7a01a550b915b6bd43803",
    "external": "0xac74ffeebb45f9760018916fb03196915184a075ed77b800a9218ad92cb4799a",
}


def mkdirs() -> None:
    for path in (BUILD, CAPTURE_DIR, SLIDE_DIR, AUDIO_DIR, SENT_DIR, SEGMENT_DIR):
        path.mkdir(parents=True, exist_ok=True)


def font_path(*names: str) -> Optional[str]:
    base = Path(r"C:\Windows\Fonts")
    for name in names:
        p = base / name
        if p.exists():
            return str(p)
    return None


FONTS = {
    "title": font_path("segoeuib.ttf", "arialbd.ttf", "calibrib.ttf"),
    "body": font_path("segoeui.ttf", "arial.ttf", "calibri.ttf"),
    "semi": font_path("seguisb.ttf", "arialbd.ttf", "calibrib.ttf"),
    "mono": font_path("consola.ttf", "cour.ttf"),
}


def f(kind: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    p = FONTS.get(kind)
    if p:
        return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def short_tx(tx: str, left: int = 10, right: int = 6) -> str:
    return f"{tx[:left]}...{tx[-right:]}"


def read_json(name: str) -> dict:
    p = BAZAAR / name
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def scene_sentences(items: Iterable[str], pause: int = 260) -> list[tuple[str, int]]:
    return [(s, pause) for s in items]


@dataclass(frozen=True)
class Scene:
    idx: int
    slug: str
    top: str
    caption: str
    chip: str
    accent: tuple[int, int, int]
    voice: list[tuple[str, int]]
    visual: Callable[[ImageDraw.ImageDraw, Image.Image, "Scene"], None]


def text_size(d: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    box = d.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def draw_wrapped(
    d: ImageDraw.ImageDraw,
    text: str,
    xy: tuple[int, int],
    max_w: int,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int] = TEXT,
    line_gap: int = 8,
    max_lines: Optional[int] = None,
) -> int:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for word in words:
        test = f"{cur} {word}".strip()
        if text_size(d, test, font)[0] <= max_w or not cur:
            cur = test
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    if max_lines is not None:
        lines = lines[:max_lines]
    x, y = xy
    h = 0
    for line in lines:
        d.text((x, y + h), line, font=font, fill=fill)
        h += text_size(d, line, font)[1] + line_gap
    return h


def rounded_panel(
    d: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    fill: tuple[int, int, int] = PANEL,
    outline: tuple[int, int, int] = (45, 52, 62),
    width: int = 2,
    radius: int = 14,
) -> None:
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def paste_cover(base: Image.Image, src: Image.Image, box: tuple[int, int, int, int], opacity: float = 1.0) -> None:
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    img = ImageOps.exif_transpose(src.convert("RGB"))
    iw, ih = img.size
    scale = max(bw / iw, bh / ih)
    nw, nh = math.ceil(iw * scale), math.ceil(ih * scale)
    img = img.resize((nw, nh), Image.Resampling.LANCZOS)
    img = img.crop(((nw - bw) // 2, (nh - bh) // 2, (nw + bw) // 2, (nh + bh) // 2))
    if opacity < 1:
        blended = Image.blend(Image.new("RGB", img.size, BG), img, opacity)
        img = blended
    base.paste(img, (x1, y1))


def paste_contain(base: Image.Image, src: Image.Image, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    img = ImageOps.exif_transpose(src.convert("RGB"))
    img.thumbnail((bw, bh), Image.Resampling.LANCZOS)
    px = x1 + (bw - img.size[0]) // 2
    py = y1 + (bh - img.size[1]) // 2
    base.paste(img, (px, py))


def new_canvas() -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    for x in range(0, W, 48):
        d.line([(x, 0), (x, H)], fill=(13, 16, 20), width=1)
    for y in range(0, H, 48):
        d.line([(0, y), (W, y)], fill=(13, 16, 20), width=1)
    return img


def draw_chrome(d: ImageDraw.ImageDraw, scene: Scene) -> None:
    d.rectangle((0, 0, W, 74), fill=(8, 10, 13))
    d.line((0, 74, W, 74), fill=(40, 47, 57), width=2)
    d.rounded_rectangle((40, 18, 174, 56), radius=10, fill=scene.accent)
    d.text((68, 27), "BAZAAR", font=f("semi", 19), fill=(5, 6, 8))
    d.text((204, 24), scene.top, font=f("mono", 24), fill=TEXT)
    d.text((W - 300, 25), "Arc Testnet | chain 5042002", font=f("mono", 18), fill=MUTED)

    chip_text = scene.chip
    chip_font = f("mono", 22)
    tw, th = text_size(d, chip_text, chip_font)
    x1, y1, x2, y2 = 40, H - 82, 70 + tw, H - 28
    d.rounded_rectangle((x1, y1, x2, y2), radius=10, fill=(8, 10, 13), outline=scene.accent, width=2)
    d.text((x1 + 16, y1 + 15), chip_text, font=chip_font, fill=TEXT)

    cap_font = f("semi", 26)
    cap_w, cap_h = text_size(d, scene.caption, cap_font)
    d.rounded_rectangle((W - cap_w - 70, H - 84, W - 40, H - 27), radius=10, fill=(8, 10, 13), outline=(43, 50, 60), width=2)
    d.text((W - cap_w - 54, H - 69), scene.caption, font=cap_font, fill=scene.accent)


def draw_stamp(d: ImageDraw.ImageDraw, text: str, xy: tuple[int, int], color: tuple[int, int, int], angle: int = -8) -> None:
    stamp = Image.new("RGBA", (520, 150), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stamp)
    sd.rounded_rectangle((8, 22, 512, 128), radius=12, outline=color + (230,), width=7)
    sd.text((42, 54), text, font=f("title", 44), fill=color + (245,))
    stamp = stamp.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
    # The caller's draw object does not expose the base image, so this helper is
    # kept for future alpha overlays. Current slides draw stamps inline.
    _ = (d, xy, stamp)


def load_capture(name: str) -> Optional[Image.Image]:
    p = CAPTURE_DIR / f"{name}.png"
    if p.exists():
        try:
            return Image.open(p).convert("RGB")
        except Exception:
            return None
    return None


def draw_arcscan_fallback(d: ImageDraw.ImageDraw, img: Image.Image, title: str, tx: str, color: tuple[int, int, int]) -> None:
    rounded_panel(d, (90, 128, W - 90, 820), fill=(247, 248, 250), outline=(52, 58, 66), radius=12)
    d.rounded_rectangle((130, 164, W - 130, 224), radius=10, fill=(237, 240, 244), outline=(210, 216, 225))
    d.text((156, 181), f"testnet.arcscan.app/tx/{tx}", font=f("mono", 22), fill=(46, 52, 60))
    d.rounded_rectangle((W - 650, 176, W - 132, 220), radius=10, fill=(255, 243, 191), outline=(232, 89, 12), width=2)
    d.text((W - 628, 188), "PLACEHOLDER - live Arcscan capture needed", font=f("mono", 18), fill=(173, 74, 0))
    d.text((130, 270), "Transaction Details", font=f("title", 42), fill=(20, 23, 28))
    d.rounded_rectangle((130, 345, 430, 402), radius=28, fill=(224, 247, 232), outline=(116, 214, 146), width=2)
    d.text((166, 360), "Status: Success", font=f("semi", 26), fill=(23, 117, 58))
    rows = [
        ("Hash", tx),
        ("Network", "Arc Testnet (5042002)"),
        ("USDC movement", title),
        ("Block", "confirmed on chain"),
    ]
    y = 460
    for label, value in rows:
        d.text((140, y), label, font=f("semi", 24), fill=(78, 86, 99))
        d.text((430, y), value, font=f("mono", 22), fill=(28, 33, 40))
        y += 70
    d.rounded_rectangle((W - 640, 640, W - 180, 742), radius=12, outline=color, width=5)
    d.text((W - 602, 670), "ON-CHAIN RECEIPT", font=f("title", 34), fill=color)


def visual_arcscan_slash(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    cap = load_capture("arcscan_slash")
    if cap:
        paste_cover(img, cap, (0, 74, W, H), opacity=0.62)
        d.rectangle((0, 74, W, H), fill=(0, 0, 0, 90))
    else:
        draw_arcscan_fallback(
            d,
            img,
            "seller bond -0.019 USDC -> buyer +0.02925 USDC",
            TX["slash"],
            RED,
        )
    d.rounded_rectangle((102, 820, 1170, 944), radius=14, fill=(16, 18, 22), outline=RED, width=3)
    d.text((132, 842), "BOND SLASHED", font=f("title", 54), fill=RED)
    d.text((132, 905), "refund = 0.019 slashed bond + ~0.0103 escrow/dispute = 0.02925 USDC", font=f("mono", 28), fill=TEXT)


def visual_title(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    d.text((110, 166), "BAZAAR", font=f("title", 132), fill=TEXT)
    d.text((120, 303), "proof-of-quality nanopayments", font=f("semi", 46), fill=AMBER)
    problem = "AI agents need tiny payments and proof the paid work was good."
    draw_wrapped(d, problem, (124, 395), 880, f("body", 42), fill=TEXT, line_gap=14)
    x = 130
    for label, color in [
        ("pay sub-cent USDC", GREEN),
        ("grade the work", BLUE),
        ("bad work = slash", RED),
    ]:
        d.rounded_rectangle((x, 610, x + 470, 720), radius=18, fill=PANEL_2, outline=color, width=3)
        d.text((x + 30, 648), label, font=f("semi", 32), fill=color)
        x += 540
    d.rounded_rectangle((120, 846, 1068, 916), radius=12, fill=(8, 10, 13), outline=(54, 62, 74), width=2)
    d.text((148, 867), "Builder: prior Arc-hackathon winner | MSc Data Science, Sheffield", font=f("mono", 24), fill=MUTED)


def visual_arch_strip(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    labels = [
        ("Arc native USDC", GREEN),
        ("Circle ERC-8004 identity", BLUE),
        ("Circle DCW", BLUE),
        ("CrucibleMarketV7", AMBER),
        ("ScalarResolverV10", AMBER),
    ]
    x, y = 130, 395
    for i, (label, color) in enumerate(labels):
        d.rounded_rectangle((x, y, x + 300, y + 120), radius=18, fill=PANEL_2, outline=color, width=3)
        draw_wrapped(d, label, (x + 26, y + 31), 248, f("semi", 30), color, line_gap=8, max_lines=2)
        if i < len(labels) - 1:
            d.line((x + 315, y + 60, x + 388, y + 60), fill=MUTED, width=4)
            d.polygon([(x + 388, y + 60), (x + 370, y + 48), (x + 370, y + 72)], fill=MUTED)
        x += 365
    d.text((132, 245), "Composed, not reinvented", font=f("title", 72), fill=TEXT)
    d.text((136, 735), "Zero new Solidity in the demo path.", font=f("mono", 32), fill=MUTED)


def draw_terminal(d: ImageDraw.ImageDraw, box: tuple[int, int, int, int], title: str, lines: list[str], accent: tuple[int, int, int]) -> None:
    x1, y1, x2, y2 = box
    rounded_panel(d, box, fill=(7, 9, 12), outline=(50, 58, 70), radius=16)
    d.rounded_rectangle((x1, y1, x2, y1 + 58), radius=16, fill=(20, 24, 30), outline=(50, 58, 70), width=2)
    for i, c in enumerate([(255, 96, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse((x1 + 24 + i * 30, y1 + 20, x1 + 40 + i * 30, y1 + 36), fill=c)
    d.text((x1 + 130, y1 + 18), title, font=f("mono", 22), fill=MUTED)
    y = y1 + 88
    for raw in lines:
        color = TEXT
        if "SLASH" in raw or "0/100" in raw:
            color = RED
        if "100/100" in raw or "COMPLETE" in raw or "PASS" in raw:
            color = GREEN
        if "forced" in raw or "commit window" in raw or "sped-up" in raw:
            color = AMBER
        wrapped = textwrap.wrap(raw, width=92)
        for line in wrapped[:2]:
            d.text((x1 + 34, y), line, font=f("mono", 24), fill=color)
            y += 34
        y += 5
        if y > y2 - 45:
            break
    d.rounded_rectangle((x2 - 210, y2 - 58, x2 - 28, y2 - 20), radius=9, fill=(20, 24, 30), outline=accent, width=2)
    d.text((x2 - 194, y2 - 49), "sped-up", font=f("mono", 20), fill=accent)


def visual_trustless_log(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    lines = [
        "$ npm run trustless",
        "[BAD] opening market (escrow 0.01000, seller bond 0.02000)",
        "[GOOD] opening market (escrow 0.01000, seller bond 0.02000)",
        "[BAD] V1 committed 5/100 via llm:deepseek-v4-pro",
        "[BAD] V2 committed 0/100 via llm:deepseek-v4-flash",
        "[BAD] V3 committed 90/100 via forced-outlier",
        "commit window: 30 min, reveal window: 30 min (real windows)",
    ]
    draw_terminal(d, (96, 136, 1280, 820), "npm run trustless", lines, AMBER)
    d.rounded_rectangle((1330, 168, 1812, 358), radius=18, fill=PANEL_2, outline=GREEN, width=3)
    d.text((1360, 198), "seller", font=f("mono", 28), fill=MUTED)
    d.text((1360, 244), "stakes bond", font=f("semi", 44), fill=GREEN)
    d.rounded_rectangle((1330, 408, 1812, 598), radius=18, fill=PANEL_2, outline=BLUE, width=3)
    d.text((1360, 438), "buyer", font=f("mono", 28), fill=MUTED)
    d.text((1360, 484), "can dispute", font=f("semi", 44), fill=BLUE)
    d.rounded_rectangle((1330, 648, 1812, 838), radius=18, fill=PANEL_2, outline=AMBER, width=3)
    d.text((1360, 678), "validators", font=f("mono", 28), fill=MUTED)
    d.text((1360, 724), "stake + score", font=f("semi", 42), fill=AMBER)


def visual_core_architecture(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    cap = load_capture("architecture")
    if cap:
        rounded_panel(d, (80, 118, 1210, 890), fill=(255, 255, 255), outline=AMBER, width=4)
        paste_contain(img, cap, (105, 143, 1185, 865))
    else:
        rounded_panel(d, (100, 140, 1220, 850), fill=(247, 248, 250), outline=AMBER, width=4)
        d.text((160, 194), "THE CORE INNOVATION", font=f("title", 54), fill=(218, 88, 12))
        steps = [
            "independent staked validators",
            "commit then reveal",
            "median score",
            "operator-free slash",
        ]
        x, y = 165, 360
        for s in steps:
            d.rounded_rectangle((x, y, x + 235, y + 150), radius=16, fill=(255, 243, 191), outline=(232, 89, 12), width=3)
            draw_wrapped(d, s, (x + 22, y + 42), 190, f("semi", 26), fill=(17, 20, 24), line_gap=6)
            x += 260
    d.rounded_rectangle((1270, 206, 1812, 790), radius=18, fill=(14, 16, 20), outline=AMBER, width=3)
    d.text((1310, 246), "Plain English", font=f("title", 44), fill=AMBER)
    draw_wrapped(d, "A hidden vote becomes a public score. The score moves money. The operator never sets it.", (1310, 332), 440, f("body", 34), fill=TEXT, line_gap=14)
    d.rounded_rectangle((1310, 628, 1760, 710), radius=12, fill=PANEL_2, outline=AMBER, width=2)
    d.text((1338, 654), "commit-reveal -> median", font=f("mono", 28), fill=AMBER)


def visual_bad_result(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    draw_terminal(
        d,
        (90, 132, 1140, 822),
        "TRUSTLESS RESULT",
        [
            "BAD CONSENSUS: 5/100",
            "seller bond slashed: 0.019 USDC",
            "buyer refund: 0.02925 USDC",
            f"proof: {short_tx(TX['slash'], 14, 8)}",
            "No platform held the money.",
            "No operator typed the score.",
        ],
        RED,
    )
    cap = load_capture("arcscan_slash")
    if cap:
        rounded_panel(d, (1190, 160, 1818, 776), fill=(247, 248, 250), outline=GREEN, width=3)
        paste_cover(img, cap, (1210, 180, 1798, 756), opacity=0.9)
    else:
        d.rounded_rectangle((1210, 220, 1780, 700), radius=16, fill=PANEL_2, outline=GREEN, width=3)
        d.text((1260, 310), "Arcscan receipt", font=f("title", 48), fill=TEXT)
        d.text((1260, 384), "Status: Success", font=f("semi", 36), fill=GREEN)
        d.text((1260, 458), short_tx(TX["slash"], 16, 10), font=f("mono", 28), fill=MUTED)
    d.rounded_rectangle((1235, 805, 1770, 890), radius=12, fill=(8, 10, 13), outline=GREEN, width=3)
    d.text((1266, 831), "truth-stamp after receipt resolves", font=f("mono", 26), fill=GREEN)


def visual_twist(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    d.text((142, 258), "But what if the", font=f("title", 72), fill=TEXT)
    d.text((142, 350), "BUYER", font=f("title", 134), fill=AMBER)
    d.text((596, 398), "is the cheater?", font=f("title", 72), fill=TEXT)
    d.rounded_rectangle((142, 610, 1610, 742), radius=18, fill=PANEL_2, outline=AMBER, width=3)
    d.text((182, 650), "A buyer disputes GOOD work to dodge paying.", font=f("semi", 42), fill=TEXT)


def visual_good_liar(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    d.rounded_rectangle((92, 136, 900, 820), radius=18, fill=PANEL_2, outline=GREEN, width=3)
    d.text((130, 180), "GOOD delivery", font=f("title", 52), fill=GREEN)
    bullets = [
        "consensus: 100/100",
        "seller bond slashed: 0",
        "lying buyer forfeits: 0.001 USDC",
        "assertion: liar cannot slash honest seller",
    ]
    y = 300
    for b in bullets:
        d.text((150, y), b, font=f("mono", 32), fill=TEXT if "100" not in b else GREEN)
        y += 78
    cap = load_capture("arcscan_liar")
    if cap:
        paste_cover(img, cap, (960, 150, 1818, 820), opacity=0.78)
    else:
        draw_arcscan_fallback(d, img, "liar forfeits dispute bond to seller", TX["liar"], GREEN)
        d.rectangle((0, 120, 930, 860), fill=BG)
    d.rounded_rectangle((1015, 804, 1770, 890), radius=12, fill=(8, 10, 13), outline=GREEN, width=3)
    d.text((1045, 830), f"confirmed: {short_tx(TX['liar'], 14, 8)}", font=f("mono", 28), fill=GREEN)


def visual_validator_slash(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    d.rounded_rectangle((96, 140, 1822, 348), radius=18, fill=PANEL_2, outline=AMBER, width=3)
    d.text((132, 178), "Validator accountability", font=f("title", 58), fill=AMBER)
    d.text((132, 258), "V3 is deliberately forced off-consensus to demo the slash path.", font=f("mono", 30), fill=TEXT)
    rows = [
        ("V1", "5/100", "live model", GREEN),
        ("V2", "0/100", "live model", GREEN),
        ("V3", "90/100", "forced outlier", RED),
    ]
    x = 145
    for name, score, note, color in rows:
        d.rounded_rectangle((x, 470, x + 500, 710), radius=18, fill=(7, 9, 12), outline=color, width=3)
        d.text((x + 34, 508), name, font=f("title", 64), fill=color)
        d.text((x + 34, 600), score, font=f("mono", 48), fill=TEXT)
        d.text((x + 34, 666), note, font=f("mono", 24), fill=MUTED)
        x += 570
    d.rounded_rectangle((438, 790, 1480, 888), radius=16, fill=(8, 10, 13), outline=RED, width=4)
    d.text((476, 818), "chain slash: validator 0x468Ac1 loses 0.01308 USDC", font=f("semi", 34), fill=RED)


def visual_circle_trustless(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    lines = [
        "$ npm run circle:trustless",
        "agent = Circle DCW 0x9608...2a2",
        f"open COMPLETE {short_tx(TX['circle_open'], 12, 6)}",
        f"dispute COMPLETE {short_tx(TX['circle_dispute'], 12, 6)}",
        "V1 pro | V2 flash | V3 chat",
        "Circle signs + broadcasts; Bazaar never holds the key",
        "resolution lands after commit/reveal windows",
    ]
    draw_terminal(d, (96, 136, 1260, 840), "Circle through bonded rail", lines, BLUE)
    d.rounded_rectangle((1315, 180, 1815, 365), radius=18, fill=PANEL_2, outline=BLUE, width=3)
    d.text((1350, 220), "Circle role", font=f("mono", 28), fill=MUTED)
    d.text((1350, 270), "OPEN + DISPUTE", font=f("semi", 40), fill=BLUE)
    d.rounded_rectangle((1315, 455, 1815, 640), radius=18, fill=PANEL_2, outline=GREEN, width=3)
    d.text((1350, 496), "keys", font=f("mono", 28), fill=MUTED)
    d.text((1350, 546), "never held here", font=f("semi", 40), fill=GREEN)


def visual_montage(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    cards = [
        ("Circle pay", "+0.002 USDC", TX["circle_pay"], GREEN),
        ("Beginner agent", "Claude reasons, then pays", TX["beginner"], BLUE),
        ("External agent", "separate key pays seller", TX["external"], AMBER),
    ]
    x = 92
    for title, detail, tx, color in cards:
        d.rounded_rectangle((x, 180, x + 540, 820), radius=18, fill=PANEL_2, outline=color, width=3)
        d.text((x + 34, 226), title, font=f("title", 42), fill=color)
        draw_wrapped(d, detail, (x + 36, 306), 455, f("semi", 34), fill=TEXT, line_gap=12)
        d.rounded_rectangle((x + 36, 536, x + 500, 612), radius=12, fill=(8, 10, 13), outline=(52, 60, 72), width=2)
        d.text((x + 58, 560), short_tx(tx, 14, 8), font=f("mono", 26), fill=MUTED)
        d.rounded_rectangle((x + 36, 676, x + 500, 748), radius=12, fill=(8, 10, 13), outline=GREEN, width=2)
        d.text((x + 58, 697), "Arcscan: Success", font=f("mono", 26), fill=GREEN)
        x += 615


def visual_honest_scope(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    d.text((118, 146), "HONEST SCOPE", font=f("title", 74), fill=TEXT)
    d.line((120, 242, 650, 242), fill=AMBER, width=5)
    lines = [
        ("Testnet only.", TEXT),
        ("Validators use distinct models and distinct keys.", TEXT),
        ("They are TEAM-OPERATED today.", AMBER),
        ("Mechanism is permissionless; outside validator set is the open gap.", TEXT),
        ("External and beginner agents are independently keyed but self-funded.", TEXT),
        ("Reused contracts. Zero new Solidity.", TEXT),
    ]
    y = 332
    for line, color in lines:
        d.text((136, y), line, font=f("semi", 38), fill=color)
        y += 82
    d.rounded_rectangle((126, 850, 1465, 925), radius=12, fill=(8, 10, 13), outline=(54, 62, 74), width=2)
    d.text((156, 872), "No music swell here. This card should read sober.", font=f("mono", 26), fill=MUTED)


def visual_dashboard(d: ImageDraw.ImageDraw, img: Image.Image, scene: Scene) -> None:
    cap = load_capture("dashboard")
    if cap:
        paste_cover(img, cap, (60, 100, 1860, 836), opacity=0.9)
        d.rectangle((60, 100, 1860, 836), outline=GREEN, width=4)
    else:
        rounded_panel(d, (92, 128, 1828, 810), fill=PANEL, outline=GREEN, width=3, radius=18)
        d.text((135, 170), "Bazaar - on-chain evidence", font=f("title", 52), fill=TEXT)
        d.text((135, 240), "Read-only browser check against Arc Testnet", font=f("mono", 28), fill=MUTED)
        d.rounded_rectangle((1040, 156, 1760, 210), radius=10, fill=(255, 243, 191), outline=AMBER, width=2)
        d.text((1064, 173), "ROUGH CUT PLACEHOLDER - replace with live dashboard capture", font=f("mono", 20), fill=AMBER)
        txs = [
            "bad delivery -> seller bond slashed",
            "good delivery + lying buyer",
            "Circle opens bonded market",
            "Circle disputes",
            "Circle resolve + refund",
            "Circle sub-cent payment",
            "beginner pays",
            "external agent pays",
        ]
        y = 325
        for i, label in enumerate(txs, start=1):
            x = 135 if i <= 4 else 990
            yy = y + ((i - 1) % 4) * 98
            d.rounded_rectangle((x, yy, x + 750, yy + 68), radius=12, fill=PANEL_2, outline=(50, 58, 70), width=2)
            d.text((x + 24, yy + 19), label, font=f("mono", 24), fill=TEXT)
            d.text((x + 550, yy + 19), "confirmed", font=f("mono", 24), fill=GREEN)
    d.rounded_rectangle((336, 844, 1584, 940), radius=18, fill=(8, 10, 13), outline=GREEN, width=4)
    d.text((388, 874), "8/8 confirmed live on Arc Testnet", font=f("title", 42), fill=GREEN)
    d.text((388, 938), "ccheh.github.io/bazaar | github.com/Ccheh/bazaar", font=f("mono", 24), fill=MUTED)


SCENES = [
    Scene(
        1,
        "real-slash",
        "REAL ON-CHAIN SLASH",
        "refund = 0.019 bond + ~0.0103 = 0.02925",
        f"tx {short_tx(TX['slash'])}",
        RED,
        scene_sentences(
            [
                "This is a real transaction on Arc.",
                "A seller just lost its USDC bond for bad AI work.",
                "Nobody at our company decided that.",
                "The chain did.",
            ],
            260,
        ),
        visual_arcscan_slash,
    ),
    Scene(
        2,
        "title",
        "ACCOUNTABILITY FOR AGENT-TO-AGENT AI",
        "Bazaar accountability layer",
        "screen + voice only",
        AMBER,
        scene_sentences(
            [
                "As AI agents hire each other, two things are missing.",
                "Tiny payments, and proof the paid work was good.",
                "Bazaar is that accountability layer on Arc.",
            ],
            230,
        ),
        visual_title,
    ),
    Scene(
        3,
        "composed",
        "BUILT ON ARC + CIRCLE + REUSED CONTRACTS",
        "zero new Solidity",
        "architecture strip",
        GREEN,
        scene_sentences(
            [
                "It is composed, not reinvented.",
                "Circle identity, Circle wallets, and deployed contracts live on Arc.",
                "Zero new Solidity.",
            ],
            220,
        ),
        visual_arch_strip,
    ),
    Scene(
        4,
        "mechanism",
        "STAKED VALIDATORS SCORE THE WORK",
        "npm run trustless",
        "real logs, sped-up",
        AMBER,
        scene_sentences(
            [
                "Here is the mechanism.",
                "A seller stakes a bond and does real work.",
                "A buyer can dispute.",
                "Independent validators stake their own USDC and score the delivery.",
            ],
            230,
        ),
        visual_trustless_log,
    ),
    Scene(
        5,
        "commit-reveal",
        "THE CORE INNOVATION",
        "commit-reveal then median",
        "CORE box",
        AMBER,
        scene_sentences(
            [
                "Validators commit a hidden score, then reveal it.",
                "The median payout means one biased vote cannot swing the money.",
                "This is time-compressed; the protocol windows are real.",
            ],
            230,
        ),
        visual_core_architecture,
    ),
    Scene(
        6,
        "bad-result",
        "BAD DELIVERY -> SLASHED",
        "5/100 -> seller bond slashed",
        f"tx {short_tx(TX['slash'])}",
        RED,
        scene_sentences(
            [
                "On the bad delivery, consensus lands at zero.",
                "The contract slashes the seller bond and refunds the buyer.",
                "No platform held the money.",
                "No operator typed the score.",
            ],
            220,
        ),
        visual_bad_result,
    ),
    Scene(
        7,
        "twist",
        "THE TWIST",
        "what if the buyer lies?",
        "amber twist",
        AMBER,
        scene_sentences(
            [
                "Now the attack almost nobody demos.",
                "What if the buyer lies, and disputes good work just to avoid paying?",
            ],
            260,
        ),
        visual_twist,
    ),
    Scene(
        8,
        "good-liar",
        "GOOD WORK + LYING BUYER",
        "100/100 -> liar forfeits 0.001",
        f"tx {short_tx(TX['liar'])}",
        GREEN,
        scene_sentences(
            [
                "The validators read the actual work and agree it is a hundred out of a hundred.",
                "The seller stays protected.",
                "The lying buyer forfeits its dispute bond to that seller.",
            ],
            230,
        ),
        visual_good_liar,
    ),
    Scene(
        9,
        "validator-slash",
        "VALIDATOR ACCOUNTABILITY",
        "V3 forced outlier, demo path",
        "slash 0.01308 USDC",
        RED,
        scene_sentences(
            [
                "Validators are accountable too.",
                "We force one off consensus to show the path.",
                "The chain slashes it, point eight eight cents.",
                "The all-live three-model run is separate.",
            ],
            220,
        ),
        visual_validator_slash,
    ),
    Scene(
        10,
        "circle-trustless",
        "CIRCLE THROUGH THE BONDED RAIL",
        "Circle DCW opens + disputes",
        f"{short_tx(TX['circle_open'])} / {short_tx(TX['circle_dispute'])}",
        BLUE,
        scene_sentences(
            [
                "Circle is not bolted on.",
                "A Circle wallet opens and disputes the market through Circle's execution API.",
                "Circle signs and broadcasts; Bazaar never holds the key.",
            ],
            220,
        ),
        visual_circle_trustless,
    ),
    Scene(
        11,
        "montage",
        "BEYOND THE BOND",
        "Circle, beginner, external",
        f"{short_tx(TX['circle_pay'])} / {short_tx(TX['beginner'])} / {short_tx(TX['external'])}",
        GREEN,
        scene_sentences(
            [
                "Beyond the bond, a Circle wallet pays a seller.",
                "A Claude-powered newcomer chooses and pays on chain.",
                "A separately keyed external agent pays too.",
            ],
            220,
        ),
        visual_montage,
    ),
    Scene(
        12,
        "honest-scope",
        "HONEST SCOPE",
        "testnet, team-operated for now",
        "no music swell",
        AMBER,
        scene_sentences(
            [
                "We would rather under claim.",
                "This is testnet.",
                "Validators use distinct models and keys, but are team-operated today.",
                "The mechanism is permissionless; outside validators are the open gap.",
            ],
            230,
        ),
        visual_honest_scope,
    ),
    Scene(
        13,
        "dashboard",
        "VERIFY, DON'T TRUST",
        "8/8 confirmed live",
        "ccheh.github.io/bazaar",
        GREEN,
        [
            ("You do not have to trust any of this.", 230),
            ("Open the dashboard: your browser confirms all eight transactions live on Arc.", 230),
            ("Or run one command.", 230),
            ("Clone the repo and check it yourself.", 230),
            ("That is Bazaar: the chain, not the platform, has the final word.", 5600),
        ],
        visual_dashboard,
    ),
]


async def capture_web_assets() -> None:
    from playwright.async_api import async_playwright

    targets = [
        ("arcscan_slash", f"https://testnet.arcscan.app/tx/{TX['slash']}", 5000),
        ("arcscan_liar", f"https://testnet.arcscan.app/tx/{TX['liar']}", 5000),
        ("dashboard", "https://ccheh.github.io/bazaar/", 9000),
    ]
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=1)
        page = await context.new_page()

        svg = DEMO / "architecture.svg"
        if svg.exists():
            try:
                await page.goto(svg.as_uri(), wait_until="domcontentloaded", timeout=20000)
                await page.screenshot(path=str(CAPTURE_DIR / "architecture.png"), full_page=True)
                print("captured architecture.svg")
            except Exception as e:
                print(f"architecture capture skipped: {e}")

        for name, url, wait_ms in targets:
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=35000)
                await page.wait_for_timeout(wait_ms)
                if name == "dashboard":
                    try:
                        await page.wait_for_selector("text=confirmed", timeout=6000)
                    except Exception:
                        pass
                await page.screenshot(path=str(CAPTURE_DIR / f"{name}.png"), full_page=False)
                print(f"captured {name}: {url}")
            except Exception as e:
                print(f"web capture skipped for {name}: {e}")
        await browser.close()


async def synth_one(text: str, out_path: Path) -> None:
    comm = edge_tts.Communicate(text, VOICE, rate=RATE, volume=VOLUME)
    await comm.save(str(out_path))


async def synth_all(force: bool = False) -> None:
    total = sum(len(scene.voice) for scene in SCENES)
    count = 0
    for scene in SCENES:
        for sent_idx, (text, _) in enumerate(scene.voice, start=1):
            count += 1
            out = SENT_DIR / f"scene{scene.idx:02d}_sent{sent_idx:02d}.mp3"
            if out.exists() and out.stat().st_size > 1000 and not force:
                print(f"audio cached [{count}/{total}] scene {scene.idx}.{sent_idx}")
                continue
            print(f"synth [{count}/{total}] scene {scene.idx}.{sent_idx}: {text[:64]}")
            await synth_one(text, out)


def silence_file(ms: int) -> Path:
    out = AUDIO_DIR / "silence" / f"silence_{ms}ms.mp3"
    out.parent.mkdir(exist_ok=True)
    if not out.exists():
        subprocess.run(
            [
                FFMPEG,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=channel_layout=mono:sample_rate=44100",
                "-t",
                f"{ms / 1000:.3f}",
                "-q:a",
                "9",
                str(out),
            ],
            capture_output=True,
            check=True,
        )
    return out


def build_scene_audio(scene: Scene) -> Path:
    inputs: list[str] = []
    refs: list[str] = []
    n = 0
    for sent_idx, (_, pause_ms) in enumerate(scene.voice, start=1):
        sent = SENT_DIR / f"scene{scene.idx:02d}_sent{sent_idx:02d}.mp3"
        inputs += ["-i", str(sent)]
        refs.append(f"[{n}:a]")
        n += 1
        if pause_ms:
            sil = silence_file(pause_ms)
            inputs += ["-i", str(sil)]
            refs.append(f"[{n}:a]")
            n += 1
    out = AUDIO_DIR / f"scene_{scene.idx:02d}.mp3"
    concat = "".join(refs) + f"concat=n={n}:v=0:a=1[out]"
    subprocess.run(
        [FFMPEG, "-y", *inputs, "-filter_complex", concat, "-map", "[out]", "-b:a", "128k", str(out)],
        capture_output=True,
        check=True,
    )
    return out


def render_scene(scene: Scene) -> Path:
    img = new_canvas()
    d = ImageDraw.Draw(img)
    scene.visual(d, img, scene)
    draw_chrome(d, scene)
    out = SLIDE_DIR / f"scene_{scene.idx:02d}_{scene.slug}.png"
    img.save(out)
    return out


def write_narration_file() -> None:
    out = BUILD / "narration_script.txt"
    lines = [
        "Bazaar demo narration",
        f"Voice: {VOICE}, rate {RATE}",
        "",
    ]
    for scene in SCENES:
        lines.append(f"{scene.idx:02d}. {scene.slug}")
        for text, pause in scene.voice:
            lines.append(f"  {text} [{pause}ms]")
        lines.append("")
    out.write_text("\n".join(lines), encoding="utf-8")


def encode_segment(scene: Scene, slide: Path, audio_path: Path, duration: float) -> Path:
    out = SEGMENT_DIR / f"scene_{scene.idx:02d}.mp4"
    subprocess.run(
        [
            FFMPEG,
            "-y",
            "-loop",
            "1",
            "-framerate",
            str(FPS),
            "-i",
            str(slide),
            "-i",
            str(audio_path),
            "-t",
            f"{duration:.3f}",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "stillimage",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(out),
        ],
        capture_output=True,
        check=True,
    )
    return out


def compose_video() -> Path:
    segments: list[Path] = []
    total = 0.0
    for scene in SCENES:
        slide = render_scene(scene)
        audio_path = build_scene_audio(scene)
        audio = AudioFileClip(str(audio_path))
        dur = audio.duration
        audio.close()
        total += dur
        segment = encode_segment(scene, slide, audio_path, dur)
        segments.append(segment)
        print(f"scene {scene.idx:02d}: {dur:.2f}s")

    print(f"total duration: {total:.2f}s ({total / 60:.2f} min)")
    concat_list = BUILD / "concat_segments.txt"
    concat_list.write_text(
        "\n".join(f"file 'segments/{p.name}'" for p in segments) + "\n",
        encoding="utf-8",
    )
    out = BUILD / "bazaar_demo.mp4"
    subprocess.run(
        [
            FFMPEG,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(out),
        ],
        capture_output=True,
        check=True,
    )
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture-web", action="store_true", help="Capture public Arcscan/dashboard screenshots before rendering.")
    parser.add_argument("--force-tts", action="store_true", help="Regenerate cached sentence audio.")
    parser.add_argument("--skip-tts", action="store_true", help="Reuse existing sentence audio.")
    args = parser.parse_args()

    mkdirs()
    write_narration_file()

    if args.capture_web:
        asyncio.run(capture_web_assets())

    if not args.skip_tts:
        asyncio.run(synth_all(force=args.force_tts))

    out = compose_video()
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
