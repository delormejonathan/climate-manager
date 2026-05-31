/**
 * delormej-climate-card  v0.10.0
 *
 * Four-section layout for one zone of the delormej_climate integration:
 *   1. ÉTAT ACTUEL       — observability (T° hero, narrative, profile pill)
 *   2. PROFILS           — cascade of driver profiles (add/edit/reorder)
 *   3. PILOTAGE          — mode (auto/off/boost) + force start
 *   4. COMMANDE MANUELLE — boost/resume + direct climate.* controls
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
  none: "—", attaque: "Attaque", stabilisation: "Stabilisation", boost: "Boost",
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
      powerSelect: this._ent("select", "power"),
      fanIntensitySelect: this._ent("select", "fan_intensity"),
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

    // Profiles — single delegate on the list, plus "add" button
    $("profiles-list").addEventListener("click", (e) => this._onProfileListClick(e));
    $("profiles-list").addEventListener("change", (e) => this._onProfileFieldChange(e));
    $("profile-add").addEventListener("click", () => this._onProfileAdd());
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

    // Timeline + sparkline (only during an active cycle)
    this._updateTimeline(stateVal, attrs, get, ids);

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

    // Profil actif — surfacing the cascade decision in §1 so the user sees
    // which profile drives the current cycle without scrolling to §2.
    const activeProfileName = attrs.active_profile_name;
    if (activeProfileName) {
      pills.appendChild(this._pill("mdi:tag", `Profil : ${activeProfileName}`, "info"));
    } else if (Array.isArray(attrs.profiles) && attrs.profiles.length > 0) {
      pills.appendChild(this._pill("mdi:tag-off", "Aucun profil actif", "warn"));
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

    // ─────────────────── SECTION 2: PROFILS (rendu cascade)
    this._renderProfiles(attrs);

    // ─────────────────── SECTION 3: PILOTAGE
    const currentMode = get(ids.modeSelect)?.state;
    $("mode").querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === currentMode));

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

    // ─────────────────── SECTION 4: COMMANDE MANUELLE
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
        attaque: `${verb} en cours vers ${targetSpan(target)}.`,
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

  /* =================================================================== profiles */

  _renderProfiles(attrs) {
    const list = this.querySelector('[data-bind="profiles-list"]');
    const empty = this.querySelector('[data-bind="profiles-empty"]');
    const profiles = Array.isArray(attrs.profiles) ? attrs.profiles : [];
    const activeName = attrs.active_profile_name;

    if (profiles.length === 0) {
      list.innerHTML = "";
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";

    // Re-render only when the underlying data signature changes (avoids
    // wiping a half-typed input on every coordinator tick).
    const sig = JSON.stringify({ profiles, activeName, editing: this._editingProfileIdx });
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.innerHTML = "";

    profiles.forEach((p, idx) => {
      list.appendChild(this._buildProfileCard(p, idx, idx === this._editingProfileIdx, p.name === activeName));
    });
  }

  _buildProfileCard(profile, idx, isEditing, isActive) {
    const card = document.createElement("div");
    card.className = "dc-profile" + (isActive ? " dc-profile--active" : "");
    card.dataset.idx = String(idx);

    if (isEditing) {
      card.appendChild(this._buildProfileEditForm(profile, idx));
      return card;
    }

    const head = document.createElement("div");
    head.className = "dc-profile-head";
    head.innerHTML = `
      ${isActive ? '<span class="dc-profile-badge">ACTIF</span>' : ''}
      <span class="dc-profile-name">${this._escapeHTML(profile.name || "Sans nom")}</span>
      <div class="dc-profile-actions">
        <button data-action="up" title="Monter">↑</button>
        <button data-action="down" title="Descendre">↓</button>
        <button data-action="edit" title="Éditer"><ha-icon icon="mdi:pencil"></ha-icon></button>
        <button data-action="delete" title="Supprimer"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
      </div>`;
    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "dc-profile-meta";
    const schedule = profile.schedule_entity || "—";
    const presence = profile.presence_entity
      ? `${profile.presence_entity}${profile.presence_required_state ? " = " + profile.presence_required_state : ""}`
      : null;
    meta.innerHTML = `
      <span><ha-icon icon="mdi:calendar-clock"></ha-icon>${this._escapeHTML(schedule)}</span>
      ${presence ? `<span><ha-icon icon="mdi:shield-account"></ha-icon>${this._escapeHTML(presence)}</span>` : ''}
      <span><ha-icon icon="mdi:snowflake"></ha-icon>cible ${this._fmtTemp(profile.seuil_fin_refroidissement)}°C</span>
      <span><ha-icon icon="mdi:flash"></ha-icon>${this._capitalize(profile.power || "normal")}</span>
      <span><ha-icon icon="mdi:fan"></ha-icon>${this._capitalize(profile.fan_intensity || "normal")}</span>`;
    card.appendChild(meta);
    return card;
  }

  _buildProfileEditForm(profile, idx) {
    const form = document.createElement("div");
    form.className = "dc-profile-edit";
    form.dataset.idx = String(idx);
    const scheduleEntities = this._listEntities("schedule.");
    const presenceEntities = this._listEntities(["alarm_control_panel.", "person.", "binary_sensor.", "device_tracker.", "input_boolean.", "group."]);
    const opt = (val, label, current) =>
      `<option value="${this._escapeHTML(val)}" ${val === current ? "selected" : ""}>${this._escapeHTML(label)}</option>`;
    form.innerHTML = `
      <div class="dc-profile-edit-title">Édition de ${this._escapeHTML(profile.name || "Sans nom")}</div>
      <div class="dc-field"><label>Nom</label>
        <input type="text" data-field="name" value="${this._escapeHTML(profile.name || "")}">
      </div>
      <div class="dc-field"><label>Schedule (gate horaire)</label>
        <select data-field="schedule_entity">
          ${opt("", "— Aucun (toujours actif) —", profile.schedule_entity || "")}
          ${scheduleEntities.map(e => opt(e, e, profile.schedule_entity || "")).join("")}
        </select>
      </div>
      <div class="dc-field"><label>Entité présence (condition optionnelle)</label>
        <select data-field="presence_entity">
          ${opt("", "— Aucune condition —", profile.presence_entity || "")}
          ${presenceEntities.map(e => opt(e, e, profile.presence_entity || "")).join("")}
        </select>
      </div>
      <div class="dc-field"><label>État requis (ex: armed_away, home, on)</label>
        <input type="text" data-field="presence_required_state" value="${this._escapeHTML(profile.presence_required_state || "")}">
      </div>
      <div class="dc-pair">
        <div class="dc-field"><label>Démarrage froid</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-field="seuil_debut_refroidissement" value="${profile.seuil_debut_refroidissement}"><span class="unit">°C</span></div>
        </div>
        <div class="dc-field"><label>Cible froid</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-field="seuil_fin_refroidissement" value="${profile.seuil_fin_refroidissement}"><span class="unit">°C</span></div>
        </div>
      </div>
      <div class="dc-pair">
        <div class="dc-field"><label>Démarrage chaud</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-field="seuil_debut_chauffage" value="${profile.seuil_debut_chauffage}"><span class="unit">°C</span></div>
        </div>
        <div class="dc-field"><label>Cible chaud</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-field="seuil_fin_chauffage" value="${profile.seuil_fin_chauffage}"><span class="unit">°C</span></div>
        </div>
      </div>
      <div class="dc-pair">
        <div class="dc-field"><label>Puissance</label>
          <select data-field="power">
            ${["doux","normal","agressif"].map(o => opt(o, this._capitalize(o), profile.power || "normal")).join("")}
          </select>
        </div>
        <div class="dc-field"><label>Ventilation</label>
          <select data-field="fan_intensity">
            ${["doux","normal","fort"].map(o => opt(o, this._capitalize(o), profile.fan_intensity || "normal")).join("")}
          </select>
        </div>
      </div>
      <div class="dc-profile-edit-actions">
        <button data-action="cancel">Annuler</button>
        <button data-action="save" class="dc-profile-save">Enregistrer</button>
      </div>`;
    return form;
  }

  _listEntities(prefixes) {
    if (!this._hass) return [];
    const list = Array.isArray(prefixes) ? prefixes : [prefixes];
    return Object.keys(this._hass.states)
      .filter((eid) => list.some((p) => eid.startsWith(p)))
      .sort();
  }

  _onProfileListClick(e) {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const card = btn.closest(".dc-profile");
    if (!card) return;
    const idx = parseInt(card.dataset.idx, 10);
    const action = btn.dataset.action;
    if (action === "edit") {
      this._editingProfileIdx = idx;
      this._update();
    } else if (action === "cancel") {
      this._editingProfileIdx = null;
      this._update();
    } else if (action === "delete") {
      if (!confirm(`Supprimer ce profil ?`)) return;
      const profiles = this._currentProfiles();
      profiles.splice(idx, 1);
      this._editingProfileIdx = null;
      this._pushProfiles(profiles);
    } else if (action === "up" && idx > 0) {
      const profiles = this._currentProfiles();
      [profiles[idx - 1], profiles[idx]] = [profiles[idx], profiles[idx - 1]];
      this._pushProfiles(profiles);
    } else if (action === "down") {
      const profiles = this._currentProfiles();
      if (idx < profiles.length - 1) {
        [profiles[idx], profiles[idx + 1]] = [profiles[idx + 1], profiles[idx]];
        this._pushProfiles(profiles);
      }
    } else if (action === "save") {
      const form = card.querySelector(".dc-profile-edit");
      if (!form) return;
      const profiles = this._currentProfiles();
      profiles[idx] = this._readProfileForm(form, profiles[idx]);
      this._editingProfileIdx = null;
      this._pushProfiles(profiles);
    }
  }

  _onProfileFieldChange(_e) {
    // No-op for now — fields are only committed on Enregistrer. Kept as a
    // listener anchor so we can add per-field validation later.
  }

  _onProfileAdd() {
    const profiles = this._currentProfiles();
    profiles.push({
      name: "Nouveau profil",
      schedule_entity: null,
      presence_entity: null,
      presence_required_state: null,
      seuil_debut_chauffage: 19.5,
      seuil_fin_chauffage: 21.0,
      seuil_debut_refroidissement: 26.5,
      seuil_fin_refroidissement: 24.0,
      power: "normal",
      fan_intensity: "normal",
    });
    this._editingProfileIdx = profiles.length - 1;
    this._pushProfiles(profiles);
  }

  _currentProfiles() {
    const attrs = this._hass?.states[this._ent("sensor", "state")]?.attributes || {};
    // Deep copy so we don't mutate the cached attrs in place
    return JSON.parse(JSON.stringify(attrs.profiles || []));
  }

  _readProfileForm(form, fallback) {
    const get = (field) => form.querySelector(`[data-field="${field}"]`)?.value ?? "";
    const f = (field, def) => {
      const v = parseFloat(get(field));
      return Number.isFinite(v) ? v : def;
    };
    const s = (field) => {
      const v = get(field);
      return v === "" ? null : v;
    };
    return {
      name: get("name") || "Sans nom",
      schedule_entity: s("schedule_entity"),
      presence_entity: s("presence_entity"),
      presence_required_state: s("presence_required_state"),
      seuil_debut_chauffage: f("seuil_debut_chauffage", fallback?.seuil_debut_chauffage ?? 19.5),
      seuil_fin_chauffage: f("seuil_fin_chauffage", fallback?.seuil_fin_chauffage ?? 21.0),
      seuil_debut_refroidissement: f("seuil_debut_refroidissement", fallback?.seuil_debut_refroidissement ?? 26.5),
      seuil_fin_refroidissement: f("seuil_fin_refroidissement", fallback?.seuil_fin_refroidissement ?? 24.0),
      power: get("power") || "normal",
      fan_intensity: get("fan_intensity") || "normal",
    };
  }

  _pushProfiles(profiles) {
    this._call("delormej_climate", "update_profiles", {
      zone_id: this._zone,
      profiles,
    });
  }

  /* =================================================================== timeline */

  _updateTimeline(state, attrs, get, ids) {
    const $ = (sel) => this.querySelector(`[data-bind="${sel}"]`);
    const block = $("timeline");
    if (!block) return;

    const active = state === "starting" || state === "running" || state === "stabilizing";
    const startedAt = attrs.cycle_started_at;
    if (!active || !startedAt) {
      block.style.display = "none";
      return;
    }
    block.style.display = "";

    const startMs = Date.parse(startedAt);
    const elapsedMin = Math.max(0, Math.round((Date.now() - startMs) / 60000));
    const target = attrs.target_temperature;

    // Fetch (or reuse cached) history of the room temp sensor since cycle start.
    this._ensureSparkData(ids.roomTemp, startMs).then((points) => {
      this._renderSpark($("spark"), points, target, attrs.direction);
      // Text line: "Démarré il y a 23min · -2.0°C"
      const txtEl = $("timeline-text");
      const deltaTxt = this._deltaText(points, parseFloat(get(ids.roomTemp)?.state));
      const elapsedTxt = elapsedMin === 0 ? "à l'instant" : `il y a ${elapsedMin} min`;
      txtEl.innerHTML = deltaTxt
        ? `Démarré ${elapsedTxt} · <span class="dc-delta">${deltaTxt}</span>`
        : `Démarré ${elapsedTxt}`;
    });
  }

  _deltaText(points, currentT) {
    if (!points || points.length === 0 || Number.isNaN(currentT)) return null;
    const startT = points[0].t;
    const d = currentT - startT;
    if (Math.abs(d) < 0.1) return "stable";
    const sign = d > 0 ? "+" : "−";
    return `${sign}${Math.abs(d).toFixed(1)}°C`;
  }

  async _ensureSparkData(entityId, cycleStartMs) {
    const now = Date.now();
    const cache = this._sparkCache;
    if (
      cache
      && cache.entityId === entityId
      && cache.cycleStartMs === cycleStartMs
      && now - cache.fetchedAt < 30_000
    ) {
      return cache.points;
    }
    const startIso = new Date(cycleStartMs).toISOString();
    const endIso = new Date(now).toISOString();
    let raw;
    try {
      raw = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: startIso,
        end_time: endIso,
        entity_ids: [entityId],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
    } catch {
      return cache?.points || [];
    }
    const series = (raw && raw[entityId]) || [];
    const points = [];
    for (const s of series) {
      const v = parseFloat(s.s ?? s.state);
      // Each row's timestamp is either `lu` (minimal) or `last_updated`
      const ts = (s.lu ?? s.last_updated);
      if (!Number.isNaN(v) && ts != null) {
        const ms = typeof ts === "number" ? ts * 1000 : Date.parse(ts);
        points.push({ ms, t: v });
      }
    }
    this._sparkCache = { entityId, cycleStartMs, fetchedAt: now, points };
    return points;
  }

  _renderSpark(el, points, target, direction) {
    if (!el) return;
    if (!points || points.length < 2) {
      el.innerHTML = "";
      return;
    }
    const W = 280, H = 56, padX = 4, padY = 6;
    const xs = points.map(p => p.ms);
    const ys = points.map(p => p.t);
    const xMin = xs[0], xMax = Math.max(xs[xs.length - 1], xs[0] + 60_000);
    const tValues = [...ys];
    if (typeof target === "number") tValues.push(target);
    let yMin = Math.min(...tValues) - 0.3;
    let yMax = Math.max(...tValues) + 0.3;
    if (yMax - yMin < 1) { yMax = yMin + 1; }
    const sx = (x) => padX + ((x - xMin) / (xMax - xMin)) * (W - 2 * padX);
    const sy = (y) => padY + (1 - (y - yMin) / (yMax - yMin)) * (H - 2 * padY);

    const stroke = direction === "heat" ? "#ff6b35" : "#4d8bff";
    const path = points.map((p, i) =>
      `${i === 0 ? "M" : "L"}${sx(p.ms).toFixed(1)},${sy(p.t).toFixed(1)}`
    ).join(" ");

    let targetLine = "";
    if (typeof target === "number") {
      const ty = sy(target).toFixed(1);
      targetLine =
        `<line x1="${padX}" y1="${ty}" x2="${W - padX}" y2="${ty}" `
        + `stroke="#fd9853" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`;
    }

    const last = points[points.length - 1];
    const lastDot =
      `<circle cx="${sx(last.ms).toFixed(1)}" cy="${sy(last.t).toFixed(1)}" `
      + `r="2.5" fill="${stroke}"/>`;

    el.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" `
      + `style="width:100%;height:${H}px;display:block">`
      + targetLine
      + `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.6" `
      + `stroke-linejoin="round" stroke-linecap="round"/>`
      + lastDot
      + `</svg>`;
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
  .section-status   .head-bubble { background: var(--dc-info); }
  .section-profiles .head-bubble { background: var(--dc-warn); }
  .section-auto     .head-bubble { background: var(--dc-success); }
  .section-manual   .head-bubble { background: var(--dc-cool); }

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
    gap: 14px; flex-wrap: wrap;
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
    color: var(--dc-muted); font-size: 1.1em; font-weight: 400;
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
  }
  .dc-hero .target-block {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
  }
  .dc-hero .target-block .target {
    font-size: 1em; font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--dc-accent);
  }
  .dc-hero .target-block .target-label {
    font-size: 0.65em; color: var(--dc-dim); font-weight: 500;
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

  /* Timeline + sparkline (visible during an active cycle) */
  .dc-timeline {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--dc-hairline);
  }
  .dc-timeline-text {
    font-size: 0.82em;
    color: var(--dc-muted);
    margin-bottom: 6px;
    font-variant-numeric: tabular-nums;
  }
  .dc-timeline-text .dc-delta {
    color: var(--dc-info);
    font-weight: 600;
  }
  .dc-spark { width: 100%; }
  .dc-spark svg { display: block; }

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

  /* Collapsible 'Détails techniques' — hidden by default, keeps §1 concise */
  .dc-details-toggle {
    margin-top: 10px;
    border-top: 1px dashed var(--dc-hairline);
    padding-top: 4px;
  }
  .dc-details-toggle > summary {
    cursor: pointer; list-style: none;
    padding: 10px 4px;
    font-size: 0.8em; color: var(--dc-muted); font-weight: 600;
    display: flex; align-items: center; gap: 8px;
    user-select: none;
  }
  .dc-details-toggle > summary::-webkit-details-marker { display: none; }
  .dc-details-toggle > summary::before {
    content: "▸";
    display: inline-block;
    transition: transform 0.2s ease;
    color: var(--dc-dim);
  }
  .dc-details-toggle[open] > summary::before { transform: rotate(90deg); }
  .dc-details-toggle > summary:hover { color: var(--dc-fg); }
  .dc-details-toggle[open] .dc-metrics { margin-top: 4px; }

  /* ============ §2 PROFILS ============ */
  .dc-profiles-list {
    display: flex; flex-direction: column; gap: 8px;
    margin-bottom: 10px;
  }
  .dc-profiles-empty {
    background: var(--dc-bg-bubble);
    border-radius: var(--dc-radius-sm);
    padding: 14px;
    color: var(--dc-muted);
    font-size: 0.85em;
    text-align: center;
    margin-bottom: 10px;
  }
  .dc-profile {
    background: var(--dc-bg-bubble);
    border-radius: var(--dc-radius-sm);
    padding: 12px;
    border: 1px solid transparent;
  }
  .dc-profile--active {
    background: rgba(67,160,71,0.10);
    border-color: rgba(67,160,71,0.35);
  }
  .dc-profile-head {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 8px;
  }
  .dc-profile-badge {
    background: var(--dc-success);
    color: white;
    font-size: 0.65em; font-weight: 700;
    padding: 2px 7px;
    border-radius: var(--dc-radius-pill);
    letter-spacing: 0.05em;
  }
  .dc-profile-name {
    flex: 1;
    font-weight: 600;
    color: var(--dc-fg);
    font-size: 0.95em;
  }
  .dc-profile-actions {
    display: flex; gap: 4px;
  }
  .dc-profile-actions button {
    width: 32px; height: 32px;
    border: none; border-radius: 50%;
    background: var(--dc-bg-bubble-strong);
    color: var(--dc-muted);
    cursor: pointer; font-size: 0.95em; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
  }
  .dc-profile-actions button ha-icon { --mdc-icon-size: 16px; }
  .dc-profile-actions button:hover { background: var(--dc-bg-inset); color: var(--dc-fg); }
  .dc-profile-meta {
    display: flex; flex-wrap: wrap; gap: 4px 10px;
    font-size: 0.78em; color: var(--dc-muted);
  }
  .dc-profile-meta span { display: inline-flex; align-items: center; gap: 5px; }
  .dc-profile-meta ha-icon { --mdc-icon-size: 14px; color: var(--dc-dim); }

  /* Profile edit form */
  .dc-profile-edit { display: flex; flex-direction: column; gap: 10px; }
  .dc-profile-edit-title {
    font-size: 0.85em; color: var(--dc-muted); font-weight: 600;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--dc-hairline);
  }
  .dc-profile-edit .dc-field { display: flex; flex-direction: column; gap: 4px; }
  .dc-profile-edit .dc-field label {
    font-size: 0.75em; color: var(--dc-muted); font-weight: 600;
  }
  .dc-profile-edit input[type="text"],
  .dc-profile-edit input[type="number"],
  .dc-profile-edit select {
    background: var(--dc-bg-inset); border: none;
    border-radius: var(--dc-radius-sm);
    color: var(--dc-fg); padding: 9px 11px;
    font-size: 0.9em; font-weight: 500;
    appearance: none; -webkit-appearance: none;
  }
  .dc-profile-edit select {
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(255,255,255,0.5)' d='M0 0l5 6 5-6z'/></svg>");
    background-repeat: no-repeat; background-position: right 10px center;
    padding-right: 28px;
  }
  .dc-profile-edit input:focus,
  .dc-profile-edit select:focus { outline: 2px solid var(--dc-cool); outline-offset: -2px; }
  .dc-profile-edit-actions {
    display: flex; gap: 8px; justify-content: flex-end;
    margin-top: 4px;
  }
  .dc-profile-edit-actions button {
    padding: 8px 16px;
    border-radius: var(--dc-radius-pill);
    border: none; cursor: pointer;
    font-size: 0.85em; font-weight: 600;
    background: var(--dc-bg-inset); color: var(--dc-muted);
    transition: all 0.15s;
  }
  .dc-profile-edit-actions button:hover { background: var(--dc-bg-bubble-strong); color: var(--dc-fg); }
  .dc-profile-edit-actions .dc-profile-save {
    background: var(--dc-success); color: white;
  }
  .dc-profile-edit-actions .dc-profile-save:hover { background: #2e8430; }

  .dc-profile-add {
    width: 100%;
    padding: 11px 14px;
    border: 1px dashed var(--dc-hairline);
    border-radius: var(--dc-radius-sm);
    background: transparent;
    color: var(--dc-muted);
    font-size: 0.9em; font-weight: 600;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    transition: all 0.15s;
  }
  .dc-profile-add ha-icon { --mdc-icon-size: 18px; }
  .dc-profile-add:hover {
    border-color: var(--dc-cool);
    color: var(--dc-cool);
  }

  /* ============ §3 PILOTAGE ============ */
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
  .dc-segmented.tone-warn button.active[data-power="agressif"],
  .dc-segmented.tone-warn button.active[data-fan-intensity="fort"] {
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

  /* ============ §4 COMMANDE MANUELLE ============ */
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
    <span class="dc-state" data-bind="state-badge">
      <ha-icon icon="mdi:circle-outline" data-bind="state-icon"></ha-icon>
      <span data-bind="state-label">—</span>
    </span>
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
      <div class="dc-timeline" data-bind="timeline" style="display:none">
        <div class="dc-timeline-text" data-bind="timeline-text"></div>
        <div class="dc-spark" data-bind="spark"></div>
      </div>
    </div>

    <div class="dc-pills" data-bind="status-pills"></div>

    <div class="dc-override-row" data-bind="override-row" style="display:none">
      <span class="lbl"><ha-icon icon="mdi:account-clock"></ha-icon>Override jusqu'à</span>
      <span class="val" data-bind="override-until-val">—</span>
    </div>

    <details class="dc-details-toggle">
      <summary>Détails techniques</summary>
      <div class="dc-metrics">
        <div class="dc-metric-row">
          <span class="label"><ha-icon icon="mdi:send"></ha-icon>Consigne envoyée par le module</span>
          <span class="value" data-bind="metric-setpoint-sent">—</span>
        </div>
        <div class="dc-metric-row">
          <span class="label"><ha-icon icon="mdi:thermostat"></ha-icon>Consigne actuelle de la clim</span>
          <span class="value" data-bind="metric-clim-setpoint">—</span>
        </div>
        <div class="dc-metric-row">
          <span class="label"><ha-icon icon="mdi:thermometer"></ha-icon>Sonde interne clim</span>
          <span class="value" data-bind="metric-clim-sonde">—</span>
        </div>
        <div class="dc-metric-row">
          <span class="label"><ha-icon icon="mdi:gauge"></ha-icon>Régime de pilotage</span>
          <span class="value" data-bind="metric-regime">—</span>
        </div>
      </div>
    </details>
  </section>

  <!-- ════════════════════════════════════ §2 PROFILS -->
  <section class="dc-section section-profiles">
    <div class="dc-section-head">
      <div class="head-bubble"><ha-icon icon="mdi:layers-triple"></ha-icon></div>
      <span class="lbl">Profils</span>
    </div>
    <div class="dc-profiles-empty" data-bind="profiles-empty" style="display:none">
      Aucun profil configuré. Tant qu'aucun profil ne match, la zone reste OFF.
    </div>
    <div class="dc-profiles-list" data-bind="profiles-list"></div>
    <button class="dc-profile-add" data-bind="profile-add">
      <ha-icon icon="mdi:plus-circle"></ha-icon> Nouveau profil
    </button>
  </section>

  <!-- ════════════════════════════════════ §3 PILOTAGE -->
  <section class="dc-section section-auto">
    <div class="dc-section-head">
      <div class="head-bubble"><ha-icon icon="mdi:robot"></ha-icon></div>
      <span class="lbl">Pilotage</span>
    </div>

    <div class="dc-control">
      <div class="dc-control-label">Mode pilotage</div>
      <div class="dc-segmented tone-warn tone-danger" data-bind="mode">
        <button data-mode="auto">Auto</button>
        <button data-mode="off">Off</button>
        <button data-mode="boost">Boost</button>
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
  </section>

  <!-- ════════════════════════════════════ §4 COMMANDE MANUELLE -->
  <section class="dc-section section-manual">
    <div class="dc-section-head">
      <div class="head-bubble"><ha-icon icon="mdi:hand-back-right"></ha-icon></div>
      <span class="lbl">Commande manuelle</span>
    </div>

    <div class="dc-control">
      <div class="dc-control-label">Actions rapides</div>
      <div class="dc-quick-actions">
        <button data-bind="boost-btn"><ha-icon icon="mdi:rocket-launch"></ha-icon> Boost 15 min</button>
        <button data-bind="resume-btn"><ha-icon icon="mdi:restore"></ha-icon> Reprendre auto</button>
      </div>
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
  </section>

  <div class="dc-err" data-bind="error"></div>
`;

customElements.define("delormej-climate-card", DelormejClimateCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "delormej-climate-card",
  name: "Delormej Climate Card",
  description: "Carte tout-en-un en 4 sections : état, profils, pilotage, commande manuelle.",
  preview: false,
});

console.info(
  "%c DELORMEJ-CLIMATE-CARD %c v0.10.0 ",
  "color: white; background: #28a745; font-weight: 700;",
  "color: #28a745; background: white; font-weight: 700;"
);
