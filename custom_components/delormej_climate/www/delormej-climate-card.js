/**
 * delormej-climate-card  v0.4.2
 *
 * Single all-in-one card for one zone of the delormej_climate integration.
 * Replaces both the standard HA `thermostat` card and the previous slim
 * delormej card — drop this one card in a pop-up / view and you have:
 *
 *   • Zone state badge + narrative status line
 *   • Current room temperature → target temperature
 *   • Underlying climate controls: hvac_mode chiclets, setpoint +/-,
 *     fan mode, swing mode (touching these triggers MANUAL_OVERRIDE)
 *   • Zone pilotage: auto / off / boost
 *   • Aggressivité: doux / normal / agressif
 *   • Quick actions: Boost 15 min, Reprendre auto
 *   • Collapsible config: live thresholds + durations
 *
 * Usage:
 *   type: custom:delormej-climate-card
 *   zone: rdc                          # required
 *   title: Salon                       # optional
 *   climate_entity: climate.salon      # required for the hvac controls block
 */

const STATE_LABELS = {
  idle: { label: "Inactif", color: "var(--state-inactive-color, #6c757d)", icon: "mdi:power-sleep" },
  starting: { label: "Démarrage", color: "#fd7e14", icon: "mdi:play-circle" },
  running: { label: "Actif", color: "var(--success-color, #28a745)", icon: "mdi:fan" },
  stabilizing: { label: "Stabilisation", color: "#17a2b8", icon: "mdi:waves" },
  cooldown: { label: "Cooldown", color: "#6f42c1", icon: "mdi:timer-sand" },
  schedule_off: { label: "Hors planning", color: "#495057", icon: "mdi:clock-outline" },
  manual_override_timed: { label: "Override (timed)", color: "#e83e8c", icon: "mdi:account-clock" },
  manual_override_free: { label: "Override libre", color: "#e83e8c", icon: "mdi:account-edit" },
  window_open: { label: "Fenêtre ouverte", color: "var(--warning-color, #ffc107)", icon: "mdi:window-open" },
};

const REGIME_LABELS = {
  none: "—", attaque: "Attaque", croisiere: "Croisière",
  approche: "Approche", stabilisation: "Stabilisation", boost: "Boost",
};

// HVAC mode → icon for chiclet bar (matches HA's own climate icons)
const HVAC_ICONS = {
  off: "mdi:power",
  heat: "mdi:fire",
  cool: "mdi:snowflake",
  heat_cool: "mdi:autorenew",
  auto: "mdi:autorenew",
  dry: "mdi:water-percent",
  fan_only: "mdi:fan",
};
const HVAC_COLORS = {
  off: "var(--state-inactive-color, #888)",
  heat: "var(--state-climate-heat-color, #ff6b35)",
  cool: "var(--state-climate-cool-color, #4d8bff)",
  heat_cool: "var(--state-climate-auto-color, #45b7af)",
  auto: "var(--state-climate-auto-color, #45b7af)",
  dry: "var(--state-climate-dry-color, #efc439)",
  fan_only: "var(--state-climate-fan_only-color, #b1c1c0)",
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
  getCardSize() { return 10; }

  _ent(kind, suffix) { return `${kind}.delormej_climate_${this._zone}_${suffix}`; }

  _ids() {
    return {
      state: this._ent("sensor", "state"),
      regime: this._ent("sensor", "regime"),
      roomTemp: this._ent("sensor", "room_temperature_average"),
      setpointSent: this._ent("sensor", "setpoint_sent"),
      overrideUntil: this._ent("sensor", "override_until"),
      autoSwitch: this._ent("switch", "auto_control"),
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

  /* ============================================================== render */

  _render() {
    const root = document.createElement("ha-card");
    root.classList.add("dc-card");

    const style = document.createElement("style");
    style.textContent = STYLES;
    root.appendChild(style);

    const body = document.createElement("div");
    body.innerHTML = TEMPLATE;
    root.appendChild(body);

    this.appendChild(root);
    // Static title (doesn't change post-render)
    const titleEl = this.querySelector('[data-bind="title-text"]');
    if (titleEl) titleEl.textContent = this._title;
    this._wireUp();
  }

  _wireUp() {
    const ids = this._ids();
    const $ = (sel) => this.querySelector(`[data-bind="${sel}"]`);
    const $$ = (sel) => Array.from(this.querySelectorAll(`[data-bind="${sel}"]`));

    // Mode pilotage
    $("mode").querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => this._call("select", "select_option",
        { entity_id: ids.modeSelect, option: btn.dataset.mode }));
    });

    // Aggressivity
    $("aggressivity").querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => this._call("select", "select_option",
        { entity_id: ids.aggressivitySelect, option: btn.dataset.aggressivity }));
    });

    // Boost / Resume
    $("boost-btn").addEventListener("click", () =>
      this._call("button", "press", { entity_id: ids.boostBtn }));
    $("resume-btn").addEventListener("click", () =>
      this._call("button", "press", { entity_id: ids.resumeAutoBtn }));

    // Underlying climate: HVAC mode chiclets, setpoint +/-, fan, swing
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

    // Number inputs in config section
    const numMap = {
      heatStart: ids.heatStart, heatStop: ids.heatStop,
      coolStart: ids.coolStart, coolStop: ids.coolStop,
      stabDuration: ids.stabDuration, cooldownDuration: ids.cooldownDuration,
      overrideDuration: ids.overrideDuration,
    };
    for (const [key, entity] of Object.entries(numMap)) {
      const el = $(`num-${key}`);
      if (el) el.addEventListener("change", (e) => this._call("number", "set_value",
        { entity_id: entity, value: parseFloat(e.target.value) }));
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

  /* ============================================================== update */

  _update() {
    if (!this._hass) return;
    const $ = (sel) => this.querySelector(`[data-bind="${sel}"]`);
    const states = this._hass.states;
    const ids = this._ids();
    const get = (eid) => states[eid];

    // ----- Header / state badge -----
    const stateObj = get(ids.state);
    const stateVal = stateObj?.state ?? "unknown";
    const meta = STATE_LABELS[stateVal] || { label: stateVal, color: "#6c757d", icon: "mdi:help-circle" };
    const badge = $("state-badge");
    badge.style.setProperty("--dc-state-color", meta.color);
    $("state-icon").setAttribute("icon", meta.icon);
    $("state-label").textContent = meta.label;
    $("subtitle").textContent = this._climateEntity || "";

    const attrs = stateObj?.attributes || {};

    // ----- Hero: T° → target -----
    $("room-temp").textContent = this._fmtTemp(get(ids.roomTemp)?.state);
    const target = attrs.target_temperature;
    if (target != null) {
      $("target-block").style.visibility = "";
      $("target-temp").textContent = this._fmtTemp(target);
      const dir = attrs.direction;
      $("target-arrow").setAttribute("icon",
        dir === "cool" ? "mdi:arrow-down-bold" :
        dir === "heat" ? "mdi:arrow-up-bold" : "mdi:arrow-right-bold");
    } else {
      $("target-block").style.visibility = "hidden";
    }
    $("regime").textContent = REGIME_LABELS[get(ids.regime)?.state] ?? "—";

    // ----- Narrative -----
    const nar = this._buildNarrative(stateVal, get(ids.regime)?.state, attrs, get, ids);
    const narEl = $("narrative");
    narEl.innerHTML = nar.html;
    narEl.classList.toggle("warn", !!nar.warn);

    // ----- Context chips -----
    const ctx = $("ctx");
    ctx.innerHTML = "";
    if (attrs.schedule_on === false) ctx.appendChild(this._chip("mdi:clock-outline", "Hors planning", "warn"));
    if (attrs.any_window_open === true) ctx.appendChild(this._chip("mdi:window-open", "Fenêtre ouverte", "warn"));
    if (attrs.house_is_absent === true) ctx.appendChild(this._chip("mdi:home-export-outline", "Maison absente", "info"));
    if (attrs.in_override === true) ctx.appendChild(this._chip("mdi:account-edit", "Override manuel", "warn"));

    // ----- Resume-auto button is only meaningful while in MANUAL_OVERRIDE_* -----
    const inOverride = attrs.in_override === true;
    const resumeBtn = $("resume-btn");
    resumeBtn.disabled = !inOverride;
    resumeBtn.title = inOverride
      ? "Annule l'override manuel en cours"
      : "Aucun override en cours";

    // ----- Mode pilotage segmented -----
    const currentMode = get(ids.modeSelect)?.state;
    $("mode").querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === currentMode);
    });

    // ----- Aggressivity segmented -----
    const currentAgg = get(ids.aggressivitySelect)?.state || attrs.aggressivity || "normal";
    $("aggressivity").querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.aggressivity === currentAgg);
    });

    // ----- Underlying climate block -----
    const climBlock = $("clim-block");
    if (!this._climateEntity) {
      climBlock.style.display = "none";
    } else {
      climBlock.style.display = "";
      const clim = get(this._climateEntity);
      if (clim) {
        this._renderHvacModes($("hvac-modes"), clim);
        $("setpoint").textContent = this._fmtTemp(clim.attributes.temperature);
        $("clim-current").textContent = `${this._fmtTemp(clim.attributes.current_temperature)} °C`;
        this._renderFanSwing($("fan-select"), clim.attributes.fan_modes, clim.attributes.fan_mode);
        this._renderFanSwing($("swing-select"), clim.attributes.swing_modes, clim.attributes.swing_mode);
      }
    }

    // ----- Config section: live values -----
    $("setpoint-sent-val").textContent = this._fmtTempUnit(get(ids.setpointSent)?.state);
    const overrideUntil = get(ids.overrideUntil);
    const overrideRow = $("override-row");
    if (overrideUntil && overrideUntil.state !== "unknown" && overrideUntil.state !== "unavailable") {
      overrideRow.style.display = "";
      $("override-until-val").textContent = this._fmtTime(overrideUntil.state);
    } else {
      overrideRow.style.display = "none";
    }

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
    if (container.dataset.modes === modes.join(",") && container.dataset.current === current) return;
    container.dataset.modes = modes.join(",");
    container.dataset.current = current;
    container.innerHTML = "";
    for (const m of modes) {
      const btn = document.createElement("button");
      btn.dataset.hvac = m;
      btn.title = m;
      btn.classList.toggle("active", m === current);
      if (m === current) btn.style.setProperty("--hvac-color", HVAC_COLORS[m] || "var(--primary-color)");
      const ic = document.createElement("ha-icon");
      ic.setAttribute("icon", HVAC_ICONS[m] || "mdi:dots-horizontal");
      btn.appendChild(ic);
      container.appendChild(btn);
    }
  }

  _renderFanSwing(select, options, current) {
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

  /* ============================================================== narrative */

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
        if (dToCool > 0 && dToCool < dToHeat) hint = ` &middot; <span class="until">${dToCool.toFixed(1)}°C avant cool</span>`;
        else if (dToHeat > 0 && dToHeat < dToCool) hint = ` &middot; <span class="until">${dToHeat.toFixed(1)}°C avant heat</span>`;
      }
      return { html: `Inactif. ${parts.join(" / ")}${hint}.`, warn: false };
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

  /* ============================================================== helpers */

  _chip(icon, text, cls = "") {
    const div = document.createElement("div");
    div.className = `dc-chip ${cls}`;
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
  _fmtTemp(v) {
    if (v == null || v === "unknown" || v === "unavailable") return "—";
    const f = parseFloat(v);
    return Number.isNaN(f) ? "—" : f.toFixed(1);
  }
  _fmtTempUnit(v) { const t = this._fmtTemp(v); return t === "—" ? "—" : `${t} °C`; }
  _fmtTime(iso) { try { return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); } catch { return iso; } }
  _escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  _capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
}

const STYLES = `
  ha-card.dc-card {
    --dc-pad: 16px;
    --dc-radius: 10px;
    --dc-divider: var(--divider-color, rgba(255,255,255,0.08));
    --dc-muted: var(--secondary-text-color, #8a8a8a);
    --dc-fg: var(--primary-text-color, #fff);
    padding: 0; overflow: hidden;
  }

  /* Header */
  .dc-header { display: flex; align-items: center; gap: 10px; padding: var(--dc-pad); padding-bottom: 6px; }
  .dc-header .title-block { flex: 1; min-width: 0; }
  .dc-header .title { font-size: 1.1em; font-weight: 600; line-height: 1.15; }
  .dc-header .subtitle { font-size: 0.78em; color: var(--dc-muted); margin-top: 2px; }
  .dc-state {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px;
    font-size: 0.78em; font-weight: 600; color: white;
    background: var(--dc-state-color, #6c757d);
    white-space: nowrap;
  }
  .dc-state ha-icon { --mdc-icon-size: 14px; }

  /* Hero */
  .dc-hero { padding: 12px var(--dc-pad) 14px; border-bottom: 1px solid var(--dc-divider); }
  .dc-hero-temps { display: flex; align-items: center; justify-content: center; gap: 14px; margin-bottom: 6px; }
  .dc-hero .room {
    font-size: 2.6em; font-weight: 700; line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .dc-hero .room .unit { font-size: 0.4em; color: var(--dc-muted); font-weight: 400; margin-left: 2px; }
  .dc-hero .target-block {
    display: flex; flex-direction: column; align-items: center;
    color: var(--dc-muted);
  }
  .dc-hero .target-block ha-icon { --mdc-icon-size: 24px; color: var(--primary-color); }
  .dc-hero .target-block .target {
    font-size: 1.3em; font-weight: 600; color: var(--primary-color);
    font-variant-numeric: tabular-nums;
  }
  .dc-hero .target-block .target-label { font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.05em; }
  .dc-hero-meta { display: flex; justify-content: space-between; align-items: center; font-size: 0.9em; color: var(--dc-muted); }
  .dc-hero-meta .regime-block .regime-val { color: var(--dc-fg); font-weight: 600; }
  .dc-narrative { margin-top: 8px; font-size: 0.95em; line-height: 1.4; color: var(--dc-fg); text-align: center; }
  .dc-narrative .target { color: var(--primary-color); font-weight: 600; font-variant-numeric: tabular-nums; }
  .dc-narrative .until { color: var(--dc-muted); font-variant-numeric: tabular-nums; }
  .dc-narrative.warn { color: var(--warning-color, #ffc107); }

  /* Ctx chips */
  .dc-ctx { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px var(--dc-pad) 0; }
  .dc-ctx:empty { display: none; }
  .dc-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px;
    font-size: 0.78em; background: var(--secondary-background-color, rgba(255,255,255,0.05));
    color: var(--dc-muted); }
  .dc-chip ha-icon { --mdc-icon-size: 14px; }
  .dc-chip.warn { background: rgba(255,193,7,0.15); color: var(--warning-color, #ffc107); }
  .dc-chip.info { background: rgba(13,110,253,0.12); color: var(--info-color, #5e9eff); }

  /* Sections */
  .dc-section { padding: 12px var(--dc-pad); border-top: 1px solid var(--dc-divider); }
  .dc-section-title { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dc-muted); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .dc-section-title ha-icon { --mdc-icon-size: 14px; }

  /* Segmented control */
  .dc-segmented { display: flex; background: var(--secondary-background-color); border-radius: var(--dc-radius); padding: 3px; }
  .dc-segmented button {
    flex: 1; padding: 7px 10px; border: none; background: transparent; color: var(--dc-muted);
    font-size: 0.88em; font-weight: 500; cursor: pointer; border-radius: 7px;
    transition: background 0.15s, color 0.15s;
  }
  .dc-segmented button:hover { color: var(--dc-fg); }
  .dc-segmented button.active {
    background: var(--card-background-color, #1a1a1a);
    color: var(--dc-fg);
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  }
  .dc-segmented.tone-warning button.active[data-mode="boost"],
  .dc-segmented.tone-warning button.active[data-aggressivity="agressif"] { color: var(--warning-color, #ffc107); }
  .dc-segmented.tone-danger button.active[data-mode="off"] { color: var(--error-color, #dc3545); }

  /* HVAC mode chiclets */
  .dc-hvac { display: flex; gap: 6px; }
  .dc-hvac button {
    flex: 1; aspect-ratio: 1; max-height: 40px;
    background: var(--secondary-background-color); border: 1px solid var(--dc-divider);
    border-radius: var(--dc-radius); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    color: var(--dc-muted); transition: all 0.15s;
  }
  .dc-hvac button ha-icon { --mdc-icon-size: 20px; }
  .dc-hvac button:hover { color: var(--dc-fg); }
  .dc-hvac button.active {
    background: var(--hvac-color, var(--primary-color));
    border-color: transparent;
    color: white;
  }

  /* Setpoint */
  .dc-setpoint { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 12px; }
  .dc-setpoint .sp-val { font-size: 1.6em; font-weight: 700; font-variant-numeric: tabular-nums; min-width: 80px; text-align: center; }
  .dc-setpoint .sp-unit { font-size: 0.85em; color: var(--dc-muted); }
  .dc-setpoint button {
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--secondary-background-color); border: 1px solid var(--dc-divider);
    color: var(--dc-fg); font-size: 1.2em; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background 0.15s;
  }
  .dc-setpoint button:hover { background: var(--primary-color); border-color: transparent; color: white; }
  .dc-setpoint .sp-aux { font-size: 0.78em; color: var(--dc-muted); text-align: center; margin-top: 4px; }

  /* Fan+swing row */
  .dc-fanswing { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
  .dc-fanswing .field { display: flex; flex-direction: column; gap: 4px; }
  .dc-fanswing label { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dc-muted); }
  .dc-fanswing select {
    background: var(--secondary-background-color); border: 1px solid var(--dc-divider);
    border-radius: 6px; color: var(--dc-fg); padding: 7px 8px; font-size: 0.9em;
  }
  .dc-fanswing select:focus { outline: none; border-color: var(--primary-color); }

  /* Actions */
  .dc-actions { display: flex; gap: 8px; margin-top: 12px; }
  .dc-actions button {
    flex: 1; padding: 9px 12px; border-radius: var(--dc-radius);
    border: 1px solid var(--dc-divider); background: transparent;
    color: var(--dc-fg); cursor: pointer; font-weight: 500; font-size: 0.9em;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    transition: background 0.15s;
  }
  .dc-actions button ha-icon { --mdc-icon-size: 16px; }
  .dc-actions button:hover:not(:disabled) { background: var(--secondary-background-color); }
  .dc-actions button:disabled { opacity: 0.35; cursor: not-allowed; }

  /* Collapsible config */
  details.dc-collapse { padding: 0; border-top: 1px solid var(--dc-divider); }
  details.dc-collapse > summary {
    padding: 12px var(--dc-pad); cursor: pointer;
    font-size: 0.9em; color: var(--dc-muted);
    display: flex; align-items: center; gap: 8px; list-style: none;
  }
  details.dc-collapse > summary::-webkit-details-marker { display: none; }
  details.dc-collapse > summary ha-icon { transition: transform 0.2s; --mdc-icon-size: 16px; }
  details.dc-collapse[open] > summary ha-icon.chevron { transform: rotate(90deg); }
  details.dc-collapse > summary:hover { color: var(--dc-fg); }
  .dc-collapse-body { padding: 0 var(--dc-pad) var(--dc-pad); }
  .dc-row {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 4px 0; font-size: 0.9em;
  }
  .dc-row .label { color: var(--dc-muted); }
  .dc-row .val { font-variant-numeric: tabular-nums; font-weight: 500; }

  .dc-config-group { margin-top: 14px; }
  .dc-config-group:first-child { margin-top: 0; }
  .dc-config-group .group-title { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dc-muted); margin-bottom: 6px; }
  .dc-field { display: grid; grid-template-columns: 1fr 80px 28px; gap: 8px; align-items: center; margin: 5px 0; font-size: 0.9em; }
  .dc-field .lbl { color: var(--dc-muted); }
  .dc-field .unit { color: var(--dc-muted); font-size: 0.85em; }
  .dc-field input[type=number] {
    width: 100%; padding: 6px 8px; border-radius: 6px;
    border: 1px solid var(--dc-divider); background: var(--secondary-background-color);
    color: var(--dc-fg); font-variant-numeric: tabular-nums; text-align: right;
  }
  .dc-field input[type=number]:focus { outline: none; border-color: var(--primary-color); }

  .dc-err {
    margin: 8px var(--dc-pad); padding: 8px;
    border-radius: 6px; background: rgba(220,53,69,0.15);
    color: var(--error-color, #dc3545); font-size: 0.85em;
  }
  .dc-err:empty { display: none; }
`;

const TEMPLATE = `
  <div class="dc-header">
    <div class="title-block">
      <div class="title" data-bind="title-text"></div>
      <div class="subtitle" data-bind="subtitle"></div>
    </div>
    <span class="dc-state" data-bind="state-badge">
      <ha-icon icon="mdi:circle-outline" data-bind="state-icon"></ha-icon>
      <span data-bind="state-label">—</span>
    </span>
  </div>

  <div class="dc-hero">
    <div class="dc-hero-temps">
      <div class="room"><span data-bind="room-temp">—</span><span class="unit">°C</span></div>
      <div class="target-block" data-bind="target-block">
        <ha-icon icon="mdi:arrow-right-bold" data-bind="target-arrow"></ha-icon>
        <span class="target"><span data-bind="target-temp">—</span> °C</span>
        <span class="target-label">cible</span>
      </div>
    </div>
    <div class="dc-hero-meta">
      <span>T° zone</span>
      <span class="regime-block">Régime · <span class="regime-val" data-bind="regime">—</span></span>
    </div>
    <div class="dc-narrative" data-bind="narrative"></div>
  </div>

  <div class="dc-ctx" data-bind="ctx"></div>

  <div class="dc-section">
    <div class="dc-section-title"><ha-icon icon="mdi:tune-variant"></ha-icon> Mode pilotage</div>
    <div class="dc-segmented tone-warning tone-danger" data-bind="mode">
      <button data-mode="auto">Auto</button>
      <button data-mode="off">Off</button>
      <button data-mode="boost">Boost</button>
    </div>
  </div>

  <div class="dc-section" data-bind="clim-block">
    <div class="dc-section-title"><ha-icon icon="mdi:air-conditioner"></ha-icon> Climatisation (contrôle direct)</div>
    <div class="dc-hvac" data-bind="hvac-modes"></div>
    <div class="dc-setpoint">
      <button data-bind="sp-dec" title="Diminuer">−</button>
      <div>
        <div class="sp-val"><span data-bind="setpoint">—</span><span class="sp-unit"> °C</span></div>
        <div class="sp-aux">sonde clim <span data-bind="clim-current">—</span></div>
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

  <div class="dc-section">
    <div class="dc-section-title"><ha-icon icon="mdi:speedometer"></ha-icon> Agressivité</div>
    <div class="dc-segmented tone-warning" data-bind="aggressivity">
      <button data-aggressivity="doux">Doux</button>
      <button data-aggressivity="normal">Normal</button>
      <button data-aggressivity="agressif">Agressif</button>
    </div>
    <div class="dc-actions">
      <button data-bind="boost-btn"><ha-icon icon="mdi:rocket-launch"></ha-icon> Boost 15 min</button>
      <button data-bind="resume-btn"><ha-icon icon="mdi:restore"></ha-icon> Reprendre auto</button>
    </div>
  </div>

  <details class="dc-collapse">
    <summary>
      <ha-icon icon="mdi:chevron-right" class="chevron"></ha-icon>
      <ha-icon icon="mdi:information-outline"></ha-icon>
      <span>Détails &amp; configuration</span>
    </summary>
    <div class="dc-collapse-body">
      <div class="dc-row"><span class="label">Consigne envoyée par le composant</span><span class="val" data-bind="setpoint-sent-val">—</span></div>
      <div class="dc-row" data-bind="override-row" style="display:none">
        <span class="label">Override actif jusqu'à</span><span class="val" data-bind="override-until-val">—</span>
      </div>

      <div class="dc-config-group">
        <div class="group-title">Chauffage</div>
        <div class="dc-field"><span class="lbl">Démarrage</span><input type="number" step="0.5" data-bind="num-heatStart"><span class="unit">°C</span></div>
        <div class="dc-field"><span class="lbl">Arrêt</span><input type="number" step="0.5" data-bind="num-heatStop"><span class="unit">°C</span></div>
      </div>
      <div class="dc-config-group">
        <div class="group-title">Refroidissement</div>
        <div class="dc-field"><span class="lbl">Démarrage</span><input type="number" step="0.5" data-bind="num-coolStart"><span class="unit">°C</span></div>
        <div class="dc-field"><span class="lbl">Arrêt</span><input type="number" step="0.5" data-bind="num-coolStop"><span class="unit">°C</span></div>
      </div>
      <div class="dc-config-group">
        <div class="group-title">Temporisations</div>
        <div class="dc-field"><span class="lbl">Stabilisation</span><input type="number" step="1" data-bind="num-stabDuration"><span class="unit">min</span></div>
        <div class="dc-field"><span class="lbl">Cooldown</span><input type="number" step="1" data-bind="num-cooldownDuration"><span class="unit">min</span></div>
        <div class="dc-field"><span class="lbl">Override max</span><input type="number" step="1" data-bind="num-overrideDuration"><span class="unit">min</span></div>
      </div>
    </div>
  </details>

  <div class="dc-err" data-bind="error"></div>
`;

customElements.define("delormej-climate-card", DelormejClimateCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "delormej-climate-card",
  name: "Delormej Climate Card",
  description: "Carte tout-en-un pour une zone delormej_climate.",
  preview: false,
});

// Inject title text on first render
document.addEventListener("DOMContentLoaded", () => {});

console.info(
  "%c DELORMEJ-CLIMATE-CARD %c v0.4.2 ",
  "color: white; background: #28a745; font-weight: 700;",
  "color: #28a745; background: white; font-weight: 700;"
);
