#!/usr/bin/env python3
"""Regenerate every app icon from src-tauri/icons/icon.svg.

Needs Python with Pillow and a Chromium that Playwright can launch (used only to rasterise the SVG).
Small sizes (48 px and below) use thicker strokes so the mark stays readable in the taskbar.

    python3 scripts/make-icons.py
"""
import io
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
SVG = (ICONS / "icon.svg").read_text(encoding="utf-8")
# Thicker strokes for small sizes
SMALL = re.sub(r'stroke-width="6"', 'stroke-width="8"', SVG).replace('stroke-width="6.5"', 'stroke-width="9"')

RENDER = r"""
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const fs = require("fs");
(async () => {
  const [svgFile, out, size] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +size, height: +size }, deviceScaleFactor: 1 });
  const svg = fs.readFileSync(svgFile, "utf8").replace("<svg ", `<svg width="${size}" height="${size}" `);
  await p.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
  await p.screenshot({ path: out, omitBackground: true });
  await b.close();
})();
"""


def render(svg: str, size: int) -> Image.Image:
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "i.svg").write_text(svg, encoding="utf-8")
        (Path(d) / "r.js").write_text(RENDER, encoding="utf-8")
        subprocess.run(["node", str(Path(d) / "r.js"), str(Path(d) / "i.svg"), str(Path(d) / "o.png"), str(size)], check=True)
        return Image.open(io.BytesIO((Path(d) / "o.png").read_bytes())).convert("RGBA")


def icon(size: int) -> Image.Image:
    # Render at 4x and scale down for clean edges
    big = render(SMALL if size <= 48 else SVG, size * 4)
    return big.resize((size, size), Image.LANCZOS)


def main() -> int:
    pngs = {
        "32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512,
        "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107, "Square142x142Logo.png": 142, "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284, "Square310x310Logo.png": 310, "StoreLogo.png": 50,
    }
    for name, size in pngs.items():
        icon(size).save(ICONS / name)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [icon(s) for s in ico_sizes]
    frames[-1].save(ICONS / "icon.ico", format="ICO", append_images=frames[:-1], sizes=[(s, s) for s in ico_sizes])
    icon(1024).save(ICONS / "icon.icns", format="ICNS")
    print("wrote", len(pngs) + 2, "files to", ICONS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
