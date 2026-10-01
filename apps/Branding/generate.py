#!/usr/bin/env python3
"""Generate Kanbot brand assets (app icons, launch logo) from the vector mark.

The mark is a kanban board shaped like a robot head: three columns of cards,
side "ears" and an antenna. Run from anywhere:

    pip install cairosvg
    python3 apps/Branding/generate.py

Outputs SVG sources into apps/Branding/ and PNGs into the asset catalog.
"""
import json
import pathlib

import cairosvg

HERE = pathlib.Path(__file__).resolve().parent
ASSETS = HERE.parent / "Kanbot" / "Assets.xcassets"

INDIGO_TOP = "#7078F6"
INDIGO_BOTTOM = "#4148D2"
INDIGO = "#5D66EA"  # matches AccentColor
INDIGO_LIGHT = "#A9AEF7"
AMBER = "#FFB547"
WHITE = "#FFFFFF"

# The mark, drawn in a 1024x1024 space (centered at 512,512).
MARK = f"""
  <g id="mark">
    <!-- antenna -->
    <rect x="500" y="200" width="24" height="96" rx="12" fill="{WHITE}"/>
    <circle cx="512" cy="190" r="38" fill="{AMBER}"/>
    <!-- ears -->
    <rect x="186" y="440" width="64" height="150" rx="28" fill="{WHITE}"/>
    <rect x="774" y="440" width="64" height="150" rx="28" fill="{WHITE}"/>
    <!-- head / board -->
    <rect x="232" y="280" width="560" height="470" rx="112" fill="{WHITE}"/>
    <!-- column 1: to do -->
    <rect x="302" y="352" width="116" height="150" rx="30" fill="{INDIGO}"/>
    <rect x="302" y="518" width="116" height="110" rx="30" fill="{INDIGO_LIGHT}"/>
    <!-- column 2: doing -->
    <rect x="454" y="352" width="116" height="96" rx="30" fill="{INDIGO_LIGHT}"/>
    <rect x="454" y="464" width="116" height="164" rx="30" fill="{INDIGO}"/>
    <!-- column 3: done (by the bot) -->
    <rect x="606" y="352" width="116" height="130" rx="30" fill="{AMBER}"/>
    <rect x="606" y="498" width="116" height="76" rx="30" fill="{INDIGO_LIGHT}"/>
  </g>
"""

GRADIENT = f"""
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{INDIGO_TOP}"/>
      <stop offset="1" stop-color="{INDIGO_BOTTOM}"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>
"""


def svg(body, size=1024, view="0 0 1024 1024"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="{view}">{body}</svg>')


# iOS: full-bleed square, the system applies the corner mask.
ICON_IOS = svg(GRADIENT + '<rect width="1024" height="1024" fill="url(#bg)"/>'
               + f'<g transform="translate(512 528) scale(0.92) translate(-512 -512)" '
               f'filter="url(#shadow)">{MARK}</g>')

# macOS: Big Sur grid — 824pt rounded body inside a 1024 canvas, with drop shadow.
_MAC_BODY = (GRADIENT
             + '<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#shadow)"/>'
             + f'<g transform="translate(512 525) scale(0.74) translate(-512 -512)">{MARK}</g>')
ICON_MAC = svg(_MAC_BODY)

# Launch screen / in-app mark: just the mark on transparent, cropped to its bounds.
MARK_VIEW = "176 142 672 618"  # x y w h around the mark
MARK_ONLY = (f'<svg xmlns="http://www.w3.org/2000/svg" width="672" height="618" '
             f'viewBox="{MARK_VIEW}">{MARK}</svg>')


def png(src, out, w, h=None):
    out.parent.mkdir(parents=True, exist_ok=True)
    cairosvg.svg2png(bytestring=src.encode(), write_to=str(out), output_width=w,
                     output_height=h or w)


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n")


def main():
    (HERE / "kanbot-icon-ios.svg").write_text(ICON_IOS + "\n")
    (HERE / "kanbot-icon-macos.svg").write_text(ICON_MAC + "\n")
    (HERE / "kanbot-mark.svg").write_text(MARK_ONLY + "\n")

    # App icon
    appicon = ASSETS / "AppIcon.appiconset"
    images = []
    png(ICON_IOS, appicon / "icon-ios-1024.png", 1024)
    images.append({"filename": "icon-ios-1024.png", "idiom": "universal",
                   "platform": "ios", "size": "1024x1024"})
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            name = f"icon-mac-{pt}@{scale}x.png"
            png(ICON_MAC, appicon / name, pt * scale)
            images.append({"filename": name, "idiom": "mac",
                           "scale": f"{scale}x", "size": f"{pt}x{pt}"})
    write_json(appicon / "Contents.json",
               {"images": images, "info": {"author": "xcode", "version": 1}})

    # Mark used by the launch screen and the in-app splash (160pt wide).
    mark = ASSETS / "BrandMark.imageset"
    w, h = 160, round(160 * 618 / 672)
    mark_images = []
    for scale in (1, 2, 3):
        name = f"mark@{scale}x.png"
        png(MARK_ONLY, mark / name, w * scale, h * scale)
        mark_images.append({"filename": name, "idiom": "universal", "scale": f"{scale}x"})
    write_json(mark / "Contents.json",
               {"images": mark_images, "info": {"author": "xcode", "version": 1}})

    # Rounded app tile for in-app branding (login screen), 96pt.
    tile = ASSETS / "BrandIcon.imageset"
    tile_images = []
    for scale in (1, 2, 3):
        name = f"brand-icon@{scale}x.png"
        png(ICON_IOS, tile / name, 96 * scale)
        tile_images.append({"filename": name, "idiom": "universal", "scale": f"{scale}x"})
    write_json(tile / "Contents.json",
               {"images": tile_images, "info": {"author": "xcode", "version": 1}})

    # Launch screen background — the icon's mid indigo.
    write_json(ASSETS / "LaunchBackground.colorset" / "Contents.json", {
        "colors": [{"color": {"color-space": "srgb", "components": {
            "alpha": "1.000", "red": "0.345", "green": "0.376", "blue": "0.894"}},
            "idiom": "universal"}],
        "info": {"author": "xcode", "version": 1}})


if __name__ == "__main__":
    main()
