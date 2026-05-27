/**
 * delormej-climate-card  v0.6.2
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
  idle:        { label: "Inactif",          color: "#7a8290", icon: "mdi:power-sleep" },
  starting:    { label: "Démarrage",        color: "#fd9853", icon: "mdi:play-circle" },
  running:     { label: "Actif",            color: "#43a047", icon: "mdi:fan" },
  stabilizing: { label: "Stabilisation",    color: "#00bcd4", icon: "mdi:waves" },
  cooldown:    { label: "Cooldown",         color: "#8e6dc8", icon: "mdi:timer-sand" },
  schedule_off:{ label: "Hors planning",    color: "#7a8290", icon: "mdi:clock-outline" },
  manual_override_timed: { label: "Override", color: "#e96f8e", icon: "mdi:account-clock" },
  manual_override_free:  { label: "Manuel",   color: "#e96f8e", icon: "mdi:account-edit" },
  window_open: { label: "Fenêtre ouverte",  color: "#fbbf24", icon: "mdi:window-open" },
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
      forceCoolBtn: this._ent("button", "start_cooling"),
      forceHeatBtn: this._ent("button", "start_heating"),
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
    // Force start (visible only when idle/cooldown/etc.)
    $("force-cool-btn").addEventListener("click", () =>
      this._call("button", "press", { entity_id: ids.forceCoolBtn }));
    $("force-heat-btn").addEventListener("click", () =>
      this._call("button", "press", { entity_id: ids.forceHeatBtn }));

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
    const meta = STATE_META[stateVal] || { label: stateVal, color: "#7a8290", icon: "mdi:help-circle" };
    const badge = $("state-badge");
    badge.style.setProperty("--dc-state-color", meta.color);
    $("state-icon").setAttribute("icon", meta.icon);
    $("state-label").textContent = meta.label;
    const attrs = stateObj?.attributes || {};
    const regimeVal = get(ids.regime)?.state;
    const regimeLabel = REGIME_LABELS[regimeVal] || "—";
    $("header-regime").textContent = regimeLabel;
    $("header-regime").style.display = regimeLabel === "—" ? "none" : "";

    // Header icon bubble — represents the AC device.
    // Active (cool/heat): colored bubble with snowflake/fire icon.
    // Otherwise (off/fan/dry/unknown): neutral bubble with a generic AC icon.
    const climObj0 = this._climateEntity ? get(this._climateEntity) : null;
    const climMode = climObj0?.state || "off";
    const headIco = $("head-icon");
    const headIcoSvg = $("head-icon-ico");
    if (climMode === "cool") {
      headIcoSvg.setAttribute("icon", "mdi:snowflake");
      headIco.classList.add("active");
      headIco.style.setProperty("--dc-state-color", HVAC_COLORS.cool);
    } else if (climMode === "heat") {
      headIcoSvg.setAttribute("icon", "mdi:fire");
      headIco.classList.add("active");
      headIco.style.setProperty("--dc-state-color", HVAC_COLORS.heat);
    } else {
      // Idle / off / fan_only / dry — show the device, not an action button
      headIcoSvg.setAttribute("icon", "mdi:air-conditioner");
      headIco.classList.remove("active");
      headIco.style.removeProperty("--dc-state-color");
    }

    // ─────────────────── SECTION 1: ÉTAT ACTUEL
    $("room-temp").textContent = this._fmtTemp(get(ids.roomTemp)?.state);
    const target = attrs.target_temperature;
    const targetBlock = $("target-block");
    const arrowEl = $("target-arrow");
    const heroRow = this.querySelector(".dc-hero-row");
    if (target != null) {
      targetBlock.style.display = "";
      arrowEl.style.display = "";
      heroRow.classList.remove("hero-row--idle");
      $("target-temp").textContent = this._fmtTemp(target);
      const dir = attrs.direction;
      arrowEl.textContent = dir === "cool" ? "↓" : dir === "heat" ? "↑" : "→";
      arrowEl.style.color =
        dir === "cool" ? "var(--dc-cool)" :
        dir === "heat" ? "var(--dc-heat)" : "var(--dc-muted)";
    } else {
      // No target → hide the arrow + target block entirely, keep big room temp
      // centered.  Add idle modifier for the "à l'écoute" badge.
      targetBlock.style.display = "none";
      arrowEl.style.display = "none";
      heroRow.classList.add("hero-row--idle");
    }

    // Narrative
    const nar = this._buildNarrative(stateVal, regimeVal, attrs, get, ids);
    const narEl = $("narrative");
    narEl.innerHTML = nar.html;
    narEl.classList.toggle("warn", !!nar.warn);

    // Status pills — always show, color-coded by state
    const pills = $("status-pills");
    pills.innerHTML = "";

    // Pilotage (schedule) — with next transition time when available
    const nextEvt = attrs.schedule_next_event;
    const nextEvtTxt = nextEvt ? this._fmtTime(nextEvt) : null;
    if (attrs.schedule_on === false) {
      pills.appendChild(this._pill(
        "mdi:pause-circle-outline",
        nextEvtTxt ? `Pilotage en pause · reprise à ${nextEvtTxt}` : "Pilotage en pause",
        "warn",
      ));
    } else {
      pills.appendChild(this._pill(
        "mdi:play-circle-outline",
        nextEvtTxt ? `Pilotage actif jusqu'à ${nextEvtTxt}` : "Pilotage actif",
        "ok",
      ));
    }

    // Présence maison
    pills.appendChild(this._pill(
      attrs.house_is_absent === true ? "mdi:home-export-outline" : "mdi:home",
      attrs.house_is_absent === true ? "Maison absente" : "Maison présente",
      attrs.house_is_absent === true ? "info" : "neutral"));

    // Fenêtres — counted + plural agreement
    const wOpen = attrs.windows_open;
    const wTotal = attrs.windows_total;
    if (typeof wTotal === "number" && wTotal > 0) {
      if (wOpen === 0) {
        pills.appendChild(this._pill(
          "mdi:window-closed-variant",
          `${wTotal}/${wTotal} fenêtre${wTotal > 1 ? "s" : ""} fermée${wTotal > 1 ? "s" : ""}`,
          "ok",
        ));
      } else {
        pills.appendChild(this._pill(
          "mdi:window-open",
          `${wOpen}/${wTotal} fenêtre${wOpen > 1 ? "s" : ""} ouverte${wOpen > 1 ? "s" : ""}`,
          "warn",
        ));
      }
    }

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

    // Force-start row : only meaningful when the zone is currently not running
    // AND the underlying clim actually supports the offered direction(s).
    const canForceStart = ["idle", "cooldown", "schedule_off", "window_open"].includes(stateVal);
    const supportsCool = attrs.supports_cool !== false;
    const supportsHeat = attrs.supports_heat !== false;
    const forceRow = this.querySelector(".dc-force-row");
    if (forceRow) {
      forceRow.style.display = canForceStart && (supportsCool || supportsHeat) ? "" : "none";
      const coolBtn = $("force-cool-btn");
      const heatBtn = $("force-heat-btn");
      coolBtn.style.display = supportsCool ? "" : "none";
      heatBtn.style.display = supportsHeat ? "" : "none";
      // Single button → make it span the full row width
      const single = (supportsCool ? 1 : 0) + (supportsHeat ? 1 : 0) === 1;
      forceRow.querySelector(".dc-force-actions")
        .style.gridTemplateColumns = single ? "1fr" : "1fr 1fr";
    }

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
      const iconWrap = document.createElement("div");
      iconWrap.className = "ha-icon-wrap";
      const ic = document.createElement("ha-icon");
      ic.setAttribute("icon", HVAC_ICONS[m] || "mdi:dots-horizontal");
      iconWrap.appendChild(ic);
      const lbl = document.createElement("span");
      lbl.textContent = HVAC_LABELS[m] || m;
      wrap.appendChild(iconWrap);
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
      const supportsCool = attrs.supports_cool !== false;
      const supportsHeat = attrs.supports_heat !== false;
      const parts = [];
      if (supportsCool && !Number.isNaN(coolStart)) parts.push(`refroidissement à ${coolStart}°C`);
      if (supportsHeat && !Number.isNaN(heatStart)) parts.push(`chauffage à ${heatStart}°C`);
      let hint = "";
      if (!Number.isNaN(room)) {
        const dToCool = supportsCool && !Number.isNaN(coolStart) ? coolStart - room : null;
        const dToHeat = supportsHeat && !Number.isNaN(heatStart) ? room - heatStart : null;
        const both = dToCool !== null && dToHeat !== null;
        if (both && dToCool > 0 && dToCool < dToHeat) hint = ` <span class="until">(encore ${dToCool.toFixed(1)}°C avant refroidissement)</span>`;
        else if (both && dToHeat > 0 && dToHeat < dToCool) hint = ` <span class="until">(encore ${dToHeat.toFixed(1)}°C avant chauffage)</span>`;
        else if (!both && dToCool !== null && dToCool > 0) hint = ` <span class="until">(encore ${dToCool.toFixed(1)}°C avant refroidissement)</span>`;
        else if (!both && dToHeat !== null && dToHeat > 0) hint = ` <span class="until">(encore ${dToHeat.toFixed(1)}°C avant chauffage)</span>`;
      }
      const lead = parts.length === 2
        ? `Démarre le ${parts[0]} ou le ${parts[1]}`
        : parts.length === 1
          ? `Démarre le ${parts[0]}`
          : "Pas de seuil configuré";
      return { html: `En veille. ${lead}.${hint}`, warn: false };
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
  /* ─────────────────────────────────────────────────────────────────
     Bubble palette : doux gris-bleus + icônes colorées dans des cercles
     vibrants, à la manière du dashboard bubble-card de l'utilisateur.
     ───────────────────────────────────────────────────────────────── */
  ha-card.dc-card {
    --dc-pad: 18px;
    --dc-radius: 18px;
    --dc-radius-pill: 999px;
    --dc-radius-sm: 12px;
    --dc-hairline: rgba(255,255,255,0.06);
    --dc-bg-bubble: rgba(255,255,255,0.04);
    --dc-bg-bubble-strong: rgba(255,255,255,0.07);
    --dc-bg-inset: rgba(0,0,0,0.18);
    --dc-fg: rgba(255,255,255,0.95);
    --dc-muted: rgba(255,255,255,0.62);
    --dc-dim: rgba(255,255,255,0.42);
    --dc-cool: #4d8bff;
    --dc-heat: #ff7043;
    --dc-warn: #fb9223;
    --dc-success: #43a047;
    --dc-danger: #e85e54;
    --dc-info: #00bcd4;
    --dc-accent: #fbbf24;       /* doré chaud, plus chaleureux que champagne */
    padding: 0; overflow: hidden;
    border-radius: var(--ha-card-border-radius, var(--dc-radius));
    color: var(--dc-fg);
    font-size: 0.95em;
  }

  /* ============ HEADER ============ */
  .dc-header {
    display: flex; align-items: center; gap: 14px;
    padding: 18px var(--dc-pad);
  }
  .dc-header .head-icon {
    width: 44px; height: 44px; border-radius: 50%;
    background: var(--dc-bg-bubble-strong);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: var(--dc-state-color, var(--dc-fg));
    transition: background 0.3s, color 0.3s;
  }
  .dc-header .head-icon ha-icon { --mdc-icon-size: 24px; }
  .dc-header .head-icon.active { background: var(--dc-state-color, var(--dc-bg-bubble-strong)); color: white; }
  .dc-header .title-block { flex: 1; min-width: 0; }
  .dc-header .title {
    font-size: 1.15em; font-weight: 700; line-height: 1.2;
    letter-spacing: -0.005em;
  }
  .dc-header .subtitle {
    font-size: 0.82em; color: var(--dc-muted); margin-top: 3px;
  }
  .dc-header .head-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .dc-state {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 11px; border-radius: var(--dc-radius-pill);
    font-size: 0.78em; font-weight: 600;
    color: white;
    background: var(--dc-state-color, #7a8290);
    white-space: nowrap;
  }
  .dc-state ha-icon { --mdc-icon-size: 14px; }
  .dc-header .head-regime {
    font-size: 0.75em; color: var(--dc-muted);
    font-weight: 500;
  }

  /* ============ SECTIONS ============ */
  .dc-section { padding: 0 var(--dc-pad) var(--dc-pad); }
  .dc-section-head {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 12px;
  }
  .dc-section-head .head-bubble {
    width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; color: white;
  }
  .dc-section-head .head-bubble ha-icon { --mdc-icon-size: 16px; }
  .dc-section-head .lbl {
    font-size: 1em; font-weight: 700;
    color: var(--dc-fg);
  }
  /* per-section accent on the head bubble */
  .section-status .head-bubble { background: var(--dc-info); }
  .section-auto   .head-bubble { background: var(--dc-success); }
  .section-config .head-bubble { background: var(--dc-warn); }

  /* ============ §1 ÉTAT ACTUEL ============ */
  /* Hero bubble — big, friendly, central */
  .dc-hero {
    background: var(--dc-bg-bubble);
    border-radius: var(--dc-radius-sm);
    padding: 18px;
    margin-bottom: 12px;
  }
  .dc-hero-row {
    display: flex; align-items: center; justify-content: center;
    gap: 18px; flex-wrap: wrap;
  }
  /* Idle (no target): centered room temp, slightly larger to balance the bubble */
  .dc-hero-row.hero-row--idle .room { font-size: 3.4em; line-height: 1; }
  .dc-hero-row.hero-row--idle .room-label {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px; border-radius: var(--dc-radius-pill);
    background: var(--dc-bg-bubble); margin-top: 12px;
  }
  .dc-hero-row.hero-row--idle .room-label::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--dc-muted);
  }
  .dc-hero .room-block { text-align: center; }
  .dc-hero .room {
    font-size: 3em; font-weight: 700; line-height: 1;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    color: var(--dc-fg);
  }
  .dc-hero .room .unit {
    font-size: 0.35em; color: var(--dc-muted); font-weight: 500;
    margin-left: 3px;
  }
  .dc-hero .room-label {
    font-size: 0.78em; color: var(--dc-muted); margin-top: 6px;
    font-weight: 500;
  }
  .dc-hero .arrow {
    color: var(--dc-muted); font-size: 1.8em; font-weight: 400;
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--dc-bg-bubble);
    display: flex; align-items: center; justify-content: center;
  }
  .dc-hero .target-block {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
  }
  .dc-hero .target-block .target {
    font-size: 1.5em; font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--dc-accent);
    letter-spacing: -0.01em;
  }
  .dc-hero .target-block .target-label {
    font-size: 0.7em; color: var(--dc-muted); font-weight: 500;
  }

  .dc-narrative {
    text-align: center; margin: 14px 0 0;
    padding-top: 14px; border-top: 1px solid var(--dc-hairline);
    font-size: 0.95em; line-height: 1.45; color: var(--dc-fg);
    font-weight: 500;
  }
  .dc-narrative .target { color: var(--dc-accent); font-weight: 700; font-variant-numeric: tabular-nums; }
  .dc-narrative .until { color: var(--dc-muted); font-variant-numeric: tabular-nums; font-weight: 600; }
  .dc-narrative.warn { color: var(--dc-warn); }

  /* Status pills */
  .dc-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .dc-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 11px; border-radius: var(--dc-radius-pill);
    font-size: 0.78em; font-weight: 600;
    background: var(--dc-bg-bubble);
    color: var(--dc-muted);
  }
  .dc-pill ha-icon { --mdc-icon-size: 14px; }
  .dc-pill--ok    { background: rgba(67,160,71,0.15); color: var(--dc-success); }
  .dc-pill--warn  { background: rgba(251,146,35,0.18); color: var(--dc-warn); }
  .dc-pill--info  { background: rgba(0,188,212,0.15); color: var(--dc-info); }
  .dc-pill--neutral { background: var(--dc-bg-bubble); color: var(--dc-muted); }

  /* Metrics — list of rows in a bubble */
  .dc-metrics {
    background: var(--dc-bg-bubble);
    border-radius: var(--dc-radius-sm);
    padding: 6px 4px;
  }
  .dc-metric-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 12px;
    border-bottom: 1px solid var(--dc-hairline);
  }
  .dc-metric-row:last-child { border-bottom: none; }
  .dc-metric-row .label {
    display: flex; align-items: center; gap: 8px;
    font-size: 0.9em; color: var(--dc-muted); font-weight: 500;
  }
  .dc-metric-row .label ha-icon { --mdc-icon-size: 16px; color: var(--dc-dim); }
  .dc-metric-row .value {
    font-size: 1em; font-weight: 700;
    font-variant-numeric: tabular-nums; color: var(--dc-fg);
  }
  .dc-override-row {
    margin-top: 10px; padding: 12px 14px;
    background: rgba(233,111,142,0.12);
    border-radius: var(--dc-radius-sm);
    display: flex; justify-content: space-between; align-items: center;
    font-size: 0.9em;
  }
  .dc-override-row .lbl { color: #e96f8e; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .dc-override-row .val { font-weight: 700; font-variant-numeric: tabular-nums; color: #e96f8e; }

  /* ============ §2 AUTOMATISATION ============ */
  .dc-control { margin-bottom: 14px; }
  .dc-control:last-child { margin-bottom: 0; }
  .dc-control-label {
    font-size: 0.85em; color: var(--dc-muted); font-weight: 600;
    margin-bottom: 8px;
  }
  .dc-segmented {
    display: flex; gap: 6px;
    background: var(--dc-bg-bubble);
    border-radius: var(--dc-radius-pill);
    padding: 5px;
  }
  .dc-segmented button {
    flex: 1; padding: 10px 14px; border: none; background: transparent;
    color: var(--dc-muted); font-size: 0.9em; font-weight: 600;
    cursor: pointer;
    border-radius: var(--dc-radius-pill);
    transition: all 0.2s;
  }
  .dc-segmented button:hover { color: var(--dc-fg); }
  .dc-segmented button.active {
    background: var(--dc-bg-bubble-strong);
    color: var(--dc-fg);
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  }
  .dc-segmented.tone-warn button.active[data-mode="boost"],
  .dc-segmented.tone-warn button.active[data-aggressivity="agressif"] {
    background: var(--dc-warn); color: white;
  }
  .dc-segmented.tone-danger button.active[data-mode="off"] {
    background: var(--dc-danger); color: white;
  }

  .dc-quick-actions {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  }
  .dc-quick-actions button {
    padding: 12px 14px; border-radius: var(--dc-radius-pill);
    border: none; background: var(--dc-bg-bubble);
    color: var(--dc-fg); cursor: pointer;
    font-weight: 600; font-size: 0.9em;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: all 0.2s;
  }
  .dc-quick-actions button ha-icon { --mdc-icon-size: 16px; }
  .dc-quick-actions button:hover:not(:disabled) {
    background: var(--dc-bg-bubble-strong);
  }
  .dc-quick-actions button:disabled { opacity: 0.35; cursor: not-allowed; }
  .dc-quick-actions button[data-bind="boost-btn"] {
    background: rgba(251,146,35,0.15); color: var(--dc-warn);
  }
  .dc-quick-actions button[data-bind="boost-btn"]:hover:not(:disabled) {
    background: rgba(251,146,35,0.25);
  }
  .dc-quick-actions button[data-bind="boost-btn"] ha-icon { color: var(--dc-warn); }

  /* Force-start actions (idle only) */
  .dc-force-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .dc-force-actions button {
    padding: 12px 14px; border-radius: var(--dc-radius-pill);
    border: none; cursor: pointer;
    font-weight: 700; font-size: 0.95em;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: all 0.2s; color: white;
  }
  .dc-force-actions button ha-icon { --mdc-icon-size: 18px; color: white; }
  .dc-force-actions .force-cool { background: var(--dc-cool); }
  .dc-force-actions .force-cool:hover { background: #3d76e0; }
  .dc-force-actions .force-heat { background: var(--dc-heat); }
  .dc-force-actions .force-heat:hover { background: #f06030; }

  /* ============ §3 CONFIGURATION ============ */
  .dc-subblock {
    background: var(--dc-bg-bubble);
    border-radius: var(--dc-radius-sm);
    padding: 14px;
    margin-bottom: 10px;
  }
  .dc-subblock:last-child { margin-bottom: 0; }
  .dc-subblock-title {
    font-size: 0.85em; color: var(--dc-muted); font-weight: 600;
    margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .dc-subblock-title ha-icon { --mdc-icon-size: 16px; color: var(--dc-dim); }

  /* HVAC chiclets — colored circular icons like the user's dashboard */
  .dc-hvac {
    display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px;
  }
  .dc-hvac button {
    padding: 10px 4px; background: var(--dc-bg-inset);
    border: none; border-radius: var(--dc-radius-sm);
    color: var(--dc-muted); cursor: pointer;
    transition: all 0.2s;
    display: flex; flex-direction: column; align-items: center; gap: 5px;
  }
  .dc-hvac button > div { display: flex; flex-direction: column; align-items: center; gap: 5px; width: 100%; }
  .dc-hvac button .ha-icon-wrap {
    width: 28px; height: 28px; border-radius: 50%;
    background: var(--dc-bg-bubble-strong);
    display: flex; align-items: center; justify-content: center;
    color: var(--dc-muted);
    transition: all 0.2s;
  }
  .dc-hvac button ha-icon { --mdc-icon-size: 16px; }
  .dc-hvac button span { font-size: 0.7em; font-weight: 600; }
  .dc-hvac button:hover { background: var(--dc-bg-bubble); }
  .dc-hvac button:hover .ha-icon-wrap { background: var(--dc-bg-bubble); color: var(--dc-fg); }
  .dc-hvac button.active { background: var(--dc-bg-bubble); }
  .dc-hvac button.active .ha-icon-wrap {
    background: var(--hvac-color, var(--dc-accent));
    color: white;
  }
  .dc-hvac button.active span { color: var(--dc-fg); }

  /* Setpoint */
  .dc-setpoint {
    display: flex; align-items: center; justify-content: center; gap: 22px;
    margin-top: 14px;
  }
  .dc-setpoint .sp-val {
    font-size: 2.2em; font-weight: 700;
    font-variant-numeric: tabular-nums;
    min-width: 100px; text-align: center;
    letter-spacing: -0.02em;
    color: var(--dc-fg);
  }
  .dc-setpoint .sp-unit { font-size: 0.45em; color: var(--dc-muted); font-weight: 600; margin-left: 3px; }
  .dc-setpoint button {
    width: 44px; height: 44px; border-radius: 50%;
    background: var(--dc-bg-bubble-strong);
    border: none;
    color: var(--dc-fg); font-size: 1.4em; font-weight: 600;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: all 0.2s;
  }
  .dc-setpoint button:hover {
    background: var(--dc-cool); color: white;
  }

  /* Fan + swing */
  .dc-fanswing { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
  .dc-fanswing .field { display: flex; flex-direction: column; gap: 6px; }
  .dc-fanswing label {
    font-size: 0.8em; color: var(--dc-muted); font-weight: 600;
  }
  .dc-fanswing select {
    background: var(--dc-bg-inset);
    border: none;
    border-radius: var(--dc-radius-sm); color: var(--dc-fg); padding: 11px 12px;
    font-size: 0.9em; font-weight: 600;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(255,255,255,0.5)' d='M0 0l5 6 5-6z'/></svg>");
    background-repeat: no-repeat; background-position: right 12px center;
    padding-right: 32px;
    cursor: pointer;
  }
  .dc-fanswing select:focus { outline: 2px solid var(--dc-cool); outline-offset: -2px; }

  /* Threshold pairs (start/stop side by side) */
  .dc-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .dc-field { display: flex; flex-direction: column; gap: 6px; }
  .dc-field label {
    font-size: 0.8em; color: var(--dc-muted); font-weight: 600;
  }
  .dc-input-wrap {
    display: flex; align-items: center; gap: 6px;
    background: var(--dc-bg-inset);
    border-radius: var(--dc-radius-sm); padding: 0 14px;
    transition: outline 0.2s;
  }
  .dc-input-wrap:focus-within { outline: 2px solid var(--dc-cool); outline-offset: -2px; }
  .dc-input-wrap input {
    flex: 1; min-width: 0; padding: 11px 0; background: transparent; border: none;
    color: var(--dc-fg); font-size: 1em; font-weight: 700;
    font-variant-numeric: tabular-nums; text-align: right;
  }
  .dc-input-wrap input:focus { outline: none; }
  .dc-input-wrap .unit { font-size: 0.82em; color: var(--dc-muted); font-weight: 600; }

  /* Temporisations — stack rows instead of cramping 3 cols on narrow widths */
  .dc-rows { display: flex; flex-direction: column; gap: 8px; }
  .dc-rows .dc-field-row {
    display: grid; grid-template-columns: 1fr 110px;
    gap: 12px; align-items: center;
  }
  .dc-rows .dc-field-row label {
    font-size: 0.88em; color: var(--dc-muted); font-weight: 600;
  }

  .dc-err {
    margin: 10px var(--dc-pad); padding: 12px 14px;
    border-radius: var(--dc-radius-sm);
    background: rgba(232,94,84,0.15);
    color: var(--dc-danger); font-size: 0.9em; font-weight: 600;
  }
  .dc-err:empty { display: none; }
`;

const TEMPLATE = `
  <div class="dc-header">
    <div class="head-icon" data-bind="head-icon">
      <ha-icon icon="mdi:air-conditioner" data-bind="head-icon-ico"></ha-icon>
    </div>
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
      <div class="head-bubble"><ha-icon icon="mdi:radar"></ha-icon></div>
      <span class="lbl">État actuel</span>
    </div>

    <div class="dc-hero">
      <div class="dc-hero-row">
        <div class="room-block">
          <div class="room"><span data-bind="room-temp">—</span><span class="unit">°C</span></div>
          <div class="room-label">T° zone</div>
        </div>
        <span class="arrow" data-bind="target-arrow">→</span>
        <div class="target-block" data-bind="target-block">
          <span class="target"><span data-bind="target-temp">—</span> °C</span>
          <span class="target-label">cible</span>
        </div>
      </div>
      <div class="dc-narrative" data-bind="narrative"></div>
    </div>

    <div class="dc-pills" data-bind="status-pills"></div>

    <div class="dc-metrics">
      <div class="dc-metric-row">
        <span class="label"><ha-icon icon="mdi:send"></ha-icon>Consigne envoyée</span>
        <span class="value" data-bind="metric-setpoint-sent">—</span>
      </div>
      <div class="dc-metric-row">
        <span class="label"><ha-icon icon="mdi:thermostat"></ha-icon>Consigne clim</span>
        <span class="value" data-bind="metric-clim-setpoint">—</span>
      </div>
      <div class="dc-metric-row">
        <span class="label"><ha-icon icon="mdi:thermometer"></ha-icon>Sonde clim</span>
        <span class="value" data-bind="metric-clim-sonde">—</span>
      </div>
      <div class="dc-metric-row">
        <span class="label"><ha-icon icon="mdi:gauge"></ha-icon>Régime</span>
        <span class="value" data-bind="metric-regime">—</span>
      </div>
    </div>

    <div class="dc-override-row" data-bind="override-row" style="display:none">
      <span class="lbl"><ha-icon icon="mdi:account-clock"></ha-icon>Override jusqu'à</span>
      <span class="val" data-bind="override-until-val">—</span>
    </div>
  </section>

  <!-- ════════════════════════════════════ §2 AUTOMATISATION -->
  <section class="dc-section section-auto">
    <div class="dc-section-head">
      <div class="head-bubble"><ha-icon icon="mdi:robot"></ha-icon></div>
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

    <div class="dc-control dc-force-row" style="display:none">
      <div class="dc-control-label">Démarrer maintenant</div>
      <div class="dc-force-actions">
        <button class="force-cool" data-bind="force-cool-btn">
          <ha-icon icon="mdi:snowflake"></ha-icon> Refroidir
        </button>
        <button class="force-heat" data-bind="force-heat-btn">
          <ha-icon icon="mdi:fire"></ha-icon> Chauffer
        </button>
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
      <div class="head-bubble"><ha-icon icon="mdi:cog"></ha-icon></div>
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
      <div class="dc-rows">
        <div class="dc-field-row">
          <label>Stabilisation</label>
          <div class="dc-input-wrap"><input type="number" step="1" data-bind="num-stabDuration"><span class="unit">min</span></div>
        </div>
        <div class="dc-field-row">
          <label>Cooldown</label>
          <div class="dc-input-wrap"><input type="number" step="1" data-bind="num-cooldownDuration"><span class="unit">min</span></div>
        </div>
        <div class="dc-field-row">
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
  "%c DELORMEJ-CLIMATE-CARD %c v0.6.2 ",
  "color: white; background: #28a745; font-weight: 700;",
  "color: #28a745; background: white; font-weight: 700;"
);
