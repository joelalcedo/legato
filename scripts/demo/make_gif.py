"""Render the README demo GIF from typed commands and their captured output.

Usage: python3 scripts/demo/make_gif.py scripts/demo/demo.json docs/demo.gif

demo.json: {"cols": 96, "rows": 24, "steps": [{"cmd": "legato explain ...", "out_file": "out1.txt", "hold": 3.0}, ...]}
Every output shown is the real output of the command, captured into out_file next to demo.json
(see CONTRIBUTING.md, "Recording the demo"). Needs Pillow and the Menlo font (macOS).
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Menlo.ttc"
SIZE = 15
PAD = 18
BAR = 34
BG = (13, 17, 23)
FG = (201, 209, 217)
DIM = (139, 148, 158)
GREEN = (63, 185, 80)
CYAN = (121, 192, 255)
YELLOW = (210, 153, 34)
RED = (248, 81, 73)


def main(script_path, out_path):
    spec = json.load(open(script_path))
    here = os.path.dirname(os.path.abspath(script_path))
    cols, rows = spec.get("cols", 96), spec.get("rows", 24)
    font = ImageFont.truetype(FONT, SIZE, index=0)
    bold = ImageFont.truetype(FONT, SIZE, index=1)
    cw = font.getbbox("M")[2]
    lh = SIZE + 7
    W, H = PAD * 2 + cols * cw, BAR + PAD * 2 + rows * lh

    frames, durations = [], []
    lines = []  # list of (text, color, font)

    def render():
        im = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(im)
        d.rectangle([0, 0, W, BAR], fill=(22, 27, 34))
        for i, c in enumerate([RED, YELLOW, GREEN]):
            d.ellipse([14 + i * 22, 11, 26 + i * 22, 23], fill=c)
        title = spec.get("title", "legato")
        d.text(((W - d.textlength(title, font=font)) / 2, 8), title, fill=DIM, font=font)
        visible = lines[-rows:]
        for i, (text, color, f) in enumerate(visible):
            d.text((PAD, BAR + PAD + i * lh), text[:cols], fill=color, font=f)
        return im

    def add(frame, ms):
        frames.append(frame)
        durations.append(ms)

    def color_for(line):
        s = line.strip()
        if s.startswith("Arithmetic:"):
            return DIM, font
        if s.startswith("Switch "):
            return CYAN, bold
        if s.startswith(("Stay ", "Keep ")):
            return YELLOW, bold
        return FG, font

    def wrap(ln, extra=4):
        """Wrap at word boundaries, keeping the leading indent; continuation lines go in further."""
        indent = len(ln) - len(ln.lstrip(" "))
        out, cur = [], " " * indent
        for w in ln.lstrip(" ").split(" "):
            if cur.strip() and len(cur) + 1 + len(w) > cols:
                out.append(cur)
                cur = " " * (indent + extra) + w
            else:
                cur = cur + w if not cur.strip() else cur + " " + w
        out.append(cur)
        return out

    add(render(), 600)
    for step in spec["steps"]:
        cmd = step["cmd"]
        typed = ""
        for ch in cmd:
            typed += ch
            lines_backup = list(lines)
            lines.extend((w, GREEN, font) for w in wrap("$ " + typed + "▌", 2))
            add(render(), 28 if ch != " " else 60)
            lines[:] = lines_backup
        lines.extend((w, GREEN, font) for w in wrap("$ " + cmd, 2))
        add(render(), 350)
        out = open(os.path.join(here, step["out_file"])).read().rstrip("\n").split("\n")
        for ln in out:
            color, f = color_for(ln)
            for w in wrap(ln):
                lines.append((w, color, f))
        lines.append(("", FG, font))
        add(render(), int(step.get("hold", 3.0) * 1000))
    add(render(), 2500)

    pal = [f.quantize(colors=64, method=Image.Quantize.MEDIANCUT) for f in frames]
    pal[0].save(out_path, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True)
    print(out_path, len(frames), "frames", W, "x", H)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
