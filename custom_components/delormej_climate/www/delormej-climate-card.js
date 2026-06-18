/**
 * delormej-climate-card  v0.13.0
 *
 * Instrument-panel redesign. Five sections for one zone:
 *   1. ÉTAT ACTUEL       — narrative + thermal rail + phase ribbon (signature)
 *   2. PROFILS           — cascade of driver profiles (add/edit/reorder)
 *   3. PILOTAGE          — mode (auto/off/boost) + force start
 *   4. COMMANDE MANUELLE — boost/resume + direct climate.* controls
 *   5. SESSIONS RÉCENTES — last N completed cycles with per-row sparklines
 *
 * Usage:
 *   type: custom:delormej-climate-card
 *   zone: rdc
 *   title: Salon (RDC)
 *   climate_entity: climate.salon
 */

// Each state has a tone class for the header tag (dot color + animation):
//   active = lime pulsing dot (cycle running)
//   warn   = amber (transient/transitional)
//   alert  = red (override / window open)
//   idle   = gray (no animation)
const STATE_META = {
  idle:        { label: "En veille",       color: "#8A92A0", icon: "mdi:power-sleep", tone: "idle" },
  starting:    { label: "Démarrage",       color: "#F5A056", icon: "mdi:play-circle", tone: "warn" },
  running:     { label: "Actif",           color: "#D6FF00", icon: "mdi:fan", tone: "active" },
  stabilizing: { label: "Stabilisation",   color: "#D6FF00", icon: "mdi:waves", tone: "active" },
  cooldown:    { label: "Cooldown",        color: "#5BC8E2", icon: "mdi:timer-sand", tone: "warn" },
  schedule_off:{ label: "Hors planning",   color: "#8A92A0", icon: "mdi:clock-outline", tone: "idle" },
  manual_override_timed: { label: "Override", color: "#F26D5B", icon: "mdi:account-clock", tone: "alert" },
  manual_override_free:  { label: "Manuel",   color: "#F26D5B", icon: "mdi:account-edit", tone: "alert" },
  window_open: { label: "Fenêtre ouverte", color: "#F5A056", icon: "mdi:window-open", tone: "warn" },
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
    const meta = STATE_META[stateVal] || { label: stateVal, color: "#8A92A0", icon: "mdi:help-circle", tone: "idle" };
    const badge = $("state-badge");
    badge.style.setProperty("--dc-state-color", meta.color);
    badge.className = `dc-state state-${meta.tone}`;
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

    // Thermal rail + phase ribbon (signature hero elements)
    this._updateThermalRail(stateVal, attrs, get, ids);
    this._updatePhases(stateVal, attrs);

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

    // ─────────────────── SECTION 5: SESSIONS RÉCENTES
    this._renderCycleHistory(attrs);
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

  /* =================================================================== thermal rail */

  /**
   * Render the thermal rail in the hero. The rail represents the cooling (or
   * heating) descent from "start threshold" to "target threshold", with a
   * glowing cursor showing the current room T° pièce. When the zone is idle
   * we hide the cursor reading but keep the bounds visible as a preview of
   * the next cycle's range.
   */
  _updateThermalRail(stateVal, attrs, get, ids) {
    const wrap = this.querySelector('[data-bind="rail-wrap"]');
    const fill = this.querySelector('[data-bind="rail-fill"]');
    const targetEl = this.querySelector('[data-bind="rail-target"]');
    const cursor = this.querySelector('[data-bind="rail-cursor"]');
    const cursorVal = this.querySelector('[data-bind="rail-cursor-val"]');
    const boundLeft = this.querySelector('[data-bind="rail-bound-left"]');
    const boundRight = this.querySelector('[data-bind="rail-bound-right"]');
    if (!wrap || !fill || !targetEl || !cursor) return;

    const roomTemp = parseFloat(get(ids.roomTemp)?.state);
    const profiles = Array.isArray(attrs.profiles) ? attrs.profiles : [];
    const activeName = attrs.active_profile_name;
    const active = profiles.find((p) => p && p.name === activeName) || profiles[0];

    // Resolve direction + thresholds. Direction comes from coordinator; when
    // unknown, infer from room temp vs profile thresholds.
    let dir = attrs.direction; // 'cool' | 'heat' | null
    let startT, endT; // start = where the cycle would begin; end = the cible
    if (active) {
      if (dir === "cool") {
        startT = active.seuil_debut_refroidissement;
        endT = active.seuil_fin_refroidissement;
      } else if (dir === "heat") {
        startT = active.seuil_debut_chauffage;
        endT = active.seuil_fin_chauffage;
      } else {
        // Idle: show the cooling range by default (more useful in summer)
        startT = active.seuil_debut_refroidissement;
        endT = active.seuil_fin_refroidissement;
      }
    }

    if (startT == null || endT == null) {
      // No profile / no thresholds → just hide the rail content
      wrap.classList.add("no-rail");
      return;
    }
    wrap.classList.remove("no-rail");

    // Wrap classes — direction-aware coloring + idle dim
    const idle = !["starting", "running", "stabilizing"].includes(stateVal);
    wrap.classList.toggle("warm", dir === "heat");
    wrap.classList.toggle("idle", idle);

    // Map a temperature to a [0..100] position on the rail. The rail's LEFT
    // edge represents `startT`, the RIGHT edge represents `endT`. For cool,
    // startT > endT (rail descends left→right); for heat, startT < endT.
    const mapPct = (t) => {
      if (t == null || Number.isNaN(t) || startT === endT) return null;
      let pct = ((t - startT) / (endT - startT)) * 100;
      pct = Math.max(0, Math.min(100, pct));
      return pct;
    };

    // Bounds labels: left = start, right = target — formatted as readouts
    if (boundLeft) boundLeft.textContent = `${this._fmtTemp(startT)}°`;
    if (boundRight) boundRight.textContent = `${this._fmtTemp(endT)}°`;

    // Target marker — always at 100% (rail's right edge by definition).
    // Visually offset slightly so it's not at the very edge.
    targetEl.style.left = "100%";
    targetEl.setAttribute("data-label", "CIBLE");

    // Cursor position based on current room T°
    const roomPct = mapPct(roomTemp);
    if (roomPct == null) {
      cursor.style.left = "0";
      if (cursorVal) cursorVal.textContent = "—";
      fill.style.width = "0";
      return;
    }
    cursor.style.left = `${roomPct}%`;
    if (cursorVal) cursorVal.textContent = this._fmtTemp(roomTemp);

    // Fill: from rail-start (0%) up to current cursor (covers the journey already done)
    fill.style.left = "0";
    fill.style.width = `${roomPct}%`;
  }

  /* =================================================================== phases */

  /**
   * Highlight the active phase in the 3-card ribbon. Phases:
   *   ATTAQUE (state in starting/running) → first card lights up
   *   STABILISATION (state == stabilizing) → second card lights up
   *   COOLDOWN (state == cooldown) → third card lights up
   *
   * Each card shows a small relevant value:
   *   - attaque: elapsed time since cycle started
   *   - stab: remaining time before STAB ends
   *   - cooldown: remaining time before COOLDOWN ends
   */
  _updatePhases(stateVal, attrs) {
    const wrap = this.querySelector('[data-bind="phases"]');
    if (!wrap) return;

    const active = ["starting", "running", "stabilizing", "cooldown"].includes(stateVal);
    wrap.classList.toggle("hidden", !active);
    if (!active) return;

    const cards = {
      attaque:  this.querySelector('[data-bind="phase-attaque"]'),
      stab:     this.querySelector('[data-bind="phase-stab"]'),
      cooldown: this.querySelector('[data-bind="phase-cooldown"]'),
    };
    const vals = {
      attaque:  this.querySelector('[data-bind="phase-attaque-val"]'),
      stab:     this.querySelector('[data-bind="phase-stab-val"]'),
      cooldown: this.querySelector('[data-bind="phase-cooldown-val"]'),
    };
    Object.values(cards).forEach((c) => c && (c.className = "dc-phase upcoming"));

    const now = Date.now() / 1000;
    const cycleStart = attrs.cycle_started_at
      ? new Date(attrs.cycle_started_at).getTime() / 1000 : null;
    const stabEnds = attrs.stabilization_ends_at
      ? new Date(attrs.stabilization_ends_at).getTime() / 1000 : null;
    const cooldownEnds = attrs.cooldown_ends_at
      ? new Date(attrs.cooldown_ends_at).getTime() / 1000 : null;

    const fmtMin = (s) => {
      if (s == null || s < 0) return "—";
      const m = Math.round(s / 60);
      if (m < 60) return `${m} min`;
      const h = Math.floor(m / 60);
      return `${h}h ${(m % 60).toString().padStart(2, "0")}`;
    };

    if (stateVal === "starting" || stateVal === "running") {
      cards.attaque.className = "dc-phase active";
      if (vals.attaque) {
        vals.attaque.textContent = cycleStart != null
          ? fmtMin(now - cycleStart) : "en cours";
      }
      if (vals.stab) vals.stab.textContent = "—";
      if (vals.cooldown) vals.cooldown.textContent = "—";
    } else if (stateVal === "stabilizing") {
      cards.attaque.className = "dc-phase done";
      if (vals.attaque && cycleStart != null && attrs.state_entered_at) {
        const stabStart = new Date(attrs.state_entered_at).getTime() / 1000;
        vals.attaque.textContent = fmtMin(stabStart - cycleStart);
      }
      cards.stab.className = "dc-phase active";
      if (vals.stab) {
        vals.stab.textContent = stabEnds != null
          ? `${fmtMin(stabEnds - now)} restantes` : "en cours";
      }
      if (vals.cooldown) vals.cooldown.textContent = "—";
    } else if (stateVal === "cooldown") {
      cards.attaque.className = "dc-phase done";
      cards.stab.className = "dc-phase done";
      cards.cooldown.className = "dc-phase active";
      if (vals.cooldown) {
        vals.cooldown.textContent = cooldownEnds != null
          ? `${fmtMin(cooldownEnds - now)} restantes` : "en cours";
      }
    }
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
  _fmtTimeFromTs(ts) {
    if (ts == null) return "—";
    try {
      return new Date(ts * 1000).toLocaleTimeString("fr-FR",
        { hour: "2-digit", minute: "2-digit" });
    } catch { return "—"; }
  }
  _fmtDuration(minutes) {
    if (minutes == null) return "—";
    const total = Math.round(minutes);
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return `${m} min`;
    return `${h}h ${m.toString().padStart(2, "0")}`;
  }

  /* =================================================================== cycles */

  _renderCycleHistory(attrs) {
    const list = this.querySelector('[data-bind="cycles-list"]');
    const empty = this.querySelector('[data-bind="cycles-empty"]');
    const cycles = Array.isArray(attrs.cycle_history) ? attrs.cycle_history : [];
    if (cycles.length === 0) {
      empty.style.display = "";
      list.innerHTML = "";
      list.dataset.sig = "";
      return;
    }
    empty.style.display = "none";
    // Newest first (server gives oldest-first)
    const newest = [...cycles].reverse();
    const sig = JSON.stringify(newest);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.innerHTML = newest.map((c) => this._buildCycleRow(c)).join("");
  }

  _buildCycleRow(c) {
    const tStart = this._fmtTimeFromTs(c.start_ts);
    const tEnd = this._fmtTimeFromTs(c.end_ts);
    const duration = this._fmtDuration(c.duration_min);
    const tStartC = this._fmtTemp(c.temp_start);
    const tEndC = this._fmtTemp(c.temp_end);
    const tMinC = this._fmtTemp(c.temp_min);
    const profile = c.profile_at_start || c.profile_at_end || "—";
    const meta = this._cycleEndReasonMeta(c.end_reason);
    const spark = this._buildCycleSparkline(c);
    const dayLabel = this._fmtDayLabel(c.start_ts);
    return `
      <div class="dc-cycle-row">
        <div class="dc-cycle-times">
          ${tStart}
          <span class="end">${tEnd}</span>
        </div>
        <div class="dc-cycle-icon ${meta.klass}" title="${this._escapeHTML(meta.label)}">
          <ha-icon icon="${meta.icon}"></ha-icon>
        </div>
        <div class="dc-cycle-main">
          <div class="dc-cycle-spark">${spark}</div>
          <div class="dc-cycle-details">
            <span class="v">${tStartC}°</span> → <span class="v">${tEndC}°</span>
            · min <span class="v">${tMinC}°</span>
            · ${this._escapeHTML(profile)}
          </div>
        </div>
        <div class="dc-cycle-duration">
          ${duration}
          <span class="sub">${dayLabel}</span>
        </div>
      </div>
    `;
  }

  /**
   * Build a 3-point sparkline SVG (start → min → end). It's a "trajectory hint"
   * — we don't have per-tick samples for completed cycles, only start/min/end
   * temps. A bezier curve gives the eye a sense of the descent's shape.
   */
  _buildCycleSparkline(c) {
    const tS = parseFloat(c.temp_start);
    const tE = parseFloat(c.temp_end);
    const tM = parseFloat(c.temp_min);
    if ([tS, tE, tM].some((v) => Number.isNaN(v))) {
      return `<svg viewBox="0 0 100 22" preserveAspectRatio="none"></svg>`;
    }
    const tMax = Math.max(tS, tE);
    const tMin = Math.min(tM, tS, tE);
    const range = Math.max(0.5, tMax - tMin);
    // Y inverted: higher temp = higher up (closer to 0). Padding of 2 top/bot.
    const y = (t) => 2 + (1 - (t - tMin) / range) * 18;
    const x0 = 2, x1 = 50, x2 = 98;
    const y0 = y(tS), y1 = y(tM), y2 = y(tE);
    // Smooth quadratic-ish curve through the 3 points
    const cp1x = (x0 + x1) / 2, cp1y = y0;
    const cp2x = (x1 + x2) / 2, cp2y = y2;
    const d = `M${x0} ${y0} Q ${cp1x} ${cp1y}, ${x1} ${y1} Q ${cp2x} ${cp2y}, ${x2} ${y2}`;
    return `
      <svg viewBox="0 0 100 22" preserveAspectRatio="none">
        <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round" opacity="0.85"/>
        <circle cx="${x0}" cy="${y0}" r="1.6" fill="currentColor"/>
        <circle cx="${x1}" cy="${y1}" r="1.6" fill="currentColor" opacity="0.5"/>
        <circle cx="${x2}" cy="${y2}" r="1.6" fill="currentColor"/>
      </svg>
    `;
  }

  _fmtDayLabel(ts) {
    if (ts == null) return "";
    const now = new Date();
    const d = new Date(ts * 1000);
    const startOfDay = (date) => {
      const c = new Date(date);
      c.setHours(0, 0, 0, 0);
      return c.getTime();
    };
    const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (dayDiff === 0) return "AUJ";
    if (dayDiff === 1) return "HIER";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  }

  _cycleEndReasonMeta(reason) {
    switch (reason) {
      case "stabilization_complete":
        return { icon: "mdi:check-circle", klass: "success", label: "Stabilisation terminée" };
      case "natural_end":
        return { icon: "mdi:stop-circle", klass: "", label: "Fin naturelle" };
      case "schedule_ended":
        return { icon: "mdi:calendar-clock", klass: "", label: "Fin de plage horaire" };
      case "window_opened":
        return { icon: "mdi:window-open", klass: "warn", label: "Fenêtre ouverte" };
      case "user_override":
        return { icon: "mdi:hand-back-right", klass: "warn", label: "Override utilisateur" };
      default:
        return { icon: "mdi:circle-small", klass: "", label: reason || "—" };
    }
  }

  _escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
  _capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
}


const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap');

  /* ─────────────────────────────────────────────────────────────────
     Instrument-panel palette : deep neutral surface + glacial cool +
     amber warm + sharp lime live signal. Mono numerals for readouts.
     ───────────────────────────────────────────────────────────────── */
  ha-card.dc-card {
    /* spacing */
    --dc-pad: 20px;
    --dc-radius: 18px;
    --dc-radius-sm: 14px;
    --dc-radius-pill: 999px;
    --dc-hairline: rgba(255,255,255,0.07);

    /* surfaces */
    --dc-bg: #0E1014;
    --dc-surface: #181B22;
    --dc-surface-strong: #1E222A;
    --dc-rail-empty: #2A2F3A;
    --dc-bg-bubble: rgba(255,255,255,0.035);
    --dc-bg-bubble-strong: rgba(255,255,255,0.06);
    --dc-bg-inset: rgba(0,0,0,0.22);

    /* text */
    --dc-fg: #F2F4F7;
    --dc-muted: #8A92A0;
    --dc-dim: #5A6170;

    /* climate semantics */
    --dc-cool: #5BC8E2;
    --dc-cool-soft: rgba(91,200,226,0.14);
    --dc-heat: #F5A056;
    --dc-warm: #F5A056;
    --dc-warm-soft: rgba(245,160,86,0.14);

    /* live signal — single bright accent, used VERY sparingly */
    --dc-live: #D6FF00;
    --dc-live-soft: rgba(214,255,0,0.16);

    /* alerts / states */
    --dc-warn: #F5A056;
    --dc-success: #5BC8E2;
    --dc-danger: #F26D5B;
    --dc-info: #5BC8E2;
    --dc-accent: #D6FF00;

    /* typography */
    --dc-font-mono: 'Geist Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
    --dc-font-body: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;

    background: var(--dc-bg);
    color: var(--dc-fg);
    font-family: var(--dc-font-body);
    font-size: 14px;
    line-height: 1.4;
    padding: 0; overflow: hidden;
    border-radius: var(--ha-card-border-radius, var(--dc-radius));
  }
  ha-card.dc-card * { box-sizing: border-box; }

  /* ============ HEADER ============ */
  .dc-header {
    display: flex; align-items: flex-start; gap: 14px;
    padding: 24px var(--dc-pad) 12px;
  }
  .dc-header .head-icon {
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: var(--dc-state-color, var(--dc-muted));
    margin-top: 4px;
    transition: color 0.3s;
  }
  .dc-header .head-icon ha-icon { --mdc-icon-size: 24px; }
  .dc-header .head-icon.active { color: var(--dc-state-color, var(--dc-fg)); }
  .dc-header .title-block { flex: 1; min-width: 0; }
  .dc-header .title {
    font-size: 22px; font-weight: 700; line-height: 1.15;
    letter-spacing: -0.02em;
    color: var(--dc-fg);
  }
  .dc-header .subtitle {
    font-size: 11px; color: var(--dc-muted);
    margin-top: 5px;
    font-family: var(--dc-font-mono);
    letter-spacing: 0.04em;
  }
  /* State tag — small mono uppercase with a "live" dot when active */
  .dc-state {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 10px 6px 11px;
    border-radius: var(--dc-radius-pill);
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-family: var(--dc-font-mono);
    color: var(--dc-muted);
    background: var(--dc-surface);
    white-space: nowrap;
    margin-top: 2px;
  }
  .dc-state::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--dc-muted);
    flex-shrink: 0;
  }
  .dc-state.state-active {
    color: var(--dc-live);
    background: var(--dc-live-soft);
  }
  .dc-state.state-active::before {
    background: var(--dc-live);
    box-shadow: 0 0 8px var(--dc-live);
    animation: dc-pulse 1.8s ease-in-out infinite;
  }
  .dc-state.state-warn { color: var(--dc-warm); background: var(--dc-warm-soft); }
  .dc-state.state-warn::before { background: var(--dc-warm); }
  .dc-state.state-alert { color: var(--dc-danger); background: rgba(242,109,91,0.16); }
  .dc-state.state-alert::before { background: var(--dc-danger); }
  .dc-state ha-icon { display: none; }
  @keyframes dc-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.8); }
  }

  /* ============ SECTIONS ============ */
  .dc-section { padding: 0 var(--dc-pad) 26px; }
  .dc-section-head {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 16px;
  }
  /* Hide the legacy circular bubble icons */
  .dc-section-head .head-bubble {
    display: none;
  }
  /* Eyebrow label — small mono uppercase, followed by a thin rule */
  .dc-section-head .lbl {
    font-family: var(--dc-font-mono);
    font-size: 10px; font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--dc-muted);
    flex-shrink: 0;
  }
  .dc-section-head::after {
    content: "";
    flex: 1; height: 1px;
    background: var(--dc-hairline);
  }

  /* ============ §5 SESSIONS RÉCENTES ============ */
  .dc-cycles-empty {
    text-align: center;
    color: var(--dc-muted);
    font-family: var(--dc-font-body);
    font-size: 13px;
    padding: 20px;
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    border: 1px dashed var(--dc-hairline);
  }
  .dc-cycles-list {
    display: flex; flex-direction: column;
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    border: 1px solid var(--dc-hairline);
    overflow: hidden;
  }
  .dc-cycle-row {
    display: grid;
    grid-template-columns: 64px 70px 1fr 78px;
    gap: 12px;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--dc-hairline);
    transition: background 0.15s;
  }
  .dc-cycle-row:last-child { border-bottom: none; }
  .dc-cycle-row:hover { background: var(--dc-surface-strong); }
  /* Time column — start/end times stacked */
  .dc-cycle-times {
    font-family: var(--dc-font-mono);
    font-size: 12px;
    color: var(--dc-fg);
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: 0.02em;
  }
  .dc-cycle-times .end {
    display: block;
    color: var(--dc-dim);
    font-weight: 500;
  }
  /* Compact end-reason icon column */
  .dc-cycle-icon {
    display: flex; align-items: center; justify-content: center;
    width: 24px; height: 24px;
    color: var(--dc-cool);
    flex-shrink: 0;
  }
  .dc-cycle-icon.success { color: var(--dc-cool); }
  .dc-cycle-icon.warn { color: var(--dc-warm); }
  .dc-cycle-icon ha-icon { --mdc-icon-size: 18px; }
  /* Sparkline + temp details column */
  .dc-cycle-main {
    display: flex; flex-direction: column;
    gap: 4px; min-width: 0;
  }
  .dc-cycle-spark {
    width: 100%; height: 22px;
    color: var(--dc-cool);
  }
  .dc-cycle-spark svg { display: block; width: 100%; height: 100%; }
  .dc-cycle-details {
    font-family: var(--dc-font-mono);
    font-size: 10px;
    color: var(--dc-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    letter-spacing: 0.04em;
  }
  .dc-cycle-details .v {
    color: var(--dc-fg);
    font-weight: 600;
  }
  /* Right column — duration */
  .dc-cycle-duration {
    font-family: var(--dc-font-mono);
    font-size: 12px; font-weight: 600;
    color: var(--dc-fg);
    text-align: right;
    white-space: nowrap;
    letter-spacing: 0.02em;
  }
  .dc-cycle-duration .sub {
    display: block;
    font-size: 9px; color: var(--dc-dim);
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-top: 1px;
  }

  /* ============ §1 ÉTAT ACTUEL — instrument-style hero ============ */
  .dc-hero {
    padding: 4px 0 24px;
  }
  /* Narrative — 1 sentence above the rail */
  .dc-narrative {
    font-size: 15px; line-height: 1.5;
    color: var(--dc-fg);
    margin-bottom: 4px;
    font-weight: 400;
  }
  .dc-narrative .target,
  .dc-narrative .accent {
    color: var(--dc-cool);
    font-family: var(--dc-font-mono);
    font-weight: 600;
    font-size: 0.92em;
  }
  .dc-narrative .until {
    color: var(--dc-muted);
    font-family: var(--dc-font-mono);
    font-size: 0.88em;
  }
  .dc-narrative.warm .target,
  .dc-narrative.warm .accent { color: var(--dc-warm); }
  .dc-narrative.warn { color: var(--dc-warm); }

  /* Hidden legacy hero-row elements (we don't use them anymore — JS still sets them) */
  .dc-hero-row { display: none !important; }

  /* THERMAL RAIL — the signature element */
  .dc-rail-wrap {
    position: relative;
    margin: 48px 12px 0;
    height: 56px;
  }
  .dc-rail-wrap.idle { opacity: 0.7; }
  .dc-rail-track {
    position: absolute;
    left: 0; right: 0;
    top: 22px;
    height: 4px;
    border-radius: 2px;
    background: var(--dc-rail-empty);
    overflow: visible;
  }
  /* Active fill: from the "start" threshold to the cursor position */
  .dc-rail-fill {
    position: absolute;
    top: 0; bottom: 0;
    background: linear-gradient(90deg, transparent, var(--dc-cool));
    border-radius: 2px;
    opacity: 0.5;
    transition: left 0.6s ease, width 0.6s ease;
  }
  .dc-rail-wrap.warm .dc-rail-fill {
    background: linear-gradient(90deg, transparent, var(--dc-warm));
  }
  /* Target marker — vertical line at the target threshold */
  .dc-rail-target {
    position: absolute;
    top: -10px; bottom: -10px;
    width: 2px;
    background: var(--dc-cool);
    opacity: 0.55;
    transition: left 0.6s ease;
  }
  .dc-rail-wrap.warm .dc-rail-target { background: var(--dc-warm); }
  .dc-rail-target::after {
    content: attr(data-label);
    position: absolute;
    bottom: -22px;
    left: 50%;
    transform: translateX(-50%);
    font-family: var(--dc-font-mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.14em;
    color: var(--dc-muted);
    text-transform: uppercase;
    white-space: nowrap;
  }
  /* Cursor — current T° pièce */
  .dc-rail-cursor {
    position: absolute;
    top: 4px;
    transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center;
    gap: 6px;
    transition: left 0.6s ease;
  }
  .dc-rail-cursor .reading {
    font-family: var(--dc-font-mono);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--dc-fg);
    white-space: nowrap;
    line-height: 1;
  }
  .dc-rail-cursor .reading .unit {
    font-size: 12px;
    color: var(--dc-muted);
    margin-left: 1px;
    font-weight: 500;
  }
  .dc-rail-cursor .dot {
    width: 14px; height: 14px;
    border-radius: 50%;
    background: var(--dc-live);
    box-shadow: 0 0 18px var(--dc-live), 0 0 0 4px var(--dc-bg);
    transition: background 0.3s, box-shadow 0.3s;
  }
  .dc-rail-wrap.idle .dc-rail-cursor .dot {
    background: var(--dc-muted);
    box-shadow: 0 0 0 4px var(--dc-bg);
  }
  /* Bounds row — start/end of the rail */
  .dc-rail-bounds {
    position: absolute;
    left: 0; right: 0;
    top: 44px;
    display: flex;
    justify-content: space-between;
    font-family: var(--dc-font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--dc-dim);
  }
  .dc-rail-bounds .bound {
    display: flex; flex-direction: column; gap: 1px;
  }
  .dc-rail-bounds .bound.right { align-items: flex-end; }
  .dc-rail-bounds .bound .v {
    color: var(--dc-muted); font-weight: 600; font-size: 11px;
  }
  /* When idle (no cycle running), hide the cursor reading + dot, just show the rail */
  .dc-rail-wrap.no-rail { display: none; }

  /* PHASE RIBBON — 3 phase cards below the rail */
  .dc-phases {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
    margin-top: 28px;
  }
  .dc-phase {
    padding: 10px 12px 11px;
    background: var(--dc-surface);
    border-radius: 10px;
    border: 1px solid transparent;
    display: flex; flex-direction: column; gap: 3px;
    transition: all 0.3s;
  }
  .dc-phase .label {
    font-family: var(--dc-font-mono);
    font-size: 9px; letter-spacing: 0.16em;
    font-weight: 600;
    color: var(--dc-dim);
    text-transform: uppercase;
  }
  .dc-phase .val {
    font-family: var(--dc-font-mono);
    font-size: 12px;
    color: var(--dc-muted);
    font-weight: 500;
  }
  .dc-phase.active {
    background: var(--dc-live-soft);
    border-color: rgba(214,255,0,0.32);
  }
  .dc-phase.active .label { color: var(--dc-live); }
  .dc-phase.active .val { color: var(--dc-fg); font-weight: 600; }
  .dc-phase.done .label { color: var(--dc-muted); }
  .dc-phase.done .val { color: var(--dc-fg); }
  .dc-phase.upcoming { opacity: 0.45; }
  .dc-phases.hidden { display: none; }

  /* Timeline + sparkline (visible during an active cycle, below phases) */
  .dc-timeline {
    margin-top: 20px;
    padding-top: 14px;
    border-top: 1px solid var(--dc-hairline);
  }
  .dc-timeline-text {
    font-family: var(--dc-font-mono);
    font-size: 11px;
    color: var(--dc-muted);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
  }
  .dc-timeline-text .dc-delta {
    color: var(--dc-cool);
    font-weight: 600;
  }
  .dc-spark { width: 100%; }
  .dc-spark svg { display: block; }

  /* Compact info row below hero — replaces the old pills row */
  .dc-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 18px; }
  .dc-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 9px;
    border-radius: var(--dc-radius-pill);
    font-family: var(--dc-font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    font-weight: 500;
    background: var(--dc-surface);
    color: var(--dc-muted);
    border: 1px solid var(--dc-hairline);
  }
  .dc-pill ha-icon { --mdc-icon-size: 12px; opacity: 0.8; }
  .dc-pill--ok    { color: var(--dc-cool); border-color: rgba(91,200,226,0.25); background: var(--dc-cool-soft); }
  .dc-pill--warn  { color: var(--dc-warm); border-color: rgba(245,160,86,0.28); background: var(--dc-warm-soft); }
  .dc-pill--info  { color: var(--dc-cool); border-color: rgba(91,200,226,0.25); background: var(--dc-cool-soft); }
  .dc-pill--neutral { background: var(--dc-surface); color: var(--dc-muted); }

  /* Metrics list (in Détails techniques) */
  .dc-metrics {
    background: transparent;
    padding: 0;
  }
  .dc-metric-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 11px 0;
    border-bottom: 1px solid var(--dc-hairline);
  }
  .dc-metric-row:last-child { border-bottom: none; }
  .dc-metric-row .label {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--dc-muted); font-weight: 500;
  }
  .dc-metric-row .label ha-icon { --mdc-icon-size: 14px; color: var(--dc-dim); }
  .dc-metric-row .value {
    font-family: var(--dc-font-mono);
    font-size: 13px; font-weight: 600;
    color: var(--dc-fg);
  }
  .dc-override-row {
    margin-top: 14px; padding: 12px 14px;
    background: rgba(242,109,91,0.10);
    border: 1px solid rgba(242,109,91,0.28);
    border-radius: var(--dc-radius-sm);
    display: flex; justify-content: space-between; align-items: center;
    font-size: 12px;
  }
  .dc-override-row .lbl {
    color: var(--dc-danger); font-weight: 600;
    display: flex; align-items: center; gap: 8px;
    font-family: var(--dc-font-mono);
    font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  }
  .dc-override-row .val {
    font-family: var(--dc-font-mono);
    font-weight: 700;
    color: var(--dc-danger);
  }

  /* Collapsible 'Détails techniques' — hidden by default */
  .dc-details-toggle {
    margin-top: 20px;
    padding: 0;
  }
  .dc-details-toggle > summary {
    cursor: pointer; list-style: none;
    padding: 10px 0;
    font-family: var(--dc-font-mono);
    font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--dc-muted); font-weight: 600;
    display: flex; align-items: center; gap: 8px;
    user-select: none;
    border-top: 1px solid var(--dc-hairline);
  }
  .dc-details-toggle > summary::-webkit-details-marker { display: none; }
  .dc-details-toggle > summary::before {
    content: "+";
    display: inline-block;
    transition: transform 0.2s ease;
    color: var(--dc-dim);
    font-size: 14px;
    line-height: 1;
  }
  .dc-details-toggle[open] > summary::before { content: "−"; }
  .dc-details-toggle > summary:hover { color: var(--dc-fg); }
  .dc-details-toggle[open] > summary { color: var(--dc-fg); }
  .dc-details-toggle[open] .dc-metrics { margin-top: 6px; }

  /* ============ §2 PROFILS ============ */
  .dc-profiles-list {
    display: flex; flex-direction: column; gap: 8px;
    margin-bottom: 12px;
  }
  .dc-profiles-empty {
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    padding: 18px;
    color: var(--dc-muted);
    font-size: 13px;
    text-align: center;
    margin-bottom: 10px;
  }
  .dc-profile {
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    padding: 14px 14px 14px 18px;
    border: 1px solid var(--dc-hairline);
    position: relative;
    transition: all 0.2s;
  }
  .dc-profile--active {
    background: var(--dc-surface-strong);
    border-color: rgba(214,255,0,0.28);
  }
  .dc-profile--active::before {
    content: "";
    position: absolute;
    left: 0; top: 14px; bottom: 14px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--dc-live);
    box-shadow: 0 0 12px var(--dc-live);
  }
  .dc-profile-head {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 8px;
  }
  .dc-profile-badge {
    background: var(--dc-live);
    color: var(--dc-bg);
    font-family: var(--dc-font-mono);
    font-size: 9px; font-weight: 700;
    padding: 3px 7px 2px;
    border-radius: 4px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .dc-profile-name {
    flex: 1;
    font-weight: 600;
    color: var(--dc-fg);
    font-size: 14px;
    letter-spacing: -0.01em;
  }
  .dc-profile-actions {
    display: flex; gap: 4px;
  }
  .dc-profile-actions button {
    width: 28px; height: 28px;
    border: none; border-radius: 8px;
    background: transparent;
    color: var(--dc-muted);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
  }
  .dc-profile-actions button ha-icon { --mdc-icon-size: 16px; }
  .dc-profile-actions button:hover { background: var(--dc-bg-inset); color: var(--dc-fg); }
  .dc-profile-meta {
    display: flex; flex-wrap: wrap;
    gap: 4px 14px;
    font-family: var(--dc-font-mono);
    font-size: 11px;
    color: var(--dc-muted);
    letter-spacing: 0.02em;
  }
  .dc-profile-meta span {
    display: inline-flex; align-items: center; gap: 5px;
  }
  .dc-profile-meta ha-icon { --mdc-icon-size: 13px; color: var(--dc-dim); }
  .dc-profile-meta .v {
    color: var(--dc-fg); font-weight: 600;
  }

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
  .dc-control { margin-bottom: 16px; }
  .dc-control:last-child { margin-bottom: 0; }
  .dc-control-label {
    font-family: var(--dc-font-mono);
    font-size: 9px; letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--dc-muted); font-weight: 600;
    margin-bottom: 10px;
  }
  .dc-segmented {
    display: flex; gap: 4px;
    background: var(--dc-surface);
    border-radius: 10px;
    padding: 4px;
    border: 1px solid var(--dc-hairline);
  }
  .dc-segmented button {
    flex: 1; padding: 9px 14px;
    border: none; background: transparent;
    color: var(--dc-muted);
    font-family: var(--dc-font-body);
    font-size: 13px; font-weight: 600;
    letter-spacing: -0.005em;
    cursor: pointer;
    border-radius: 7px;
    transition: all 0.2s;
  }
  .dc-segmented button:hover { color: var(--dc-fg); }
  .dc-segmented button.active {
    background: var(--dc-bg-inset);
    color: var(--dc-fg);
  }
  .dc-segmented.tone-warn button.active[data-mode="boost"] {
    background: var(--dc-warm-soft); color: var(--dc-warm);
  }
  .dc-segmented.tone-danger button.active[data-mode="off"] {
    background: rgba(242,109,91,0.16); color: var(--dc-danger);
  }
  .dc-segmented button.active[data-mode="auto"] {
    background: var(--dc-live-soft); color: var(--dc-live);
  }

  .dc-quick-actions {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  }
  .dc-quick-actions button {
    padding: 11px 14px;
    border-radius: 10px;
    border: 1px solid var(--dc-hairline);
    background: var(--dc-surface);
    color: var(--dc-fg); cursor: pointer;
    font-family: var(--dc-font-body);
    font-weight: 600; font-size: 13px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: all 0.2s;
  }
  .dc-quick-actions button ha-icon { --mdc-icon-size: 16px; }
  .dc-quick-actions button:hover:not(:disabled) {
    background: var(--dc-surface-strong);
    border-color: rgba(255,255,255,0.12);
  }
  .dc-quick-actions button:disabled { opacity: 0.35; cursor: not-allowed; }
  .dc-quick-actions button[data-bind="boost-btn"] {
    color: var(--dc-warm);
    border-color: rgba(245,160,86,0.32);
    background: var(--dc-warm-soft);
  }
  .dc-quick-actions button[data-bind="boost-btn"]:hover:not(:disabled) {
    background: rgba(245,160,86,0.22);
  }
  .dc-quick-actions button[data-bind="boost-btn"] ha-icon { color: var(--dc-warm); }

  /* Force-start (idle only) */
  .dc-force-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .dc-force-actions button {
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--dc-hairline);
    cursor: pointer;
    font-family: var(--dc-font-body);
    font-weight: 600; font-size: 13px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: all 0.2s;
  }
  .dc-force-actions button ha-icon { --mdc-icon-size: 16px; }
  .dc-force-actions .force-cool {
    color: var(--dc-cool); background: var(--dc-cool-soft);
    border-color: rgba(91,200,226,0.28);
  }
  .dc-force-actions .force-cool:hover { background: rgba(91,200,226,0.22); }
  .dc-force-actions .force-cool ha-icon { color: var(--dc-cool); }
  .dc-force-actions .force-heat {
    color: var(--dc-warm); background: var(--dc-warm-soft);
    border-color: rgba(245,160,86,0.28);
  }
  .dc-force-actions .force-heat:hover { background: rgba(245,160,86,0.22); }
  .dc-force-actions .force-heat ha-icon { color: var(--dc-warm); }

  /* ============ §4 COMMANDE MANUELLE ============ */
  .dc-subblock {
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    padding: 16px;
    margin-bottom: 10px;
    border: 1px solid var(--dc-hairline);
  }
  .dc-subblock:last-child { margin-bottom: 0; }
  .dc-subblock-title {
    font-family: var(--dc-font-mono);
    font-size: 9px; letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--dc-muted); font-weight: 600;
    margin-bottom: 14px;
    display: flex; align-items: center; gap: 8px;
  }
  .dc-subblock-title ha-icon { --mdc-icon-size: 13px; color: var(--dc-dim); }

  /* HVAC mode chips */
  .dc-hvac {
    display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px;
  }
  .dc-hvac button {
    padding: 9px 4px;
    background: var(--dc-bg-inset);
    border: 1px solid transparent;
    border-radius: 10px;
    color: var(--dc-muted); cursor: pointer;
    transition: all 0.2s;
    display: flex; flex-direction: column; align-items: center; gap: 5px;
  }
  .dc-hvac button > div { display: flex; flex-direction: column; align-items: center; gap: 5px; width: 100%; }
  .dc-hvac button .ha-icon-wrap {
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    color: var(--dc-muted);
    transition: all 0.2s;
  }
  .dc-hvac button ha-icon { --mdc-icon-size: 18px; }
  .dc-hvac button span {
    font-family: var(--dc-font-mono);
    font-size: 9px; letter-spacing: 0.06em;
    font-weight: 600; text-transform: uppercase;
  }
  .dc-hvac button:hover {
    background: var(--dc-surface-strong);
    color: var(--dc-fg);
  }
  .dc-hvac button:hover .ha-icon-wrap { color: var(--dc-fg); }
  .dc-hvac button.active {
    background: var(--dc-surface-strong);
    border-color: rgba(255,255,255,0.1);
  }
  .dc-hvac button.active .ha-icon-wrap { color: var(--hvac-color, var(--dc-fg)); }
  .dc-hvac button.active span { color: var(--dc-fg); }

  /* Setpoint stepper */
  .dc-setpoint {
    display: flex; align-items: center; justify-content: center; gap: 24px;
    margin-top: 16px;
  }
  .dc-setpoint .sp-val {
    font-family: var(--dc-font-mono);
    font-size: 36px; font-weight: 700;
    min-width: 110px; text-align: center;
    letter-spacing: -0.03em;
    color: var(--dc-fg);
    line-height: 1;
  }
  .dc-setpoint .sp-unit { font-size: 14px; color: var(--dc-muted); font-weight: 500; margin-left: 4px; }
  .dc-setpoint button {
    width: 42px; height: 42px; border-radius: 50%;
    background: var(--dc-bg-inset);
    border: 1px solid var(--dc-hairline);
    color: var(--dc-fg);
    font-size: 18px; font-weight: 600;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: all 0.2s;
  }
  .dc-setpoint button:hover {
    background: var(--dc-cool-soft);
    color: var(--dc-cool);
    border-color: rgba(91,200,226,0.3);
  }

  /* Fan + swing selects */
  .dc-fanswing { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 16px; }
  .dc-fanswing .field { display: flex; flex-direction: column; gap: 6px; }
  .dc-fanswing label {
    font-family: var(--dc-font-mono);
    font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--dc-muted); font-weight: 600;
  }
  .dc-fanswing select {
    background: var(--dc-bg-inset);
    border: 1px solid var(--dc-hairline);
    border-radius: 10px;
    color: var(--dc-fg);
    padding: 10px 12px;
    font-family: var(--dc-font-body);
    font-size: 13px; font-weight: 500;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(138,146,160,0.8)' d='M0 0l5 6 5-6z'/></svg>");
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
      <!-- Legacy bindings kept invisible so existing JS setters don't break -->
      <div class="dc-hero-row" style="display:none">
        <span data-bind="room-temp"></span>
        <span data-bind="target-arrow"></span>
        <div data-bind="target-block">
          <span data-bind="target-temp"></span>
        </div>
      </div>

      <div class="dc-narrative" data-bind="narrative"></div>

      <!-- THERMAL RAIL — signature element -->
      <div class="dc-rail-wrap" data-bind="rail-wrap">
        <div class="dc-rail-track">
          <div class="dc-rail-fill" data-bind="rail-fill" style="left:0;width:0"></div>
          <div class="dc-rail-target" data-bind="rail-target" data-label="CIBLE" style="left:0"></div>
        </div>
        <div class="dc-rail-cursor" data-bind="rail-cursor" style="left:0">
          <div class="reading"><span data-bind="rail-cursor-val">—</span><span class="unit">°C</span></div>
          <div class="dot"></div>
        </div>
        <div class="dc-rail-bounds">
          <div class="bound">
            <span class="v" data-bind="rail-bound-left">—</span>
            <span>début</span>
          </div>
          <div class="bound right">
            <span class="v" data-bind="rail-bound-right">—</span>
            <span>cible</span>
          </div>
        </div>
      </div>

      <!-- PHASE RIBBON — ATTAQUE / STABILISATION / COOLDOWN -->
      <div class="dc-phases" data-bind="phases">
        <div class="dc-phase" data-bind="phase-attaque">
          <div class="label">Attaque</div>
          <div class="val" data-bind="phase-attaque-val">—</div>
        </div>
        <div class="dc-phase" data-bind="phase-stab">
          <div class="label">Stabilisation</div>
          <div class="val" data-bind="phase-stab-val">—</div>
        </div>
        <div class="dc-phase" data-bind="phase-cooldown">
          <div class="label">Cooldown</div>
          <div class="val" data-bind="phase-cooldown-val">—</div>
        </div>
      </div>

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

  <!-- ════════════════════════════════════ §5 SESSIONS RÉCENTES -->
  <section class="dc-section section-cycles">
    <div class="dc-section-head">
      <div class="head-bubble"><ha-icon icon="mdi:history"></ha-icon></div>
      <span class="lbl">Sessions récentes</span>
    </div>
    <div class="dc-cycles-empty" data-bind="cycles-empty" style="display:none">
      Aucune session terminée. La prochaine apparaîtra ici dès que le cycle se boucle.
    </div>
    <div class="dc-cycles-list" data-bind="cycles-list"></div>
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
  "%c DELORMEJ-CLIMATE-CARD %c v0.13.0 ",
  "color: white; background: #28a745; font-weight: 700;",
  "color: #28a745; background: white; font-weight: 700;"
);
