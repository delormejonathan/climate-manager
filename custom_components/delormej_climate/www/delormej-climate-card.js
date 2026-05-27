/**
 * delormej-climate-card  v0.5.0
 *
 * Three-section layout for one zone of the delormej_climate integration:
 *   1. ÉTAT ACTUEL   — observability (T° hero, narrative, status pills, metrics)
 *   2. AUTOMATISATION — integration knobs (mode, agressivité, boost/resume)
 *   3. CONFIGURATION — manual clim controls + thresholds + durations
 *
 * Usage:
 *   type: custom:delormej-climate-card
 *   zone: rdc
 *   title: Salon (RDC)
 *   climate_entity: climate.salon
 */

const STATE_META = {
  idle:        { label: "Inactif",          color: "#6c757d", icon: "mdi:power-sleep" },
  starting:    { label: "Démarrage",        color: "#fd7e14", icon: "mdi:play-circle" },
  running:     { label: "Actif",            color: "#28a745", icon: "mdi:fan" },
  stabilizing: { label: "Stabilisation",    color: "#17a2b8", icon: "mdi:waves" },
  cooldown:    { label: "Cooldown",         color: "#6f42c1", icon: "mdi:timer-sand" },
  schedule_off:{ label: "Hors planning",    color: "#495057", icon: "mdi:clock-outline" },
  manual_override_timed: { label: "Override (timed)", color: "#e83e8c", icon: "mdi:account-clock" },
  manual_override_free:  { label: "Override libre",   color: "#e83e8c", icon: "mdi:account-edit" },
  window_open: { label: "Fenêtre ouverte",  color: "#ffc107", icon: "mdi:window-open" },
};

const REGIME_LABELS = {
  none: "—", attaque: "Attaque", croisiere: "Croisière",
  approche: "Approche", stabilisation: "Stabilisation", boost: "Boost",
};

const HVAC_ICONS = {
  off: "mdi:power", heat: "mdi:fire", cool: "mdi:snowflake",
  heat_cool: "mdi:autorenew", auto: "mdi:autorenew",
  dry: "mdi:water-percent", fan_only: "mdi:fan",
};
const HVAC_LABELS = {
  off: "Off", heat: "Chauffer", cool: "Refroidir",
  heat_cool: "Auto", auto: "Auto", dry: "Déshu.", fan_only: "Ventil.",
};
const HVAC_COLORS = {
  off: "#6c757d",
  heat: "#ff6b35",
  cool: "#4d8bff",
  heat_cool: "#45b7af",
  auto: "#45b7af",
  dry: "#efc439",
  fan_only: "#b1c1c0",
};

const SECTION_COLORS = {
  status: "#4d8bff",   // bleu — état actuel
  auto:   "#28a745",   // vert — automatisation
  config: "#fd7e14",   // orange — configuration (action user)
};


class DelormejClimateCard extends HTMLElement {
  setConfig(config) {
    if (!config?.zone) throw new Error("Required: `zone` (e.g. 'rdc')");
    this._config = config;
    this._zone = config.zone;
    this._title = config.title || this._capitalize(config.zone);
    this._climateEntity = config.climate_entity || null;
    this._rendered = false;
  }
  static getStubConfig() { return { type: "custom:delormej-climate-card", zone: "rdc" }; }
  getCardSize() { return 14; }

  _ent(kind, suffix) { return `${kind}.delormej_climate_${this._zone}_${suffix}`; }

  _ids() {
    return {
      state: this._ent("sensor", "state"),
      regime: this._ent("sensor", "regime"),
      roomTemp: this._ent("sensor", "room_temperature_average"),
      setpointSent: this._ent("sensor", "setpoint_sent"),
      overrideUntil: this._ent("sensor", "override_until"),
      modeSelect: this._ent("select", "mode"),
      aggressivitySelect: this._ent("select", "aggressivity"),
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

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered) { this._render(); this._rendered = true; }
    this._update();
  }

  /* =================================================================== render */

  _render() {
    const card = document.createElement("ha-card");
    card.classList.add("dc-card");
    const style = document.createElement("style");
    style.textContent = STYLES;
    card.appendChild(style);
    const body = document.createElement("div");
    body.innerHTML = TEMPLATE;
    card.appendChild(body);
    this.appendChild(card);

    const titleEl = this.querySelector('[data-bind="title-text"]');
    if (titleEl) titleEl.textContent = this._title;
    const subEl = this.querySelector('[data-bind="subtitle"]');
    if (subEl) subEl.textContent = this._climateEntity || "";

    this._wireUp();
  }

  _wireUp() {
    const ids = this._ids();
    const $ = (sel) => this.querySelector(`[data-bind="${sel}"]`);

    // Mode pilotage
    $("mode").querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => this._call("select", "select_option",
        { entity_id: ids.modeSelect, option: b.dataset.mode }));
    });
    // Agressivité
    $("aggressivity").querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => this._call("select", "select_option",
        { entity_id: ids.aggressivitySelect, option: b.dataset.aggressivity }));
    });
    // Quick actions
    $("boost-btn").addEventListener("click", () =>
      this._call("button", "press", { entity_id: ids.boostBtn }));
    $("resume-btn").addEventListener("click", () =>
      this._call("button", "press", { entity_id: ids.resumeAutoBtn }));

    // Manual clim controls
    if (this._climateEntity) {
      $("hvac-modes").addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-hvac]");
        if (!btn) return;
        this._call("climate", "set_hvac_mode",
          { entity_id: this._climateEntity, hvac_mode: btn.dataset.hvac });
      });
      $("sp-dec").addEventListener("click", () => this._bumpSetpoint(-1));
      $("sp-inc").addEventListener("click", () => this._bumpSetpoint(+1));
      $("fan-select").addEventListener("change", (e) =>
        this._call("climate", "set_fan_mode",
          { entity_id: this._climateEntity, fan_mode: e.target.value }));
      $("swing-select").addEventListener("change", (e) =>
        this._call("climate", "set_swing_mode",
          { entity_id: this._climateEntity, swing_mode: e.target.value }));
    }

    // Number inputs (thresholds + durations)
    const numMap = {
      heatStart: ids.heatStart, heatStop: ids.heatStop,
      coolStart: ids.coolStart, coolStop: ids.coolStop,
      stabDuration: ids.stabDuration, cooldownDuration: ids.cooldownDuration,
      overrideDuration: ids.overrideDuration,
    };
    for (const [key, entity] of Object.entries(numMap)) {
      const el = $(`num-${key}`);
      if (el) el.addEventListener("change", (e) =>
        this._call("number", "set_value", { entity_id: entity, value: parseFloat(e.target.value) }));
    }
  }

  _bumpSetpoint(dir) {
    if (!this._climateEntity || !this._hass) return;
    const clim = this._hass.states[this._climateEntity];
    if (!clim) return;
    const cur = parseFloat(clim.attributes.temperature);
    const step = parseFloat(clim.attributes.target_temp_step) || 0.5;
    if (Number.isNaN(cur)) return;
    const next = Math.round((cur + dir * step) * 2) / 2;
    this._call("climate", "set_temperature",
      { entity_id: this._climateEntity, temperature: next });
  }

  /* =================================================================== update */

  _update() {
    if (!this._hass) return;
    const $ = (sel) => this.querySelector(`[data-bind="${sel}"]`);
    const states = this._hass.states;
    const ids = this._ids();
    const get = (eid) => states[eid];

    // ─────────────────── HEADER + STATE BADGE
    const stateObj = get(ids.state);
    const stateVal = stateObj?.state ?? "unknown";
    const meta = STATE_META[stateVal] || { label: stateVal, color: "#6c757d", icon: "mdi:help-circle" };
    const badge = $("state-badge");
    badge.style.setProperty("--dc-state-color", meta.color);
    $("state-icon").setAttribute("icon", meta.icon);
    $("state-label").textContent = meta.label;
    const attrs = stateObj?.attributes || {};
    const regimeVal = get(ids.regime)?.state;
    const regimeLabel = REGIME_LABELS[regimeVal] || "—";
    $("header-regime").textContent = regimeLabel;
    $("header-regime").style.display = regimeLabel === "—" ? "none" : "";

    // ─────────────────── SECTION 1: ÉTAT ACTUEL
    $("room-temp").textContent = this._fmtTemp(get(ids.roomTemp)?.state);
    const target = attrs.target_temperature;
    const targetBlock = $("target-block");
    if (target != null) {
      targetBlock.style.visibility = "";
      $("target-temp").textContent = this._fmtTemp(target);
      const dir = attrs.direction;
      $("target-arrow").setAttribute("icon",
        dir === "cool" ? "mdi:arrow-down-bold" :
        dir === "heat" ? "mdi:arrow-up-bold" : "mdi:arrow-right-bold");
      $("target-arrow").style.color =
        dir === "cool" ? HVAC_COLORS.cool :
        dir === "heat" ? HVAC_COLORS.heat : "var(--secondary-text-color)";
    } else {
      targetBlock.style.visibility = "hidden";
    }

    // Narrative
    const nar = this._buildNarrative(stateVal, regimeVal, attrs, get, ids);
    const narEl = $("narrative");
    narEl.innerHTML = nar.html;
    narEl.classList.toggle("warn", !!nar.warn);

    // Status pills — always show, color-coded by state
    const pills = $("status-pills");
    pills.innerHTML = "";
    pills.appendChild(this._pill(
      attrs.schedule_on === false ? "mdi:clock-remove" : "mdi:clock-check",
      attrs.schedule_on === false ? "Hors planning" : "Planning ouvert",
      attrs.schedule_on === false ? "warn" : "ok"));
    pills.appendChild(this._pill(
      attrs.house_is_absent === true ? "mdi:home-export-outline" : "mdi:home",
      attrs.house_is_absent === true ? "Maison absente" : "Maison présente",
      attrs.house_is_absent === true ? "info" : "neutral"));
    pills.appendChild(this._pill(
      attrs.any_window_open === true ? "mdi:window-open" : "mdi:window-closed",
      attrs.any_window_open === true ? "Fenêtre ouverte" : "Fenêtres OK",
      attrs.any_window_open === true ? "warn" : "ok"));
    if (attrs.in_override === true) {
      pills.appendChild(this._pill("mdi:account-edit", "Override actif", "warn"));
    }

    // Metrics grid (2x2)
    $("metric-setpoint-sent").textContent = this._fmtTempUnit(get(ids.setpointSent)?.state);
    const climObj = this._climateEntity ? get(this._climateEntity) : null;
    $("metric-clim-setpoint").textContent =
      climObj ? this._fmtTempUnit(climObj.attributes.temperature) : "—";
    $("metric-clim-sonde").textContent =
      climObj ? this._fmtTempUnit(climObj.attributes.current_temperature) : "—";
    $("metric-regime").textContent = regimeLabel;

    // Override row
    const overrideUntil = get(ids.overrideUntil);
    const overrideRow = $("override-row");
    if (overrideUntil && overrideUntil.state !== "unknown" && overrideUntil.state !== "unavailable") {
      overrideRow.style.display = "";
      $("override-until-val").textContent = this._fmtTime(overrideUntil.state);
    } else {
      overrideRow.style.display = "none";
    }

    // ─────────────────── SECTION 2: AUTOMATISATION
    const currentMode = get(ids.modeSelect)?.state;
    $("mode").querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === currentMode));

    const currentAgg = get(ids.aggressivitySelect)?.state || attrs.aggressivity || "normal";
    $("aggressivity").querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.aggressivity === currentAgg));

    const inOverride = attrs.in_override === true;
    const resumeBtn = $("resume-btn");
    resumeBtn.disabled = !inOverride;
    resumeBtn.title = inOverride ? "Annule l'override en cours" : "Aucun override en cours";

    // ─────────────────── SECTION 3: CONFIGURATION
    const climBlock = $("manual-clim-block");
    if (!this._climateEntity || !climObj) {
      climBlock.style.display = "none";
    } else {
      climBlock.style.display = "";
      this._renderHvacModes($("hvac-modes"), climObj);
      $("setpoint").textContent = this._fmtTemp(climObj.attributes.temperature);
      this._renderSelectOptions($("fan-select"), climObj.attributes.fan_modes, climObj.attributes.fan_mode);
      this._renderSelectOptions($("swing-select"), climObj.attributes.swing_modes, climObj.attributes.swing_mode);
    }

    // Number inputs
    const numMap = {
      heatStart: ids.heatStart, heatStop: ids.heatStop,
      coolStart: ids.coolStart, coolStop: ids.coolStop,
      stabDuration: ids.stabDuration, cooldownDuration: ids.cooldownDuration,
      overrideDuration: ids.overrideDuration,
    };
    for (const [key, entity] of Object.entries(numMap)) {
      const o = get(entity);
      const el = $(`num-${key}`);
      if (o && el && document.activeElement !== el) el.value = o.state;
    }
  }

  _renderHvacModes(container, clim) {
    const modes = clim.attributes.hvac_modes || ["off", "cool", "heat", "auto"];
    const current = clim.state;
    const sig = modes.join(",") + "|" + current;
    if (container.dataset.sig === sig) return;
    container.dataset.sig = sig;
    container.innerHTML = "";
    for (const m of modes) {
      const btn = document.createElement("button");
      btn.dataset.hvac = m;
      btn.title = HVAC_LABELS[m] || m;
      btn.classList.toggle("active", m === current);
      if (m === current) btn.style.setProperty("--hvac-color", HVAC_COLORS[m] || "var(--primary-color)");
      const wrap = document.createElement("div");
      const ic = document.createElement("ha-icon");
      ic.setAttribute("icon", HVAC_ICONS[m] || "mdi:dots-horizontal");
      const lbl = document.createElement("span");
      lbl.textContent = HVAC_LABELS[m] || m;
      wrap.appendChild(ic);
      wrap.appendChild(lbl);
      btn.appendChild(wrap);
      container.appendChild(btn);
    }
  }

  _renderSelectOptions(select, options, current) {
    options = options || [];
    if (select.dataset.options !== options.join(",")) {
      select.innerHTML = "";
      for (const o of options) {
        const opt = document.createElement("option");
        opt.value = o;
        opt.textContent = this._capitalize(o);
        select.appendChild(opt);
      }
      select.dataset.options = options.join(",");
    }
    if (current && select.value !== current) select.value = current;
  }

  /* =================================================================== narrative */

  _buildNarrative(state, regime, attrs, get, ids) {
    const dir = attrs.direction;
    const target = attrs.target_temperature;
    const targetSpan = (t) => `<span class="target">${this._fmtTemp(t)}°C</span>`;
    const verb = dir === "heat" ? "Chauffage" : "Refroidissement";

    if (state === "idle") {
      const heatStart = parseFloat(get(ids.heatStart)?.state);
      const coolStart = parseFloat(get(ids.coolStart)?.state);
      const room = parseFloat(get(ids.roomTemp)?.state);
      let parts = [];
      if (!Number.isNaN(coolStart)) parts.push(`refroidira > ${coolStart}°C`);
      if (!Number.isNaN(heatStart)) parts.push(`chauffera < ${heatStart}°C`);
      let hint = "";
      if (!Number.isNaN(room) && !Number.isNaN(coolStart) && !Number.isNaN(heatStart)) {
        const dToCool = coolStart - room, dToHeat = room - heatStart;
        if (dToCool > 0 && dToCool < dToHeat) hint = ` · <span class="until">${dToCool.toFixed(1)}°C avant cool</span>`;
        else if (dToHeat > 0 && dToHeat < dToCool) hint = ` · <span class="until">${dToHeat.toFixed(1)}°C avant heat</span>`;
      }
      return { html: `En attente. ${parts.join(" / ")}${hint}.`, warn: false };
    }
    if (state === "starting")
      return { html: `Démarrage ${dir === "heat" ? "chauffage" : "refroidissement"} vers ${targetSpan(target)}.`, warn: false };
    if (state === "running") {
      const reg = {
        attaque: `${verb} intensif vers ${targetSpan(target)}.`,
        croisiere: `${verb} en cours vers ${targetSpan(target)}.`,
        approche: `Approche de ${targetSpan(target)}.`,
        boost: `Boost ${dir === "heat" ? "chauffage" : "refroidissement"} vers ${targetSpan(target)}.`,
      }[regime] || `${verb} en cours.`;
      return { html: reg, warn: false };
    }
    if (state === "stabilizing") {
      const until = attrs.stabilization_ends_at;
      const t = until ? ` jusqu'à <span class="until">${this._fmtTime(until)}</span>` : "";
      return { html: `Stabilisation à ${targetSpan(target)}${t}.`, warn: false };
    }
    if (state === "cooldown") {
      const until = attrs.cooldown_ends_at;
      const t = until ? ` jusqu'à <span class="until">${this._fmtTime(until)}</span>` : "";
      return { html: `Pause anti-rebond${t}.`, warn: false };
    }
    if (state === "schedule_off") return { html: "Hors plage planning, pilotage auto désactivé.", warn: true };
    if (state === "manual_override_timed") {
      const u = get(ids.overrideUntil)?.state;
      const t = u && u !== "unknown" ? ` jusqu'à <span class="until">${this._fmtTime(u)}</span>` : "";
      return { html: `Override manuel${t}.`, warn: true };
    }
    if (state === "manual_override_free") return { html: "Pilotage manuel libre.", warn: true };
    if (state === "window_open") return { html: "Fenêtre ouverte, clim en pause.", warn: true };
    return { html: "", warn: false };
  }

  /* =================================================================== helpers */

  _pill(icon, text, cls = "neutral") {
    const div = document.createElement("div");
    div.className = `dc-pill dc-pill--${cls}`;
    div.innerHTML = `<ha-icon icon="${icon}"></ha-icon><span>${this._escapeHTML(text)}</span>`;
    return div;
  }
  _call(domain, service, data) {
    if (!this._hass) return;
    const err = this.querySelector('[data-bind="error"]');
    err.textContent = "";
    this._hass.callService(domain, service, data).catch((e) => {
      err.textContent = `${domain}.${service} : ${e?.message || e}`;
      setTimeout(() => (err.textContent = ""), 4500);
    });
  }
  _fmtTemp(v) { if (v == null || v === "unknown" || v === "unavailable") return "—";
    const f = parseFloat(v); return Number.isNaN(f) ? "—" : f.toFixed(1); }
  _fmtTempUnit(v) { const t = this._fmtTemp(v); return t === "—" ? "—" : `${t} °C`; }
  _fmtTime(iso) { try { return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); } catch { return iso; } }
  _escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  _capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
}


const STYLES = `
  ha-card.dc-card {
    --dc-pad: 16px;
    --dc-radius: 12px;
    --dc-radius-sm: 8px;
    --dc-divider: var(--divider-color, rgba(255,255,255,0.08));
    --dc-muted: var(--secondary-text-color, #8a8a8a);
    --dc-fg: var(--primary-text-color, #fff);
    --dc-bg-soft: rgba(255,255,255,0.025);
    --dc-bg-section: rgba(255,255,255,0.015);
    padding: 0; overflow: hidden;
    border-radius: var(--ha-card-border-radius, var(--dc-radius));
  }

  /* ============ HEADER ============ */
  .dc-header {
    display: flex; align-items: center; gap: 12px;
    padding: var(--dc-pad);
    background: linear-gradient(180deg, var(--dc-bg-soft), transparent);
    border-bottom: 1px solid var(--dc-divider);
  }
  .dc-header .title-block { flex: 1; min-width: 0; }
  .dc-header .title { font-size: 1.15em; font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; }
  .dc-header .subtitle {
    font-size: 0.75em; color: var(--dc-muted); margin-top: 2px;
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
  }
  .dc-header .head-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .dc-state {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 11px; border-radius: 999px;
    font-size: 0.78em; font-weight: 700; color: white;
    background: var(--dc-state-color, #6c757d);
    box-shadow: 0 1px 4px rgba(0,0,0,0.15);
    white-space: nowrap;
  }
  .dc-state ha-icon { --mdc-icon-size: 14px; }
  .dc-header .head-regime {
    font-size: 0.75em; color: var(--dc-muted);
    text-transform: uppercase; letter-spacing: 0.05em;
  }

  /* ============ SECTIONS (3 buckets) ============ */
  .dc-section {
    position: relative;
    padding: 18px var(--dc-pad) 18px calc(var(--dc-pad) + 8px);
    border-bottom: 1px solid var(--dc-divider);
  }
  .dc-section:last-child { border-bottom: none; }
  .dc-section::before {
    content: ""; position: absolute; left: var(--dc-pad); top: 18px; bottom: 18px;
    width: 3px; border-radius: 2px;
    background: var(--dc-section-accent, var(--dc-muted));
  }
  .dc-section.section-status { --dc-section-accent: ${SECTION_COLORS.status}; }
  .dc-section.section-auto   { --dc-section-accent: ${SECTION_COLORS.auto}; }
  .dc-section.section-config { --dc-section-accent: ${SECTION_COLORS.config}; }
  .dc-section-head {
    display: flex; align-items: center; gap: 8px; margin-bottom: 14px;
    color: var(--dc-section-accent, var(--dc-muted));
  }
  .dc-section-head ha-icon { --mdc-icon-size: 18px; }
  .dc-section-head .lbl {
    font-size: 0.78em; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.08em;
  }

  /* ============ §1 ÉTAT ACTUEL ============ */
  .dc-hero {
    display: flex; align-items: center; justify-content: center;
    gap: 18px; margin-bottom: 12px;
  }
  .dc-hero .room-block { text-align: center; }
  .dc-hero .room {
    font-size: 2.8em; font-weight: 800; line-height: 1;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }
  .dc-hero .room .unit { font-size: 0.35em; color: var(--dc-muted); font-weight: 500; margin-left: 2px; }
  .dc-hero .room-label {
    font-size: 0.7em; color: var(--dc-muted); margin-top: 4px;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .dc-hero .target-block {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    padding: 8px 14px; border-radius: var(--dc-radius-sm);
    background: var(--dc-bg-soft);
  }
  .dc-hero .target-block ha-icon { --mdc-icon-size: 22px; }
  .dc-hero .target-block .target {
    font-size: 1.3em; font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .dc-hero .target-block .target-label {
    font-size: 0.65em; color: var(--dc-muted);
    text-transform: uppercase; letter-spacing: 0.06em;
  }

  .dc-narrative {
    text-align: center; margin: 0 0 14px;
    font-size: 0.98em; line-height: 1.4; color: var(--dc-fg);
  }
  .dc-narrative .target { color: var(--primary-color); font-weight: 700; font-variant-numeric: tabular-nums; }
  .dc-narrative .until { color: var(--dc-muted); font-variant-numeric: tabular-nums; }
  .dc-narrative.warn { color: var(--warning-color, #ffc107); }

  .dc-pills { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-bottom: 14px; }
  .dc-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 0.78em;
    background: var(--dc-bg-soft);
    color: var(--dc-muted);
    border: 1px solid var(--dc-divider);
  }
  .dc-pill ha-icon { --mdc-icon-size: 13px; }
  .dc-pill--ok    { color: var(--success-color, #28a745); border-color: rgba(40,167,69,0.3); background: rgba(40,167,69,0.08); }
  .dc-pill--warn  { color: var(--warning-color, #ffc107); border-color: rgba(255,193,7,0.3); background: rgba(255,193,7,0.1); }
  .dc-pill--info  { color: var(--info-color, #5e9eff); border-color: rgba(94,158,255,0.3); background: rgba(94,158,255,0.08); }
  .dc-pill--neutral { /* defaults */ }

  .dc-metrics {
    display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
    background: var(--dc-divider);
    border-radius: var(--dc-radius-sm); overflow: hidden;
    border: 1px solid var(--dc-divider);
  }
  .dc-metric {
    background: var(--card-background-color, #1a1a1a);
    padding: 10px 12px;
    display: flex; flex-direction: column; gap: 3px;
  }
  .dc-metric .label {
    font-size: 0.68em; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--dc-muted); font-weight: 600;
  }
  .dc-metric .value {
    font-size: 1.05em; font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .dc-override-row {
    margin-top: 10px; padding: 8px 12px;
    background: rgba(232,62,140,0.1); border: 1px solid rgba(232,62,140,0.3);
    border-radius: var(--dc-radius-sm);
    display: flex; justify-content: space-between; align-items: center;
    font-size: 0.88em; color: var(--dc-fg);
  }
  .dc-override-row .lbl { color: var(--dc-muted); }
  .dc-override-row .val { font-weight: 700; font-variant-numeric: tabular-nums; }

  /* ============ §2 AUTOMATISATION ============ */
  .dc-control { margin-bottom: 14px; }
  .dc-control:last-child { margin-bottom: 0; }
  .dc-control-label {
    font-size: 0.74em; color: var(--dc-muted); font-weight: 600;
    margin-bottom: 6px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .dc-segmented {
    display: flex; background: var(--dc-bg-soft); border-radius: var(--dc-radius-sm);
    padding: 4px; border: 1px solid var(--dc-divider);
  }
  .dc-segmented button {
    flex: 1; padding: 9px 12px; border: none; background: transparent;
    color: var(--dc-muted); font-size: 0.92em; font-weight: 600;
    cursor: pointer; border-radius: 6px;
    transition: background 0.15s, color 0.15s;
  }
  .dc-segmented button:hover { color: var(--dc-fg); }
  .dc-segmented button.active {
    background: var(--card-background-color, #1a1a1a);
    color: var(--dc-fg);
    box-shadow: 0 1px 3px rgba(0,0,0,0.25);
  }
  .dc-segmented.tone-warn button.active[data-mode="boost"],
  .dc-segmented.tone-warn button.active[data-aggressivity="agressif"] { color: var(--warning-color, #ffc107); }
  .dc-segmented.tone-danger button.active[data-mode="off"] { color: var(--error-color, #dc3545); }

  .dc-quick-actions {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  }
  .dc-quick-actions button {
    padding: 11px; border-radius: var(--dc-radius-sm);
    border: 1px solid var(--dc-divider); background: var(--dc-bg-soft);
    color: var(--dc-fg); cursor: pointer; font-weight: 600; font-size: 0.9em;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    transition: background 0.15s;
  }
  .dc-quick-actions button ha-icon { --mdc-icon-size: 16px; }
  .dc-quick-actions button:hover:not(:disabled) { background: var(--dc-divider); }
  .dc-quick-actions button:disabled { opacity: 0.35; cursor: not-allowed; }
  .dc-quick-actions button[data-bind="boost-btn"] { color: var(--warning-color, #ffc107); }

  /* ============ §3 CONFIGURATION ============ */
  .dc-subblock {
    background: var(--dc-bg-soft); border: 1px solid var(--dc-divider);
    border-radius: var(--dc-radius-sm); padding: 12px; margin-bottom: 12px;
  }
  .dc-subblock:last-child { margin-bottom: 0; }
  .dc-subblock-title {
    font-size: 0.74em; color: var(--dc-muted); font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em;
    margin-bottom: 10px;
    display: flex; align-items: center; gap: 6px;
  }
  .dc-subblock-title ha-icon { --mdc-icon-size: 14px; }

  /* HVAC chiclets */
  .dc-hvac { display: flex; gap: 6px; }
  .dc-hvac button {
    flex: 1; padding: 8px 4px; border-radius: var(--dc-radius-sm);
    background: var(--card-background-color, #1a1a1a);
    border: 1px solid var(--dc-divider);
    color: var(--dc-muted); cursor: pointer;
    transition: all 0.15s;
  }
  .dc-hvac button > div { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .dc-hvac button ha-icon { --mdc-icon-size: 18px; }
  .dc-hvac button span { font-size: 0.7em; font-weight: 600; }
  .dc-hvac button:hover { color: var(--dc-fg); }
  .dc-hvac button.active {
    background: var(--hvac-color, var(--primary-color));
    border-color: transparent;
    color: white;
  }

  /* Setpoint */
  .dc-setpoint {
    display: flex; align-items: center; justify-content: center; gap: 18px;
    margin-top: 14px;
  }
  .dc-setpoint .sp-val { font-size: 1.7em; font-weight: 800; font-variant-numeric: tabular-nums; min-width: 88px; text-align: center; letter-spacing: -0.02em; }
  .dc-setpoint .sp-unit { font-size: 0.85em; color: var(--dc-muted); font-weight: 500; }
  .dc-setpoint button {
    width: 42px; height: 42px; border-radius: 50%;
    background: var(--card-background-color, #1a1a1a);
    border: 1px solid var(--dc-divider);
    color: var(--dc-fg); font-size: 1.4em; font-weight: 600;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
  }
  .dc-setpoint button:hover { background: var(--primary-color); border-color: transparent; color: white; }

  /* Fan + swing */
  .dc-fanswing { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
  .dc-fanswing .field { display: flex; flex-direction: column; gap: 4px; }
  .dc-fanswing label {
    font-size: 0.7em; color: var(--dc-muted); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .dc-fanswing select {
    background: var(--card-background-color, #1a1a1a);
    border: 1px solid var(--dc-divider);
    border-radius: 6px; color: var(--dc-fg); padding: 8px;
    font-size: 0.9em; font-weight: 500;
  }
  .dc-fanswing select:focus { outline: none; border-color: var(--primary-color); }

  /* Threshold pairs (start/stop side by side) */
  .dc-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .dc-field { display: flex; flex-direction: column; gap: 4px; }
  .dc-field label {
    font-size: 0.7em; color: var(--dc-muted); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .dc-input-wrap {
    display: flex; align-items: center; gap: 6px;
    background: var(--card-background-color, #1a1a1a);
    border: 1px solid var(--dc-divider); border-radius: 6px; padding: 0 10px;
  }
  .dc-input-wrap:focus-within { border-color: var(--primary-color); }
  .dc-input-wrap input {
    flex: 1; min-width: 0; padding: 8px 0; background: transparent; border: none;
    color: var(--dc-fg); font-size: 0.95em; font-weight: 600;
    font-variant-numeric: tabular-nums; text-align: right;
  }
  .dc-input-wrap input:focus { outline: none; }
  .dc-input-wrap .unit { font-size: 0.78em; color: var(--dc-muted); }

  .dc-triple { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }

  .dc-err {
    margin: 8px var(--dc-pad); padding: 10px;
    border-radius: var(--dc-radius-sm); background: rgba(220,53,69,0.12);
    color: var(--error-color, #dc3545); font-size: 0.85em;
    border: 1px solid rgba(220,53,69,0.3);
  }
  .dc-err:empty { display: none; }
`;

const TEMPLATE = `
  <div class="dc-header">
    <div class="title-block">
      <div class="title" data-bind="title-text"></div>
      <div class="subtitle" data-bind="subtitle"></div>
    </div>
    <div class="head-meta">
      <span class="dc-state" data-bind="state-badge">
        <ha-icon icon="mdi:circle-outline" data-bind="state-icon"></ha-icon>
        <span data-bind="state-label">—</span>
      </span>
      <span class="head-regime" data-bind="header-regime"></span>
    </div>
  </div>

  <!-- ════════════════════════════════════ §1 ÉTAT ACTUEL -->
  <section class="dc-section section-status">
    <div class="dc-section-head">
      <ha-icon icon="mdi:radar"></ha-icon>
      <span class="lbl">État actuel</span>
    </div>

    <div class="dc-hero">
      <div class="room-block">
        <div class="room"><span data-bind="room-temp">—</span><span class="unit">°C</span></div>
        <div class="room-label">T° zone</div>
      </div>
      <div class="target-block" data-bind="target-block">
        <ha-icon icon="mdi:arrow-right-bold" data-bind="target-arrow"></ha-icon>
        <span class="target"><span data-bind="target-temp">—</span> °C</span>
        <span class="target-label">cible</span>
      </div>
    </div>

    <div class="dc-narrative" data-bind="narrative"></div>

    <div class="dc-pills" data-bind="status-pills"></div>

    <div class="dc-metrics">
      <div class="dc-metric">
        <span class="label">Consigne envoyée</span>
        <span class="value" data-bind="metric-setpoint-sent">—</span>
      </div>
      <div class="dc-metric">
        <span class="label">Consigne clim</span>
        <span class="value" data-bind="metric-clim-setpoint">—</span>
      </div>
      <div class="dc-metric">
        <span class="label">Sonde clim</span>
        <span class="value" data-bind="metric-clim-sonde">—</span>
      </div>
      <div class="dc-metric">
        <span class="label">Régime</span>
        <span class="value" data-bind="metric-regime">—</span>
      </div>
    </div>

    <div class="dc-override-row" data-bind="override-row" style="display:none">
      <span class="lbl">⏱ Override actif jusqu'à</span>
      <span class="val" data-bind="override-until-val">—</span>
    </div>
  </section>

  <!-- ════════════════════════════════════ §2 AUTOMATISATION -->
  <section class="dc-section section-auto">
    <div class="dc-section-head">
      <ha-icon icon="mdi:robot"></ha-icon>
      <span class="lbl">Automatisation</span>
    </div>

    <div class="dc-control">
      <div class="dc-control-label">Mode pilotage</div>
      <div class="dc-segmented tone-warn tone-danger" data-bind="mode">
        <button data-mode="auto">Auto</button>
        <button data-mode="off">Off</button>
        <button data-mode="boost">Boost</button>
      </div>
    </div>

    <div class="dc-control">
      <div class="dc-control-label">Agressivité</div>
      <div class="dc-segmented tone-warn" data-bind="aggressivity">
        <button data-aggressivity="doux">Doux</button>
        <button data-aggressivity="normal">Normal</button>
        <button data-aggressivity="agressif">Agressif</button>
      </div>
    </div>

    <div class="dc-control">
      <div class="dc-control-label">Actions rapides</div>
      <div class="dc-quick-actions">
        <button data-bind="boost-btn"><ha-icon icon="mdi:rocket-launch"></ha-icon> Boost 15 min</button>
        <button data-bind="resume-btn"><ha-icon icon="mdi:restore"></ha-icon> Reprendre auto</button>
      </div>
    </div>
  </section>

  <!-- ════════════════════════════════════ §3 CONFIGURATION -->
  <section class="dc-section section-config">
    <div class="dc-section-head">
      <ha-icon icon="mdi:cog"></ha-icon>
      <span class="lbl">Configuration</span>
    </div>

    <div class="dc-subblock" data-bind="manual-clim-block">
      <div class="dc-subblock-title">
        <ha-icon icon="mdi:air-conditioner"></ha-icon> Contrôle direct climatisation
      </div>
      <div class="dc-hvac" data-bind="hvac-modes"></div>
      <div class="dc-setpoint">
        <button data-bind="sp-dec" title="Diminuer">−</button>
        <div>
          <div class="sp-val"><span data-bind="setpoint">—</span><span class="sp-unit"> °C</span></div>
        </div>
        <button data-bind="sp-inc" title="Augmenter">+</button>
      </div>
      <div class="dc-fanswing">
        <div class="field">
          <label>Ventilation</label>
          <select data-bind="fan-select"></select>
        </div>
        <div class="field">
          <label>Swing</label>
          <select data-bind="swing-select"></select>
        </div>
      </div>
    </div>

    <div class="dc-subblock">
      <div class="dc-subblock-title">
        <ha-icon icon="mdi:thermometer-chevron-up"></ha-icon> Seuils chauffage
      </div>
      <div class="dc-pair">
        <div class="dc-field">
          <label>Démarrage</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-bind="num-heatStart"><span class="unit">°C</span></div>
        </div>
        <div class="dc-field">
          <label>Arrêt</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-bind="num-heatStop"><span class="unit">°C</span></div>
        </div>
      </div>
    </div>

    <div class="dc-subblock">
      <div class="dc-subblock-title">
        <ha-icon icon="mdi:thermometer-chevron-down"></ha-icon> Seuils refroidissement
      </div>
      <div class="dc-pair">
        <div class="dc-field">
          <label>Démarrage</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-bind="num-coolStart"><span class="unit">°C</span></div>
        </div>
        <div class="dc-field">
          <label>Arrêt</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-bind="num-coolStop"><span class="unit">°C</span></div>
        </div>
      </div>
    </div>

    <div class="dc-subblock">
      <div class="dc-subblock-title">
        <ha-icon icon="mdi:timer-sand"></ha-icon> Temporisations
      </div>
      <div class="dc-triple">
        <div class="dc-field">
          <label>Stabilisation</label>
          <div class="dc-input-wrap"><input type="number" step="1" data-bind="num-stabDuration"><span class="unit">min</span></div>
        </div>
        <div class="dc-field">
          <label>Cooldown</label>
          <div class="dc-input-wrap"><input type="number" step="1" data-bind="num-cooldownDuration"><span class="unit">min</span></div>
        </div>
        <div class="dc-field">
          <label>Override max</label>
          <div class="dc-input-wrap"><input type="number" step="1" data-bind="num-overrideDuration"><span class="unit">min</span></div>
        </div>
      </div>
    </div>
  </section>

  <div class="dc-err" data-bind="error"></div>
`;

customElements.define("delormej-climate-card", DelormejClimateCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "delormej-climate-card",
  name: "Delormej Climate Card",
  description: "Carte tout-en-un en 3 sections : état, automatisation, configuration.",
  preview: false,
});

console.info(
  "%c DELORMEJ-CLIMATE-CARD %c v0.5.0 ",
  "color: white; background: #28a745; font-weight: 700;",
  "color: #28a745; background: white; font-weight: 700;"
);
