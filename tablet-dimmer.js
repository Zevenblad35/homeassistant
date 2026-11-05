/*
 * Tablet Dimmer voor Home Assistant
 * Dimt een wandtablet per tijdvak (ochtend / dag / avond / slaap) zolang het
 * dashboard fullscreen draait. In de slaapstand: zwart scherm met klok.
 * Aanraken = tijdelijk wakker (ochtend- of avondstand), daarna terug naar slaap.
 */

const TD_VERSION = "1.0.0";

const TD_DEFAULTS = {
  presence_entity: null,     // person.x, group.x, binary_sensor.x of zone.home
  fullscreen_only: true,     // alleen actief in fullscreen / kiosk
  modes: {
    morning: { start: "06:30", brightness: 60 },
    day:     { start: "09:00", brightness: 100, brightness_away: 40 },
    evening: { start: "19:00", brightness: 35 },
    sleep:   { start: "23:00", brightness: 5 },
  },
  wake_mode: "auto",         // auto | morning | evening | day
  wake_timeout: 2,           // minuten zonder aanraking -> terug naar slaap
  sleep_style: "clock",      // clock | black
  clock_brightness: 35,      // zichtbaarheid van de klok in % (0-100)
  show_date: true,
  use_fully: "auto",         // auto | false  (Fully Kiosk backlight aansturen)
  restore_brightness: 100,   // helderheid buiten fullscreen (alleen Fully Kiosk)
  show_card: false,          // statuskaart tonen op het dashboard
};

const TD_LABELS = { morning: "Ochtend", day: "Dag", evening: "Avond", sleep: "Slaap" };
const TD_ORDER = ["morning", "day", "evening", "sleep"];

function tdMinutes(t) {
  const [h, m] = String(t || "0:0").split(":").map((v) => parseInt(v, 10));
  return ((isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m)) % 1440;
}

function tdClamp(v, min, max) {
  const n = Number(v);
  if (isNaN(n)) return max;
  return Math.min(max, Math.max(min, n));
}

function tdMergeConfig(cfg = {}) {
  const merged = { ...TD_DEFAULTS, ...cfg, modes: {} };
  for (const key of TD_ORDER) {
    merged.modes[key] = { ...TD_DEFAULTS.modes[key], ...((cfg.modes || {})[key] || {}) };
  }
  return merged;
}

class TabletDimmerController {
  constructor() {
    this.config = null;
    this.hass = null;
    this.awakeUntil = 0;
    this.forced = null;          // { mode, base }
    this.lastPct = null;
    this.state = {};
    this.listeners = new Set();
    this._clockTimer = null;
    this._lastShift = 0;
    this._buildDom();
    this._bindEvents();
    this._timer = setInterval(() => this.update(), 10000);
  }

  /* ---------- DOM ---------- */

  _buildDom() {
    const style = document.createElement("style");
    style.textContent = `
      #td-dim {
        position: fixed; inset: 0; background: #000; opacity: 0;
        pointer-events: none; z-index: 2147483000;
        transition: opacity 1.2s ease;
      }
      #td-sleep {
        position: fixed; inset: 0; background: #000; z-index: 2147483001;
        display: none; align-items: center; justify-content: center;
        cursor: none; touch-action: none; user-select: none; -webkit-user-select: none;
      }
      #td-sleep.td-on { display: flex; }
      #td-clock {
        text-align: center; color: #fff;
        font-family: "Helvetica Neue", "Segoe UI", Roboto, system-ui, sans-serif;
        transition: transform 2s ease;
      }
      #td-time {
        font-size: clamp(4rem, 19vw, 15rem); font-weight: 200;
        letter-spacing: -0.02em; line-height: 1; font-variant-numeric: tabular-nums;
      }
      #td-date {
        font-size: clamp(1rem, 3vw, 1.8rem); font-weight: 300;
        margin-top: 0.6em; letter-spacing: 0.02em;
      }
      @media (prefers-reduced-motion: reduce) {
        #td-dim, #td-clock { transition: none; }
      }
    `;
    document.head.appendChild(style);

    this.dimEl = document.createElement("div");
    this.dimEl.id = "td-dim";

    this.sleepEl = document.createElement("div");
    this.sleepEl.id = "td-sleep";
    this.sleepEl.innerHTML = `<div id="td-clock"><div id="td-time"></div><div id="td-date"></div></div>`;

    const attach = () => {
      document.body.appendChild(this.dimEl);
      document.body.appendChild(this.sleepEl);
    };
    if (document.body) attach();
    else document.addEventListener("DOMContentLoaded", attach);

    this.clockEl = this.sleepEl.querySelector("#td-clock");
    this.timeEl = this.sleepEl.querySelector("#td-time");
    this.dateEl = this.sleepEl.querySelector("#td-date");
  }

  _bindEvents() {
    // Aanraking op het slaapscherm: wakker worden, maar de tik niet doorgeven
    const wakeHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.wake();
    };
    this.sleepEl.addEventListener("pointerdown", wakeHandler);
    this.sleepEl.addEventListener("touchstart", wakeHandler, { passive: false });
    this.sleepEl.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });

    // Elke aanraking tijdens 'tijdelijk wakker' verlengt de timer
    document.addEventListener("pointerdown", () => {
      if (this.awakeUntil > Date.now()) this._extendWake();
    }, { capture: true, passive: true });

    document.addEventListener("fullscreenchange", () => this.update());
    document.addEventListener("visibilitychange", () => this.update());
    window.addEventListener("resize", () => this.update());
  }

  /* ---------- API voor de kaart ---------- */

  setConfig(cfg) {
    this.config = tdMergeConfig(cfg);
    this.lastPct = null;
    this.update();
  }

  setHass(hass) {
    const first = !this.hass;
    this.hass = hass;
    if (first) this.update();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  sleepNow() {
    this.forced = { mode: "sleep", base: this.scheduledMode() };
    this.awakeUntil = 0;
    this.update();
  }

  followSchedule() {
    this.forced = null;
    this.awakeUntil = 0;
    this.update();
  }

  wake() {
    this._extendWake();
    this.update();
  }

  _extendWake() {
    const minutes = tdClamp(this.config ? this.config.wake_timeout : 2, 0.25, 240);
    this.awakeUntil = Date.now() + minutes * 60000;
  }

  /* ---------- Logica ---------- */

  scheduledMode(now = new Date()) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const list = TD_ORDER
      .map((k) => ({ k, s: tdMinutes(this.config.modes[k].start) }))
      .filter((m) => this.config.modes[m.k].enabled !== false)
      .sort((a, b) => a.s - b.s);
    if (!list.length) return "day";
    let mode = list[list.length - 1].k; // voor de eerste starttijd: laatste van gisteren
    for (const m of list) if (m.s <= cur) mode = m.k;
    return mode;
  }

  _wakeMode() {
    const w = this.config.wake_mode;
    if (w && w !== "auto" && this.config.modes[w]) return w;
    return new Date().getHours() < 12 ? "morning" : "evening";
  }

  _getHass() {
    const ha = document.querySelector("home-assistant");
    return (ha && ha.hass) || this.hass;
  }

  isHome() {
    const id = this.config.presence_entity;
    if (!id) return true;
    const st = this.hass && this.hass.states && this.hass.states[id];
    if (!st) return true;
    const s = String(st.state).toLowerCase();
    if (["home", "on", "true", "thuis"].includes(s)) return true;
    const n = Number(s);
    if (!isNaN(n)) return n > 0; // zone.home = aantal personen thuis
    return false;
  }

  brightnessFor(mode) {
    const mc = this.config.modes[mode] || {};
    const useAway = !this.isHome() && mc.brightness_away !== undefined && mc.brightness_away !== null;
    return tdClamp(useAway ? mc.brightness_away : mc.brightness, 0, 100);
  }

  isFullscreen() {
    if (!this.config.fullscreen_only) return true;
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    if (window.fully) return true; // Fully Kiosk Browser
    const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
    if (mq("(display-mode: fullscreen)") || mq("(display-mode: standalone)")) return true;
    const qs = window.location.search || "";
    if (/[?&](kiosk|fullscreen|td_active)/.test(qs)) return true;
    // Browser-fullscreen via F11 / kiosk-modus van de browser
    if (Math.abs(window.innerHeight - screen.height) <= 2 && Math.abs(window.innerWidth - screen.width) <= 2) return true;
    return false;
  }

  hasFully() {
    if (this.config.use_fully === false || this.config.use_fully === "false") return false;
    return !!(window.fully && typeof window.fully.setScreenBrightness === "function");
  }

  update() {
    if (!this.config) return;
    this.hass = this._getHass();

    if (document.hidden) return;

    const active = this.isFullscreen();
    if (!active) {
      this._clear();
      this._publish({ active: false });
      return;
    }

    const scheduled = this.scheduledMode();
    if (this.forced && this.forced.base !== scheduled) this.forced = null; // schema is verder
    const mode = this.forced ? this.forced.mode : scheduled;

    const now = Date.now();
    let effective = mode;
    if (mode === "sleep") {
      if (this.awakeUntil > now) effective = this._wakeMode();
      else this.awakeUntil = 0;
    } else {
      this.awakeUntil = 0;
    }

    const pct = this.brightnessFor(effective);
    this._applyBrightness(pct);
    this._showSleep(effective === "sleep");

    this._publish({
      active: true, mode, effective, pct,
      home: this.isHome(),
      awakeUntil: this.awakeUntil,
      forced: !!this.forced,
      fully: this.hasFully(),
    });
  }

  _applyBrightness(pct) {
    if (pct === this.lastPct) return;
    this.lastPct = pct;
    if (this.hasFully()) {
      try { window.fully.setScreenBrightness(Math.max(1, Math.round(pct * 2.55))); } catch (e) { /* negeren */ }
      this.dimEl.style.opacity = "0";
    } else {
      this.dimEl.style.opacity = String(tdClamp(1 - pct / 100, 0, 0.97));
    }
  }

  _showSleep(on) {
    const isOn = this.sleepEl.classList.contains("td-on");
    if (on && !isOn) {
      this.sleepEl.classList.add("td-on");
      const showClock = this.config.sleep_style !== "black";
      this.clockEl.style.display = showClock ? "" : "none";
      this.clockEl.style.opacity = String(tdClamp(this.config.clock_brightness, 0, 100) / 100);
      this.dateEl.style.display = this.config.show_date ? "" : "none";
      this._tickClock();
      this._clockTimer = setInterval(() => this._tickClock(), 1000);
    } else if (!on && isOn) {
      this.sleepEl.classList.remove("td-on");
      clearInterval(this._clockTimer);
      this._clockTimer = null;
    }
  }

  _tickClock() {
    const d = new Date();
    this.timeEl.textContent = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
    this.dateEl.textContent = d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" });
    // Elke minuut een kleine verschuiving tegen inbranden
    if (Date.now() - this._lastShift > 60000) {
      this._lastShift = Date.now();
      const x = (Math.random() * 2 - 1) * 6;
      const y = (Math.random() * 2 - 1) * 6;
      this.clockEl.style.transform = `translate(${x}vw, ${y}vh)`;
    }
  }

  _clear() {
    this._showSleep(false);
    this.awakeUntil = 0;
    if (this.lastPct !== null) {
      if (this.hasFully()) {
        try {
          window.fully.setScreenBrightness(Math.round(tdClamp(this.config.restore_brightness, 1, 100) * 2.55));
        } catch (e) { /* negeren */ }
      }
      this.dimEl.style.opacity = "0";
      this.lastPct = null;
    }
  }

  _publish(state) {
    this.state = state;
    this.listeners.forEach((fn) => { try { fn(state); } catch (e) { /* negeren */ } });
  }
}

function tdController() {
  if (!window.__tabletDimmer) window.__tabletDimmer = new TabletDimmerController();
  return window.__tabletDimmer;
}

/* ---------- Dashboardkaart ---------- */

class TabletDimmerCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    tdController().setConfig(this._config);
    this._render();
  }

  set hass(hass) {
    tdController().setHass(hass);
  }

  connectedCallback() {
    this._unsub = tdController().subscribe(() => this._render());
    this._render();
  }

  disconnectedCallback() {
    if (this._unsub) this._unsub();
  }

  getCardSize() {
    return this._config && this._config.show_card ? 3 : 0;
  }

  static getStubConfig() {
    return { presence_entity: "zone.home", show_card: true };
  }

  _render() {
    if (!this._config) return;
    if (!this._config.show_card) {
      this.style.display = "none";
      this.innerHTML = "";
      return;
    }
    this.style.display = "";
    const ctrl = tdController();
    const s = ctrl.state || {};
    const rows = [];
    if (!s.active) {
      rows.push(["Status", "Wacht op fullscreen"]);
    } else {
      const label = TD_LABELS[s.effective] || s.effective;
      const extra = s.mode === "sleep" && s.effective !== "sleep" ? " (tijdelijk wakker)" : "";
      rows.push(["Stand", label + extra]);
      rows.push(["Helderheid", `${Math.round(s.pct)}%`]);
      rows.push(["Iemand thuis", s.home ? "Ja" : "Nee"]);
      rows.push(["Aansturing", s.fully ? "Fully Kiosk (scherm)" : "Overlay"]);
    }
    this.innerHTML = `
      <ha-card header="Tablet Dimmer">
        <div style="padding:0 16px 8px">
          ${rows.map(([k, v]) => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--divider-color)">
              <span style="color:var(--secondary-text-color)">${k}</span><span>${v}</span>
            </div>`).join("")}
        </div>
        <div style="display:flex;gap:8px;padding:8px 16px 16px">
          <mwc-button raised data-act="sleep">Slaap nu</mwc-button>
          <mwc-button data-act="schedule">Volg schema</mwc-button>
        </div>
      </ha-card>`;
    this.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.act === "sleep") ctrl.sleepNow();
        else ctrl.followSchedule();
      });
    });
  }
}

if (!customElements.get("tablet-dimmer-card")) {
  customElements.define("tablet-dimmer-card", TabletDimmerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "tablet-dimmer-card",
    name: "Tablet Dimmer",
    description: "Dimt de tablet per tijdvak en toont 's nachts een klok.",
  });
  console.info(`%c TABLET-DIMMER %c v${TD_VERSION} `, "background:#222;color:#fff", "background:#555;color:#fff");
}
