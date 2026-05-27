/**
 * delormej-climate-card  v0.3.2
 *
 * Lovelace card for one zone of the delormej_climate integration.
 *
 * Usage:
 *   type: custom:delormej-climate-card
 *   zone: rdc                            # required
 *   title: Salon                         # optional — header label override
 *   climate_entity: climate.salon        # optional — underlying AC for live readouts
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
  none: "—",
  attaque: "Attaque",
  croisiere: "Croisière",
  approche: "Approche",
  stabilisation: "Stabilisation",
  boost: "Boost",
};


class DelormejClimateCard extends HTMLElement {
  setConfig(config) {
    if (!config?.zone) {
      throw new Error("Required: `zone` (the zone id, e.g. 'rdc')");
    }
    this._config = config;
    this._zone = config.zone;
    this._title = config.title || this._capitalize(config.zone);
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
    return 7;
  }

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

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered) {
      this._render();
      this._rendered = true;
    }
    this._update();
  }

  /* ============================================================== render */

  _render() {
    const root = document.createElement("ha-card");
    root.classList.add("dc-card");

    const style = document.createElement("style");
    style.textContent = `
      ha-card.dc-card {
        --dc-pad: 16px;
        --dc-gap: 12px;
        --dc-radius: 10px;
        --dc-divider: var(--divider-color, rgba(255,255,255,0.08));
        --dc-muted: var(--secondary-text-color, #8a8a8a);
        --dc-fg: var(--primary-text-color, #fff);
        padding: 0;
        overflow: hidden;
      }

      .dc-header {
        display: flex; align-items: center; gap: 10px;
        padding: var(--dc-pad);
      }
      .dc-header .title-block { flex: 1; min-width: 0; }
      .dc-header .title { font-size: 1.05em; font-weight: 600; line-height: 1.15; }
      .dc-header .subtitle { font-size: 0.8em; color: var(--dc-muted); margin-top: 2px; }
      .dc-state {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 10px; border-radius: 999px;
        font-size: 0.78em; font-weight: 600; color: white;
        background: var(--dc-state-color, #6c757d);
        white-space: nowrap;
      }
      .dc-state ha-icon { --mdc-icon-size: 14px; }

      .dc-hero {
        display: grid; grid-template-columns: 1fr auto;
        gap: var(--dc-gap); padding: 0 var(--dc-pad) var(--dc-pad);
        border-bottom: 1px solid var(--dc-divider);
      }
      .dc-hero .temp {
        font-size: 2.4em; font-weight: 700; line-height: 1;
        font-variant-numeric: tabular-nums;
        display: flex; align-items: baseline; gap: 4px;
      }
      .dc-hero .temp .unit { font-size: 0.5em; color: var(--dc-muted); font-weight: 400; }
      .dc-hero .temp-label { font-size: 0.78em; color: var(--dc-muted); margin-top: 4px; }
      .dc-hero .narrative {
        margin-top: 8px; font-size: 0.95em; line-height: 1.4;
        color: var(--dc-fg); grid-column: 1 / -1;
      }
      .dc-hero .narrative .target {
        color: var(--primary-color); font-weight: 600; font-variant-numeric: tabular-nums;
      }
      .dc-hero .narrative .until {
        color: var(--dc-muted); font-variant-numeric: tabular-nums;
      }
      .dc-hero .narrative.warn { color: var(--warning-color, #ffc107); }
      .dc-hero .regime { text-align: right; align-self: end; font-size: 0.85em; color: var(--dc-muted); }
      .dc-hero .regime-val { font-weight: 600; color: var(--dc-fg); display: block; }

      .dc-ctx { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px var(--dc-pad); }
      .dc-ctx:empty { display: none; }
      .dc-chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 8px; border-radius: 999px;
        font-size: 0.78em;
        background: var(--secondary-background-color, rgba(255,255,255,0.05));
        color: var(--dc-muted);
      }
      .dc-chip ha-icon { --mdc-icon-size: 14px; }
      .dc-chip.warn { background: rgba(255,193,7,0.15); color: var(--warning-color, #ffc107); }
      .dc-chip.info { background: rgba(13,110,253,0.12); color: var(--info-color, #5e9eff); }

      .dc-metrics {
        display: grid; grid-template-columns: 1fr 1fr;
        gap: 1px;
        background: var(--dc-divider);
      }
      .dc-metric {
        background: var(--card-background-color, #1a1a1a);
        padding: 10px var(--dc-pad);
        display: flex; flex-direction: column; gap: 2px;
      }
      .dc-metric .label {
        font-size: 0.72em; text-transform: uppercase;
        letter-spacing: 0.04em; color: var(--dc-muted);
      }
      .dc-metric .value {
        font-size: 1.1em; font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .dc-metric .value.dim { color: var(--dc-muted); }

      .dc-section { padding: var(--dc-pad); }
      .dc-section + .dc-section { border-top: 1px solid var(--dc-divider); }

      .dc-mode { display: flex; background: var(--secondary-background-color); border-radius: var(--dc-radius); padding: 3px; }
      .dc-mode button {
        flex: 1; padding: 8px; border: none; background: transparent; color: var(--dc-muted);
        font-size: 0.9em; font-weight: 500; cursor: pointer; border-radius: 8px;
        transition: background 0.15s, color 0.15s;
      }
      .dc-mode button:hover { color: var(--dc-fg); }
      .dc-mode button.active {
        background: var(--card-background-color, #1a1a1a);
        color: var(--dc-fg);
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      }
      .dc-mode button.active[data-mode="boost"] { color: var(--warning-color, #ffc107); }
      .dc-mode button.active[data-mode="off"] { color: var(--error-color, #dc3545); }

      .dc-actions { display: flex; gap: 8px; margin-top: 10px; }
      .dc-actions button {
        flex: 1; padding: 9px 12px; border-radius: var(--dc-radius);
        border: 1px solid var(--dc-divider); background: transparent;
        color: var(--dc-fg); cursor: pointer; font-weight: 500; font-size: 0.9em;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        transition: background 0.15s;
      }
      .dc-actions button ha-icon { --mdc-icon-size: 16px; }
      .dc-actions button:hover { background: var(--secondary-background-color); }
      .dc-actions button:disabled { opacity: 0.4; cursor: not-allowed; }

      details.dc-config { padding: 0; }
      details.dc-config > summary {
        padding: 12px var(--dc-pad); cursor: pointer;
        font-size: 0.9em; color: var(--dc-muted);
        display: flex; align-items: center; gap: 8px;
        list-style: none;
      }
      details.dc-config > summary::-webkit-details-marker { display: none; }
      details.dc-config > summary ha-icon { transition: transform 0.2s; --mdc-icon-size: 18px; }
      details.dc-config[open] > summary ha-icon.chevron { transform: rotate(90deg); }
      details.dc-config > summary:hover { color: var(--dc-fg); }
      .dc-config-body { padding: 4px var(--dc-pad) var(--dc-pad); }
      .dc-config-group { margin-bottom: 14px; }
      .dc-config-group:last-child { margin-bottom: 0; }
      .dc-config-group .group-title {
        font-size: 0.72em; text-transform: uppercase;
        letter-spacing: 0.04em; color: var(--dc-muted);
        margin-bottom: 6px;
      }
      .dc-field { display: grid; grid-template-columns: 1fr 80px 28px; gap: 8px; align-items: center; margin: 5px 0; font-size: 0.9em; }
      .dc-field .lbl { color: var(--dc-muted); }
      .dc-field .unit { color: var(--dc-muted); font-size: 0.85em; text-align: left; }
      .dc-field input[type=number] {
        width: 100%; padding: 6px 8px; border-radius: 6px;
        border: 1px solid var(--dc-divider);
        background: var(--secondary-background-color);
        color: var(--dc-fg); font-size: inherit; font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .dc-field input[type=number]:focus {
        outline: none; border-color: var(--primary-color);
      }
      .dc-err {
        margin: 8px var(--dc-pad); padding: 8px;
        border-radius: 6px; background: rgba(220,53,69,0.15);
        color: var(--error-color, #dc3545); font-size: 0.85em;
      }
      .dc-err:empty { display: none; }
    `;
    root.appendChild(style);

    const body = document.createElement("div");
    body.innerHTML = `
      <div class="dc-header">
        <div class="title-block">
          <div class="title">${this._escapeHTML(this._title)}</div>
          <div class="subtitle" data-bind="subtitle"></div>
        </div>
        <span class="dc-state" data-bind="state-badge">
          <ha-icon icon="mdi:circle-outline" data-bind="state-icon"></ha-icon>
          <span data-bind="state-label">—</span>
        </span>
      </div>

      <div class="dc-hero">
        <div>
          <div class="temp"><span data-bind="room-temp">—</span><span class="unit">°C</span></div>
          <div class="temp-label">T° zone</div>
        </div>
        <div class="regime">
          Régime
          <span class="regime-val" data-bind="regime">—</span>
        </div>
        <div class="narrative" data-bind="narrative"></div>
      </div>

      <div class="dc-ctx" data-bind="ctx"></div>

      <div class="dc-metrics">
        <div class="dc-metric">
          <span class="label">Consigne envoyée</span>
          <span class="value" data-bind="setpoint-sent">—</span>
        </div>
        <div class="dc-metric">
          <span class="label">Consigne clim</span>
          <span class="value" data-bind="climate-setpoint">—</span>
        </div>
        <div class="dc-metric">
          <span class="label">Sonde clim</span>
          <span class="value dim" data-bind="climate-internal">—</span>
        </div>
        <div class="dc-metric" data-bind="override-metric" style="display:none">
          <span class="label">Override jusqu'à</span>
          <span class="value" data-bind="override-until">—</span>
        </div>
      </div>

      <div class="dc-section">
        <div class="dc-mode" data-bind="mode">
          <button data-mode="auto">Auto</button>
          <button data-mode="off">Off</button>
          <button data-mode="boost">Boost</button>
        </div>
        <div class="dc-actions">
          <button data-bind="boost-btn" title="Active le boost pour 15 minutes puis retour auto">
            <ha-icon icon="mdi:rocket-launch"></ha-icon> Activer Boost 15 min
          </button>
          <button data-bind="resume-btn" title="Annule l'override manuel en cours">
            <ha-icon icon="mdi:restore"></ha-icon> Reprendre auto
          </button>
        </div>
      </div>

      <details class="dc-config">
        <summary>
          <ha-icon icon="mdi:chevron-right" class="chevron"></ha-icon>
          <ha-icon icon="mdi:tune"></ha-icon>
          <span>Configuration</span>
        </summary>
        <div class="dc-config-body">
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
    root.appendChild(body);
    this.appendChild(root);

    this._wireUp();
  }

  _wireUp() {
    const ids = this._entityIds();
    const $ = (sel) => this.querySelector(`[data-bind="${sel}"]`);

    $("mode").querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._call("select", "select_option", { entity_id: ids.modeSelect, option: btn.dataset.mode });
      });
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

  /* ============================================================== update */

  _update() {
    if (!this._hass) return;
    const $ = (sel) => this.querySelector(`[data-bind="${sel}"]`);
    const states = this._hass.states;
    const ids = this._entityIds();
    const get = (eid) => states[eid];

    // --- State ---
    const stateObj = get(ids.state);
    const stateVal = stateObj?.state ?? "unknown";
    const stateMeta = STATE_LABELS[stateVal] || { label: stateVal, color: "#6c757d", icon: "mdi:help-circle" };
    const badge = $("state-badge");
    badge.style.setProperty("--dc-state-color", stateMeta.color);
    $("state-icon").setAttribute("icon", stateMeta.icon);
    $("state-label").textContent = stateMeta.label;

    // Subtitle: e.g. "climate.salon · planning ouvert"
    const ent = this._climateEntity || "";
    const attrs = stateObj?.attributes || {};
    $("subtitle").textContent = ent || "";

    // --- Hero ---
    $("room-temp").textContent = this._fmtTemp(get(ids.roomTemp)?.state);
    const regimeVal = get(ids.regime)?.state;
    $("regime").textContent = REGIME_LABELS[regimeVal] ?? "—";

    // --- Narrative line ---
    const narrative = this._buildNarrative(stateVal, regimeVal, attrs, get, ids);
    const narrativeEl = $("narrative");
    narrativeEl.innerHTML = narrative.html;
    narrativeEl.classList.toggle("warn", !!narrative.warn);

    // --- Context chips ---
    const ctx = $("ctx");
    ctx.innerHTML = "";
    if (attrs.schedule_on === false) ctx.appendChild(this._chip("mdi:clock-outline", "Hors planning", "warn"));
    if (attrs.any_window_open === true) ctx.appendChild(this._chip("mdi:window-open", "Fenêtre ouverte", "warn"));
    if (attrs.house_is_absent === true) ctx.appendChild(this._chip("mdi:home-export-outline", "Maison absente", "info"));
    if (attrs.in_override === true) ctx.appendChild(this._chip("mdi:account-edit", "Override manuel", "warn"));

    // --- Metrics ---
    $("setpoint-sent").textContent = this._fmtTempUnit(get(ids.setpointSent)?.state);

    if (this._climateEntity) {
      const clim = get(this._climateEntity);
      $("climate-internal").textContent = this._fmtTempUnit(clim?.attributes?.current_temperature);
      $("climate-setpoint").textContent = this._fmtTempUnit(clim?.attributes?.temperature);
    } else {
      $("climate-internal").textContent = "—";
      $("climate-setpoint").textContent = "—";
    }

    const overrideUntil = get(ids.overrideUntil);
    if (overrideUntil && overrideUntil.state !== "unknown" && overrideUntil.state !== "unavailable") {
      $("override-metric").style.display = "";
      $("override-until").textContent = this._fmtTime(overrideUntil.state);
    } else {
      $("override-metric").style.display = "none";
    }

    // --- Mode segmented control ---
    const currentMode = get(ids.modeSelect)?.state;
    $("mode").querySelectorAll("button").forEach((b) => {
      if (b.dataset.mode === currentMode) b.classList.add("active");
      else b.classList.remove("active");
    });

    // --- Config inputs ---
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

  /* ============================================================== narrative */

  _buildNarrative(state, regime, attrs, get, ids) {
    const dir = attrs.direction;  // 'cool' | 'heat' | null
    const target = attrs.target_temperature;
    const targetSpan = (t) => `<span class="target">${this._fmtTemp(t)}°C</span>`;
    const verb = dir === "heat" ? "Chauffage" : "Refroidissement";

    if (state === "idle") {
      const heatStart = parseFloat(get(ids.heatStart)?.state);
      const coolStart = parseFloat(get(ids.coolStart)?.state);
      const room = parseFloat(get(ids.roomTemp)?.state);
      let parts = [];
      if (!Number.isNaN(coolStart)) parts.push(`refroidira si T° > ${coolStart}°C`);
      if (!Number.isNaN(heatStart)) parts.push(`chauffera si T° < ${heatStart}°C`);
      // Hint about which seuil is closer
      let hint = "";
      if (!Number.isNaN(room) && !Number.isNaN(coolStart) && !Number.isNaN(heatStart)) {
        const dToCool = coolStart - room;
        const dToHeat = room - heatStart;
        if (dToCool > 0 && dToCool < dToHeat) hint = ` (${dToCool.toFixed(1)}°C avant cool)`;
        else if (dToHeat > 0 && dToHeat < dToCool) hint = ` (${dToHeat.toFixed(1)}°C avant heat)`;
      }
      return { html: `Inactif. ${parts.join(" ; ")}${hint}.`, warn: false };
    }

    if (state === "starting") {
      return { html: `Démarrage ${dir === "heat" ? "chauffage" : "refroidissement"} vers ${targetSpan(target)}.`, warn: false };
    }

    if (state === "running") {
      switch (regime) {
        case "attaque":
          return { html: `${verb} intensif vers ${targetSpan(target)}.`, warn: false };
        case "croisiere":
          return { html: `${verb} en cours vers ${targetSpan(target)}.`, warn: false };
        case "approche":
          return { html: `Approche de ${targetSpan(target)}.`, warn: false };
        case "boost":
          return { html: `Mode boost ${dir === "heat" ? "chauffage" : "refroidissement"} vers ${targetSpan(target)}.`, warn: false };
        default:
          return { html: `${verb} en cours.`, warn: false };
      }
    }

    if (state === "stabilizing") {
      const until = attrs.stabilization_ends_at;
      const untilTxt = until ? ` jusqu'à <span class="until">${this._fmtTime(until)}</span>` : "";
      return { html: `Stabilisation à ${targetSpan(target)}${untilTxt}.`, warn: false };
    }

    if (state === "cooldown") {
      const until = attrs.cooldown_ends_at;
      const untilTxt = until ? ` jusqu'à <span class="until">${this._fmtTime(until)}</span>` : "";
      return { html: `Pause anti-rebond${untilTxt}.`, warn: false };
    }

    if (state === "schedule_off") {
      return { html: "Hors plage planning, pilotage auto désactivé.", warn: true };
    }

    if (state === "manual_override_timed") {
      const overrideUntil = get(ids.overrideUntil)?.state;
      const untilTxt = overrideUntil && overrideUntil !== "unknown"
        ? ` jusqu'à <span class="until">${this._fmtTime(overrideUntil)}</span>`
        : "";
      return { html: `Override manuel${untilTxt}.`, warn: true };
    }

    if (state === "manual_override_free") {
      return { html: "Pilotage manuel libre (auto reprend si le planning rouvre).", warn: true };
    }

    if (state === "window_open") {
      return { html: "Fenêtre ouverte, clim en pause.", warn: true };
    }

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
    const errEl = this.querySelector('[data-bind="error"]');
    errEl.textContent = "";
    this._hass.callService(domain, service, data).catch((e) => {
      errEl.textContent = `${domain}.${service} a échoué : ${e?.message || e}`;
      setTimeout(() => (errEl.textContent = ""), 4500);
    });
  }

  _fmtTemp(v) {
    if (v == null || v === "unknown" || v === "unavailable") return "—";
    const f = parseFloat(v);
    return Number.isNaN(f) ? "—" : f.toFixed(1);
  }
  _fmtTempUnit(v) {
    const t = this._fmtTemp(v);
    return t === "—" ? "—" : `${t} °C`;
  }
  _fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    } catch { return iso; }
  }
  _escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  _capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
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
  "%c DELORMEJ-CLIMATE-CARD %c v0.3.2 ",
  "color: white; background: #28a745; font-weight: 700;",
  "color: #28a745; background: white; font-weight: 700;"
);
