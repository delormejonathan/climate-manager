/**
 * climate-manager-card  v0.19.0
 *
 * Instrument-panel redesign. Can be used as an all-in-one card or as
 * five separate widgets for dashboards:
 *   - custom:climate-manager-status-card
 *   - custom:climate-manager-pilotage-card
 *   - custom:climate-manager-manual-card
 *   - custom:climate-manager-profiles-card
 *   - custom:climate-manager-sessions-card
 *
 * Usage:
 *   type: custom:climate-manager-card
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
  running:     { label: "Actif",           color: "#D6FF00", icon: "mdi:fan", tone: "active" },
  manual_override_timed: { label: "Override", color: "#F26D5B", icon: "mdi:account-clock", tone: "alert" },
  manual_override_free:  { label: "Manuel",   color: "#F26D5B", icon: "mdi:account-edit", tone: "alert" },
  window_open: { label: "Fenêtre ouverte", color: "#F5A056", icon: "mdi:window-open", tone: "warn" },
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
    this._variant = this.constructor.widgetVariant || config.widget || config.variant || "full";
    this._split = this._variant !== "full";
    const fallbackTitles = {
      status: "État actuel",
      pilotage: "Pilotage & état",
      manual: "Commande manuelle",
      profiles: "Profils",
      sessions: "Sessions",
      full: this._capitalize(config.zone),
    };
    this._title = config.title || fallbackTitles[this._variant] || this._capitalize(config.zone);
    this._climateEntity = config.climate_entity || null;
    this._rendered = false;
  }
  static getStubConfig() { return { type: "custom:climate-manager-card", zone: "rdc" }; }
  getCardSize() {
    // Legacy masonry estimate.
    return ({ status: 3, pilotage: 7, manual: 5, profiles: 6, sessions: 6 })[this._variant] || 12;
  }
  getGridOptions() {
    // Home Assistant Sections dashboards use grid options, not just
    // getCardSize(). Without this, HA can reserve a huge empty tile around
    // compact split widgets on mobile.
    return ({
      status:   { columns: 12, rows: 3, min_rows: 2 },
      pilotage: { columns: 12, rows: 7, min_rows: 6 },
      manual:   { columns: 12, rows: 5, min_rows: 4 },
      profiles: { columns: 12, rows: 6, min_rows: 5 },
      sessions: { columns: 12, rows: 6, min_rows: 5 },
    })[this._variant] || { columns: 12, rows: 10, min_rows: 6 };
  }

  _ent(kind, suffix) { return `${kind}.climate_manager_${this._zone}_${suffix}`; }

  _ids() {
    return {
      state: this._ent("sensor", "state"),
      regime: this._ent("sensor", "regime"),
      roomTemp: this._ent("sensor", "zone_temperature"),
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
    card.classList.add("dc-card", `dc-widget-${this._variant}`);
    if (this._split) card.classList.add("dc-split-widget");
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

    // Technical details are intentionally available only during an active cycle.
    $("details-toggle").addEventListener("click", (e) => {
      if ($("details-toggle").classList.contains("no-details")) e.preventDefault();
    });

    // Profiles — single delegate on the list, plus "add" button
    $("profiles-list").addEventListener("click", (e) => this._onProfileListClick(e));
    $("profiles-list").addEventListener("change", (e) => this._onProfileFieldChange(e));
    $("profile-add").addEventListener("click", () => this._onProfileAdd());

    // Session actions
    const sessionModifyBtn = $("session-modify-btn");
    if (sessionModifyBtn) sessionModifyBtn.addEventListener("click", () => this._openSessionModifyModal());
    const sessionExtendBtn = $("session-extend-btn");
    if (sessionExtendBtn) sessionExtendBtn.addEventListener("click", () => {
      this._call("climate_manager", "extend_session", { zone_id: this._zone, hours: 1 });
    });
    const sessionCancelBtn = $("session-cancel-btn");
    if (sessionCancelBtn) sessionCancelBtn.addEventListener("click", () => {
      if (confirm("Arrêter la session en cours ?")) {
        this._call("climate_manager", "cancel_session", { zone_id: this._zone });
      }
    });
    const sessionStartBtn = $("session-start-btn");
    if (sessionStartBtn) sessionStartBtn.addEventListener("click", () => this._openSessionStartModal());
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

  /* =================================================================== session block + modals */

  _stateAttrs() {
    const stateObj = this._hass?.states[this._ent("sensor", "state")];
    return stateObj?.attributes || {};
  }

  /**
   * Rendu state-driven du bloc Actions. Boutons pleine largeur, stacké
   * verticalement, labels clairs. Une zone "primaire" et une zone "secondaire"
   * séparées par un divider discret. Pas de mur de boutons : ce qui n'a pas
   * de sens dans l'état courant n'est pas affiché.
   */
  _updateActionsBlock(stateVal, attrs) {
    const block = this.querySelector('[data-bind="actions-block"]');
    if (!block) return;
    const isOff = !!attrs.is_off_mode;
    const inOverride = !!attrs.in_override;
    const hasSession = !!attrs.session;
    const isWindow = stateVal === "window_open";

    const btn = (variant, icon, label, dataAction) => `
      <button class="dc-action-btn ${variant}" data-action="${dataAction}">
        <ha-icon icon="${icon}"></ha-icon>
        <span>${label}</span>
      </button>`;
    const info = (icon, text) => `
      <div class="dc-action-info">
        <ha-icon icon="${icon}"></ha-icon>
        <span>${text}</span>
      </div>`;

    let primary = [];
    let secondary = [];

    if (isWindow) {
      const n = attrs.windows_open || 1;
      primary.push(info(
        "mdi:window-open-variant",
        n > 1 ? `${n} fenêtres ouvertes — la clim reprendra automatiquement à la fermeture.`
              : "Fenêtre ouverte — la clim reprendra automatiquement à la fermeture.",
      ));
    } else if (inOverride) {
      const until = attrs.override_until_at
        ? ` (auto à ${new Date(attrs.override_until_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })})`
        : "";
      primary.push(info("mdi:account-hard-hat", `Tu as la main en mode manuel${until}.`));
      primary.push(btn("primary", "mdi:restore", "Reprendre le pilotage auto", "resume-auto"));
      secondary.push(btn("secondary-line", "mdi:tune-variant", "Contrôle direct de la clim", "open-manual"));
    } else if (isOff) {
      primary.push(info("mdi:power-off", "Pilotage désactivé."));
      primary.push(btn("primary", "mdi:auto-mode", "Réactiver le pilotage auto", "mode-auto"));
      primary.push(btn("secondary", "mdi:play-circle", "Démarrer une session manuelle", "session-start"));
      secondary.push(btn("secondary-line", "mdi:tune-variant", "Contrôle direct de la clim", "open-manual"));
    } else if (hasSession) {
      primary.push(btn("primary", "mdi:pencil", "Modifier la session", "session-modify"));
      primary.push(btn("secondary", "mdi:clock-plus-outline", "Ajouter 1 heure à la session", "session-extend"));
      primary.push(btn("danger", "mdi:stop-circle-outline", "Arrêter la session", "session-cancel"));
      secondary.push(btn("secondary-line", "mdi:tune-variant", "Contrôle direct de la clim", "open-manual"));
      secondary.push(btn("secondary-line", "mdi:power", "Désactiver le pilotage auto", "mode-off"));
    } else {
      // IDLE en auto, pas de session
      primary.push(btn("primary", "mdi:play-circle", "Démarrer une session", "session-start"));
      secondary.push(btn("secondary-line", "mdi:tune-variant", "Contrôle direct de la clim", "open-manual"));
      secondary.push(btn("secondary-line", "mdi:power", "Désactiver le pilotage auto", "mode-off"));
    }

    const primaryHtml = `<div class="dc-actions-primary">${primary.join("")}</div>`;
    const secondaryHtml = secondary.length
      ? `<div class="dc-actions-secondary">${secondary.join("")}</div>`
      : "";
    block.innerHTML = primaryHtml + secondaryHtml;
    block.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => this._onActionClick(e));
    });
  }

  _onActionClick(e) {
    const a = e.currentTarget.dataset.action;
    if (a === "session-start") return this._openSessionStartModal();
    if (a === "session-modify") return this._openSessionModifyModal();
    if (a === "session-extend") {
      return this._call("climate_manager", "extend_session", { zone_id: this._zone, hours: 1 });
    }
    if (a === "session-cancel") {
      if (!confirm("Arrêter la session en cours ?")) return;
      return this._call("climate_manager", "cancel_session", { zone_id: this._zone });
    }
    if (a === "resume-auto") {
      return this._call("button", "press", { entity_id: this._ent("button", "resume_auto") });
    }
    if (a === "mode-auto") {
      return this._call("select", "select_option", {
        entity_id: this._ent("select", "mode"),
        option: "auto",
      });
    }
    if (a === "mode-off") {
      if (!confirm("Désactiver le pilotage automatique ? Toutes les sessions s'arrêteront.")) return;
      return this._call("select", "select_option", {
        entity_id: this._ent("select", "mode"),
        option: "off",
      });
    }
    if (a === "open-manual") return this._openManualControlModal();
  }

  /**
   * Modal de contrôle direct de la clim. Toutes les actions ici envoient
   * directement vers climate.* — le mécanisme override du module détecte
   * automatiquement les changements non-tracked et bascule en
   * MANUAL_OVERRIDE_FREE / TIMED.
   */
  _openManualControlModal() {
    if (!this._climateEntity) {
      alert("Aucune entité climate configurée pour cette carte.");
      return;
    }
    const clim = this._hass?.states[this._climateEntity];
    if (!clim) {
      alert("Entité climate indisponible.");
      return;
    }
    const cur = clim;
    const hvacModes = (cur.attributes.hvac_modes || ["off","cool","heat","auto"]);
    const fanModes = cur.attributes.fan_modes || [];
    const swingModes = cur.attributes.swing_modes || [];
    const curMode = cur.state;
    const curSetpoint = cur.attributes.temperature;
    const curFan = cur.attributes.fan_mode;
    const curSwing = cur.attributes.swing_mode;

    const modeLabels = {
      off: "Off", cool: "Cool", heat: "Heat", auto: "Auto",
      heat_cool: "Auto", dry: "Déshu.", fan_only: "Vent.",
    };
    this._openModal(`
      <h2 class="dc-modal-title">Contrôle direct de la clim</h2>
      <div class="dc-modal-form">
        <div class="dc-modal-field">
          <label>Mode</label>
          <div class="dc-manual-modes">
            ${hvacModes.map(m => `
              <button class="dc-manual-mode ${m === curMode ? "active" : ""}" data-action="set-mode" data-mode="${m}">
                ${modeLabels[m] || m}
              </button>
            `).join("")}
          </div>
        </div>
        <div class="dc-modal-field">
          <label>Consigne</label>
          <div class="dc-manual-setpoint">
            <button class="dc-manual-step" data-action="sp-dec">−</button>
            <div class="dc-manual-spval">${curSetpoint != null ? curSetpoint : "—"}<span>°C</span></div>
            <button class="dc-manual-step" data-action="sp-inc">+</button>
          </div>
        </div>
        ${fanModes.length ? `
          <div class="dc-modal-field">
            <label>Ventilation</label>
            <select data-field="fan_mode">
              ${fanModes.map(f => `<option value="${f}" ${f === curFan ? "selected" : ""}>${f}</option>`).join("")}
            </select>
          </div>
        ` : ""}
        ${swingModes.length ? `
          <div class="dc-modal-field">
            <label>Swing</label>
            <select data-field="swing_mode">
              ${swingModes.map(s => `<option value="${s}" ${s === curSwing ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
        ` : ""}
        <span class="dc-modal-hint">Tout changement déclenche un override manuel — l'auto reprendra après la durée d'override configurée.</span>
        <div class="dc-modal-actions">
          <button class="dc-btn" data-bind="modal-cancel">Fermer</button>
        </div>
      </div>
    `);
    const m = this._modalEl;
    m.querySelector('[data-bind="modal-cancel"]').addEventListener("click", () => this._closeModal());
    // Mode buttons
    m.querySelectorAll('[data-action="set-mode"]').forEach((el) => {
      el.addEventListener("click", () => {
        this._call("climate", "set_hvac_mode", {
          entity_id: this._climateEntity,
          hvac_mode: el.dataset.mode,
        });
      });
    });
    // Setpoint +/-
    const dec = m.querySelector('[data-action="sp-dec"]');
    const inc = m.querySelector('[data-action="sp-inc"]');
    if (dec) dec.addEventListener("click", () => this._bumpSetpoint(-1));
    if (inc) inc.addEventListener("click", () => this._bumpSetpoint(+1));
    // Fan
    const fanSel = m.querySelector('[data-field="fan_mode"]');
    if (fanSel) fanSel.addEventListener("change", (e) => {
      this._call("climate", "set_fan_mode", {
        entity_id: this._climateEntity, fan_mode: e.target.value,
      });
    });
    // Swing
    const swSel = m.querySelector('[data-field="swing_mode"]');
    if (swSel) swSel.addEventListener("change", (e) => {
      this._call("climate", "set_swing_mode", {
        entity_id: this._climateEntity, swing_mode: e.target.value,
      });
    });
  }

  _updateSessionBlock(attrs) {
    // Strip inline — affiché juste sous la narrative quand une session est active.
    const strip = this.querySelector('[data-bind="session-strip"]');
    if (!strip) return;
    const session = attrs.session;
    if (!session) {
      strip.style.display = "none";
      return;
    }
    strip.style.display = "";
    const $ = (k) => this.querySelector(`[data-bind="${k}"]`);
    const parent = session.parent_profile_name || (session.manual ? "Manuelle" : "—");
    const parentLabel = session.manual ? `Manuelle (${parent})` : parent;
    $("session-parent").textContent = parentLabel;
    $("session-power-fan").textContent =
      `Puissance ${this._capitalize(session.power || "—")} · Vent. ${this._capitalize(session.fan_intensity || "—")}`;
    $("session-started").textContent = session.started_ts
      ? `Démarrée ${this._fmtElapsed(Date.now() / 1000 - session.started_ts)}`
      : "—";
    $("session-max-end").textContent = session.max_end_ts
      ? this._fmtTimeFromTs(session.max_end_ts)
      : "—";
    const cutoffRow = $("session-cutoff-row");
    if (session.target_cutoff != null) {
      cutoffRow.style.display = "";
      $("session-cutoff").textContent = this._fmtTempUnit(session.target_cutoff);
    } else {
      cutoffRow.style.display = "none";
    }
    // Banners (kickstart, cutoff hold)
    const banners = $("session-banners");
    banners.innerHTML = "";
    if (session.kickstart_until_ts && session.kickstart_until_ts > Date.now() / 1000) {
      const remaining = Math.round((session.kickstart_until_ts - Date.now() / 1000) / 60);
      banners.innerHTML += `
        <div class="dc-session-banner">
          <ha-icon icon="mdi:rocket-launch"></ha-icon>
          Kickstart actif — bascule régulière dans ${remaining} min
        </div>`;
    }
    if (session.cutoff_held_since_ts && session.target_cutoff != null) {
      const heldFor = Math.round((Date.now() / 1000 - session.cutoff_held_since_ts) / 60);
      banners.innerHTML += `
        <div class="dc-session-banner">
          <ha-icon icon="mdi:timer-sand"></ha-icon>
          Coupure atteinte — confirmé depuis ${heldFor} min
        </div>`;
    }
  }

  _openModal(html) {
    this._closeModal();
    // On append à document.body (et pas à `this`) parce que HA met les cartes
    // dans des conteneurs avec transform/will-change qui cassent position:fixed.
    // En contrepartie, les styles .dc-modal* sont injectés dans un <style>
    // attaché à document.head pour être globalement disponibles.
    this._ensureModalStyles();
    const m = document.createElement("div");
    m.className = "dc-modal-backdrop";
    m.innerHTML = `
      <div class="dc-modal" role="dialog" aria-modal="true">
        <button class="dc-modal-close" data-bind="modal-close" aria-label="Fermer">×</button>
        ${html}
      </div>
    `;
    m.addEventListener("click", (e) => {
      if (e.target === m) this._closeModal();
    });
    m.querySelector('[data-bind="modal-close"]').addEventListener("click", () => this._closeModal());
    this._escListener = (e) => { if (e.key === "Escape") this._closeModal(); };
    document.addEventListener("keydown", this._escListener);
    document.body.appendChild(m);
    this._modalEl = m;
    // Auto-focus le premier input
    const firstInput = m.querySelector("input, select");
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
  }

  _ensureModalStyles() {
    // Idempotent : injecte un <style> global avec les règles modal, une seule
    // fois pour toute la page (toutes les cartes climate-manager partagent).
    if (document.getElementById("cm-modal-styles")) return;
    const style = document.createElement("style");
    style.id = "cm-modal-styles";
    style.textContent = MODAL_STYLES;
    document.head.appendChild(style);
  }

  _closeModal() {
    if (this._modalEl) {
      this._modalEl.remove();
      this._modalEl = null;
    }
    if (this._escListener) {
      document.removeEventListener("keydown", this._escListener);
      this._escListener = null;
    }
    // Si un profil "nouveau" était en attente d'édition et n'a pas été sauvé,
    // on l'abandonne (l'utilisateur a cancel/escape).
    this._pendingNewProfile = null;
  }

  _openSessionModifyModal() {
    const attrs = this._stateAttrs();
    const s = attrs.session;
    if (!s) return;
    const maxEndLocal = s.max_end_ts ? this._fmtDatetimeLocal(s.max_end_ts) : "";
    this._openModal(`
      <h2 class="dc-modal-title">Modifier la session</h2>
      <div class="dc-modal-form" data-bind="session-modify-form">
        <div class="dc-modal-pair">
          <div class="dc-modal-field">
            <label>Cible (°C)</label>
            <input type="number" step="0.5" data-field="target" value="${s.target ?? ""}">
          </div>
          <div class="dc-modal-field">
            <label>Coupure (°C, vide = aucune)</label>
            <input type="number" step="0.5" data-field="target_cutoff" value="${s.target_cutoff ?? ""}">
          </div>
        </div>
        <div class="dc-modal-pair">
          <div class="dc-modal-field">
            <label>Puissance</label>
            <select data-field="power">
              ${["doux","normal","agressif"].map(o => `<option value="${o}" ${s.power===o?"selected":""}>${this._capitalize(o)}</option>`).join("")}
            </select>
          </div>
          <div class="dc-modal-field">
            <label>Ventilation</label>
            <select data-field="fan_intensity">
              ${["doux","normal","fort"].map(o => `<option value="${o}" ${s.fan_intensity===o?"selected":""}>${this._capitalize(o)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="dc-modal-field">
          <label>Fin maximale</label>
          <input type="datetime-local" data-field="max_end" value="${maxEndLocal}">
          <span class="dc-modal-hint">La session se termine à cette heure quoi qu'il arrive.</span>
        </div>
        <div class="dc-modal-actions">
          <button class="dc-btn" data-bind="modal-cancel">Annuler</button>
          <button class="dc-btn dc-btn-primary" data-bind="modal-save">Enregistrer</button>
        </div>
      </div>
    `);
    const form = this._modalEl.querySelector('[data-bind="session-modify-form"]');
    form.querySelector('[data-bind="modal-cancel"]').addEventListener("click", () => this._closeModal());
    form.querySelector('[data-bind="modal-save"]').addEventListener("click", () => this._submitSessionModify(form));
  }

  _submitSessionModify(form) {
    const get = (f) => form.querySelector(`[data-field="${f}"]`)?.value ?? "";
    const data = { zone_id: this._zone };
    const target = parseFloat(get("target"));
    if (Number.isFinite(target)) data.target = target;
    const cutoffRaw = get("target_cutoff").trim();
    if (cutoffRaw === "") {
      // L'utilisateur veut effacer la coupure
      data.target_cutoff = null;
    } else {
      const c = parseFloat(cutoffRaw);
      if (Number.isFinite(c)) data.target_cutoff = c;
    }
    const pwr = get("power");
    if (pwr) data.power = pwr;
    const fan = get("fan_intensity");
    if (fan) data.fan_intensity = fan;
    const maxEndStr = get("max_end");
    if (maxEndStr) {
      const ts = new Date(maxEndStr).getTime() / 1000;
      if (Number.isFinite(ts)) data.max_end_ts = ts;
    }
    this._call("climate_manager", "update_session", data);
    this._closeModal();
  }

  _openSessionStartModal() {
    const attrs = this._stateAttrs();
    // Hérite du profil "actif" (ou du premier profil de la cascade) si pas de session
    const profiles = Array.isArray(attrs.profiles) ? attrs.profiles : [];
    let inherit = profiles.find((p) => p.name === attrs.active_profile_name);
    if (!inherit && profiles.length > 0) inherit = profiles[0];
    inherit = inherit || { mode: "cool", target: 24.5, power: "normal", fan_intensity: "normal" };
    // max_end_ts : 23:59 par défaut
    const defaultEnd = new Date();
    defaultEnd.setHours(23, 59, 0, 0);
    const maxEndLocal = this._fmtDatetimeLocalDate(defaultEnd);
    this._openModal(`
      <h2 class="dc-modal-title">Démarrer une session</h2>
      <div class="dc-modal-form" data-bind="session-start-form">
        <div class="dc-modal-pair">
          <div class="dc-modal-field">
            <label>Mode</label>
            <select data-field="mode">
              <option value="cool" ${inherit.mode==="cool"?"selected":""}>Refroidissement</option>
              <option value="heat" ${inherit.mode==="heat"?"selected":""}>Chauffage</option>
            </select>
          </div>
          <div class="dc-modal-field">
            <label>Cible (°C)</label>
            <input type="number" step="0.5" data-field="target" value="${inherit.target ?? 24.5}">
          </div>
        </div>
        <div class="dc-modal-pair">
          <div class="dc-modal-field">
            <label>Coupure (°C, vide = aucune)</label>
            <input type="number" step="0.5" data-field="target_cutoff" value="">
          </div>
          <div class="dc-modal-field">
            <label>Fin maximale</label>
            <input type="datetime-local" data-field="max_end" value="${maxEndLocal}">
          </div>
        </div>
        <div class="dc-modal-pair">
          <div class="dc-modal-field">
            <label>Puissance</label>
            <select data-field="power">
              ${["doux","normal","agressif"].map(o => `<option value="${o}" ${inherit.power===o?"selected":""}>${this._capitalize(o)}</option>`).join("")}
            </select>
          </div>
          <div class="dc-modal-field">
            <label>Ventilation</label>
            <select data-field="fan_intensity">
              ${["doux","normal","fort"].map(o => `<option value="${o}" ${inherit.fan_intensity===o?"selected":""}>${this._capitalize(o)}</option>`).join("")}
            </select>
          </div>
        </div>
        <span class="dc-modal-hint">Pré-rempli depuis ${attrs.active_profile_name ? `le profil <b>${attrs.active_profile_name}</b>` : "le premier profil de la cascade"}. Modifie ce que tu veux avant de valider.</span>
        <div class="dc-modal-actions">
          <button class="dc-btn" data-bind="modal-cancel">Annuler</button>
          <button class="dc-btn dc-btn-primary" data-bind="modal-save">Démarrer</button>
        </div>
      </div>
    `);
    const form = this._modalEl.querySelector('[data-bind="session-start-form"]');
    form.querySelector('[data-bind="modal-cancel"]').addEventListener("click", () => this._closeModal());
    form.querySelector('[data-bind="modal-save"]').addEventListener("click", () => this._submitSessionStart(form, attrs.active_profile_name));
  }

  _submitSessionStart(form, parentProfileName) {
    const get = (f) => form.querySelector(`[data-field="${f}"]`)?.value ?? "";
    const data = { zone_id: this._zone };
    data.mode = get("mode") || "cool";
    const target = parseFloat(get("target"));
    data.target = Number.isFinite(target) ? target : (data.mode === "cool" ? 24.5 : 21);
    const cutoffRaw = get("target_cutoff").trim();
    if (cutoffRaw) {
      const c = parseFloat(cutoffRaw);
      if (Number.isFinite(c)) data.target_cutoff = c;
    }
    const maxEndStr = get("max_end");
    if (maxEndStr) {
      const ts = new Date(maxEndStr).getTime() / 1000;
      if (Number.isFinite(ts)) data.max_end_ts = ts;
    } else {
      // Default : +4h
      data.max_end_ts = Date.now() / 1000 + 4 * 3600;
    }
    data.power = get("power") || "normal";
    data.fan_intensity = get("fan_intensity") || "normal";
    if (parentProfileName) data.parent_profile_name = parentProfileName;
    this._call("climate_manager", "start_session", data);
    this._closeModal();
  }

  _fmtElapsed(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const min = Math.round(seconds / 60);
    if (min < 1) return "à l'instant";
    if (min < 60) return `il y a ${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `il y a ${h}h${m.toString().padStart(2, "0")}`;
  }

  _fmtDatetimeLocal(epochSec) {
    const d = new Date(epochSec * 1000);
    return this._fmtDatetimeLocalDate(d);
  }

  _fmtDatetimeLocalDate(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* =================================================================== profile modal */

  _openProfileModal(idx) {
    const profiles = this._currentProfiles();
    const p = profiles[idx] || {};
    const presenceEntities = this._listEntities([
      "alarm_control_panel.", "person.", "binary_sensor.", "device_tracker.",
      "input_boolean.", "group.",
    ]);
    const opt = (v, l, cur) =>
      `<option value="${this._escapeHTML(v)}" ${v === cur ? "selected" : ""}>${this._escapeHTML(l)}</option>`;
    this._openModal(`
      <h2 class="dc-modal-title">Profil — ${this._escapeHTML(p.name || "Nouveau")}</h2>
      <div class="dc-modal-form" data-bind="profile-modal-form" data-idx="${idx}">
        <div class="dc-modal-field">
          <label>Nom</label>
          <input type="text" data-field="name" value="${this._escapeHTML(p.name || "")}">
        </div>
        <div class="dc-modal-field">
          <label>Mode</label>
          <select data-field="mode">
            ${opt("cool", "Refroidissement", p.mode || "cool")}
            ${opt("heat", "Chauffage", p.mode || "cool")}
          </select>
        </div>
        <div class="dc-modal-pair">
          <div class="dc-modal-field">
            <label>Actif de</label>
            <input type="time" data-field="active_from" value="${this._escapeHTML(p.active_from || "")}">
          </div>
          <div class="dc-modal-field">
            <label>Jusqu'à</label>
            <input type="time" data-field="active_to" value="${this._escapeHTML(p.active_to || "")}">
          </div>
        </div>
        <div class="dc-modal-pair">
          <div class="dc-modal-field">
            <label>Seuil de démarrage</label>
            <input type="number" step="0.5" data-field="seuil_demarrage" value="${p.seuil_demarrage ?? ""}">
          </div>
          <div class="dc-modal-field">
            <label>Cible (°C)</label>
            <input type="number" step="0.5" data-field="target" value="${p.target ?? ""}">
          </div>
        </div>
        <div class="dc-modal-field">
          <label>Cible de coupure (°C — vide = pas de coupure auto)</label>
          <input type="number" step="0.5" data-field="target_cutoff" value="${p.target_cutoff ?? ""}">
          <span class="dc-modal-hint">Si renseignée, la session s'arrête quand la pièce atteint cette T° pendant 15 min.</span>
        </div>
        <div class="dc-modal-pair">
          <div class="dc-modal-field">
            <label>Puissance</label>
            <select data-field="power">
              ${["doux","normal","agressif"].map(o => opt(o, this._capitalize(o), p.power || "normal")).join("")}
            </select>
          </div>
          <div class="dc-modal-field">
            <label>Ventilation</label>
            <select data-field="fan_intensity">
              ${["doux","normal","fort"].map(o => opt(o, this._capitalize(o), p.fan_intensity || "normal")).join("")}
            </select>
          </div>
        </div>

        <details class="dc-modal-advanced" ${p.kickstart_minutes > 0 ? "open" : ""}>
          <summary>Kickstart (boost de démarrage)</summary>
          <div class="dc-modal-field">
            <label>Durée du kickstart (min, 0 = désactivé)</label>
            <input type="number" min="0" step="5" data-field="kickstart_minutes" value="${p.kickstart_minutes ?? 0}">
          </div>
          <div class="dc-modal-pair">
            <div class="dc-modal-field">
              <label>Puissance kickstart</label>
              <select data-field="kickstart_power">
                <option value="">(hériter)</option>
                ${["doux","normal","agressif"].map(o => opt(o, this._capitalize(o), p.kickstart_power || "")).join("")}
              </select>
            </div>
            <div class="dc-modal-field">
              <label>Ventilation kickstart</label>
              <select data-field="kickstart_fan_intensity">
                <option value="">(hériter)</option>
                ${["doux","normal","fort"].map(o => opt(o, this._capitalize(o), p.kickstart_fan_intensity || "")).join("")}
              </select>
            </div>
          </div>
          <span class="dc-modal-hint">Pendant les N premières minutes, on remplace puissance + ventilation par les valeurs ci-dessus (idéal pour absorber un gros écart au démarrage).</span>
        </details>

        <details class="dc-modal-advanced" ${p.presence_entity ? "open" : ""}>
          <summary>Présence (condition optionnelle)</summary>
          <div class="dc-modal-field">
            <label>Entité de présence</label>
            <select data-field="presence_entity">
              ${opt("", "— Aucune —", p.presence_entity || "")}
              ${presenceEntities.map((e) => opt(e, e, p.presence_entity || "")).join("")}
            </select>
          </div>
          <div class="dc-modal-field">
            <label>État requis (ex: armed_away, home, on)</label>
            <input type="text" data-field="presence_required_state" value="${this._escapeHTML(p.presence_required_state || "")}">
          </div>
        </details>

        <div class="dc-modal-actions">
          <button class="dc-btn" data-bind="modal-cancel">Annuler</button>
          <button class="dc-btn dc-btn-primary" data-bind="modal-save">Enregistrer</button>
        </div>
      </div>
    `);
    const form = this._modalEl.querySelector('[data-bind="profile-modal-form"]');
    form.querySelector('[data-bind="modal-cancel"]').addEventListener("click", () => this._closeModal());
    form.querySelector('[data-bind="modal-save"]').addEventListener("click", () => this._submitProfileModal(form, idx));
  }

  _submitProfileModal(form, idx) {
    const get = (f) => form.querySelector(`[data-field="${f}"]`)?.value ?? "";
    const num = (f, def) => {
      const v = parseFloat(get(f));
      return Number.isFinite(v) ? v : def;
    };
    const nullableNum = (f) => {
      const raw = get(f).trim();
      if (raw === "") return null;
      const v = parseFloat(raw);
      return Number.isFinite(v) ? v : null;
    };
    const nullableInt = (f) => {
      const raw = get(f).trim();
      if (raw === "") return 0;
      const v = parseInt(raw, 10);
      return Number.isFinite(v) ? Math.max(0, v) : 0;
    };
    const nullableStr = (f) => {
      const v = get(f);
      return v === "" ? null : v;
    };
    const mode = get("mode") === "heat" ? "heat" : "cool";
    const defSeuil = mode === "cool" ? 27.0 : 18.0;
    const defTarget = mode === "cool" ? 24.5 : 21.0;
    const profile = {
      name: get("name").trim() || "Sans nom",
      mode,
      active_from: nullableStr("active_from"),
      active_to: nullableStr("active_to"),
      presence_entity: nullableStr("presence_entity"),
      presence_required_state: nullableStr("presence_required_state"),
      seuil_demarrage: num("seuil_demarrage", defSeuil),
      target: num("target", defTarget),
      target_cutoff: nullableNum("target_cutoff"),
      power: get("power") || "normal",
      fan_intensity: get("fan_intensity") || "normal",
      kickstart_minutes: nullableInt("kickstart_minutes"),
      kickstart_power: nullableStr("kickstart_power"),
      kickstart_fan_intensity: nullableStr("kickstart_fan_intensity"),
    };
    const profiles = this._currentProfiles();
    profiles[idx] = profile;
    this._pendingNewProfile = null;
    this._closeModal();
    this._pushProfiles(profiles);
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
    badge.style.display = (this._split && stateVal === "idle") ? "none" : "";
    $("state-icon").setAttribute("icon", meta.icon);
    $("state-label").textContent = meta.label;
    const attrs = stateObj?.attributes || {};

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

    // ─────────────────── SECTION 1: ÉTAT ACTUEL — minimal hero
    $("room-temp").textContent = this._fmtTemp(get(ids.roomTemp)?.state);
    // Target temperature next to room temp, with arrow. The target comes from
    // the active profile (via coordinator). When no profile is active, hide.
    const targetT = attrs.target_temperature;
    const targetEl = $("target-temp");
    if (targetEl) targetEl.textContent = targetT != null ? this._fmtTemp(targetT) : "—";

    // Cool/warm dynamic accent — swaps the whole card's accent var so the
    // hero number, pills, segmented active state, controls all follow.
    const card = this.querySelector("ha-card");
    const dir = attrs.direction;
    const cycleActive = stateVal === "running";
    const detailsToggle = $("details-toggle");
    if (detailsToggle) {
      detailsToggle.classList.toggle("no-details", !cycleActive);
      detailsToggle.title = cycleActive ? "Voir les détails techniques" : "Détails disponibles quand la climatisation tourne";
      if (!cycleActive) detailsToggle.removeAttribute("open");
    }
    const hero = $("hero");
    if (cycleActive && dir === "heat") {
      card?.classList.add("accent-warm");
      hero?.classList.add("active-warm");
      hero?.classList.remove("active-cool");
    } else if (cycleActive && dir === "cool") {
      card?.classList.remove("accent-warm");
      hero?.classList.add("active-cool");
      hero?.classList.remove("active-warm");
    } else {
      card?.classList.remove("accent-warm");
      hero?.classList.remove("active-cool", "active-warm");
    }
    hero?.classList.toggle("no-target", targetT == null);

    // Narrative — 1 line that synthesises everything the user needs:
    // current direction + target temp + profile + next schedule transition.
    const nar = this._buildNarrative(stateVal, null, attrs, get, ids);
    const narEl = $("narrative");
    narEl.innerHTML = nar.html;
    narEl.classList.toggle("warn", !!nar.warn);
    narEl.classList.toggle("warm", dir === "heat");

    this._updateThermalRail(stateVal, attrs, get, ids);
    this._updateTimeline(stateVal, attrs, get, ids);
    this._updateSessionBlock(attrs);
    this._updateActionsBlock(stateVal, attrs);

    // Pills — ONLY surface what's not redundant with the narrative or state
    // tag. Windows open is real signal. Override is real signal. Schedule
    // off when it actually matters. Default to nothing.
    const pills = $("status-pills");
    pills.innerHTML = "";

    // Pills only when there's something the badge / banner doesn't already
    // say. Override is already covered by the header badge + the bottom
    // banner — no pill for it.
    if (attrs.schedule_on === false && !attrs.in_override) {
      const nextEvt = attrs.schedule_next_event;
      const nextEvtTxt = nextEvt ? this._fmtTime(nextEvt) : null;
      pills.appendChild(this._pill(
        "mdi:pause-circle-outline",
        nextEvtTxt ? `Reprise ${nextEvtTxt}` : "Hors planning",
        "warn",
      ));
    }
    const wOpen = attrs.windows_open;
    const wTotal = attrs.windows_total;
    if (typeof wTotal === "number" && wTotal > 0 && wOpen > 0) {
      pills.appendChild(this._pill(
        "mdi:window-open",
        `${wOpen} fenêtre${wOpen > 1 ? "s" : ""} ouverte${wOpen > 1 ? "s" : ""}`,
        "warn",
      ));
    }

    // Metrics grid (2x2)
    $("metric-setpoint-sent").textContent = this._fmtTempUnit(get(ids.setpointSent)?.state);
    const climObj = this._climateEntity ? get(this._climateEntity) : null;
    $("metric-clim-setpoint").textContent =
      climObj ? this._fmtTempUnit(climObj.attributes.temperature) : "—";
    $("metric-clim-sonde").textContent =
      climObj ? this._fmtTempUnit(climObj.attributes.current_temperature) : "—";

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

    // SECTION 4 (Commande manuelle) supprimée — désormais via modal
    // déclenché par l'action « Contrôle direct clim ». Le bloc legacy reste
    // hidden dans le DOM pour ne pas casser le wireUp.

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
      const profiles = Array.isArray(attrs.profiles) ? attrs.profiles : [];
      const active = profiles.find((p) => p && p.name === attrs.active_profile_name) || null;
      const room = parseFloat(get(ids.roomTemp)?.state);

      if (!active) {
        return { html: "Aucun profil actif sur ce créneau.", warn: false };
      }
      const seuil = parseFloat(active.seuil_demarrage);
      const isCool = active.mode === "cool";
      const cmp = isCool ? "dépasse" : "descend sous";
      let hint = "";
      if (!Number.isNaN(room) && !Number.isNaN(seuil)) {
        const d = isCool ? (seuil - room) : (room - seuil);
        if (d > 0) hint = ` <span class="until">(encore ${d.toFixed(1)}°C)</span>`;
      }
      const verb = isCool ? "refroidissement" : "chauffage";
      return { html: `Démarre le ${verb} dès que la pièce ${cmp} ${this._fmtTemp(seuil)}°C.${hint}`, warn: false };
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
    // Conditions de pause / override : la badge état + la zone dédiée
    // en dessous portent déjà l'info, narrative redondante → vide.
    if (state === "schedule_off") return { html: "", warn: false };
    if (state === "manual_override_timed") return { html: "", warn: false };
    if (state === "manual_override_free") return { html: "", warn: false };
    if (state === "window_open") return { html: "", warn: false };
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
      ${isActive ? '<span class="dc-profile-badge">ACTIF</span>' : '<span class="dc-profile-badge ghost"></span>'}
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
    meta.innerHTML = `
      <span class="primary"><ha-icon icon="${this._profileGateIcon(profile)}"></ha-icon>${this._escapeHTML(this._profileGateLabel(profile))}</span>
      <span><ha-icon icon="mdi:snowflake"></ha-icon>${this._escapeHTML(this._profileCoolLabel(profile))}</span>
      <span><ha-icon icon="mdi:tune-variant"></ha-icon>${this._escapeHTML(this._profileDriverLabel(profile))}</span>`;
    card.appendChild(meta);
    const detail = this._profileDetailLabel(profile);
    if (detail) {
      const more = document.createElement("div");
      more.className = "dc-profile-detail";
      more.textContent = detail;
      card.appendChild(more);
    }
    return card;
  }

  _profileGateIcon(profile) {
    if (profile.presence_entity) return "mdi:shield-account";
    if (profile.active_from || profile.active_to) return "mdi:clock-outline";
    return "mdi:infinity";
  }

  _profileGateLabel(profile) {
    if (profile.presence_entity) {
      const state = profile.presence_required_state;
      const stateLabel = this._presenceStateLabel(state);
      const entity = this._friendlyEntityName(profile.presence_entity);
      return stateLabel ? stateLabel : entity;
    }
    if (profile.active_from && profile.active_to) {
      return `${profile.active_from} → ${profile.active_to}`;
    }
    return "Toujours actif";
  }

  _profileCoolLabel(profile) {
    const start = this._fmtTemp(profile.seuil_demarrage);
    const end = this._fmtTemp(profile.target);
    if (start === "—" && end === "—") return profile.mode === "heat" ? "Chaud —" : "Froid —";
    if (start === "—") return `Cible ${end}°`;
    return `${start}→${end}°`;
  }

  _profileDriverLabel(profile) {
    const power = this._profilePowerLabel(profile.power || "normal");
    const fan = this._profileFanLabel(profile.fan_intensity || "normal");
    return power === fan ? power : `${power} · ${fan}`;
  }

  _profileDetailLabel(profile) {
    const parts = [];
    // Surface mode + time window combined with presence as secondary info.
    parts.push(profile.mode === "heat" ? "Chauffage" : "Refroidissement");
    if (profile.presence_entity && profile.active_from && profile.active_to) {
      parts.push(`${profile.active_from} → ${profile.active_to}`);
    } else if (profile.presence_entity && !(profile.active_from && profile.active_to)) {
      parts.push(this._friendlyEntityName(profile.presence_entity));
    }
    return parts.join(" · ");
  }

  _friendlyEntityName(entityId) {
    const st = this._hass?.states?.[entityId];
    return st?.attributes?.friendly_name || entityId;
  }

  _friendlyScheduleName(entityId) {
    const name = this._friendlyEntityName(entityId)
      .replace(/^Delormej Climate\s*/i, "")
      .replace(/^Climate Manager\s*[·-]?\s*/i, "");
    return name || "Planning";
  }

  _presenceStateLabel(state) {
    if (Array.isArray(state)) return state.map((s) => this._presenceStateLabel(s)).join(" ou ");
    const s = String(state || "").toLowerCase();
    const labels = {
      armed_away: "Maison vide",
      armed_vacation: "Vacances",
      armed_night: "Nuit",
      armed_home: "Maison armée",
      not_home: "Absent",
      away: "Absent",
      home: "Présent",
      on: "Actif",
      off: "Inactif",
    };
    return labels[s] || (state ? String(state) : "Condition présence");
  }

  _profilePowerLabel(power) {
    return ({ doux: "Doux", normal: "Normal", agressif: "Agressif" })[power] || this._capitalize(power);
  }

  _profileFanLabel(fan) {
    return ({ doux: "Ventil. douce", normal: "Ventil. normale", fort: "Ventil. forte" })[fan] || this._capitalize(fan);
  }

  _buildProfileEditForm(profile, idx) {
    const form = document.createElement("div");
    form.className = "dc-profile-edit";
    form.dataset.idx = String(idx);
    const presenceEntities = this._listEntities(["alarm_control_panel.", "person.", "binary_sensor.", "device_tracker.", "input_boolean.", "group."]);
    const opt = (val, label, current) =>
      `<option value="${this._escapeHTML(val)}" ${val === current ? "selected" : ""}>${this._escapeHTML(label)}</option>`;
    const mode = profile.mode || "cool";
    form.innerHTML = `
      <div class="dc-profile-edit-title">Édition de ${this._escapeHTML(profile.name || "Sans nom")}</div>
      <div class="dc-field"><label>Nom</label>
        <input type="text" data-field="name" value="${this._escapeHTML(profile.name || "")}">
      </div>
      <div class="dc-field"><label>Mode</label>
        <select data-field="mode">
          ${opt("cool", "Refroidissement", mode)}
          ${opt("heat", "Chauffage", mode)}
        </select>
      </div>
      <div class="dc-pair">
        <div class="dc-field"><label>Actif à partir de</label>
          <input type="time" data-field="active_from" value="${this._escapeHTML(profile.active_from || "")}">
        </div>
        <div class="dc-field"><label>Jusqu'à</label>
          <input type="time" data-field="active_to" value="${this._escapeHTML(profile.active_to || "")}">
        </div>
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
        <div class="dc-field"><label>Seuil de démarrage</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-field="seuil_demarrage" value="${profile.seuil_demarrage ?? ""}"><span class="unit">°C</span></div>
        </div>
        <div class="dc-field"><label>Cible</label>
          <div class="dc-input-wrap"><input type="number" step="0.5" data-field="target" value="${profile.target ?? ""}"><span class="unit">°C</span></div>
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
      this._openProfileModal(idx);
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
      mode: "cool",
      active_from: null,
      active_to: null,
      presence_entity: null,
      presence_required_state: null,
      seuil_demarrage: 27.0,
      target: 24.5,
      target_cutoff: null,
      power: "normal",
      fan_intensity: "normal",
      kickstart_minutes: 0,
      kickstart_power: null,
      kickstart_fan_intensity: null,
    });
    const idx = profiles.length - 1;
    // Stocker temporairement le profil pour que le modal puisse l'éditer
    // sans avoir à le pousser d'abord (et il sera persisté à la sauvegarde).
    this._pendingNewProfile = profiles;
    this._openProfileModal(idx);
  }

  _currentProfiles() {
    // Pendant qu'un nouveau profil est en cours d'édition dans le modal,
    // on travaille sur le buffer pending. Le buffer est effacé sur save ou cancel.
    if (this._pendingNewProfile) {
      return JSON.parse(JSON.stringify(this._pendingNewProfile));
    }
    const attrs = this._hass?.states[this._ent("sensor", "state")]?.attributes || {};
    return JSON.parse(JSON.stringify(attrs.profiles || []));
  }

  _readProfileForm(form, fallback) {
    const get = (field) => form.querySelector(`[data-field="${field}"]`)?.value ?? "";
    const f = (field, def) => {
      const v = parseFloat(get(field));
      return Number.isFinite(v) ? v : def;
    };
    const i = (field) => {
      const raw = get(field).trim();
      if (raw === "") return null;
      const v = parseInt(raw, 10);
      return Number.isFinite(v) ? v : null;
    };
    const s = (field) => {
      const v = get(field);
      return v === "" ? null : v;
    };
    const mode = get("mode") === "heat" ? "heat" : "cool";
    const defSeuil = mode === "cool" ? 27.0 : 18.0;
    const defTarget = mode === "cool" ? 24.5 : 21.0;
    return {
      name: get("name") || "Sans nom",
      mode,
      active_from: s("active_from"),
      active_to: s("active_to"),
      presence_entity: s("presence_entity"),
      presence_required_state: s("presence_required_state"),
      seuil_demarrage: f("seuil_demarrage", fallback?.seuil_demarrage ?? defSeuil),
      target: f("target", fallback?.target ?? defTarget),
      power: get("power") || "normal",
      fan_intensity: get("fan_intensity") || "normal",
    };
  }

  _pushProfiles(profiles) {
    this._call("climate_manager", "update_profiles", {
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
    this._ensureHistoryData(ids.roomTemp, startMs, Date.now()).then((points) => {
      this._renderSpark($("spark"), points, target, attrs.direction);
      // timeline-text supprimé : doublonne le strip session « Démarrée il y a X min »
      const txtEl = $("timeline-text");
      if (txtEl) txtEl.textContent = "";
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

  async _ensureHistoryData(entityId, startMs, endMs = Date.now()) {
    const now = Date.now();
    if (!this._historyCache) this._historyCache = new Map();
    const endBucket = Math.round(endMs / 30_000); // avoids refetching every HA tick
    const cacheKey = `${entityId}|${startMs}|${endBucket}`;
    const cache = this._historyCache.get(cacheKey);
    if (cache && now - cache.fetchedAt < 30_000) {
      return cache.points;
    }
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
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
      // Each row's timestamp is either `lu` (minimal) or `last_updated`.
      const ts = (s.lu ?? s.last_updated);
      if (!Number.isNaN(v) && ts != null) {
        const ms = typeof ts === "number" ? ts * 1000 : Date.parse(ts);
        points.push({ ms, t: v });
      }
    }
    this._historyCache.set(cacheKey, { fetchedAt: now, points });
    // Keep the cache bounded. A dashboard can stay open for days.
    if (this._historyCache.size > 24) {
      const oldestKey = this._historyCache.keys().next().value;
      this._historyCache.delete(oldestKey);
    }
    return points;
  }

  // Backward-compatible name for older call sites / browser cache edge cases.
  async _ensureSparkData(entityId, cycleStartMs) {
    return this._ensureHistoryData(entityId, cycleStartMs, Date.now());
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
    const targetNum = parseFloat(target);
    if (!Number.isNaN(targetNum)) tValues.push(targetNum);
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
    if (!Number.isNaN(targetNum)) {
      const ty = sy(targetNum).toFixed(1);
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

    // Resolve direction + thresholds. Direction comes from coordinator; fall
    // back to the active profile's mode.
    let dir = attrs.direction; // 'cool' | 'heat' | null
    let startT, endT; // start = where the cycle would begin; end = the cible
    if (active) {
      startT = parseFloat(active.seuil_demarrage);
      endT = parseFloat(active.target);
      if (!dir) dir = active.mode || "cool";
      if (Number.isNaN(startT)) startT = null;
      if (Number.isNaN(endT)) endT = null;
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
    // v0.20: `sessions` replaces `cycle_history`. Schema differs (kwh, no temp).
    const cycles = Array.isArray(attrs.sessions) ? attrs.sessions : [];
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
    list.innerHTML = newest.map((c, idx) => this._buildCycleRow(c, idx)).join("");
    this._hydrateCycleSparklines(newest);
  }

  _buildCycleRow(c, idx) {
    const tStart = this._fmtTimeFromTs(c.start_ts);
    const tEnd = this._fmtTimeFromTs(c.end_ts);
    const duration = this._fmtDuration(c.duration_min);
    const profile = c.profile_name || c.profile_at_start || c.profile_at_end || "—";
    const dayLabel = this._fmtDayLabel(c.start_ts);
    const reason = this._cycleEndReasonMeta(c.end_reason);
    const kwh = c.kwh_consumed != null
      ? `${Number(c.kwh_consumed).toFixed(2)} kWh`
      : null;
    return `
      <div class="dc-cycle-row">
        <div class="dc-cycle-main">
          <div class="dc-cycle-top">
            <div class="dc-cycle-times">${tStart} → <span class="end">${tEnd}</span></div>
            <div class="dc-cycle-duration">
              ${duration}
              <span class="sub">${dayLabel}</span>
            </div>
          </div>
          <div class="dc-cycle-spark" data-cycle-idx="${idx}">
            ${this._buildCycleSparkline(c)}
          </div>
          <div class="dc-cycle-details">
            ${kwh ? `<span class="v">${kwh}</span>` : ""}
            <br>
            <span class="profile">${this._escapeHTML(profile)}</span>
            <span class="reason ${reason.klass}"><ha-icon icon="${reason.icon}"></ha-icon>${reason.label}</span>
          </div>
        </div>
      </div>
    `;
  }

  _hydrateCycleSparklines(cycles) {
    if (!this._hass) return;
    const ids = this._ids();
    cycles.slice(0, 6).forEach((c, idx) => {
      if (c.start_ts == null || c.end_ts == null) return;
      const el = this.querySelector(`.dc-cycle-spark[data-cycle-idx="${idx}"]`);
      if (!el) return;
      const startMs = c.start_ts * 1000;
      const endMs = c.end_ts * 1000;
      this._ensureHistoryData(ids.roomTemp, startMs, endMs).then((points) => {
        if (!points || points.length < 2) return; // keep 3-point fallback
        const direction = this._cycleDirection(c);
        this._renderSpark(el, points, null, direction);
      });
    });
  }

  _cycleDirection(c) {
    const s = parseFloat(c.temp_start);
    const e = parseFloat(c.temp_end);
    if (!Number.isNaN(s) && !Number.isNaN(e)) return e >= s ? "heat" : "cool";
    return "cool";
  }

  _cycleDeltaLabel(c) {
    const s = parseFloat(c.temp_start);
    const e = parseFloat(c.temp_end);
    if (Number.isNaN(s) || Number.isNaN(e)) return "";
    const d = e - s;
    if (Math.abs(d) < 0.1) return "stable";
    const sign = d > 0 ? "+" : "−";
    return `${sign}${Math.abs(d).toFixed(1)}°C`;
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


const MODAL_STYLES = `
  .dc-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    backdrop-filter: blur(2px);
  }
  .dc-modal-backdrop * { box-sizing: border-box; }
  .dc-modal {
    background: var(--card-background-color, #ffffff);
    color: var(--primary-text-color, #1c1c1c);
    border-radius: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
    width: 100%;
    max-width: 480px;
    max-height: 90vh;
    overflow: auto;
    padding: 22px 22px 18px;
    position: relative;
    font-family: var(--primary-font-family, system-ui, -apple-system, sans-serif);
  }
  .dc-modal-close {
    position: absolute;
    top: 12px;
    right: 14px;
    background: none;
    border: none;
    color: var(--secondary-text-color, #6b6b6b);
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    padding: 4px 8px;
  }
  .dc-modal-title {
    margin: 0 30px 18px 0;
    font-size: 17px;
    font-weight: 700;
    color: var(--primary-text-color, #1c1c1c);
  }
  .dc-modal-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .dc-modal-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dc-modal-field label {
    font-size: 12px;
    font-weight: 600;
    color: var(--secondary-text-color, #6b6b6b);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .dc-modal-field input,
  .dc-modal-field select {
    padding: 12px 14px;
    font-size: 15px;
    font-family: inherit;
    background: var(--secondary-background-color, #f3f3f3);
    color: var(--primary-text-color, #1c1c1c);
    border: 1px solid var(--divider-color, #d8d8d8);
    border-radius: 8px;
  }
  .dc-modal-field input:focus,
  .dc-modal-field select:focus {
    outline: none;
    border-color: var(--primary-color, #2196f3);
  }
  .dc-modal-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .dc-modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 8px;
  }
  .dc-modal-hint {
    font-size: 12px;
    color: var(--secondary-text-color, #6b6b6b);
    line-height: 1.4;
  }
  .dc-modal-advanced {
    border-top: 1px solid var(--divider-color, #e0e0e0);
    padding-top: 12px;
  }
  .dc-modal-advanced summary {
    cursor: pointer;
    padding: 6px 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--secondary-text-color, #6b6b6b);
    user-select: none;
  }
  .dc-modal-advanced[open] summary {
    margin-bottom: 10px;
    color: var(--primary-text-color, #1c1c1c);
  }
  .dc-modal-advanced > .dc-modal-field,
  .dc-modal-advanced > .dc-modal-pair {
    margin-top: 10px;
  }
  /* Boutons dans le modal (clone des règles .dc-btn pour autonomie) */
  .dc-modal .dc-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 16px;
    background: var(--secondary-background-color, #f3f3f3);
    color: var(--primary-text-color, #1c1c1c);
    border: 1px solid var(--divider-color, #d8d8d8);
    border-radius: 8px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .dc-modal .dc-btn:hover {
    border-color: var(--secondary-text-color, #6b6b6b);
  }
  .dc-modal .dc-btn-primary {
    background: var(--primary-color, #2196f3);
    color: var(--text-primary-color, #ffffff);
    border-color: transparent;
  }
  .dc-modal .dc-btn-primary:hover {
    filter: brightness(1.08);
  }
  /* Manual control modal */
  .dc-manual-modes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
    gap: 6px;
  }
  .dc-manual-mode {
    padding: 10px 8px;
    background: var(--secondary-background-color, #f3f3f3);
    color: var(--primary-text-color, #1c1c1c);
    border: 1px solid var(--divider-color, #d8d8d8);
    border-radius: 8px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .dc-manual-mode.active {
    background: var(--primary-color, #2196f3);
    color: var(--text-primary-color, white);
    border-color: transparent;
  }
  .dc-manual-setpoint {
    display: flex; align-items: center; justify-content: center; gap: 12px;
    padding: 8px;
    background: var(--secondary-background-color, #f3f3f3);
    border-radius: 10px;
  }
  .dc-manual-step {
    width: 44px; height: 44px;
    background: var(--card-background-color, white);
    color: var(--primary-text-color, #1c1c1c);
    border: 1px solid var(--divider-color, #d8d8d8);
    border-radius: 50%;
    font-size: 20px; font-weight: 600;
    cursor: pointer;
  }
  .dc-manual-spval {
    font-size: 28px; font-weight: 600;
    min-width: 110px; text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .dc-manual-spval span {
    font-size: 14px; color: var(--secondary-text-color, #6b6b6b);
    margin-left: 2px;
  }
`;

const STYLES = `
  /* ─────────────────────────────────────────────────────────────────
     Clean / flat / soft palette — matches bubble-card aesthetic.
     One accent that swaps cool↔warm with the active direction. No
     mono numerals. No bright signal colors. Generous breathing room.
     ───────────────────────────────────────────────────────────────── */
  ha-card.dc-card {
    /* accent — swapped at runtime via --dc-accent (cool by default) */
    --dc-cool: #00BCD4;
    --dc-cool-soft: rgba(0,188,212,0.13);
    --dc-warm: #FF8A65;
    --dc-warm-soft: rgba(255,138,101,0.13);
    --dc-accent: var(--dc-cool);
    --dc-accent-soft: var(--dc-cool-soft);

    /* spacing */
    --dc-pad: 20px;
    --dc-radius: 26px;
    --dc-radius-sm: 16px;
    --dc-radius-pill: 999px;

    /* Light-mode first: Home Assistant dashboards are often white cards. */
    --dc-card-bg: var(--card-background-color, #ffffff);
    --dc-surface: rgba(36,40,50,0.045);
    --dc-surface-strong: rgba(36,40,50,0.07);
    --dc-bg-bubble: rgba(36,40,50,0.045);
    --dc-bg-bubble-strong: rgba(36,40,50,0.07);
    --dc-bg-inset: rgba(36,40,50,0.035);
    --dc-hairline: rgba(36,40,50,0.08);

    /* text */
    --dc-fg: rgba(36,40,50,0.94);
    --dc-muted: rgba(36,40,50,0.58);
    --dc-dim: rgba(36,40,50,0.36);

    /* alerts */
    --dc-warn: #B86F2F;
    --dc-danger: #D05B50;

    background: var(--dc-card-bg);
    color: var(--dc-fg);
    font-family: var(--ha-card-font-family, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif);
    font-size: 14px;
    line-height: 1.45;
    padding: 0; overflow: hidden;
    border-radius: var(--ha-card-border-radius, var(--dc-radius));
    border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, rgba(36,40,50,0.07));
    box-shadow: var(--ha-card-box-shadow, none);
  }
  /* Do not use prefers-color-scheme here: HA dashboards can force a white
     card while the phone/browser is in dark mode. In that case OS dark-mode
     media queries make the text white on white. Keep this card's own Apple-ish
     light palette stable; dashboards that want dark cards can override these
     CSS vars explicitly. */
  /* When the active cycle is in heating, swap the accent globally */
  ha-card.dc-card.accent-warm {
    --dc-accent: var(--dc-warm);
    --dc-accent-soft: var(--dc-warm-soft);
  }
  ha-card.dc-card * { box-sizing: border-box; }

  /* ============ HEADER ============ */
  .dc-header {
    display: flex; align-items: center; gap: 14px;
    padding: 20px var(--dc-pad) 8px;
  }
  .dc-header .head-icon {
    width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: var(--dc-muted);
    transition: color 0.3s;
  }
  .dc-header .head-icon ha-icon { --mdc-icon-size: 26px; }
  .dc-header .head-icon.active { color: var(--dc-accent); }
  .dc-header .title-block { flex: 1; min-width: 0; }
  .dc-header .title {
    font-size: 18px; font-weight: 600; line-height: 1.2;
    color: var(--dc-fg);
  }
  .dc-header .subtitle {
    font-size: 12px; color: var(--dc-muted);
    margin-top: 3px;
    font-weight: 500;
  }
  /* State chip — soft and small */
  .dc-state {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 11px;
    border-radius: var(--dc-radius-pill);
    font-size: 11px; font-weight: 600;
    color: var(--dc-muted);
    background: var(--dc-surface);
    white-space: nowrap;
  }
  .dc-state::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%;
    background: var(--dc-muted);
    flex-shrink: 0;
  }
  .dc-state.state-active {
    color: var(--dc-accent);
    background: var(--dc-accent-soft);
  }
  .dc-state.state-active::before { background: var(--dc-accent); }
  .dc-state.state-warn { color: var(--dc-warm); background: var(--dc-warm-soft); }
  .dc-state.state-warn::before { background: var(--dc-warm); }
  .dc-state.state-alert { color: var(--dc-danger); background: rgba(229,115,115,0.13); }
  .dc-state.state-alert::before { background: var(--dc-danger); }
  .dc-state ha-icon { display: none; }

  /* ============ SECTIONS ============ */
  .dc-section { padding: 0 var(--dc-pad) 20px; }
  .dc-section:last-of-type { padding-bottom: 24px; }
  .dc-section-head {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 14px;
  }
  .dc-section-head .head-bubble { display: none; }
  .dc-section-head .lbl {
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dc-muted);
    flex-shrink: 0;
  }

  /* ============ §5 SESSIONS RÉCENTES — clean rows ============ */
  .dc-cycles-empty {
    text-align: center;
    color: var(--dc-muted);
    font-size: 13px;
    padding: 18px;
  }
  .dc-cycles-list {
    display: flex; flex-direction: column;
  }
  .dc-cycle-row {
    padding: 14px 0 16px;
    border-bottom: 1px solid var(--dc-hairline);
  }
  .dc-cycle-row:last-child { border-bottom: none; }
  .dc-cycle-main { display: block; }
  .dc-cycle-top {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
    margin-bottom: 8px;
  }
  .dc-cycle-times {
    font-size: 13px; color: var(--dc-fg); font-weight: 600;
    line-height: 1.35;
    font-variant-numeric: tabular-nums;
  }
  .dc-cycle-times .end {
    color: var(--dc-muted);
    font-weight: 500;
  }
  .dc-cycle-icon { display: none; }
  .dc-cycle-spark {
    height: 58px;
    margin: 2px 0 8px;
    color: var(--dc-accent);
    background: linear-gradient(180deg, var(--dc-accent-soft), transparent 70%);
    border-radius: var(--dc-radius-sm);
    overflow: hidden;
  }
  .dc-cycle-spark svg { width: 100%; height: 58px; display: block; }
  .dc-cycle-details {
    font-size: 12px; color: var(--dc-muted);
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
    line-height: 1.55;
  }
  .dc-cycle-details .v,
  .dc-cycle-details .delta { color: var(--dc-fg); font-weight: 600; }
  .dc-cycle-details .profile { color: var(--dc-muted); }
  .dc-cycle-details .reason {
    display: inline-flex; align-items: center; gap: 4px;
    margin-left: 8px;
    color: var(--dc-muted);
  }
  .dc-cycle-details .reason.success { color: var(--dc-accent); }
  .dc-cycle-details .reason.warn { color: var(--dc-warm); }
  .dc-cycle-details .reason ha-icon { --mdc-icon-size: 13px; }
  .dc-cycle-duration {
    font-size: 13px; color: var(--dc-fg); font-weight: 600;
    text-align: right; white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .dc-cycle-duration .sub {
    display: block;
    font-size: 11px; color: var(--dc-muted);
    font-weight: 500;
    margin-top: 1px;
  }

  /* ============ §1 ÉTAT ACTUEL — clean minimal hero ============ */
  .dc-hero {
    padding: 0 0 8px;
    text-align: center;
  }
  .dc-hero-row {
    display: flex; align-items: baseline; justify-content: center;
    gap: 14px; margin-bottom: 8px;
  }
  .dc-hero .room,
  .dc-hero .target-block {
    font-size: 48px; font-weight: 500;
    line-height: 1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .dc-hero .room { color: var(--dc-fg); }
  .dc-hero .room .unit,
  .dc-hero .target-block .target-unit {
    font-size: 0.4em; font-weight: 500;
    color: var(--dc-muted);
    margin-left: 2px;
  }
  /* When cooling/heating is active, the hero numbers take the accent */
  .dc-hero.active-cool .room { color: var(--dc-cool); }
  .dc-hero.active-warm .room { color: var(--dc-warm); }
  /* Target is the secondary number — same size as room but muted by default */
  .dc-hero .target-block { color: var(--dc-muted); }
  .dc-hero.active-cool .target-block { color: color-mix(in srgb, var(--dc-cool), transparent 35%); }
  .dc-hero.active-warm .target-block { color: color-mix(in srgb, var(--dc-warm), transparent 35%); }
  /* Arrow sits between, aligned to the digits */
  .dc-hero .arrow {
    font-size: 26px;
    font-weight: 400;
    color: var(--dc-dim);
    line-height: 1;
    transform: translateY(-4px);
  }
  .dc-hero.no-target .arrow,
  .dc-hero.no-target .target-block { display: none; }
  .dc-hero .room-label { display: none; }

  /* ============ Session active (bloc principal) ============ */
  .dc-session {
    margin-top: 12px;
    padding: 14px 16px;
    background: color-mix(in srgb, var(--dc-accent), transparent 88%);
    border-radius: var(--dc-radius-md);
    border: 1px solid color-mix(in srgb, var(--dc-accent), transparent 70%);
  }
  .dc-session-head {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .dc-session-title {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 700;
    color: var(--dc-fg);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .dc-session-title ha-icon { --mdc-icon-size: 16px; color: var(--dc-accent); }
  .dc-session-parent {
    font-size: 12px; color: var(--dc-muted);
    font-style: italic;
  }
  .dc-session-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px 14px;
    margin-bottom: 10px;
  }
  .dc-session-metric { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .dc-session-metric .lbl {
    font-size: 10px; color: var(--dc-dim);
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .dc-session-metric .val {
    font-size: 14px; font-weight: 600; color: var(--dc-fg);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dc-session-banners:empty { display: none; }
  .dc-session-banners {
    display: flex; flex-direction: column; gap: 4px;
    margin-bottom: 10px;
  }
  .dc-session-banner {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 10px;
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    font-size: 12px; color: var(--dc-muted);
  }
  .dc-session-banner ha-icon { --mdc-icon-size: 14px; color: var(--dc-accent); }
  .dc-session-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 8px;
  }
  .dc-session-idle {
    margin-top: 12px;
  }

  /* ============ Buttons (cohérents) ============ */
  .dc-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 10px 14px;
    background: var(--dc-surface);
    color: var(--dc-fg);
    border: 1px solid var(--dc-border);
    border-radius: var(--dc-radius-sm);
    font-family: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .dc-btn:hover { border-color: var(--dc-muted); }
  .dc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .dc-btn ha-icon { --mdc-icon-size: 16px; }
  .dc-btn-primary {
    background: var(--dc-accent);
    color: var(--dc-on-accent, var(--dc-fg));
    border-color: transparent;
  }
  .dc-btn-primary:hover { filter: brightness(1.08); }
  .dc-btn-danger {
    color: #c0392b;
    border-color: color-mix(in srgb, #c0392b, transparent 75%);
  }
  .dc-btn-wide { width: 100%; padding: 12px; }

  /* (Les styles modal sont injectés via MODAL_STYLES dans document.head) */

  /* ============ Session strip inline (sous la narrative) ============ */
  .dc-session-strip {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed var(--dc-border);
  }
  .dc-session-line {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px;
    font-size: 13px;
    color: var(--dc-fg);
    line-height: 1.6;
  }
  .dc-session-line-main {
    font-weight: 600;
  }
  .dc-session-parent {
    color: var(--dc-accent);
  }
  .dc-session-line-sub {
    font-size: 12px;
    color: var(--dc-muted);
    font-weight: 500;
  }
  .dc-session-sep {
    color: var(--dc-dim);
    margin: 0 2px;
  }
  .dc-session-banners:empty { display: none; }
  .dc-session-banners {
    display: flex; flex-direction: column; gap: 4px;
    margin-top: 6px;
  }
  .dc-session-banner {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 10px;
    background: color-mix(in srgb, var(--dc-accent), transparent 88%);
    border-radius: var(--dc-radius-sm);
    font-size: 12px; color: var(--dc-fg);
  }
  .dc-session-banner ha-icon { --mdc-icon-size: 14px; color: var(--dc-accent); }

  /* ============ Actions block — boutons full-width stacked ============ */
  .dc-actions-block {
    display: flex; flex-direction: column; gap: 14px;
    padding: 4px 0;
  }
  .dc-actions-primary {
    display: flex; flex-direction: column; gap: 8px;
  }
  .dc-actions-secondary {
    display: flex; flex-direction: column; gap: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--dc-border);
  }
  .dc-action-info {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 12px 14px;
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    font-size: 13px; color: var(--dc-muted);
    line-height: 1.4;
    margin-bottom: 2px;
  }
  .dc-action-info ha-icon {
    --mdc-icon-size: 18px;
    color: var(--dc-accent);
    flex-shrink: 0;
    margin-top: 1px;
  }
  .dc-action-btn {
    width: 100%;
    display: flex; align-items: center; justify-content: center; gap: 10px;
    padding: 14px 16px;
    background: var(--dc-surface);
    color: var(--dc-fg);
    border: 1px solid var(--dc-border);
    border-radius: var(--dc-radius-sm);
    font-family: inherit; font-size: 14px; font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, filter 0.15s, color 0.15s;
  }
  .dc-action-btn ha-icon { --mdc-icon-size: 20px; flex-shrink: 0; }
  .dc-action-btn:hover { border-color: var(--dc-muted); }
  .dc-action-btn.primary {
    background: var(--dc-accent);
    color: var(--dc-on-accent, white);
    border-color: transparent;
    padding: 16px;
    font-size: 15px;
  }
  .dc-action-btn.primary:hover { filter: brightness(1.08); }
  .dc-action-btn.secondary {
    background: var(--dc-surface);
    border-color: var(--dc-border);
  }
  .dc-action-btn.danger {
    background: #c0392b;
    color: white;
    border-color: transparent;
  }
  .dc-action-btn.danger:hover { filter: brightness(1.1); }
  .dc-action-btn.secondary-line {
    background: transparent;
    color: var(--dc-muted);
    border: 1px solid var(--dc-border);
    padding: 11px 14px;
    font-size: 13px;
    font-weight: 500;
  }
  .dc-action-btn.secondary-line:hover {
    color: var(--dc-fg);
    background: var(--dc-surface);
  }

  /* ============ Bloc Actions §3 — contextual ============ */
  .dc-actions-block {
    display: flex; flex-direction: column; gap: 8px;
    padding: 6px 0 4px;
  }
  .dc-action-info {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 10px 12px;
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    font-size: 13px; color: var(--dc-muted);
    line-height: 1.4;
  }
  .dc-action-info ha-icon {
    --mdc-icon-size: 18px;
    color: var(--dc-accent);
    flex-shrink: 0;
    margin-top: 1px;
  }
  .dc-action-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 12px 16px;
    background: var(--dc-surface);
    color: var(--dc-fg);
    border: 1px solid var(--dc-border);
    border-radius: var(--dc-radius-sm);
    font-family: inherit; font-size: 14px; font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, filter 0.15s;
  }
  .dc-action-btn ha-icon { --mdc-icon-size: 18px; }
  .dc-action-btn:hover { border-color: var(--dc-muted); }
  .dc-action-btn.primary {
    background: var(--dc-accent);
    color: var(--dc-on-accent, white);
    border-color: transparent;
    padding: 14px 18px; font-size: 15px;
  }
  .dc-action-btn.primary:hover { filter: brightness(1.08); }
  .dc-action-btn.secondary {
    background: var(--dc-surface);
    border-color: var(--dc-border);
  }
  .dc-action-btn.ghost {
    background: transparent;
    color: var(--dc-muted);
    border-color: var(--dc-border);
    font-weight: 500;
  }
  .dc-action-btn.ghost:hover { color: var(--dc-fg); }

  /* Contrôle direct collapsé */
  .dc-manual-collapse summary {
    list-style: none;
    cursor: pointer;
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px;
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    font-size: 13px; font-weight: 600;
    color: var(--dc-muted);
    user-select: none;
  }
  .dc-manual-collapse summary::-webkit-details-marker { display: none; }
  .dc-manual-collapse summary ha-icon { --mdc-icon-size: 16px; }
  .dc-manual-collapse summary::after {
    content: "▾"; margin-left: auto; opacity: 0.6;
  }
  .dc-manual-collapse[open] summary::after { content: "▴"; }
  .dc-manual-collapse[open] summary {
    border-bottom-left-radius: 0; border-bottom-right-radius: 0;
    margin-bottom: 0;
  }
  .dc-manual-collapse[open] .dc-subblock {
    border-top-left-radius: 0; border-top-right-radius: 0;
    margin-top: 0;
  }

  .dc-narrative {
    font-size: 14px; line-height: 1.5;
    color: var(--dc-muted);
    margin-bottom: 12px;
    font-weight: 500;
  }
  .dc-narrative .target,
  .dc-narrative .accent {
    color: var(--dc-fg);
    font-weight: 600;
  }
  .dc-narrative .until {
    color: var(--dc-fg);
    font-weight: 600;
  }
  .dc-narrative.warm .target,
  .dc-narrative.warm .accent { color: var(--dc-fg); }
  .dc-narrative.warn { color: var(--dc-warm); }

  /* Thermal rail kept hidden; live curve is intégrée sans boîte. */
  .dc-rail-wrap { display: none !important; }
  .dc-timeline {
    display: block;
    margin: 12px 0 4px;
    background: transparent;
    text-align: left;
  }
  .dc-timeline span[data-bind="timeline-text"] {
    display: none;
  }
  .dc-timeline span[data-bind="spark"] {
    display: block;
    height: 48px;
    color: var(--dc-accent);
  }

  /* Pills — minimal, single-line, just the essentials */
  .dc-pills {
    display: flex; flex-wrap: wrap; gap: 6px;
    justify-content: center;
    margin-bottom: 6px;
  }
  .dc-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 11px;
    border-radius: var(--dc-radius-pill);
    font-size: 11px; font-weight: 600;
    background: var(--dc-surface);
    color: var(--dc-muted);
  }
  .dc-pill ha-icon { --mdc-icon-size: 13px; opacity: 0.7; }
  .dc-pill--ok    { color: var(--dc-accent); background: var(--dc-accent-soft); }
  .dc-pill--warn  { color: var(--dc-warm); background: var(--dc-warm-soft); }
  .dc-pill--info  { color: var(--dc-accent); background: var(--dc-accent-soft); }
  .dc-pill--neutral { color: var(--dc-muted); background: var(--dc-surface); }

  /* Metrics list (in Détails techniques) */
  .dc-metrics { background: transparent; padding: 0; }
  .dc-metric-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0;
    border-bottom: 1px solid var(--dc-hairline);
  }
  .dc-metric-row:last-child { border-bottom: none; }
  .dc-metric-row .label {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px; color: var(--dc-muted); font-weight: 500;
  }
  .dc-metric-row .label ha-icon { --mdc-icon-size: 15px; color: var(--dc-dim); }
  .dc-metric-row .value {
    font-size: 13px; font-weight: 600;
    color: var(--dc-fg);
    font-variant-numeric: tabular-nums;
  }
  .dc-override-row {
    margin-top: 12px; padding: 12px 14px;
    background: rgba(229,115,115,0.10);
    border-radius: var(--dc-radius-sm);
    display: flex; justify-content: space-between; align-items: center;
    font-size: 13px;
  }
  .dc-override-row .lbl {
    color: var(--dc-danger); font-weight: 600;
    display: flex; align-items: center; gap: 8px;
    text-transform: none; letter-spacing: 0;
    font-size: 13px;
  }
  .dc-override-row .val {
    font-weight: 600; color: var(--dc-danger);
    font-variant-numeric: tabular-nums;
  }

  /* Collapsible sections (Détails techniques + Sessions + Manuel) */
  .dc-collapsible,
  .dc-panel {
    margin-top: 10px;
    border-radius: var(--dc-radius-sm);
    background: var(--dc-surface);
    overflow: hidden;
  }
  .dc-collapsible > summary {
    cursor: pointer; list-style: none;
    padding: 12px 14px;
    font-size: 13px; font-weight: 600;
    color: var(--dc-muted);
    display: flex; align-items: center; justify-content: space-between;
    user-select: none;
  }
  .dc-collapsible > summary::-webkit-details-marker { display: none; }
  .dc-collapsible > summary::after {
    content: "›";
    transition: transform 0.2s ease;
    color: var(--dc-dim);
    font-size: 18px; line-height: 1;
  }
  .dc-collapsible[open] > summary { color: var(--dc-fg); }
  .dc-collapsible[open] > summary::after { transform: rotate(90deg); }
  .dc-collapsible > .body, .dc-panel > .body { padding: 14px; }
  /* Détails techniques — opened directly from the temperature readout. */
  .dc-temp-details-toggle { margin: 0; }
  .dc-temp-details-toggle > summary {
    cursor: pointer; list-style: none;
    position: relative;
  }
  .dc-temp-details-toggle > summary::-webkit-details-marker { display: none; }
  .dc-temp-details-toggle > summary::after {
    content: "Détails";
    position: absolute; left: 50%; bottom: -10px; transform: translateX(-50%);
    font-size: 10px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase;
    color: var(--dc-dim); opacity: .72;
  }
  .dc-temp-details-toggle:not(.no-details) > summary:hover::after,
  .dc-temp-details-toggle[open] > summary::after { color: var(--dc-accent); opacity: 1; }
  .dc-temp-details-toggle.no-details > summary { cursor: default; }
  .dc-temp-details-toggle.no-details > summary::after { content: ""; }
  .dc-temp-details-toggle[open] .dc-metrics {
    margin: 18px 0 8px;
    padding: 2px 0 0;
    border-top: 1px solid var(--dc-hairline);
    text-align: left;
  }

  /* ============ §2 PROFILS — compact & clean ============ */
  .dc-profiles-list {
    display: flex; flex-direction: column; gap: 8px;
    margin-bottom: 10px;
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
    padding: 12px 14px;
    transition: background 0.2s;
  }
  .dc-profile--active {
    background: var(--dc-accent-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dc-accent), transparent 62%);
  }
  .dc-profile--active::before { content: none; }
  .dc-profile-head {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .dc-profile-badge {
    background: var(--dc-accent);
    color: rgba(0,0,0,0.85);
    font-size: 10px; font-weight: 700;
    padding: 2px 7px;
    border-radius: var(--dc-radius-pill);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .dc-profile-badge.ghost {
    visibility: hidden;
    width: 0;
    padding-left: 0;
    padding-right: 0;
  }
  .dc-profile-name {
    min-width: 0;
    font-weight: 650;
    color: var(--dc-fg);
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dc-profile-actions {
    display: flex; gap: 0;
    opacity: 0.58;
  }
  .dc-profile:hover .dc-profile-actions { opacity: 1; }
  .dc-profile-actions button {
    width: 26px; height: 26px;
    border: none; border-radius: 8px;
    background: transparent;
    color: var(--dc-muted);
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
    font-size: 13px;
  }
  .dc-profile-actions button ha-icon { --mdc-icon-size: 15px; }
  .dc-profile-actions button:hover { background: var(--dc-bg-bubble-strong); color: var(--dc-fg); }
  .dc-profile-meta {
    display: flex; flex-wrap: wrap;
    gap: 6px;
    font-size: 12px;
    color: var(--dc-muted);
    line-height: 1.35;
  }
  .dc-profile-meta span {
    display: inline-flex; align-items: center; gap: 5px;
    min-width: 0;
    padding: 4px 8px;
    border-radius: var(--dc-radius-pill);
    background: rgba(255,255,255,0.045);
    white-space: nowrap;
    max-width: 100%;
  }
  .dc-profile-meta span.primary { color: var(--dc-fg); }
  .dc-profile-meta ha-icon { --mdc-icon-size: 13px; color: var(--dc-dim); flex: 0 0 auto; }
  .dc-profile-meta .v {
    color: var(--dc-fg); font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .dc-profile-detail {
    margin-top: 7px;
    color: var(--dc-dim);
    font-size: 11px;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
  .dc-profile-edit input[type="time"],
  .dc-profile-edit select {
    background: var(--dc-bg-inset); border: none;
    border-radius: var(--dc-radius-sm);
    color: var(--dc-fg); padding: 9px 11px;
    font-size: 0.9em; font-weight: 500;
    appearance: none; -webkit-appearance: none;
  }
  /* Advanced section (schedule entity picker) — collapsed by default,
     reachable for users who already had a schedule.* setup before time
     windows existed. */
  .dc-profile-advanced { margin-top: 2px; }
  .dc-profile-advanced > summary {
    cursor: pointer; list-style: none;
    font-size: 0.78em; color: var(--dc-muted); font-weight: 600;
    padding: 6px 0;
    user-select: none;
  }
  .dc-profile-advanced > summary::-webkit-details-marker { display: none; }
  .dc-profile-advanced > summary::before {
    content: "›"; display: inline-block;
    transition: transform 0.15s ease;
    color: var(--dc-dim); margin-right: 4px;
  }
  .dc-profile-advanced[open] > summary::before { transform: rotate(90deg); }
  .dc-profile-advanced > summary:hover { color: var(--dc-fg); }
  .dc-profile-advanced[open] > summary { color: var(--dc-fg); }
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
    font-size: 12px;
    letter-spacing: 0;
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
    font-size: 13px; font-weight: 600;
    cursor: pointer;
    border-radius: 7px;
    transition: all 0.2s;
  }
  .dc-segmented button:hover { color: var(--dc-fg); }
  .dc-segmented button.active {
    background: var(--dc-bg-bubble-strong);
    color: var(--dc-fg);
  }
  .dc-segmented.tone-warn button.active[data-mode="boost"] {
    background: var(--dc-warm-soft); color: var(--dc-warm);
  }
  .dc-segmented.tone-danger button.active[data-mode="off"] {
    background: rgba(229,115,115,0.13); color: var(--dc-danger);
  }
  .dc-segmented button.active[data-mode="auto"] {
    background: var(--dc-accent-soft); color: var(--dc-accent);
  }

  .dc-quick-actions {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  }
  .dc-quick-actions button {
    padding: 11px 14px;
    border-radius: 10px;
    border: none;
    background: var(--dc-surface);
    color: var(--dc-fg); cursor: pointer;
    font-weight: 600; font-size: 13px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: all 0.2s;
  }
  .dc-quick-actions button ha-icon { --mdc-icon-size: 16px; }
  .dc-quick-actions button:hover:not(:disabled) {
    background: var(--dc-bg-bubble-strong);
  }
  .dc-quick-actions button:disabled { opacity: 0.35; cursor: not-allowed; }
  .dc-quick-actions button[data-bind="boost-btn"] {
    color: var(--dc-warm);
    background: var(--dc-warm-soft);
  }
  .dc-quick-actions button[data-bind="boost-btn"]:hover:not(:disabled) {
    background: rgba(255,138,101,0.20);
  }
  .dc-quick-actions button[data-bind="boost-btn"] ha-icon { color: var(--dc-warm); }

  /* Force-start (idle only) */
  .dc-force-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .dc-force-actions button {
    padding: 12px 14px;
    border-radius: 10px;
    border: none;
    cursor: pointer;
    font-weight: 600; font-size: 13px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    transition: all 0.2s;
  }
  .dc-force-actions button ha-icon { --mdc-icon-size: 16px; }
  .dc-force-actions .force-cool {
    color: var(--dc-cool); background: var(--dc-cool-soft);
  }
  .dc-force-actions .force-cool:hover { background: rgba(0,188,212,0.20); }
  .dc-force-actions .force-cool ha-icon { color: var(--dc-cool); }
  .dc-force-actions .force-heat {
    color: var(--dc-warm); background: var(--dc-warm-soft);
  }
  .dc-force-actions .force-heat:hover { background: rgba(255,138,101,0.20); }
  .dc-force-actions .force-heat ha-icon { color: var(--dc-warm); }

  /* ============ §4 COMMANDE MANUELLE ============ */
  .dc-subblock {
    background: var(--dc-surface);
    border-radius: var(--dc-radius-sm);
    padding: 14px;
    margin-bottom: 10px;
  }
  .dc-subblock:last-child { margin-bottom: 0; }
  .dc-subblock-title {
    font-size: 12px;
    color: var(--dc-muted); font-weight: 600;
    margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .dc-subblock-title ha-icon { --mdc-icon-size: 16px; color: var(--dc-dim); }

  /* HVAC mode chips */
  .dc-hvac { display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; }
  .dc-hvac button {
    padding: 9px 4px;
    background: var(--dc-bg-inset);
    border: none;
    border-radius: 10px;
    color: var(--dc-muted); cursor: pointer;
    transition: all 0.2s;
    display: flex; flex-direction: column; align-items: center; gap: 4px;
  }
  .dc-hvac button > div { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%; }
  .dc-hvac button .ha-icon-wrap {
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    color: var(--dc-muted);
    transition: all 0.2s;
  }
  .dc-hvac button ha-icon { --mdc-icon-size: 18px; }
  .dc-hvac button span { font-size: 11px; font-weight: 500; }
  .dc-hvac button:hover {
    background: var(--dc-bg-bubble-strong);
    color: var(--dc-fg);
  }
  .dc-hvac button:hover .ha-icon-wrap { color: var(--dc-fg); }
  .dc-hvac button.active { background: var(--dc-bg-bubble-strong); }
  .dc-hvac button.active .ha-icon-wrap { color: var(--hvac-color, var(--dc-fg)); }
  .dc-hvac button.active span { color: var(--dc-fg); }

  /* Setpoint stepper */
  .dc-setpoint {
    display: flex; align-items: center; justify-content: center; gap: 22px;
    margin-top: 14px;
  }
  .dc-setpoint .sp-val {
    font-size: 32px; font-weight: 600;
    min-width: 110px; text-align: center;
    letter-spacing: -0.025em;
    color: var(--dc-fg);
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .dc-setpoint .sp-unit { font-size: 14px; color: var(--dc-muted); font-weight: 500; margin-left: 3px; }
  .dc-setpoint button {
    width: 40px; height: 40px; border-radius: 50%;
    background: var(--dc-bg-inset);
    border: none;
    color: var(--dc-fg);
    font-size: 18px; font-weight: 600;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: all 0.2s;
  }
  .dc-setpoint button:hover {
    background: var(--dc-accent-soft);
    color: var(--dc-accent);
  }

  /* Fan + swing selects */
  .dc-fanswing { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
  .dc-fanswing .field { display: flex; flex-direction: column; gap: 6px; }
  .dc-fanswing label { font-size: 12px; color: var(--dc-muted); font-weight: 500; }
  .dc-fanswing select {
    background: var(--dc-bg-inset);
    border: none;
    border-radius: 10px;
    color: var(--dc-fg);
    padding: 10px 12px;
    font-size: 13px; font-weight: 500;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(138,146,160,0.8)' d='M0 0l5 6 5-6z'/></svg>");
    background-repeat: no-repeat; background-position: right 12px center;
    padding-right: 32px;
    cursor: pointer;
  }
  .dc-fanswing select:focus { outline: 2px solid var(--dc-accent); outline-offset: -2px; }

  /* Threshold pairs (start/stop side by side) */
  /* Pair grid: side-by-side on wide, stacked on narrow viewports — the
     right-hand field used to fall off the popup width on mobile, making
     the input untappable. auto-fit + minmax handles both cases without a
     media query. */
  .dc-pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
  }
  .dc-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .dc-field label {
    font-size: 0.8em; color: var(--dc-muted); font-weight: 600;
  }
  .dc-input-wrap {
    display: flex; align-items: center; gap: 6px;
    background: var(--dc-bg-inset);
    border-radius: var(--dc-radius-sm); padding: 0 14px;
    transition: outline 0.2s;
    min-width: 0;
  }
  .dc-input-wrap:focus-within { outline: 2px solid var(--dc-accent); outline-offset: -2px; }
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

  /* ============ SPLIT WIDGETS ============ */
  :host { display: block; }
  ha-card.dc-split-widget {
    --dc-pad: 18px;
    height: auto !important;
    min-height: 0 !important;
  }
  ha-card.dc-split-widget .dc-header { padding: 16px var(--dc-pad) 8px; }
  ha-card.dc-split-widget .dc-header .title { font-size: 17px; font-weight: 760; letter-spacing: -0.02em; }
  ha-card.dc-split-widget .dc-header .subtitle { display: none; }
  ha-card.dc-split-widget .dc-section { padding-bottom: 18px; }
  ha-card.dc-split-widget .dc-section-head { margin-top: 2px; }
  ha-card.dc-widget-pilotage .dc-section-head { display: none; }
  ha-card.dc-widget-pilotage .section-status { padding-top: 2px; }
  ha-card.dc-widget-pilotage .section-auto { padding-top: 0; }
  ha-card.dc-split-widget .dc-err:empty { display: none; }
  ha-card.dc-split-widget .dc-collapsible { margin-top: 0; }
  ha-card.dc-widget-status .section-auto,
  ha-card.dc-widget-status .section-manual,
  ha-card.dc-widget-status .section-profiles,
  ha-card.dc-widget-status .section-cycles { display: none; }
  /* Pilotage is now the daily widget: current state + automation controls together. */
  ha-card.dc-widget-pilotage .section-manual,
  ha-card.dc-widget-pilotage .section-profiles,
  ha-card.dc-widget-pilotage .section-cycles { display: none; }
  ha-card.dc-widget-manual .section-status,
  ha-card.dc-widget-manual .section-auto,
  ha-card.dc-widget-manual .section-profiles,
  ha-card.dc-widget-manual .section-cycles { display: none; }
  ha-card.dc-widget-profiles .section-status,
  ha-card.dc-widget-profiles .section-auto,
  ha-card.dc-widget-profiles .section-manual,
  ha-card.dc-widget-profiles .section-cycles { display: none; }
  ha-card.dc-widget-sessions .section-status,
  ha-card.dc-widget-sessions .section-auto,
  ha-card.dc-widget-sessions .section-manual,
  ha-card.dc-widget-sessions .section-profiles { display: none; }
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

    <div class="dc-hero" data-bind="hero">
      <div class="dc-hero-row">
        <div class="room"><span data-bind="room-temp">—</span><span class="unit">°C</span></div>
        <span class="arrow" data-bind="target-arrow">→</span>
        <div class="target-block" data-bind="target-block">
          <span class="target"><span data-bind="target-temp">—</span><span class="target-unit">°C</span></span>
        </div>
      </div>
      <!-- Bindings legacy hidden : kept pour ne pas casser le code _update -->
      <span data-bind="details-toggle" style="display:none"></span>
      <span data-bind="metric-setpoint-sent" style="display:none"></span>
      <span data-bind="metric-clim-setpoint" style="display:none"></span>
      <span data-bind="metric-clim-sonde" style="display:none"></span>

      <div class="dc-narrative" data-bind="narrative"></div>

      <!-- ===== Session active : strip inline d'infos, pas de boîte ===== -->
      <div class="dc-session-strip" data-bind="session-strip" style="display:none">
        <div class="dc-session-line dc-session-line-main">
          <span class="dc-session-parent" data-bind="session-parent">—</span>
          <span class="dc-session-sep">·</span>
          <span data-bind="session-power-fan">—</span>
        </div>
        <div class="dc-session-line dc-session-line-sub">
          <span data-bind="session-started">—</span>
          <span class="dc-session-sep">·</span>
          <span>fin <span data-bind="session-max-end">—</span></span>
          <span class="dc-session-cutoff-wrap" data-bind="session-cutoff-row" style="display:none">
            <span class="dc-session-sep">·</span>
            <span>coupure <span data-bind="session-cutoff">—</span></span>
          </span>
        </div>
        <div class="dc-session-banners" data-bind="session-banners"></div>
      </div>

      <div class="dc-pills" data-bind="status-pills"></div>

      <!-- Élements legacy bindings (hidden, gardés pour _updateSessionBlock interne) -->
      <span data-bind="session-target" style="display:none"></span>
      <span data-bind="session-fan" style="display:none"></span>
      <!-- session-block et session-idle-block conservés pour compat update -->
      <div data-bind="session-block" style="display:none"></div>
      <div data-bind="session-idle-block" style="display:none"></div>
    </div>

    <div class="dc-override-row" data-bind="override-row" style="display:none">
      <span class="lbl"><ha-icon icon="mdi:account-clock"></ha-icon>Override jusqu'à</span>
      <span class="val" data-bind="override-until-val">—</span>
    </div>

    <!-- Hidden legacy hero elements kept for JS compat (no-op'd) -->
    <div class="dc-rail-wrap" data-bind="rail-wrap" style="display:none">
      <span data-bind="rail-fill"></span>
      <span data-bind="rail-target"></span>
      <span data-bind="rail-cursor"><span data-bind="rail-cursor-val"></span></span>
      <span data-bind="rail-bound-left"></span><span data-bind="rail-bound-right"></span>
    </div>
    <div class="dc-timeline" data-bind="timeline" style="display:none">
      <span data-bind="timeline-text"></span><span data-bind="spark"></span>
    </div>

  </section>

  <!-- ════════════════════════════════════ §3 ACTIONS CONTEXTUELLES -->
  <section class="dc-section section-auto">
    <div class="dc-section-head">
      <div class="head-bubble"><ha-icon icon="mdi:gesture-tap"></ha-icon></div>
      <span class="lbl">Actions</span>
    </div>
    <div class="dc-actions-block" data-bind="actions-block"></div>
  </section>

  <!-- Élements legacy bindings cachés (compat _wireUp + _update internes) -->
  <div class="section-manual" style="display:none" data-bind="manual-clim-block">
    <div data-bind="hvac-modes"></div>
    <button data-bind="sp-dec"></button>
    <button data-bind="sp-inc"></button>
    <span data-bind="setpoint"></span>
    <select data-bind="fan-select"></select>
    <select data-bind="swing-select"></select>
    <button data-bind="boost-btn"></button>
    <button data-bind="resume-btn"></button>
    <button data-bind="force-cool-btn"></button>
    <button data-bind="force-heat-btn"></button>
    <div data-bind="mode">
      <button data-mode="auto"></button>
      <button data-mode="off"></button>
      <button data-mode="boost"></button>
    </div>
  </div>

  <!-- ════════════════════════════════════ §5 SESSIONS RÉCENTES -->
  <section class="dc-section section-cycles">
    <div class="dc-cycles-empty" data-bind="cycles-empty" style="display:none">
      Aucune session terminée pour l'instant.
    </div>
    <div class="dc-cycles-list" data-bind="cycles-list"></div>
  </section>

  <!-- ════════════════════════════════════ PROFILS -->
  <section class="dc-section section-profiles">
    <div class="dc-profiles-empty" data-bind="profiles-empty" style="display:none">
      Aucun profil configuré. Tant qu'aucun profil ne match, la zone reste OFF.
    </div>
    <div class="dc-profiles-list" data-bind="profiles-list"></div>
    <button class="dc-profile-add" data-bind="profile-add">
      <ha-icon icon="mdi:plus-circle"></ha-icon> Nouveau profil
    </button>
  </section>

  <div class="dc-err" data-bind="error"></div>
`;

class DelormejClimateStatusCard extends DelormejClimateCard {}
DelormejClimateStatusCard.widgetVariant = "status";
class DelormejClimatePilotageCard extends DelormejClimateCard {}
DelormejClimatePilotageCard.widgetVariant = "pilotage";
/**
 * Carte manuelle obsolète (v0.23.2). Désormais le contrôle direct est une
 * action contextuelle (modal) dans la carte principale. On garde la classe
 * pour ne pas casser les dashboards existants : elle se rend en simple
 * message d'avis pour que l'utilisateur la retire de son dashboard.
 */
class DelormejClimateManualCard extends HTMLElement {
  setConfig(_config) {
    this._rendered = false;
  }
  static getStubConfig() { return { type: "custom:climate-manager-manual-card" }; }
  getCardSize() { return 1; }
  getGridOptions() { return { columns: 12, rows: 1, min_rows: 1 }; }
  set hass(_hass) {
    if (this._rendered) return;
    this._rendered = true;
    this.innerHTML = `
      <ha-card style="padding:14px 16px; display:flex; gap:10px; align-items:center; border-radius:14px;">
        <ha-icon icon="mdi:information-outline" style="--mdc-icon-size:20px; color: var(--secondary-text-color);"></ha-icon>
        <div style="font-size:13px; color: var(--secondary-text-color); line-height:1.4;">
          Cette carte est <b>obsolète</b>. Le contrôle direct de la clim est désormais accessible
          via l'action <i>Contrôle direct de la clim</i> dans la carte principale.
          <br><span style="color: var(--primary-text-color);">Retire-la de ton dashboard.</span>
        </div>
      </ha-card>
    `;
  }
}
class DelormejClimateProfilesCard extends DelormejClimateCard {}
DelormejClimateProfilesCard.widgetVariant = "profiles";
class DelormejClimateSessionsCard extends DelormejClimateCard {}
DelormejClimateSessionsCard.widgetVariant = "sessions";

customElements.define("climate-manager-card", DelormejClimateCard);
customElements.define("climate-manager-status-card", DelormejClimateStatusCard);
customElements.define("climate-manager-pilotage-card", DelormejClimatePilotageCard);
customElements.define("climate-manager-manual-card", DelormejClimateManualCard);
customElements.define("climate-manager-profiles-card", DelormejClimateProfilesCard);
customElements.define("climate-manager-sessions-card", DelormejClimateSessionsCard);

window.customCards = window.customCards || [];
[
  {
    type: "climate-manager-card",
    name: "Climate Manager Card",
    description: "Carte tout-en-un Climate Manager.",
  },
  {
    type: "climate-manager-status-card",
    name: "Climate Manager — État actuel",
    description: "Widget Climate Manager séparé : état actuel.",
  },
  {
    type: "climate-manager-pilotage-card",
    name: "Climate Manager — Pilotage & état",
    description: "Widget Climate Manager séparé : état actuel + pilotage automatique.",
  },
  {
    type: "climate-manager-profiles-card",
    name: "Climate Manager — Profils",
    description: "Widget Climate Manager séparé : profils.",
  },
  {
    type: "climate-manager-sessions-card",
    name: "Climate Manager — Sessions",
    description: "Widget Climate Manager séparé : sessions récentes.",
  },
].forEach((card) => window.customCards.push({ ...card, preview: false }));

console.info(
  "%c CLIMATE-MANAGER-CARD %c v0.19.0 ",
  "color: white; background: #28a745; font-weight: 700;",
  "color: #28a745; background: white; font-weight: 700;"
);
