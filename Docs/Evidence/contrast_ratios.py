"""WCAG 2.x contrast ratios for the design-system tokens in front-end/src/styles.css, in both themes.

Prints one table for the text/background pairs the client actually uses, and one for adjacent non-text
surfaces. Pass/fail thresholds: 4.5:1 for body text, 3:1 for large text (>= 24px, or >= 19px bold) and
for non-text boundaries. Run from the repository root: ``python Docs/Evidence/contrast_ratios.py``.
"""
from __future__ import annotations

import re
from pathlib import Path

STYLES = Path(__file__).resolve().parents[2] / "front-end" / "src" / "styles.css"

# (label, foreground token, background token, threshold)
TEXT_PAIRS = [
    ("body text on page", "--ink", "--surface", 4.5),
    ("body text on raised box", "--ink", "--surface-raised", 4.5),
    ("promise line, intro and sign-in (22px/600; 18px/600 at 720px and below)", "--ink", "--surface", 4.5),
    ("muted text on page", "--ink-muted", "--surface", 4.5),
    ("muted text on raised box", "--ink-muted", "--surface-raised", 4.5),
    ("muted chip text on sunken chip", "--ink-muted", "--surface-sunken", 4.5),
    ("link / accent text on page", "--accent", "--surface", 4.5),
    ("link / accent text on raised box", "--accent", "--surface-raised", 4.5),
    ("ok chip text", "--ok", "--ok-soft", 4.5),
    ("warn chip text", "--warn", "--warn-soft", 4.5),
    ("text on accent-soft (selected row, chat bubble)", "--ink", "--accent-soft", 4.5),
    ("muted text on accent-soft", "--ink-muted", "--accent-soft", 4.5),
    ("button label on accent button", "--surface", "--accent", 4.5),
]
SURFACE_PAIRS = [
    ("raised box on page", "--surface-raised", "--surface", 3.0),
    ("sunken chip on raised box", "--surface-sunken", "--surface-raised", 3.0),
    ("hairline on page", "--line", "--surface", 3.0),
    ("strong line (inputs) on page", "--line-strong", "--surface", 3.0),
]


def tokens(css: str) -> tuple[dict[str, str], dict[str, str]]:
    """Light tokens from ``:root``; dark tokens from the ``prefers-color-scheme: dark`` block."""
    blocks = re.findall(r"\{([^{}]*--surface:[^{}]*)\}", css)
    light = dict(re.findall(r"(--[\w-]+):\s*(#[0-9a-fA-F]{6})", blocks[0]))
    dark = dict(re.findall(r"(--[\w-]+):\s*(#[0-9a-fA-F]{6})", blocks[1]))
    return light, dark


def luminance(hex6: str) -> float:
    def channel(c: int) -> float:
        v = c / 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4

    r, g, b = (int(hex6[i : i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def ratio(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def table(title: str, pairs, light: dict[str, str], dark: dict[str, str]) -> list[str]:
    rows = [f"### {title}", "", "| Pair | Light | Dark | Needs | Result |", "|---|---|---|---|---|"]
    for label, fg, bg, need in pairs:
        rl, rd = ratio(light[fg], light[bg]), ratio(dark[fg], dark[bg])
        ok = "pass" if min(rl, rd) >= need else "FAIL"
        rows.append(f"| {label} (`{fg}` on `{bg}`) | {rl:.2f} | {rd:.2f} | {need} | {ok} |")
    return rows + [""]


def main() -> None:
    light, dark = tokens(STYLES.read_text())
    out = table("Text on background", TEXT_PAIRS, light, dark) + table("Adjacent surfaces (non-text)", SURFACE_PAIRS, light, dark)
    print("\n".join(out))


if __name__ == "__main__":
    main()
