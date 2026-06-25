/**
 * Climate Manager — carte Lovelace
 *
 * v0.20 : modèle simplifié (IDLE | RUNNING), pas de phases, pas de stab/cooldown.
 * Sections : Statut / Pilotage / Profils / Sessions.
 * Design : flat, sobre, aucune couleur vive, défaut MIN d'info.
 */

const VERSION = "0.20.0";

const STATE_LABELS = {
  idle: "Inactif",
  running: "Actif",
  window_open: "Fenêtre ouverte",
  manual_override_timed: "Override manuel",
  manual_override_free: "Override (libre)",
};

const STATE_TONE = {
  idle: "neutral",
  running: "active",
  window_open: "warn",
  manual_override_timed: "warn",
  manual_override_free: "warn",
};

const POWER_LABELS = { doux: "Doux", normal: "Normal", agressif: "Agressif" };
const FAN_LABELS = { doux: "Silencieux", normal: "Normal", fort: "Fort" };

class ClimateManagerCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = null;
    this._zone = null;
    this._variant = "full";
    this._profileEditOpen = null;
    this._pendingProfiles = null;
    this._sectionsCollapsed = { profiles: true, sessions: true };
    this._initialized = false;
  }

  setConfig(config) {
    if (!config?.zone) throw new Error("`zone` is required");
    this._config = config;
    this._zone = config.zone;
    this._variant = this.constructor.widgetVariant || config.widget || config.variant || "full";
  }

  set hass(hass) {
    const first = !this._initialized;
    this._hass = hass;
    if (first) {
      this._render();
      this._initialized = true;
    } else {
      this._update();
    }
  }

  getCardSize() {
    return this._variant === "full" ? 8 : 3;
  }

  // === Data accessors ===

  _ent(domain, suffix) {
    return `${domain}.climate_manager_${this._zone}_${suffix}`;
  }

  _stateEntity() {
    return this._hass?.states[this._ent("sensor", "state")];
  }

  _stateAttrs() {
    return this._stateEntity()?.attributes || {};
  }

  _roomTemp() {
    const s = this._hass?.states[this._ent("sensor", "room_temperature")]
        ?? this._hass?.states[this._ent("sensor", "zone_temperature")];
    return s?.state ? parseFloat(s.state) : null;
  }

  _zoneState() {
    return this._stateEntity()?.state || "idle";
  }

  // === Render ===

  _render() {
    if (!this._hass) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = this._styles();
    const card = document.createElement("ha-card");
    card.className = `cm-card cm-variant-${this._variant}`;
    card.innerHTML = this._template();
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(card);
    this._bind();
  }

  _update() {
    if (!this.shadowRoot) return this._render();
    const card = this.shadowRoot.querySelector("ha-card");
    if (!card) return this._render();
    card.innerHTML = this._template();
    this._bind();
  }

  _template() {
    const attrs = this._stateAttrs();
    const state = this._zoneState();
    return `
      <div class="cm-header">
        <div class="cm-title">${this._esc(this._config.title || this._zone)}</div>
        <div class="cm-state cm-tone-${STATE_TONE[state] || "neutral"}">
          <span class="cm-dot"></span>
          <span>${STATE_LABELS[state] || state}</span>
        </div>
      </div>
      ${this._showsSection("status") ? this._renderStatus(attrs, state) : ""}
      ${this._showsSection("pilotage") ? this._renderPilotage(attrs, state) : ""}
      ${this._showsSection("profiles") ? this._renderProfiles(attrs) : ""}
      ${this._showsSection("sessions") ? this._renderSessions(attrs) : ""}
    `;
  }

  _showsSection(name) {
    if (this._variant === "full") return true;
    return this._variant === name;
  }

  // --- Statut ---

  _renderStatus(attrs, state) {
    const room = this._roomTemp();
    const target = attrs.target_temperature;
    const seuil = attrs.seuil_demarrage;
    const direction = attrs.direction;
    const active = attrs.active_profile_name;
    const power = attrs.power;
    const fan = attrs.fan_intensity;

    const dirIcon = direction === "cool" ? "mdi:snowflake"
      : direction === "heat" ? "mdi:fire"
      : "mdi:thermometer";
    const dirLabel = direction === "cool" ? "Refroidissement"
      : direction === "heat" ? "Chauffage"
      : "—";

    let narrative = "";
    if (state === "running" && target != null) {
      narrative = `Cible ${this._fmtT(target)}. La consigne s'adapte en continu.`;
    } else if (state === "idle" && active && seuil != null) {
      const cmp = direction === "heat" ? "descend sous" : "dépasse";
      narrative = `En veille. Démarre dès que la pièce ${cmp} ${this._fmtT(seuil)}.`;
    } else if (state === "idle" && !active) {
      narrative = "Aucun profil actif sur ce créneau.";
    } else if (state === "window_open") {
      const n = attrs.windows_open || 1;
      narrative = n > 1 ? `${n} fenêtres ouvertes — clim coupée.` : `Fenêtre ouverte — clim coupée.`;
    } else if (state.startsWith("manual_override")) {
      narrative = "Tu as la main. Reprends auto quand tu veux.";
    }

    return `
      <div class="cm-section cm-status">
        <div class="cm-hero">
          <div class="cm-temp">
            <div class="cm-temp-now">${room != null ? this._fmtT(room) : "—"}</div>
            <div class="cm-temp-label">T° actuelle</div>
          </div>
          ${target != null ? `
            <div class="cm-arrow">→</div>
            <div class="cm-temp">
              <div class="cm-temp-target">${this._fmtT(target)}</div>
              <div class="cm-temp-label">Cible</div>
            </div>
          ` : ""}
        </div>
        ${active ? `
          <div class="cm-meta">
            <div class="cm-meta-line">
              <ha-icon icon="${dirIcon}"></ha-icon>
              <span>${this._esc(active)}</span>
              <span class="cm-meta-sep">·</span>
              <span>${dirLabel}</span>
              ${power ? `<span class="cm-meta-sep">·</span><span>${POWER_LABELS[power] || power}</span>` : ""}
              ${fan ? `<span class="cm-meta-sep">·</span><span>Ventil. ${FAN_LABELS[fan] || fan}</span>` : ""}
            </div>
          </div>
        ` : ""}
        ${narrative ? `<div class="cm-narrative">${narrative}</div>` : ""}
      </div>
    `;
  }

  // --- Pilotage ---

  _renderPilotage(attrs) {
    const isOff = attrs.is_off_mode;
    const inOverride = attrs.in_override;
    const supportsCool = attrs.supports_cool !== false;
    const supportsHeat = attrs.supports_heat !== false;
    return `
      <div class="cm-section cm-pilotage">
        <div class="cm-section-title">Pilotage</div>
        <div class="cm-actions">
          <button class="cm-btn ${isOff ? "" : "cm-btn-primary"}" data-action="auto" ${isOff ? "" : "disabled"}>
            <ha-icon icon="mdi:auto-mode"></ha-icon>
            Pilotage auto
          </button>
          <button class="cm-btn ${isOff ? "cm-btn-warn" : ""}" data-action="off" ${isOff ? "disabled" : ""}>
            <ha-icon icon="mdi:power"></ha-icon>
            Forcer l'arrêt
          </button>
        </div>
        ${inOverride ? `
          <button class="cm-btn cm-btn-full cm-btn-primary" data-action="resume">
            <ha-icon icon="mdi:account-cancel"></ha-icon>
            Reprendre auto
          </button>
        ` : ""}
        <div class="cm-actions cm-actions-secondary">
          <button class="cm-btn" data-action="boost">
            <ha-icon icon="mdi:rocket-launch"></ha-icon>
            Boost 15 min
          </button>
          ${supportsCool ? `
            <button class="cm-btn" data-action="force-cool">
              <ha-icon icon="mdi:snowflake"></ha-icon>
              Forcer cool
            </button>
          ` : ""}
          ${supportsHeat ? `
            <button class="cm-btn" data-action="force-heat">
              <ha-icon icon="mdi:fire"></ha-icon>
              Forcer heat
            </button>
          ` : ""}
        </div>
      </div>
    `;
  }

  // --- Profils ---

  _renderProfiles(attrs) {
    const profiles = this._currentProfiles();
    const activeName = attrs.active_profile_name;
    const cool = profiles.map((p, i) => ({ p, i })).filter(x => x.p.mode === "cool");
    const heat = profiles.map((p, i) => ({ p, i })).filter(x => x.p.mode === "heat");
    const collapsed = this._sectionsCollapsed.profiles && this._profileEditOpen == null;
    return `
      <div class="cm-section cm-profiles">
        <button class="cm-section-toggle" data-action="toggle-section" data-section="profiles">
          <span class="cm-section-title">Profils <span class="cm-count">${profiles.length}</span></span>
          <ha-icon icon="${collapsed ? "mdi:chevron-down" : "mdi:chevron-up"}"></ha-icon>
        </button>
        ${collapsed ? "" : `
          <div class="cm-profile-group">
            <div class="cm-group-title">
              <ha-icon icon="mdi:snowflake"></ha-icon>
              <span>Refroidissement</span>
              <span class="cm-count">${cool.length}</span>
            </div>
            ${cool.map(x => this._renderProfileRow(x.p, x.i, activeName)).join("")
              || `<div class="cm-empty">Aucun profil cool</div>`}
            <button class="cm-btn cm-btn-ghost" data-action="add-profile" data-mode="cool">
              <ha-icon icon="mdi:plus"></ha-icon>
              Ajouter un profil cool
            </button>
          </div>
          <div class="cm-profile-group">
            <div class="cm-group-title">
              <ha-icon icon="mdi:fire"></ha-icon>
              <span>Chauffage</span>
              <span class="cm-count">${heat.length}</span>
            </div>
            ${heat.map(x => this._renderProfileRow(x.p, x.i, activeName)).join("")
              || `<div class="cm-empty">Aucun profil heat</div>`}
            <button class="cm-btn cm-btn-ghost" data-action="add-profile" data-mode="heat">
              <ha-icon icon="mdi:plus"></ha-icon>
              Ajouter un profil heat
            </button>
          </div>
          ${this._profileEditOpen != null ? this._renderProfileEditor(profiles, this._profileEditOpen) : ""}
        `}
      </div>
    `;
  }

  _renderProfileRow(p, index, activeName) {
    const isActive = p.name === activeName;
    const gateLabel = this._profileGateLabel(p);
    const targetLabel = `${this._fmtT(p.seuil_demarrage)} → ${this._fmtT(p.target)}`;
    return `
      <div class="cm-profile-row ${isActive ? "cm-profile-active" : ""}">
        <button class="cm-profile-head" data-action="edit-profile" data-index="${index}">
          <div class="cm-profile-name">
            ${isActive ? `<span class="cm-active-dot"></span>` : ""}
            <span>${this._esc(p.name || "Profil sans nom")}</span>
          </div>
          <div class="cm-profile-meta">
            <span>${this._esc(gateLabel)}</span>
            <span class="cm-meta-sep">·</span>
            <span>${targetLabel}</span>
          </div>
        </button>
      </div>
    `;
  }

  _profileGateLabel(p) {
    const parts = [];
    if (p.active_from && p.active_to) {
      parts.push(`${p.active_from}–${p.active_to}`);
    }
    if (p.presence_entity) {
      const reqLabel = Array.isArray(p.presence_required_state)
        ? p.presence_required_state.join("/")
        : (p.presence_required_state || "—");
      parts.push(`présence: ${reqLabel}`);
    }
    return parts.length ? parts.join(" · ") : "Toujours actif";
  }

  _renderProfileEditor(profiles, index) {
    const p = profiles[index] || {};
    const presenceEntities = Object.keys(this._hass?.states || {})
      .filter(eid => /^(person|device_tracker|binary_sensor|input_boolean|alarm_control_panel)\./.test(eid))
      .sort();
    return `
      <div class="cm-editor">
        <div class="cm-editor-head">
          <div class="cm-editor-title">Modifier le profil</div>
          <button class="cm-icon-btn" data-action="cancel-edit">
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </div>
        <div class="cm-form">
          <label class="cm-field">
            <span>Nom</span>
            <input type="text" data-field="name" value="${this._esc(p.name || "")}">
          </label>

          <label class="cm-field">
            <span>Mode</span>
            <select data-field="mode">
              <option value="cool" ${p.mode === "cool" ? "selected" : ""}>Refroidissement</option>
              <option value="heat" ${p.mode === "heat" ? "selected" : ""}>Chauffage</option>
            </select>
          </label>

          <div class="cm-field-row">
            <label class="cm-field">
              <span>Actif de</span>
              <input type="time" data-field="active_from" value="${p.active_from || ""}">
            </label>
            <label class="cm-field">
              <span>Actif à</span>
              <input type="time" data-field="active_to" value="${p.active_to || ""}">
            </label>
          </div>

          <div class="cm-field-row">
            <label class="cm-field">
              <span>Seuil démarrage</span>
              <div class="cm-input-with-unit">
                <input type="number" step="0.5" data-field="seuil_demarrage" value="${p.seuil_demarrage ?? ""}">
                <span class="cm-unit">°C</span>
              </div>
            </label>
            <label class="cm-field">
              <span>Cible</span>
              <div class="cm-input-with-unit">
                <input type="number" step="0.5" data-field="target" value="${p.target ?? ""}">
                <span class="cm-unit">°C</span>
              </div>
            </label>
          </div>

          <div class="cm-field-row">
            <label class="cm-field">
              <span>Puissance</span>
              <select data-field="power">
                ${["doux","normal","agressif"].map(v => `
                  <option value="${v}" ${p.power === v ? "selected" : ""}>${POWER_LABELS[v]}</option>
                `).join("")}
              </select>
            </label>
            <label class="cm-field">
              <span>Ventilation</span>
              <select data-field="fan_intensity">
                ${["doux","normal","fort"].map(v => `
                  <option value="${v}" ${p.fan_intensity === v ? "selected" : ""}>${FAN_LABELS[v]}</option>
                `).join("")}
              </select>
            </label>
          </div>

          <details class="cm-advanced" ${p.presence_entity ? "open" : ""}>
            <summary>Présence (optionnel)</summary>
            <label class="cm-field">
              <span>Entité de présence</span>
              <select data-field="presence_entity">
                <option value="">— Aucune —</option>
                ${presenceEntities.map(eid => `
                  <option value="${eid}" ${p.presence_entity === eid ? "selected" : ""}>${eid}</option>
                `).join("")}
              </select>
            </label>
            <label class="cm-field">
              <span>État requis (sépare par , si plusieurs)</span>
              <input type="text" data-field="presence_required_state" value="${this._esc(
                Array.isArray(p.presence_required_state)
                  ? p.presence_required_state.join(", ")
                  : (p.presence_required_state || "")
              )}">
            </label>
          </details>
        </div>
        <div class="cm-editor-actions">
          <button class="cm-btn cm-btn-danger" data-action="delete-profile">
            <ha-icon icon="mdi:delete"></ha-icon> Supprimer
          </button>
          <div class="cm-spacer"></div>
          <button class="cm-btn" data-action="cancel-edit">Annuler</button>
          <button class="cm-btn cm-btn-primary" data-action="save-profile">Enregistrer</button>
        </div>
      </div>
    `;
  }

  // --- Sessions ---

  _renderSessions(attrs) {
    const hasConso = attrs.has_consumption_sensor;
    if (!hasConso) {
      return `
        <div class="cm-section cm-sessions">
          <div class="cm-section-title">Sessions</div>
          <div class="cm-empty">Configure un capteur de conso (kWh) pour suivre les sessions.</div>
        </div>
      `;
    }
    const sessions = (attrs.sessions || []).slice().reverse();
    const collapsed = this._sectionsCollapsed.sessions;
    return `
      <div class="cm-section cm-sessions">
        <button class="cm-section-toggle" data-action="toggle-section" data-section="sessions">
          <span class="cm-section-title">Sessions <span class="cm-count">${sessions.length}</span></span>
          <ha-icon icon="${collapsed ? "mdi:chevron-down" : "mdi:chevron-up"}"></ha-icon>
        </button>
        ${collapsed ? "" : `
          ${sessions.length === 0
            ? `<div class="cm-empty">Aucune session enregistrée.</div>`
            : sessions.slice(0, 10).map(s => this._renderSessionRow(s)).join("")}
        `}
      </div>
    `;
  }

  _renderSessionRow(s) {
    const start = new Date(s.start_ts * 1000);
    const end = new Date(s.end_ts * 1000);
    const dateLabel = this._fmtDate(start);
    const timeRange = `${this._fmtHM(start)}–${this._fmtHM(end)}`;
    const duration = s.duration_min != null ? `${s.duration_min} min` : "—";
    const kwh = s.kwh_consumed != null
      ? `${Number(s.kwh_consumed).toFixed(2)} kWh`
      : "—";
    return `
      <div class="cm-session-row">
        <div class="cm-session-main">
          <div class="cm-session-date">${dateLabel}</div>
          <div class="cm-session-meta">${timeRange} · ${duration}${s.profile_name ? ` · ${this._esc(s.profile_name)}` : ""}</div>
        </div>
        <div class="cm-session-kwh">${kwh}</div>
      </div>
    `;
  }

  // === Binding ===

  _bind() {
    const root = this.shadowRoot;
    if (!root) return;
    root.querySelectorAll("[data-action]").forEach(el => {
      el.addEventListener("click", e => this._onAction(e));
    });
  }

  _onAction(e) {
    e.stopPropagation();
    const el = e.currentTarget;
    const action = el.dataset.action;
    if (action === "toggle-section") {
      const s = el.dataset.section;
      this._sectionsCollapsed[s] = !this._sectionsCollapsed[s];
      this._update();
      return;
    }
    if (action === "auto") return this._call("set_mode", { mode: "auto" });
    if (action === "off") return this._call("set_mode", { mode: "off" });
    if (action === "resume") return this._call("reset_override");
    if (action === "boost") return this._call("boost");
    if (action === "force-cool") return this._call("force_start", { direction: "cool" });
    if (action === "force-heat") return this._call("force_start", { direction: "heat" });
    if (action === "edit-profile") {
      this._profileEditOpen = parseInt(el.dataset.index, 10);
      this._sectionsCollapsed.profiles = false;
      this._update();
      return;
    }
    if (action === "add-profile") {
      const mode = el.dataset.mode;
      const profiles = this._currentProfiles();
      profiles.push({
        name: mode === "cool" ? "Nouveau cool" : "Nouveau heat",
        mode,
        active_from: null,
        active_to: null,
        seuil_demarrage: mode === "cool" ? 27.0 : 18.0,
        target: mode === "cool" ? 24.5 : 21.0,
        power: "normal",
        fan_intensity: "normal",
      });
      this._pendingProfiles = profiles;
      this._profileEditOpen = profiles.length - 1;
      this._sectionsCollapsed.profiles = false;
      this._update();
      return;
    }
    if (action === "cancel-edit") {
      this._profileEditOpen = null;
      this._pendingProfiles = null;
      this._update();
      return;
    }
    if (action === "save-profile") return this._saveCurrentProfile();
    if (action === "delete-profile") return this._deleteCurrentProfile();
  }

  _readEditorForm() {
    const root = this.shadowRoot;
    const get = (name) => root.querySelector(`[data-field="${name}"]`)?.value ?? "";
    const num = (name) => {
      const v = get(name);
      return v === "" ? null : parseFloat(v);
    };
    const str = (name) => {
      const v = get(name);
      return v === "" ? null : v;
    };
    const presenceRaw = get("presence_required_state").trim();
    let presence = null;
    if (presenceRaw) {
      const parts = presenceRaw.split(",").map(s => s.trim()).filter(Boolean);
      presence = parts.length > 1 ? parts : parts[0];
    }
    return {
      name: get("name").trim() || "Profil",
      mode: get("mode") || "cool",
      active_from: str("active_from"),
      active_to: str("active_to"),
      seuil_demarrage: num("seuil_demarrage") ?? 27,
      target: num("target") ?? 24.5,
      power: get("power") || "normal",
      fan_intensity: get("fan_intensity") || "normal",
      presence_entity: str("presence_entity"),
      presence_required_state: presence,
    };
  }

  _currentProfiles() {
    if (this._pendingProfiles) return this._pendingProfiles.map(p => ({ ...p }));
    return (this._stateAttrs().profiles || []).map(p => ({ ...p }));
  }

  _saveCurrentProfile() {
    const idx = this._profileEditOpen;
    if (idx == null) return;
    const profiles = this._currentProfiles();
    const updated = this._readEditorForm();
    profiles[idx] = updated;
    this._hass.callService("climate_manager", "update_profiles", {
      zone_id: this._zone,
      profiles,
    });
    this._profileEditOpen = null;
    this._pendingProfiles = null;
    this._update();
  }

  _deleteCurrentProfile() {
    const idx = this._profileEditOpen;
    if (idx == null) return;
    const profiles = this._currentProfiles();
    profiles.splice(idx, 1);
    this._hass.callService("climate_manager", "update_profiles", {
      zone_id: this._zone,
      profiles,
    });
    this._profileEditOpen = null;
    this._pendingProfiles = null;
    this._update();
  }

  _call(service, extra = {}) {
    this._hass.callService("climate_manager", service, { zone_id: this._zone, ...extra });
  }

  // === Helpers ===

  _fmtT(v) {
    if (v == null) return "—";
    const n = typeof v === "number" ? v : parseFloat(v);
    if (Number.isNaN(n)) return "—";
    return `${n.toFixed(1)}°`;
  }

  _fmtHM(d) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  _fmtDate(d) {
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    if (isToday) return "Aujourd'hui";
    const y = new Date();
    y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Hier";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
  }

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // === Styles ===

  _styles() {
    return `
      :host { display: block; }
      ha-card {
        padding: 0;
        background: var(--card-background-color);
        color: var(--primary-text-color);
        border-radius: var(--ha-card-border-radius, 12px);
      }
      .cm-card { display: flex; flex-direction: column; }

      .cm-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px 12px;
      }
      .cm-title { font-size: 1.05rem; font-weight: 600; }
      .cm-state {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 0.85rem; color: var(--secondary-text-color);
      }
      .cm-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--secondary-text-color);
      }
      .cm-tone-active .cm-dot { background: var(--primary-color); }
      .cm-tone-warn .cm-dot { background: var(--warning-color, #f5a623); }
      .cm-tone-active { color: var(--primary-text-color); }

      .cm-section {
        padding: 8px 20px 16px;
        border-top: 1px solid var(--divider-color);
      }
      .cm-section:first-of-type { border-top: none; padding-top: 0; }
      .cm-section-title {
        font-size: 0.8rem; font-weight: 600;
        color: var(--secondary-text-color);
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .cm-section-toggle {
        width: 100%; display: flex; align-items: center; justify-content: space-between;
        background: none; border: none; padding: 8px 0; cursor: pointer; color: inherit;
      }
      .cm-section-toggle ha-icon { color: var(--secondary-text-color); }
      .cm-count {
        display: inline-block; min-width: 18px; padding: 0 6px;
        margin-left: 6px;
        font-size: 0.7rem; line-height: 18px; text-align: center;
        background: var(--secondary-background-color);
        color: var(--secondary-text-color);
        border-radius: 9px;
      }

      /* Hero */
      .cm-hero {
        display: flex; align-items: center; justify-content: center; gap: 16px;
        padding: 12px 0 4px;
      }
      .cm-temp { text-align: center; }
      .cm-temp-now {
        font-size: 2.2rem; font-weight: 300; line-height: 1.1; letter-spacing: -0.02em;
      }
      .cm-temp-target {
        font-size: 1.6rem; font-weight: 400; line-height: 1.1;
        color: var(--secondary-text-color);
      }
      .cm-temp-label {
        font-size: 0.7rem; color: var(--secondary-text-color);
        margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em;
      }
      .cm-arrow { font-size: 1.4rem; color: var(--secondary-text-color); }

      .cm-meta { padding: 8px 0 4px; }
      .cm-meta-line {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        font-size: 0.85rem; color: var(--secondary-text-color);
      }
      .cm-meta-line ha-icon { --mdc-icon-size: 16px; }
      .cm-meta-sep { color: var(--divider-color); }
      .cm-narrative {
        font-size: 0.85rem; color: var(--secondary-text-color);
        padding-top: 8px;
      }

      /* Actions */
      .cm-actions {
        display: grid; gap: 8px; margin-top: 8px;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      }
      .cm-actions-secondary { margin-top: 4px; }
      .cm-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        padding: 10px 12px;
        background: var(--secondary-background-color);
        color: var(--primary-text-color);
        border: 1px solid var(--divider-color);
        border-radius: 8px;
        font-size: 0.85rem; font-weight: 500;
        font-family: inherit;
        cursor: pointer;
      }
      .cm-btn:hover { border-color: var(--secondary-text-color); }
      .cm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .cm-btn ha-icon { --mdc-icon-size: 18px; }
      .cm-btn-primary {
        background: var(--primary-color);
        color: var(--text-primary-color, white);
        border-color: transparent;
      }
      .cm-btn-warn {
        background: var(--warning-color, #f5a623);
        color: white; border-color: transparent;
      }
      .cm-btn-danger { color: var(--error-color, #d44); border-color: var(--divider-color); }
      .cm-btn-ghost {
        background: transparent;
        border-style: dashed;
        color: var(--secondary-text-color);
      }
      .cm-btn-full { width: 100%; margin-top: 8px; }

      /* Profils */
      .cm-profile-group { margin-top: 12px; }
      .cm-group-title {
        display: flex; align-items: center; gap: 6px;
        padding: 4px 0 8px;
        font-size: 0.8rem; font-weight: 600;
        color: var(--secondary-text-color);
      }
      .cm-group-title ha-icon { --mdc-icon-size: 16px; }
      .cm-profile-row {
        border: 1px solid var(--divider-color);
        border-radius: 8px;
        margin-bottom: 6px;
        overflow: hidden;
      }
      .cm-profile-active { border-color: var(--primary-color); }
      .cm-profile-head {
        width: 100%;
        display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
        padding: 10px 12px;
        background: none; border: none; color: inherit; text-align: left; cursor: pointer;
        font-family: inherit;
      }
      .cm-profile-name { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; }
      .cm-active-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--primary-color);
      }
      .cm-profile-meta { font-size: 0.8rem; color: var(--secondary-text-color); }
      .cm-empty {
        padding: 12px 0;
        font-size: 0.85rem; color: var(--secondary-text-color); text-align: center;
      }

      /* Editor */
      .cm-editor {
        margin-top: 12px;
        padding: 12px;
        background: var(--secondary-background-color);
        border-radius: 8px;
      }
      .cm-editor-head {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 8px;
      }
      .cm-editor-title { font-weight: 600; }
      .cm-icon-btn {
        background: none; border: none;
        color: var(--secondary-text-color);
        padding: 4px; cursor: pointer;
      }
      .cm-form { display: flex; flex-direction: column; gap: 10px; }
      .cm-field {
        display: flex; flex-direction: column; gap: 4px;
        flex: 1; min-width: 0;
      }
      .cm-field > span {
        font-size: 0.75rem; color: var(--secondary-text-color);
      }
      .cm-field input, .cm-field select {
        background: var(--card-background-color);
        color: var(--primary-text-color);
        border: 1px solid var(--divider-color);
        border-radius: 6px;
        padding: 8px 10px;
        font-size: 0.9rem;
        font-family: inherit;
      }
      .cm-field-row {
        display: grid; gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      }
      .cm-input-with-unit {
        position: relative; display: flex; align-items: center;
      }
      .cm-input-with-unit input { flex: 1; padding-right: 26px; }
      .cm-unit {
        position: absolute; right: 10px;
        color: var(--secondary-text-color); font-size: 0.8rem;
        pointer-events: none;
      }
      .cm-advanced summary {
        cursor: pointer; padding: 4px 0;
        font-size: 0.8rem; color: var(--secondary-text-color);
      }
      .cm-advanced[open] summary { margin-bottom: 8px; }
      .cm-editor-actions {
        display: flex; align-items: center; gap: 8px;
        margin-top: 12px;
      }
      .cm-spacer { flex: 1; }

      /* Sessions */
      .cm-session-row {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 8px 0;
        border-bottom: 1px solid var(--divider-color);
      }
      .cm-session-row:last-child { border-bottom: none; }
      .cm-session-main { flex: 1; min-width: 0; }
      .cm-session-date { font-size: 0.9rem; font-weight: 500; }
      .cm-session-meta { font-size: 0.75rem; color: var(--secondary-text-color); }
      .cm-session-kwh {
        font-size: 0.9rem; font-weight: 500;
        color: var(--primary-color);
      }
    `;
  }
}

class ClimateManagerStatusCard extends ClimateManagerCard {}
ClimateManagerStatusCard.widgetVariant = "status";

class ClimateManagerPilotageCard extends ClimateManagerCard {}
ClimateManagerPilotageCard.widgetVariant = "pilotage";

class ClimateManagerProfilesCard extends ClimateManagerCard {}
ClimateManagerProfilesCard.widgetVariant = "profiles";

class ClimateManagerSessionsCard extends ClimateManagerCard {}
ClimateManagerSessionsCard.widgetVariant = "sessions";

customElements.define("climate-manager-card", ClimateManagerCard);
customElements.define("climate-manager-status-card", ClimateManagerStatusCard);
customElements.define("climate-manager-pilotage-card", ClimateManagerPilotageCard);
customElements.define("climate-manager-profiles-card", ClimateManagerProfilesCard);
customElements.define("climate-manager-sessions-card", ClimateManagerSessionsCard);

window.customCards = window.customCards || [];
window.customCards.push(
  { type: "climate-manager-card", name: "Climate Manager", description: "Carte complète d'une zone" },
  { type: "climate-manager-status-card", name: "Climate Manager (Statut)", description: "Statut + cible" },
  { type: "climate-manager-pilotage-card", name: "Climate Manager (Pilotage)", description: "Contrôles" },
  { type: "climate-manager-profiles-card", name: "Climate Manager (Profils)", description: "Gestion des profils" },
  { type: "climate-manager-sessions-card", name: "Climate Manager (Sessions)", description: "Historique des sessions" },
);

console.info(
  `%c climate-manager-card %c v${VERSION} `,
  "color: white; background: #555; border-radius: 3px 0 0 3px; padding: 2px 6px;",
  "color: white; background: #888; border-radius: 0 3px 3px 0; padding: 2px 6px;",
);
