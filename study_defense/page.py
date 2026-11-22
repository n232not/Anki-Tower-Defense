"""Builds the game page. Kept free of Anki imports so it can be used for a browser preview."""

import base64
import json
import os

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


def _read(name: str) -> str:
    with open(os.path.join(WEB_DIR, name), encoding="utf-8") as f:
        return f.read()


def _sprites_js() -> str:
    """Inline every PNG in web/sprites as a data URI, keyed by file name without extension."""
    folder = os.path.join(WEB_DIR, "sprites")
    sprites = {}
    if os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            if name.endswith(".png"):
                with open(os.path.join(folder, name), "rb") as f:
                    data = base64.b64encode(f.read()).decode("ascii")
                sprites[name[:-4]] = "data:image/png;base64," + data
    return f"<script>window.TD_SPRITES = {json.dumps(sprites)};</script>"


def _font_css() -> str:
    """Inline the bundled display font (Lilita One, SIL OFL; see web/fonts/OFL.txt)."""
    path = os.path.join(WEB_DIR, "fonts", "LilitaOne-Regular.ttf")
    if not os.path.isfile(path):
        return ""
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode("ascii")
    return (
        "@font-face{font-family:'Lilita One';font-style:normal;font-weight:400;"
        f"src:url(data:font/ttf;base64,{data}) format('truetype');}}"
    )


def build_body(boot) -> str:
    """HTML body for AnkiWebView.stdHtml. `boot` is None for the standalone dev preview."""
    boot_js = ""
    if boot is not None:
        boot_json = json.dumps(boot).replace("</", "<\\/")
        boot_js = f"<script>window.TD_BOOT = {boot_json};</script>"
    return (
        f"<style>{_font_css()}{_read('game.css')}</style>"
        f"{_read('body.html')}"
        f"{boot_js}"
        f"{_sprites_js()}"
        f"<script>{_read('game.js')}</script>"
    )


def build_standalone() -> str:
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<title>Anki Tower Defense (preview)</title></head><body>"
        f"{build_body(None)}</body></html>"
    )
