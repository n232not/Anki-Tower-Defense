"""Anki Tower Defense: a tower defense game powered by your Anki reviews.

Every card you answer earns study points. Spend them on towers in the
game window (Tools > Anki Tower Defense, or the "Defense" toolbar link).
Can be docked into the main Anki window as a split-screen panel on the right.
"""

import json
import os
import time

from aqt import gui_hooks, mw
from aqt.qt import (
    QAction,
    QDialog,
    QDockWidget,
    QSize,
    Qt,
    QTimer,
    QVBoxLayout,
    qconnect,
)
from aqt.utils import restoreGeom, saveGeom, tooltip
from aqt.webview import AnkiWebView

from .page import build_body

ADDON_DIR = os.path.dirname(os.path.abspath(__file__))
USER_DIR = os.path.join(ADDON_DIR, "user_files")

TOWER_NAMES = {
    "archer": "Archer",
    "frost": "Frost",
    "boomer": "Boomerang",
    "cannon": "Cannon",
    "trapper": "Trapper",
    "sniper": "Sniper",
    "pyro": "Pyro",
    "tesla": "Tesla",
    "gust": "Gale",
    "arcanist": "Arcanist",
    "bard": "Bard",
    "titan": "Titan",
}


def config() -> dict:
    return mw.addonManager.getConfig(__name__) or {}


# ---------------------------------------------------------------- storage


class Store:
    """Per-profile JSON state: points, lifetime cards and the saved game."""

    def __init__(self) -> None:
        self.data = None
        self.profile = None
        # profiles whose run has already been reset in this Anki session
        self.fresh = set()

    def _path(self) -> str:
        name = (mw.pm.name if mw.pm else None) or "default"
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)
        return os.path.join(USER_DIR, f"state_{safe}.json")

    def get(self) -> dict:
        profile = mw.pm.name if mw.pm else None
        if self.data is None or profile != self.profile:
            self.profile = profile
            self.data = self._load()
            # A run lasts one Anki session: the first load after starting Anki clears
            # the towers and waves, and sets coins back to starting_points (25).
            if profile not in self.fresh:
                self.fresh.add(profile)
                self.data["points"] = int(config().get("starting_points", 25))
                old = self.data.get("game")
                if old is not None:
                    # keep only the difficulty preference and trophies
                    keep = {k: old[k] for k in ("diff", "trophies") if isinstance(old, dict) and old.get(k)}
                    self.data["game"] = keep or None
                self.save()
        return self.data

    def _load(self) -> dict:
        data = {}
        try:
            with open(self._path(), encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = {"points": int(config().get("starting_points", 25))}
        data.setdefault("points", int(config().get("starting_points", 25)))
        data.setdefault("totalCards", 0)
        data.setdefault("game", None)
        return data

    def reset(self) -> None:
        self.data = {
            "points": int(config().get("starting_points", 25)),
            "totalCards": 0,
            "game": None,
        }
        self.save()

    def save(self) -> None:
        if self.data is None:
            return
        os.makedirs(USER_DIR, exist_ok=True)
        path = self._path()
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f)
        os.replace(tmp, path)


store = Store()


# Round alert state: active while between waves in the build phase
_round_alert = {"active": False, "cleared": 0, "nextWave": 1, "points": 0}


# ---------------------------------------------------------------- game views (dock / dialog)


class DefenseViewMixin:
    """Shared web bridge and page logic for both docked and windowed modes."""

    def _load_page(self) -> None:
        cfg = config()
        data = store.get()
        boot = {
            "points": data["points"],
            "totalCards": data["totalCards"],
            "game": data["game"],
            "unlocks": cfg.get("unlocks", {}),
            "startLives": int(cfg.get("starting_lives", 100)),
            "waveCountdown": float(cfg.get("wave_countdown_seconds", 0)),
            "waveSeconds": float(cfg.get("wave_seconds", 300)),
            "waveSize": float(cfg.get("wave_size", 3.0)),
            "focusCards": int(cfg.get("cards_per_power", 15)),
        }
        self.web.stdHtml(build_body(boot), css=[], js=[], context=self)

    def _on_bridge(self, cmd: str):
        global _round_alert
        if cmd.startswith("commit:"):
            try:
                payload = json.loads(cmd[len("commit:"):])
                delta = int(payload.get("delta", 0))
            except (ValueError, TypeError):
                return {"ok": False}
            data = store.get()
            if data["points"] + delta < 0:
                return {"ok": False, "points": data["points"], "totalCards": data["totalCards"]}
            data["points"] += delta
            game = payload.get("game")
            if isinstance(game, dict):
                data["game"] = game
            store.save()
            return {"ok": True, "points": data["points"], "totalCards": data["totalCards"]}
        if cmd.startswith("wave_cleared:"):
            try:
                data_obj = json.loads(cmd[len("wave_cleared:"):])
                cleared = int(data_obj.get("cleared", 1))
                next_wave = int(data_obj.get("nextWave", cleared + 1))
            except (ValueError, TypeError):
                cleared = 1
                next_wave = 2
            try:
                data = store.get()
                _round_alert["active"] = True
                _round_alert["cleared"] = cleared
                _round_alert["nextWave"] = next_wave
                _round_alert["points"] = data["points"]
                show_round_alert()
                tooltip(f"⚔️ Wave {cleared} cleared! Build before the next card.", period=4000)
            except Exception:
                pass
            return {"ok": True}
        if cmd == "wave_started":
            _round_alert["active"] = False
            hide_round_alert()
            return {"ok": True}
        if cmd == "reset":
            store.reset()
            QTimer.singleShot(0, self._load_page)
            return {"ok": True}
        if cmd == "toggle_dock":
            global dock
            if dock is not None:
                if dock.isFloating():
                    dock.setFloating(False)
                    mw.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, dock)
                    dock.show()
                    dock.raise_()
                    return {"ok": True, "floating": False}
                else:
                    dock.setFloating(True)
                    dock.show()
                    dock.raise_()
                    dock.activateWindow()
                    return {"ok": True, "floating": True}
            return {"ok": True, "floating": False}
        return None

    def push_points(self) -> None:
        data = store.get()
        self.web.eval(
            f"window.TD && TD.setPoints({int(data['points'])}, {int(data['totalCards'])});"
        )


class DefenseDock(QDockWidget, DefenseViewMixin):
    """Split-screen dock widget on the right half of the main Anki window."""

    def __init__(self, parent=None) -> None:
        super().__init__("Anki Tower Defense", parent or mw)
        self.setObjectName("study_defense_dock")
        self.setAllowedAreas(
            Qt.DockWidgetArea.RightDockWidgetArea | Qt.DockWidgetArea.LeftDockWidgetArea
        )
        self.setFeatures(
            QDockWidget.DockWidgetFeature.DockWidgetMovable
            | QDockWidget.DockWidgetFeature.DockWidgetFloatable
            | QDockWidget.DockWidgetFeature.DockWidgetClosable
        )
        self.web = AnkiWebView(parent=self, title="study_defense")
        self.web.set_bridge_command(self._on_bridge, self)
        self.setWidget(self.web)
        self._load_page()

    def sizeHint(self) -> QSize:
        return QSize(560, 600)

    def keyPressEvent(self, evt) -> None:
        if evt.key() == Qt.Key.Key_Escape:
            return
        super().keyPressEvent(evt)


class DefenseDialog(QDialog, DefenseViewMixin):
    """Standalone floating window for users who prefer separate windows."""

    def __init__(self) -> None:
        super().__init__(mw, Qt.WindowType.Window)
        self.setWindowTitle("Anki Tower Defense")
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        self.resize(1260, 680)
        restoreGeom(self, "studyDefense")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.web = AnkiWebView(parent=self, title="study_defense")
        self.web.set_bridge_command(self._on_bridge, self)
        layout.addWidget(self.web)
        self._load_page()

    def keyPressEvent(self, evt) -> None:
        if evt.key() == Qt.Key.Key_Escape:
            return
        super().keyPressEvent(evt)

    def done(self, result: int) -> None:
        global dialog
        saveGeom(self, "studyDefense")
        dialog = None
        cleanup = getattr(self.web, "cleanup", None)
        if cleanup:
            cleanup()
        super().done(result)


dock: DefenseDock | None = None
dialog: DefenseDialog | None = None


def get_active_view():
    cfg = config()
    if cfg.get("dock_mode", True):
        return dock
    return dialog


def open_game() -> None:
    global dock, dialog
    cfg = config()
    use_dock = cfg.get("dock_mode", True)
    if use_dock:
        if dock is None:
            dock = DefenseDock(mw)
            mw.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, dock)
        if dock.isFloating():
            # If the user floated it into a window, clicking Defense re-docks it back into split screen!
            dock.setFloating(False)
            mw.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, dock)
            dock.show()
            dock.raise_()
        elif dock.isVisible():
            dock.hide()
        else:
            dock.show()
            dock.raise_()
            dock.activateWindow()
    else:
        if dialog is None:
            dialog = DefenseDialog()
            dialog.show()
        else:
            dialog.showNormal()
        dialog.raise_()
        dialog.activateWindow()


def redock_game() -> None:
    global dock
    if dock is None:
        open_game()
        return
    dock.setFloating(False)
    mw.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, dock)
    dock.show()
    dock.raise_()


# ---------------------------------------------------------------- round cleared notification modal


ALERT_MODAL_JS = """
(function(cleared, nextWave, points) {
  var id = 'sd-round-modal';
  var old = document.getElementById(id);
  if (old) old.remove();

  if (window.__sdBlockKeys) {
    window.removeEventListener('keydown', window.__sdBlockKeys, true);
  }

  // Block Space, Enter, 1, 2, 3, 4 so user cannot advance the card accidentally
  window.__sdBlockKeys = function(e) {
    var k = e.key || '';
    var code = e.code || '';
    if (k === ' ' || k === 'Enter' || code === 'Space' || code === 'Enter' || code === 'NumpadEnter' ||
        k === '1' || k === '2' || k === '3' || k === '4' || code.indexOf('Digit') === 0 || code.indexOf('Numpad') === 0) {
      e.stopImmediatePropagation();
      e.preventDefault();
      var c = document.getElementById('sd-modal-card');
      if (c) {
        c.style.transform = 'scale(1.04)';
        setTimeout(function() { c.style.transform = 'scale(1)'; }, 150);
      }
    }
  };
  window.addEventListener('keydown', window.__sdBlockKeys, true);

  var overlay = document.createElement('div');
  overlay.id = id;
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    'background: rgba(10, 20, 45, 0.65)',
    'backdrop-filter: blur(3px)',
    '-webkit-backdrop-filter: blur(3px)',
    'z-index: 9999999',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'padding: 16px',
    'box-sizing: border-box',
    'animation: sd-fade 0.2s ease-out'
  ].join(';');

  if (!document.getElementById('sd-modal-style')) {
    var st = document.createElement('style');
    st.id = 'sd-modal-style';
    st.textContent = [
      '@keyframes sd-fade { from { opacity: 0; } to { opacity: 1; } }',
      '@keyframes sd-zoom { from { transform: scale(0.85); opacity: 0; } to { transform: scale(1); opacity: 1; } }',
      '.sd-mbtn { padding: 10px 20px; border-radius: 10px; font-weight: 800; font-size: 15px; cursor: pointer; border: 3px solid #12213f; box-shadow: 0 4px 0 #12213f; transition: transform 0.08s; font-family: inherit; }',
      '.sd-mbtn:hover { filter: brightness(1.1); transform: translateY(-1px); }',
      '.sd-mbtn:active { transform: translateY(2px); box-shadow: 0 1px 0 #12213f; }'
    ].join('\\n');
    document.head.appendChild(st);
  }

  var card = document.createElement('div');
  card.id = 'sd-modal-card';
  card.style.cssText = [
    'background: linear-gradient(180deg, #2f62b8 0%, #1b3c7a 100%)',
    'border: 4px solid #12213f',
    'border-radius: 18px',
    'box-shadow: 0 16px 40px rgba(0,0,0,0.55), 0 6px 0 #12213f, inset 0 3px 0 rgba(255,255,255,0.3)',
    'padding: 24px 28px',
    'max-width: 440px',
    'width: 100%',
    'text-align: center',
    'color: #fff',
    'font-family: "Lilita One", "Arial Rounded MT Bold", ui-rounded, sans-serif, -apple-system',
    'animation: sd-zoom 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    'transition: transform 0.15s ease'
  ].join(';');

  card.innerHTML = [
    '<div style="background: linear-gradient(180deg, #ffe066, #ffcb2e 55%, #f0a800); border: 3px solid #12213f; border-radius: 10px; padding: 6px 14px; margin-bottom: 14px; box-shadow: 0 3px 0 #12213f;">',
    '  <div style="font-size: 24px; color: #12213f; text-shadow: 0 1px 0 rgba(255,255,255,0.6); letter-spacing: 0.5px;">⚔️ ROUND ' + cleared + ' CLEARED!</div>',
    '  <div style="font-size: 13px; font-weight: 800; color: #5a3800; text-transform: uppercase; letter-spacing: 1px;">Build Phase Active</div>',
    '</div>',
    '<div style="font-size: 15px; line-height: 1.4; color: #dbeaff; margin-bottom: 16px; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; font-weight: 600;">',
    '  Spend your points on towers before the next round begins!<br>',
    '  You have <b style="color: #ffd23f; font-size: 18px;">' + points + ' points</b> available.',
    '</div>',
    '<div style="font-size: 12px; color: #9bbfe6; margin-bottom: 18px; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;">',
    '  Next card answered will launch <b>Wave ' + nextWave + '</b>',
    '</div>',
    '<div style="display: flex; gap: 10px; justify-content: center;">',
    '  <button id="sd-btn-build" class="sd-mbtn" style="background: linear-gradient(180deg, #ffe066, #ffcb2e); color: #12213f;">🛡️ Build Towers</button>',
    '  <button id="sd-btn-ready" class="sd-mbtn" style="background: linear-gradient(180deg, #66d23a, #2f8c14); color: #fff;">⚔️ Ready (Dismiss)</button>',
    '</div>'
  ].join('');

  overlay.appendChild(card);

  function dismiss(focusGame) {
    if (window.__sdBlockKeys) {
      window.removeEventListener('keydown', window.__sdBlockKeys, true);
      window.__sdBlockKeys = null;
    }
    overlay.remove();
    if (typeof pycmd === 'function') {
      pycmd(focusGame ? 'sd_focus_game' : 'sd_dismiss_alert');
    }
  }

  card.querySelector('#sd-btn-ready').onclick = function(e) { e.stopPropagation(); dismiss(false); };
  card.querySelector('#sd-btn-build').onclick = function(e) { e.stopPropagation(); dismiss(true); };
  overlay.onclick = function(e) {
    if (e.target === overlay) dismiss(false);
  };

  document.body.appendChild(overlay);
})
"""

HIDE_ALERT_JS = """
(function() {
  if (window.__sdBlockKeys) {
    window.removeEventListener('keydown', window.__sdBlockKeys, true);
    window.__sdBlockKeys = null;
  }
  var a = document.getElementById('sd-round-modal');
  if (a) a.remove();
})();
"""


def show_round_alert() -> None:
    if not config().get("show_round_alert", True):
        return
    if not _round_alert["active"]:
        return
    try:
        if getattr(mw, "state", None) == "review" and mw.reviewer and mw.reviewer.web:
            cleared = int(_round_alert.get("cleared", 1))
            next_wave = int(_round_alert.get("nextWave", 2))
            pts = int(_round_alert.get("points", 0))
            mw.reviewer.web.eval(
                f"({ALERT_MODAL_JS})({cleared}, {next_wave}, {pts});"
            )
    except Exception:
        pass


def hide_round_alert() -> None:
    try:
        if getattr(mw, "state", None) == "review" and mw.reviewer and mw.reviewer.web:
            mw.reviewer.web.eval(HIDE_ALERT_JS)
    except Exception:
        pass


def on_js_message(handled: tuple[bool, any], cmd: str, context: any) -> tuple[bool, any]:
    global _round_alert
    if cmd == "sd_dismiss_alert":
        _round_alert["active"] = False
        return (True, None)
    if cmd == "sd_focus_game":
        _round_alert["active"] = False
        open_game()
        return (True, None)
    if cmd == "sd_save_timer_pos:default":
        cfg = config()
        if "timer_pos" in cfg:
            cfg.pop("timer_pos", None)
            mw.addonManager.writeConfig(__name__, cfg)
        return (True, None)
    if cmd.startswith("sd_save_timer_pos:"):
        try:
            parts = cmd.split(":")
            if len(parts) == 3:
                x = int(parts[1])
                y = int(parts[2])
                cfg = config()
                cfg["timer_pos"] = {"left": x, "top": y}
                mw.addonManager.writeConfig(__name__, cfg)
        except Exception:
            pass
        return (True, None)
    return handled


# ---------------------------------------------------------------- hooks


def speed_tiers(cfg: dict) -> list:
    """[(seconds, points), ...] sorted fastest first."""
    tiers = []
    for tier in cfg.get("speed_bonus", []) or []:
        try:
            tiers.append((float(tier["under_seconds"]), int(tier["points"])))
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(tiers)


def bonus_for(seconds: float, tiers: list) -> int:
    for limit, pts in tiers:
        if seconds < limit:
            return pts
    return 0


# Recall time for the current card: question shown -> answer revealed.
_timing = {"card": None, "shown": None, "revealed": None}

TIMER_JS = """
(function (tiers, initialPos) {
  var el = document.getElementById('sd-timer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sd-timer';
    el.title = 'Drag to reposition timer (double-click to reset)';
    el.style.cssText = 'position:fixed;z-index:99999;padding:6px 14px;' +
      'border-radius:10px;font:700 18px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'background:rgba(28,32,39,.92);color:#9aa3b2;cursor:grab;user-select:none;-webkit-user-select:none;' +
      'font-variant-numeric:tabular-nums;touch-action:none;border:1px solid rgba(255,255,255,0.18);' +
      'box-shadow:0 3px 10px rgba(0,0,0,0.35);transition:box-shadow .15s, border-color .15s, color .15s;';
    el.__dragging = false;

    var pos = null;
    try {
      var saved = localStorage.getItem('sd_timer_pos');
      if (saved) pos = JSON.parse(saved);
    } catch (e) {}
    if (!pos && initialPos && initialPos.left != null && initialPos.top != null) {
      pos = initialPos;
    }
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      var maxL = Math.max(0, window.innerWidth - 150);
      var maxT = Math.max(0, window.innerHeight - 44);
      el.style.left = Math.max(0, Math.min(pos.left, maxL)) + 'px';
      el.style.top = Math.max(0, Math.min(pos.top, maxT)) + 'px';
    } else {
      el.style.top = '8px';
      el.style.right = '10px';
    }

    var startX = 0, startY = 0, origLeft = 0, origTop = 0;

    function onPointerDown(e) {
      if (e.button !== 0) return;
      el.__dragging = true;
      var r = el.getBoundingClientRect();
      origLeft = r.left;
      origTop = r.top;
      startX = e.clientX;
      startY = e.clientY;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = origLeft + 'px';
      el.style.top = origTop + 'px';
      el.style.cursor = 'grabbing';
      el.style.borderColor = '#ffd166';
      el.style.boxShadow = '0 6px 18px rgba(0,0,0,0.55)';
      var captured = false;
      try {
        el.setPointerCapture(e.pointerId);
        captured = true;
      } catch (err) {}
      if (!captured) {
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
      }
      e.stopPropagation();
      e.preventDefault();
    }

    function onPointerMove(e) {
      if (!el.__dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var nl = origLeft + dx;
      var nt = origTop + dy;
      var maxL = Math.max(0, window.innerWidth - (el.offsetWidth || 150));
      var maxT = Math.max(0, window.innerHeight - (el.offsetHeight || 44));
      nl = Math.max(0, Math.min(nl, maxL));
      nt = Math.max(0, Math.min(nt, maxT));
      el.style.left = nl + 'px';
      el.style.top = nt + 'px';
      e.stopPropagation();
      e.preventDefault();
    }

    function onPointerUp(e) {
      if (!el.__dragging) return;
      el.__dragging = false;
      el.style.cursor = 'grab';
      var s = (Date.now() - t0) / 1000;
      if (s >= 7) {
        el.style.borderColor = 'rgba(255, 77, 79, 0.45)';
        el.style.boxShadow = '0 3px 12px rgba(255, 77, 79, 0.25)';
      } else {
        el.style.borderColor = 'rgba(255,255,255,0.18)';
        el.style.boxShadow = '0 3px 10px rgba(0,0,0,0.35)';
      }
      try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      var r = el.getBoundingClientRect();
      var p = { left: Math.round(r.left), top: Math.round(r.top) };
      try { localStorage.setItem('sd_timer_pos', JSON.stringify(p)); } catch (err) {}
      if (typeof pycmd === 'function') {
        pycmd('sd_save_timer_pos:' + p.left + ':' + p.top);
      }
      e.stopPropagation();
    }

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);

    el.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      el.style.left = 'auto';
      el.style.bottom = 'auto';
      el.style.top = '8px';
      el.style.right = '10px';
      try { localStorage.removeItem('sd_timer_pos'); } catch (err) {}
      if (typeof pycmd === 'function') {
        pycmd('sd_save_timer_pos:default');
      }
    });

    document.body.appendChild(el);
  } else {
    el.style.padding = '6px 14px';
    el.style.borderRadius = '10px';
    el.style.font = '700 18px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
    var pos = null;
    try {
      var saved = localStorage.getItem('sd_timer_pos');
      if (saved) pos = JSON.parse(saved);
    } catch (e) {}
    if (!pos && initialPos && initialPos.left != null && initialPos.top != null) {
      pos = initialPos;
    }
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      var maxL = Math.max(0, window.innerWidth - (el.offsetWidth || 150));
      var maxT = Math.max(0, window.innerHeight - (el.offsetHeight || 44));
      el.style.left = Math.max(0, Math.min(pos.left, maxL)) + 'px';
      el.style.top = Math.max(0, Math.min(pos.top, maxT)) + 'px';
      el.style.right = 'auto';
    }
  }

  clearInterval(window.__sdTimer);
  var t0 = Date.now();
  function tick() {
    var s = (Date.now() - t0) / 1000, bonus = 0;
    for (var i = 0; i < tiers.length; i++) { if (s < tiers[i][0]) { bonus = tiers[i][1]; break; } }
    el.textContent = '\u23F1 ' + s.toFixed(1) + 's' + (bonus ? '  +' + bonus + ' bonus' : '');
    if (s >= 7) {
      el.style.color = '#ff4d4f';
      if (!el.__dragging) {
        el.style.borderColor = 'rgba(255, 77, 79, 0.45)';
        el.style.boxShadow = '0 3px 12px rgba(255, 77, 79, 0.25)';
      }
    } else if (bonus) {
      el.style.color = '#ffd166';
      if (!el.__dragging) {
        el.style.borderColor = 'rgba(255, 209, 102, 0.3)';
        el.style.boxShadow = '0 3px 10px rgba(0,0,0,0.35)';
      }
    } else {
      el.style.color = '#dbe4f0';
      if (!el.__dragging) {
        el.style.borderColor = 'rgba(255, 255, 255, 0.18)';
        el.style.boxShadow = '0 3px 10px rgba(0,0,0,0.35)';
      }
    }
  }
  tick();
  window.__sdTimer = setInterval(tick, 100);
  window.__sdStop = function () { clearInterval(window.__sdTimer); tick(); };
})
"""


def on_show_question(card) -> None:
    _timing.update(card=card.id, shown=time.monotonic(), revealed=None)
    cfg = config()
    view = get_active_view()
    # starting (or continuing) reviews starts the next wave if none is running and alert not pending
    if (
        view is not None
        and getattr(view, "isVisible", lambda: True)()
        and cfg.get("start_wave_on_answer", True)
        and not _round_alert["active"]
    ):
        try:
            view.web.eval("window.TD && TD.reviewing && TD.reviewing();")
        except Exception:
            pass
    if cfg.get("show_timer", True) and mw.reviewer and mw.reviewer.web:
        try:
            tiers = [[sec, pts] for sec, pts in speed_tiers(cfg)]
            pos = cfg.get("timer_pos")
            mw.reviewer.web.eval(
                f"({TIMER_JS})({json.dumps(tiers)}, {json.dumps(pos)});"
            )
        except Exception:
            pass
    if _round_alert["active"]:
        show_round_alert()


def on_show_answer(card) -> None:
    if _timing["card"] == card.id and _timing["revealed"] is None:
        _timing["revealed"] = time.monotonic()
    if mw.reviewer and mw.reviewer.web:
        try:
            mw.reviewer.web.eval("window.__sdStop && window.__sdStop();")
        except Exception:
            pass
    if _round_alert["active"]:
        show_round_alert()


def on_answer(reviewer, card, ease) -> None:
    global _round_alert
    cfg = config()
    gained = int(cfg.get("points_per_card", 1))

    bonus = 0
    if _timing["card"] == card.id and _timing["shown"] is not None:
        end = _timing["revealed"] or time.monotonic()
        bonus = bonus_for(end - _timing["shown"], speed_tiers(cfg))
    _timing.update(card=None, shown=None, revealed=None)
    gained += bonus

    data = store.get()
    before = data["totalCards"]
    data["points"] += gained
    data["totalCards"] += 1
    store.save()

    unlocks = cfg.get("unlocks", {})
    unlocked = [
        TOWER_NAMES.get(key, key)
        for key, need in unlocks.items()
        if before < int(need) <= data["totalCards"]
    ]
    if unlocked:
        tooltip(f"Anki Tower Defense: {', '.join(unlocked)} tower unlocked!", period=3000)
    else:
        every = int(cfg.get("show_tooltip_every", 10))
        if every > 0 and data["totalCards"] % every == 0:
            tooltip(f"Anki Tower Defense: {data['points']} points to spend", period=1500)

    if _round_alert["active"]:
        _round_alert["active"] = False
        hide_round_alert()

    view = get_active_view()
    if view is not None and getattr(view, "isVisible", lambda: True)():
        view.push_points()
        if cfg.get("start_wave_on_answer", True):
            view.web.eval("window.TD && TD.cardAnswered && TD.cardAnswered();")


def add_toolbar_link(links, toolbar) -> None:
    if not config().get("toolbar_link", True):
        return
    links.append(
        toolbar.create_link(
            "studydefense",
            "Defense",
            open_game,
            tip="Anki Tower Defense (Toggle split screen)",
            id="studydefense",
        )
    )


gui_hooks.reviewer_did_show_question.append(on_show_question)
gui_hooks.reviewer_did_show_answer.append(on_show_answer)
gui_hooks.reviewer_did_answer_card.append(on_answer)
gui_hooks.top_toolbar_did_init_links.append(add_toolbar_link)
gui_hooks.webview_did_receive_js_message.append(on_js_message)

_action = QAction("Anki Tower Defense", mw)
qconnect(_action.triggered, open_game)
mw.form.menuTools.addAction(_action)

_redock_action = QAction("Anki Tower Defense: Re-dock Split Screen", mw)
qconnect(_redock_action.triggered, redock_game)
mw.form.menuTools.addAction(_redock_action)
