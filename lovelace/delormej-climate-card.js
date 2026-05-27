/**
 * delormej-climate-card
 *
 * Lovelace card for one zone of the delormej_climate integration.
 *
 * Usage:
 *   type: custom:delormej-climate-card
 *   zone: rdc                            # required — the zone id (the entity slug after "delormej_climate_")
 *   title: Salon                         # optional — header label override
 *   climate_entity: climate.salon        # optional — to show the underlying AC's current setpoint
 *
 * No build step. Drop this file into /config/www/delormej-climate-card.js
 * and register it as a resource at /local/delormej-climate-card.js (module).
 */

class DelormejClimateCard extends HTMLElement {
  /* ------------------------------------------------------------------ config */

  setConfig(config) {
    if (!config?.zone) {
      throw new Error("Required: `zone` (the zone id, e.g. 'rdc')");
    }
    this._config = config;
    this._zone = config.zone;
    this._title = config.title || config.zone;
    this._climateEntity = config.climate_entity;
    this._rendered = false;
  }

  static getConfigElement() {
    return document.createElement("hui-generic-entity-row");
  }

  static getStubConfig() {
    return { type: "custom:delormej-climate-card", zone: "rdc" };
  }

  getCardSize() {
    return 6;
  }

  /* ----------------------------------------------------------------- entity ids */

  _ent(kind, suffix) {
    return `${kind}.delormej_climate_${this._zone}_${suffix}`;
  }

  _entityIds() {
    return {
      state: this._ent("sensor", "state"),
      regime: this._ent("sensor", "regime"),
      roomTemp: this._ent("sensor", "room_temperature_average"),
      setpointSent: this._ent("sensor", "setpoint_sent"),
      overrideUntil: this._ent("sensor", "override_until"),
      autoSwitch: this._ent("switch", "auto_control"),
      modeSelect: this._ent("select", "mode"),
      heatStart: this._ent("number", "heat_start_threshold"),
      heatStop: this._ent("number", "heat_stop_threshold"),
      coolStart: this._ent("number", "cool_start_threshold"),
      coolStop: this._ent("number", "cool_stop_threshold"),
      stabDuration: this._ent("number", "stabilization_duration"),
      cooldownDuration: this._ent("number", "cooldown_duration"),
      overrideDuration: this._ent("number", "override_duration"),
      boostBtn: this._ent("button", "boost_15_min"),
      resumeAutoBtn: this._ent("button", "resume_auto"),
    };
  }

  /* ------------------------------------------------------------------ render */

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered) {
      this._render();
      this._rendered = true;
    } else {
      this._update();
    }
  }

  _render() {
    const root = document.createElement("ha-card");
    root.classList.add("delormej-climate-card");

    const style = document.createElement("style");
    style.textContent = `
      ha-card.delormej-climate-card { padding: 16px; }
      .header { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
      .header .name { font-size: 1.2em; font-weight: 600; flex: 1; }
      .badge {
        display: inline-block; padding: 2px 8px; border-radius: 999px;
        font-size: 0.8em; font-weight: 600; text-transform: capitalize;
        background: var(--state-icon-color, #888); color: white;
      }
      .badge.idle { background: #6c757d; }
      .badge.starting { background: #fd7e14; }
      .badge.running { background: #28a745; }
      .badge.stabilizing { background: #17a2b8; }
      .badge.cooldown { background: #6f42c1; }
      .badge.schedule_off { background: #495057; }
      .badge.manual_override_timed, .badge.manual_override_free { background: #e83e8c; }
      .badge.window_open { background: #ffc107; color: #212529; }
      .row { display: flex; align-items: baseline; gap: 12px; margin: 6px 0; }
      .row .label { color: var(--secondary-text-color); flex: 1; }
      .row .val { font-variant-numeric: tabular-nums; font-weight: 500; }
      .hero { display: flex; align-items: baseline; gap: 14px; margin: 12px 0 14px 0; }
      .hero .temp { font-size: 2.6em; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
      .hero .unit { font-size: 1.2em; color: var(--secondary-text-color); }
      .hero .regime { margin-left: auto; font-size: 0.9em; color: var(--secondary-text-color); }
      .ctx-icons { display: flex; gap: 8px; align-items: center; font-size: 0.85em; color: var(--secondary-text-color); margin: 6px 0 10px 0; }
      .ctx-icons .pill {
        display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
        border-radius: 999px; background: var(--secondary-background-color, #2a2a2a);
      }
      .ctx-icons .pill.warn { background: #ffc10733; color: #ffc107; }
      .controls { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      .controls button {
        flex: 1; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--divider-color, #444);
        background: var(--card-background-color, transparent); color: inherit; cursor: pointer;
        font-weight: 500;
      }
      .controls button:hover { background: var(--secondary-background-color); }
      .controls button.primary { background: var(--primary-color); color: var(--text-primary-color, white); border-color: transparent; }
      .controls button:disabled { opacity: 0.4; cursor: not-allowed; }
      .mode-select { padding: 4px 8px; border-radius: 6px; background: var(--secondary-background-color); color: inherit; border: 1px solid var(--divider-color); }
      details.thresholds { margin-top: 14px; border-top: 1px solid var(--divider-color, #333); padding-top: 8px; }
      details.thresholds summary { cursor: pointer; color: var(--secondary-text-color); font-size: 0.9em; }
      .slider-row { display: grid; grid-template-columns: 1fr 60px 24px; gap: 6px; align-items: center; margin: 6px 0; font-size: 0.9em; }
      .slider-row .lbl { color: var(--secondary-text-color); }
      .slider-row input[type=number] { width: 100%; padding: 4px; border-radius: 4px; border: 1px solid var(--divider-color); background: transparent; color: inherit; }
      .err { color: #dc3545; font-size: 0.85em; margin-top: 6px; }
    `;

    root.appendChild(style);

    const body = document.createElement("div");
    body.classList.add("body");
    body.innerHTML = `
      <div class="header">
        <div class="name">${this._title}</div>
        <span class="badge" data-bind="state-badge">—</span>
      </div>
      <div class="hero">
        <div class="temp" data-bind="room-temp">—</div>
        <div class="unit">°C</div>
        <div class="regime" data-bind="regime">—</div>
      </div>
      <div class="ctx-icons" data-bind="ctx-icons"></div>

      <div class="row"><div class="label">Consigne envoyée</div><div class="val" data-bind="setpoint-sent">—</div></div>
      <div class="row"><div class="label">T° interne clim</div><div class="val" data-bind="climate-internal">—</div></div>
      <div class="row"><div class="label">Consigne actuelle clim</div><div class="val" data-bind="climate-setpoint">—</div></div>
      <div class="row" data-bind="override-row" style="display:none">
        <div class="label">Override jusqu'à</div><div class="val" data-bind="override-until">—</div>
      </div>

      <div class="controls">
        <select class="mode-select" data-bind="mode-select">
          <option value="auto">Auto</option>
          <option value="off">Off</option>
          <option value="boost">Boost</option>
        </select>
        <button class="primary" data-bind="boost-btn" title="Boost 15 min">⚡ Boost</button>
        <button data-bind="resume-btn" title="Reprendre auto">↺ Reprendre</button>
      </div>

      <details class="thresholds">
        <summary>Seuils & durées</summary>
        <div class="slider-row"><span class="lbl">Début chauffage</span><input type="number" step="0.5" data-bind="num-heatStart"><span>°C</span></div>
        <div class="slider-row"><span class="lbl">Fin chauffage</span><input type="number" step="0.5" data-bind="num-heatStop"><span>°C</span></div>
        <div class="slider-row"><span class="lbl">Début refroidissement</span><input type="number" step="0.5" data-bind="num-coolStart"><span>°C</span></div>
        <div class="slider-row"><span class="lbl">Fin refroidissement</span><input type="number" step="0.5" data-bind="num-coolStop"><span>°C</span></div>
        <div class="slider-row"><span class="lbl">Stabilisation</span><input type="number" step="1" data-bind="num-stabDuration"><span>min</span></div>
        <div class="slider-row"><span class="lbl">Cooldown</span><input type="number" step="1" data-bind="num-cooldownDuration"><span>min</span></div>
        <div class="slider-row"><span class="lbl">Override max</span><input type="number" step="1" data-bind="num-overrideDuration"><span>min</span></div>
      </details>
      <div class="err" data-bind="error" style="display:none"></div>
    `;
    root.appendChild(body);
    this.appendChild(root);

    this._wireUp();
    this._update();
  }

  _wireUp() {
    const ids = this._entityIds();
    const $ = (sel) => this.querySelector(`[data-bind="${sel}"]`);

    $("mode-select").addEventListener("change", (e) => {
      this._call("select", "select_option", { entity_id: ids.modeSelect, option: e.target.value });
    });
    $("boost-btn").addEventListener("click", () => {
      this._call("button", "press", { entity_id: ids.boostBtn });
    });
    $("resume-btn").addEventListener("click", () => {
      this._call("button", "press", { entity_id: ids.resumeAutoBtn });
    });

    const numMap = {
      heatStart: ids.heatStart, heatStop: ids.heatStop,
      coolStart: ids.coolStart, coolStop: ids.coolStop,
      stabDuration: ids.stabDuration, cooldownDuration: ids.cooldownDuration,
      overrideDuration: ids.overrideDuration,
    };
    for (const [key, entity] of Object.entries(numMap)) {
      const el = $(`num-${key}`);
      if (el) {
        el.addEventListener("change", (e) => {
          this._call("number", "set_value", { entity_id: entity, value: parseFloat(e.target.value) });
        });
      }
    }
  }

  _call(domain, service, data) {
    if (!this._hass) return;
    this._hass.callService(domain, service, data).catch((e) => {
      const errEl = this.querySelector('[data-bind="error"]');
      if (errEl) {
        errEl.textContent = `${domain}.${service} failed: ${e?.message || e}`;
        errEl.style.display = "block";
        setTimeout(() => (errEl.style.display = "none"), 4000);
      }
    });
  }

  _update() {
    if (!this._hass) return;
    const states = this._hass.states;
    const ids = this._entityIds();
    const $ = (sel) => this.querySelector(`[data-bind="${sel}"]`);
    const get = (eid) => states[eid];

    // State badge
    const stateObj = get(ids.state);
    const stateVal = stateObj?.state ?? "unknown";
    const badge = $("state-badge");
    badge.textContent = this._labelState(stateVal);
    badge.className = `badge ${stateVal}`;

    // Hero
    const roomObj = get(ids.roomTemp);
    $("room-temp").textContent = this._fmtTemp(roomObj?.state);
    $("regime").textContent = this._labelRegime(get(ids.regime)?.state);

    // Context icons (presence, schedule, window)
    const attrs = stateObj?.attributes || {};
    const ctxEl = $("ctx-icons");
    ctxEl.innerHTML = "";
    const addPill = (icon, txt, warn) => {
      const p = document.createElement("span");
      p.className = "pill" + (warn ? " warn" : "");
      p.textContent = `${icon} ${txt}`;
      ctxEl.appendChild(p);
    };
    if (attrs.schedule_on === false) addPill("⏰", "Hors planning", true);
    if (attrs.house_is_absent === true) addPill("🏃", "Maison absente");
    if (attrs.any_window_open === true) addPill("🪟", "Fenêtre ouverte", true);
    if (attrs.in_override === true) addPill("✋", "Override manuel", true);

    $("setpoint-sent").textContent = this._fmtTemp(get(ids.setpointSent)?.state);

    if (this._climateEntity) {
      const clim = get(this._climateEntity);
      $("climate-internal").textContent = this._fmtTemp(clim?.attributes?.current_temperature);
      $("climate-setpoint").textContent = this._fmtTemp(clim?.attributes?.temperature);
    } else {
      // Best effort: discover the underlying climate entity from the zone's coordinator
      // by looking at sensor.delormej_climate_<zone>_setpoint_sent attributes (none exposed)
      $("climate-internal").textContent = "—";
      $("climate-setpoint").textContent = "—";
    }

    // Override row
    const overrideUntil = get(ids.overrideUntil);
    if (overrideUntil && overrideUntil.state !== "unknown" && overrideUntil.state !== "unavailable") {
      $("override-row").style.display = "";
      $("override-until").textContent = this._fmtDateTime(overrideUntil.state);
    } else {
      $("override-row").style.display = "none";
    }

    // Mode select
    const modeObj = get(ids.modeSelect);
    if (modeObj) {
      const sel = $("mode-select");
      if (sel.value !== modeObj.state) sel.value = modeObj.state;
    }

    // Number fields
    const numMap = {
      heatStart: ids.heatStart, heatStop: ids.heatStop,
      coolStart: ids.coolStart, coolStop: ids.coolStop,
      stabDuration: ids.stabDuration, cooldownDuration: ids.cooldownDuration,
      overrideDuration: ids.overrideDuration,
    };
    for (const [key, entity] of Object.entries(numMap)) {
      const o = get(entity);
      const el = $(`num-${key}`);
      if (o && el && document.activeElement !== el) {
        el.value = o.state;
      }
    }
  }

  /* ------------------------------------------------------------------ helpers */

  _fmtTemp(v) {
    if (v === undefined || v === null || v === "unknown" || v === "unavailable") return "—";
    const f = parseFloat(v);
    if (Number.isNaN(f)) return "—";
    return f.toFixed(1);
  }

  _fmtDateTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString("fr-FR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
    } catch { return iso; }
  }

  _labelState(s) {
    return ({
      idle: "Inactif",
      starting: "Démarrage",
      running: "Actif",
      stabilizing: "Stabilisation",
      cooldown: "Cooldown",
      schedule_off: "Hors planning",
      manual_override_timed: "Override (timed)",
      manual_override_free: "Override (libre)",
      window_open: "Fenêtre ouverte",
    })[s] || s;
  }

  _labelRegime(r) {
    return ({
      none: "—",
      attaque: "Attaque",
      croisiere: "Croisière",
      approche: "Approche",
      stabilisation: "Stabilisation",
      boost: "Boost",
    })[r] || r || "—";
  }
}

customElements.define("delormej-climate-card", DelormejClimateCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "delormej-climate-card",
  name: "Delormej Climate Card",
  description: "Carte de pilotage d'une zone du composant delormej_climate.",
  preview: false,
});

console.info(
  "%c DELORMEJ-CLIMATE-CARD %c v0.1.0 ",
  "color: white; background: #28a745; font-weight: 700;",
  "color: #28a745; background: white; font-weight: 700;"
);
