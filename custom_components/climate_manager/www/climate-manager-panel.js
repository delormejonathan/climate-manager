/* Climate Manager — settings panel (sidebar « Climat », admins only).
 *
 * The only place where Climate Manager is configured:
 *   Installation — equipment (what heats or cools) and zones (rooms), and who serves what
 *   Modes        — operating modes: which equipment answers, and how they combine
 *   Programme    — comfort profiles: wanted temperatures per time and presence
 *   Maison       — presence (who says the house is occupied or empty)
 * The dashboard card is for daily use only. Both share the same look
 * (soft surfaces, pills, cool/warm accent).
 */

/* Profile banks are stored per « season »: winter = heating profiles, summer = cooling profiles. */
const SEASONS = {
  winter: { label: "Chauffage", icon: "mdi:fire", mode: "heat", accent: "warm" },
  summer: { label: "Rafraîchissement", icon: "mdi:snowflake", mode: "cool", accent: "cool" },
};
const SEASON_OF = { heat: "winter", cool: "summer" };
const RELATIONS = {
  exclusive: { label: "Un seul appareil", icon: "mdi:numeric-1-circle-outline", help: "Dans chaque zone, seul le premier appareil de la liste tourne (le suivant prend le relais s'il est en panne)." },
  combined: { label: "Tous ensemble", icon: "mdi:set-all", help: "Dans chaque zone, tous les appareils de la liste tournent en même temps." },
  additive: { label: "En appoint si besoin", icon: "mdi:plus-circle-multiple-outline", help: "Le premier appareil tourne ; les suivants viennent en plus si la zone n'arrive pas à sa température." },
};
const KINDS = {
  central: { label: "Central", icon: "mdi:water-boiler", help: "Marche ou arrêt, pour une ou plusieurs zones : chaudière, gainable, plancher." },
  heat_pump: { label: "Climatisation", icon: "mdi:air-conditioner", help: "Pilotée finement, pour une seule zone." },
};
const NEW_EQUIPMENT = {
  id: null, name: "", kind: "central", entity: null, zones: [], heat: true, cool: false,
  on_option: null, off_option: null, setpoint_entity: null, setpoint_offset: 1, running_entity: null,
  energy_sensors: [], energy: "gas", energy_price: 0.11,
};
const ENERGIES = [["electricity", "Électricité"], ["gas", "Gaz"]];
const DEFAULT_PRICE = { electricity: 0.2, gas: 0.11 };
const NEW_MODE = { id: null, name: "", direction: "heat", relation: "exclusive", equipments: [], boost_gap: 1, boost_delay_min: 20, icon: null };
const TABS = [["installation", "mdi:home-lightning-bolt-outline", "Installation"], ["modes", "mdi:tune-variant", "Modes"], ["programme", "mdi:calendar-clock", "Programme"], ["maison", "mdi:home-account", "Maison"]];
const POWER = [["doux", "Doux"], ["normal", "Normal"], ["agressif", "Fort"]];
const FAN = [["doux", "Douce"], ["normal", "Normale"], ["fort", "Forte"]];
const OCCUPANCY = [["any", "Toujours"], ["home", "Maison occupée"], ["away", "Maison vide"]];
const STATE_LABELS = {
  disarmed: "Désarmée", armed_home: "Armée (présent)", armed_away: "Armée (absent)",
  armed_night: "Armée (nuit)", armed_vacation: "Vacances", armed_custom_bypass: "Armée (perso)",
  triggered: "Déclenchée", home: "À la maison", not_home: "Absent", on: "Oui", off: "Non",
};
const KNOWN_STATES = {
  alarm_control_panel: ["disarmed", "armed_home", "armed_night", "armed_away", "armed_vacation"],
  person: ["home", "not_home"], device_tracker: ["home", "not_home"],
  binary_sensor: ["on", "off"], input_boolean: ["on", "off"], group: ["home", "not_home", "on", "off"],
};
const AWAY_HINTS = ["armed_away", "armed_vacation", "not_home", "away"];
const NEW_ZONE = {
  name: "", temperature_sensors: [], window_sensors: [],
  consumption_sensor_cool: null, consumption_sensor_heat: null, override_duree_min: 30,
  anomaly_delay_min: 60, anomaly_heat_gain_per_hour: 0.5, anomaly_cool_gain_per_hour: 0.5,
  anomaly_notification_service: null,
};
const ZONE_KEYS = Object.keys(NEW_ZONE);

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v, digits = 1) => Number(v).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const deg = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? "—" : `${num(v)} °C`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const list = (v) => [].concat(v ?? []).filter((x) => x !== null && x !== "");
const sameSet = (a, b) => { const x = list(a).sort(); const y = list(b).sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };
const zoneName = (z) => { const n = z?.name || z?.id || "?"; return n.length <= 3 ? n.toUpperCase() : n.charAt(0).toUpperCase() + n.slice(1); };

class ClimateManagerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "installation";
    this._settings = null;
    this._error = null;
    this._season = null;      // season shown in the Programme tab
    this._edit = null;        // { season, original, values, zoneIds, dirty, diffLines, scheduled }
    this._zoneDrafts = {};    // zone_id | "new" -> draft
    this._houseDraft = null;
    this._eqEdit = null;      // equipment draft (id null = new)
    this._modeEdit = null;    // mode draft (id null = new)
    this._zoneOpen = null;    // zone id or "new" whose editor is open
    this._busy = false;
  }

  /* ------------------------------------------------------------ lifecycle */

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get("tab") === "zones" ? "installation" : params.get("tab");
      if (TABS.some(([id]) => id === tab)) this._tab = tab;
      this._focusZone = params.get("zone");
      if (this._focusZone) this._tab = "installation";
      this._load();
    }
    this.shadowRoot.querySelectorAll("ha-menu-button, ha-selector").forEach((el) => { el.hass = hass; });
  }
  set narrow(v) { this._narrow = v; const m = this.shadowRoot.querySelector("ha-menu-button"); if (m) m.narrow = v; }
  set panel(v) { this._panel = v; }
  set route(v) { this._route = v; }

  connectedCallback() {
    this._timer = setInterval(() => { if (!this._edit && !this._busy && !this._hasDrafts()) this._load(); }, 60000);
  }
  disconnectedCallback() { clearInterval(this._timer); }
  _hasDrafts() { return Object.keys(this._zoneDrafts).length > 0 || !!this._houseDraft || !!this._eqEdit || !!this._modeEdit; }

  async _load() {
    try {
      this._settings = await this._hass.callWS({ type: "climate_manager/settings" });
      this._error = null;
      if (this._focusZone && !this._zoneOpen) {
        const z = this._settings.zones.find((x) => [x.id, (x.name || "").toLowerCase()].includes(this._focusZone.toLowerCase()));
        if (z) this._zoneOpen = z.id;
      }
      if (!SEASONS[this._season]) this._season = SEASON_OF[this._activeMode()?.direction] || (SEASONS[this._settings.house.season] ? this._settings.house.season : "winter");
    } catch (err) {
      this._error = err?.message || String(err);
    }
    this._render();
  }

  async _ws(msg, okText) {
    this._busy = true; this._renderBusy();
    try {
      await this._hass.callWS(msg);
      if (okText) this._toast(okText);
      await new Promise((r) => setTimeout(r, 300));
      this._busy = false;
      await this._load();
      return true;
    } catch (err) {
      this._toast(`Erreur : ${err?.message || err}`);
      return false;
    } finally {
      this._busy = false; this._renderBusy();
    }
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  /* -------------------------------------------------------------- helpers */

  _name(entityId) { return this._hass?.states?.[entityId]?.attributes?.friendly_name || entityId; }
  _zone(id) { return this._settings.zones.find((z) => z.id === id); }
  _equipment(id) { return this._settings.equipments.find((e) => e.id === id); }
  _activeMode() { return this._settings.modes.find((m) => m.id === this._settings.active_mode) || null; }
  /** Central equipment first (they serve the most zones), then by name. */
  _equipments() {
    return [...this._settings.equipments].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "central" ? -1 : 1));
  }
  _eqIcon(e) { return e.kind === "central" ? (e.cool && !e.heat ? "mdi:snowflake" : "mdi:water-boiler") : "mdi:air-conditioner"; }
  _eqDoes(e) { return e.heat && e.cool ? "chaud et froid" : e.heat ? "chaud" : "froid"; }
  _modeIcon(m) { return m.icon || (m.direction === "cool" ? "mdi:snowflake" : "mdi:fire"); }

  /** Presence of the house: saved, or inferred from the existing profiles. */
  _presence() {
    const h = this._settings.house;
    if (h.presence_entity) return { entity: h.presence_entity, away: list(h.presence_absent_states), home: list(h.presence_home_states), inferred: false };
    const counts = {}; const away = new Set(); const home = new Set();
    for (const z of this._settings.zones) for (const bank of Object.values(z.profile_banks)) for (const p of bank) {
      if (!p.presence_entity) continue;
      counts[p.presence_entity] = (counts[p.presence_entity] || 0) + 1;
      const states = list(p.presence_required_state);
      states.forEach((s) => (states.every((x) => AWAY_HINTS.includes(x)) ? away : home).add(s));
    }
    const entity = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    return { entity, away: [...away], home: [...home], inferred: !!entity };
  }

  _occupancy(p) {
    if (!p.presence_entity) return "any";
    const pres = this._presence();
    const states = list(p.presence_required_state);
    if (p.presence_entity === pres.entity) {
      if (sameSet(states, pres.away)) return "away";
      if (sameSet(states, pres.home)) return "home";
    }
    return "custom";
  }
  _occupancyLabel(p) {
    const o = this._occupancy(p);
    if (o !== "custom") return OCCUPANCY.find(([k]) => k === o)[1];
    return `${this._name(p.presence_entity)} : ${list(p.presence_required_state).map((s) => STATE_LABELS[s] || s).join(" ou ")}`;
  }
  _hour(t) { const [h, m] = String(t).split(":"); return m === "00" ? `${Number(h)} h` : `${Number(h)} h ${m}`; }
  _whenLabel(p) {
    if (!p.active_from || !p.active_to || p.active_from === p.active_to) return "Toute la journée";
    return `${this._hour(p.active_from)} → ${this._hour(p.active_to)}`;
  }
  _tempLabel(p, season) {
    return `${SEASONS[season].mode === "heat" ? "chauffe sous" : "refroidit dès"} ${deg(p.seuil_demarrage)}, jusqu'à ${deg(p.target)}`;
  }

  /** Profiles of a season merged by name across zones, in priority order. */
  _rows(season) {
    const rows = [];
    for (const z of this._settings.zones) {
      (z.profile_banks[season] || []).forEach((p, idx) => {
        let row = rows.find((r) => r.name === p.name);
        if (!row) { row = { name: p.name, order: idx, zones: {} }; rows.push(row); }
        row.order = Math.min(row.order, idx);
        row.zones[z.id] = p;
      });
    }
    return rows.sort((a, b) => a.order - b.order);
  }
  _rowDiffs(row) {
    const ids = Object.keys(row.zones);
    if (ids.length < 2) return [];
    const keys = ["active_from", "active_to", "presence_entity", "presence_required_state", "seuil_demarrage", "target", "target_cutoff", "power", "fan_intensity", "kickstart_minutes"];
    const ref = row.zones[ids[0]];
    const differs = keys.filter((k) => ids.some((id) => JSON.stringify(row.zones[id][k] ?? null) !== JSON.stringify(ref[k] ?? null)));
    if (!differs.length) return [];
    const label = (p) => {
      const parts = [];
      if (differs.some((k) => k.startsWith("active"))) parts.push(this._whenLabel(p));
      if (differs.some((k) => k.startsWith("presence"))) parts.push(this._occupancyLabel(p));
      if (differs.some((k) => ["seuil_demarrage", "target", "target_cutoff"].includes(k))) parts.push(`${deg(p.seuil_demarrage)} → ${deg(p.target)}`);
      if (differs.includes("power")) parts.push(`puissance ${(POWER.find(([v]) => v === p.power) || [0, p.power])[1].toLowerCase()}`);
      if (differs.includes("fan_intensity")) parts.push(`ventilation ${(FAN.find(([v]) => v === p.fan_intensity) || [0, p.fan_intensity])[1].toLowerCase()}`);
      if (differs.includes("kickstart_minutes")) parts.push(Number(p.kickstart_minutes) ? `démarrage renforcé ${p.kickstart_minutes} min` : "sans démarrage renforcé");
      return parts.join(", ");
    };
    return ids.map((id) => ({ zone: zoneName(this._zone(id)), text: label(row.zones[id]), temps: differs.some((k) => ["seuil_demarrage", "target"].includes(k)) }));
  }

  /* --------------------------------------------------------------- render */

  _render() {
    const root = this.shadowRoot;
    root.innerHTML = `<style>${STYLES}</style>
      <div class="toolbar">
        <div class="start"><ha-menu-button></ha-menu-button><div class="title">Climat</div></div>
        <div class="pills tabs">
          ${TABS
            .map(([id, icon, label]) => `<button class="${this._tab === id ? "on" : ""}" data-tab="${id}"><ha-icon icon="${icon}"></ha-icon>${label}</button>`).join("")}
        </div>
        <div class="busy" data-busy>${this._busy ? "Enregistrement…" : ""}</div>
      </div>
      <div class="page">
        ${this._renderBody()}
      </div>`;
    const menu = root.querySelector("ha-menu-button");
    if (menu) { menu.hass = this._hass; menu.narrow = this._narrow; }
    this._mountSelectors();
    this._wire();
  }
  _renderBusy() {
    const el = this.shadowRoot.querySelector("[data-busy]");
    if (el) el.textContent = this._busy ? "Enregistrement…" : "";
    this.shadowRoot.querySelectorAll("[data-primary]").forEach((b) => { b.disabled = this._busy || b.dataset.disabled === "1"; });
  }

  _renderBody() {
    if (this._error) return `<div class="card"><div class="empty-note danger-text">Climate Manager ne répond pas : ${esc(this._error)}</div></div>`;
    if (!this._settings) return `<div class="card"><div class="empty-note">Chargement…</div></div>`;
    if (this._tab === "installation") return this._renderInstallation();
    if (this._tab === "modes") return this._renderModes();
    if (this._tab === "maison") return this._renderHouse();
    return this._renderProgramme();
  }

  _cardHead(icon, title, right = "") {
    return `<div class="card-head"><div class="bubble"><ha-icon icon="${icon}"></ha-icon></div><div class="card-title">${title}</div>${right}</div>`;
  }

  /* ------------------------------------------------------------ programme */

  _renderProgramme() {
    const s = this._settings;
    if (!s.zones.length) {
      return `<div class="card">${this._cardHead("mdi:calendar-clock", "Programme")}
        <div class="empty-note">Déclare d'abord tes pièces et tes équipements dans l'onglet Installation.</div>
        <div class="card-foot"><span class="spacer"></span><button class="btn accent" data-tab="installation">Installation</button></div></div>`;
    }
    const mode = this._activeMode();
    const inService = mode ? SEASON_OF[mode.direction] : null;
    const season = this._season;
    const rows = this._rows(season);
    const seasonPills = `<div class="pills small">${Object.entries(SEASONS).map(([k, v]) =>
      `<button data-view-season="${k}" class="${season === k ? "on" : ""}"><ha-icon icon="${v.icon}"></ha-icon>${v.label}${inService === k ? '<span class="dot" title="Actif"></span>' : ""}</button>`).join("")}</div>`;
    const banner = inService === season
      ? `<div class="note"><ha-icon icon="${this._modeIcon(mode)}"></ha-icon><span>Mode <b>${esc(mode.name)}</b> actif : ces profils décident quand ${SEASONS[season].mode === "heat" ? "chauffer" : "refroidir"} chaque zone (${esc(this._modeChain(mode))}).</span></div>`
      : `<div class="note muted"><ha-icon icon="mdi:pause-circle-outline"></ha-icon><span>${mode ? `Mode <b>${esc(mode.name)}</b> actif : ` : "Aucun mode actif : "}ces profils attendent un mode de ${SEASONS[season].label.toLowerCase()}.</span>
        <button class="btn small" data-tab="modes">Modes</button></div>`;
    const running = {};
    if (inService === season) for (const z of s.zones) if (z.live?.active_profile_name) (running[z.live.active_profile_name] ||= []).push(zoneName(z));
    const body = rows.map((row, i) => this._renderRow(row, i, season, running[row.name])).join("");
    const adding = this._edit && this._edit.season === season && this._edit.original === null;
    return `<div class="card accent-${SEASONS[season].accent}">
      ${this._cardHead("mdi:calendar-clock", "Programme", seasonPills)}
      ${banner}
      <div class="hint">De haut en bas : le premier profil dont l'horaire et la présence correspondent s'applique.</div>
      <div class="rows">${body || '<div class="empty-note">Aucun profil : la climatisation ne démarre jamais seule.</div>'}
        ${adding ? `<div class="row open"><div class="row-head static"><span class="rank">+</span><span class="row-main"><span class="row-title">Nouveau profil</span></span></div>${this._renderEditor()}</div>`
          : `<button class="add-row" data-add-profile="${season}"><ha-icon icon="mdi:plus"></ha-icon>Ajouter un profil</button>`}
      </div>
    </div>`;
  }

  _renderRow(row, index, season, runningZones) {
    const ref = Object.values(row.zones)[0];
    const zoneIds = Object.keys(row.zones);
    const allZones = zoneIds.length === this._settings.zones.length;
    const open = this._edit && this._edit.season === season && this._edit.original === row.name;
    const diffs = this._rowDiffs(row);
    return `<div class="row ${open ? "open" : ""} ${runningZones ? "running" : ""}">
      <button class="row-head" data-edit-profile="${esc(row.name)}">
        <span class="rank">${index + 1}</span>
        <span class="row-main">
          <span class="row-title">${esc(row.name)}
            ${runningZones ? `<span class="badge">En cours · ${esc(runningZones.join(", "))}</span>` : ""}
            ${allZones ? "" : `<span class="tag">${esc(zoneIds.map((id) => zoneName(this._zone(id))).join(", "))} seulement</span>`}</span>
          <span class="row-meta">
            <span><ha-icon icon="mdi:clock-outline"></ha-icon>${esc(this._whenLabel(ref))}</span>
            <span><ha-icon icon="mdi:home-outline"></ha-icon>${esc(this._occupancyLabel(ref))}</span>
            <span><ha-icon icon="mdi:thermometer"></ha-icon>${esc(diffs.some((d) => d.temps) ? "selon la zone" : this._tempLabel(ref, season))}</span>
          </span>
        </span>
        <ha-icon class="chev" icon="${open ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon>
      </button>
      ${open ? this._renderEditor() : ""}
    </div>`;
  }

  /* --------------------------------------------------------------- editor */

  _openEditor(season, name) {
    if (this._edit && this._edit.season === season && this._edit.original === name) { this._edit = null; this._render(); return; }
    const zones = this._settings.zones;
    const row = name !== null ? this._rows(season).find((r) => r.name === name) : null;
    const heat = SEASONS[season].mode === "heat";
    const values = row ? clone(Object.values(row.zones)[0]) : {
      name: "", mode: SEASONS[season].mode, active_from: null, active_to: null, presence_entity: null,
      presence_required_state: null, seuil_demarrage: heat ? 19 : 27, target: heat ? 20 : 25,
      target_cutoff: null, power: "normal", fan_intensity: "normal", kickstart_minutes: 0,
    };
    this._edit = {
      season, original: row ? row.name : null, values,
      zoneIds: row ? Object.keys(row.zones) : zones.map((z) => z.id),
      dirty: new Set(row ? [] : Object.keys(values)),
      diffLines: row ? this._rowDiffs(row) : [],
      scheduled: !!(values.active_from && values.active_to),
    };
    this._render();
    this.shadowRoot.querySelector(".row.open")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  _stepper(field, value, { step = 0.5, min = 5, max = 35, unit = "°C", digits = 1, optional = false } = {}) {
    if (optional && (value === null || value === undefined)) {
      return `<button class="stepper off" data-enable="${field}"><ha-icon icon="mdi:plus"></ha-icon>Définir</button>`;
    }
    return `<div class="stepper" data-stepper="${field}" data-step="${step}" data-min="${min}" data-max="${max}" data-digits="${digits}">
      <button data-dir="-1" aria-label="Moins"><ha-icon icon="mdi:minus"></ha-icon></button>
      <span class="value"><b>${digits ? num(value, digits) : value}</b>${unit}</span>
      <button data-dir="1" aria-label="Plus"><ha-icon icon="mdi:plus"></ha-icon></button>
      ${optional ? `<button class="clear" data-clear="${field}" aria-label="Retirer"><ha-icon icon="mdi:close"></ha-icon></button>` : ""}
    </div>`;
  }

  _choice(field, options, current, { multi = false } = {}) {
    return `<div class="pills small" data-choice="${field}">${options.map(([v, l]) =>
      `<button data-val="${esc(v)}" class="${(multi ? current.includes(v) : current === v) ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`;
  }

  _field(label, control, help = "") {
    return `<div class="f"><div class="f-label">${label}</div><div class="f-control">${control}${help ? `<div class="f-help">${help}</div>` : ""}</div></div>`;
  }

  _renderEditor() {
    const e = this._edit; const v = e.values;
    const heat = SEASONS[e.season].mode === "heat";
    const occ = this._occupancy(v);
    const pres = this._presence();
    const zones = this._settings.zones;
    return `<div class="editor">
      ${e.diffLines.length ? `<div class="note muted"><ha-icon icon="mdi:call-split"></ha-icon><span>Ce profil diffère selon la zone :<br>${e.diffLines.map((d) => `<b>${esc(d.zone)}</b> ${esc(d.text)}`).join("<br>")}<br>Les valeurs ci-dessous sont celles de ${esc(zoneName(this._zone(e.zoneIds[0])))} ; seuls les réglages que tu changes s'appliquent à toutes les zones.</span></div>` : ""}
      <div class="group">
        ${this._field("Nom", `<input class="text" data-text="name" value="${esc(v.name)}" placeholder="Présent, Nuit, Absent…" maxlength="40">`)}
        ${this._field("Quand", `${this._choice("schedule", [["all", "Toute la journée"], ["range", "Plage horaire"]], e.scheduled ? "range" : "all")}
          ${e.scheduled ? `<div class="times"><span>de</span><input type="time" class="text time" data-time="active_from" value="${esc(v.active_from || "")}"><span>à</span><input type="time" class="text time" data-time="active_to" value="${esc(v.active_to || "")}"></div>` : ""}`)}
        ${this._field("Présence", this._choice("occupancy", OCCUPANCY, occ),
          occ === "custom" ? `Condition actuelle : ${esc(this._occupancyLabel(v))}` : (pres.entity ? "" : "Règle d'abord la présence dans l'onglet Maison."))}
      </div>
      <div class="group">
        <div class="group-title">Températures</div>
        ${this._field(`Démarre ${heat ? "sous" : "au-dessus de"}`, this._stepper("seuil_demarrage", v.seuil_demarrage))}
        ${this._field("Vise", this._stepper("target", v.target))}
        ${this._field("Coupe à", this._stepper("target_cutoff", v.target_cutoff, { optional: true }), "Facultatif : arrête le chauffage ou le froid à cette température.")}
      </div>
      <div class="group">
        <div class="group-title">Climatisations</div>
        ${this._field("Puissance", this._choice("power", POWER, v.power || "normal"))}
        ${this._field("Ventilation", this._choice("fan_intensity", FAN, v.fan_intensity || "normal"))}
        ${this._field("Démarrage renforcé", this._stepper("kickstart_minutes", Number(v.kickstart_minutes) || 0, { step: 5, min: 0, max: 60, unit: "min", digits: 0 }), "Pleine puissance au début de la session. 0 = désactivé.")}
      </div>
      ${zones.length > 1 ? `<div class="group">${this._field("Zones", this._choice("zones", zones.map((z) => [z.id, zoneName(z)]), e.zoneIds, { multi: true }))}</div>` : ""}
      <div class="editor-foot">
        ${e.original ? `<button class="btn plain danger" data-delete-profile><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer</button>
          <button class="icon-btn" data-move="-1" title="Monter (plus prioritaire)"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="icon-btn" data-move="1" title="Descendre (moins prioritaire)"><ha-icon icon="mdi:arrow-down"></ha-icon></button>` : ""}
        <span class="spacer"></span>
        <button class="btn plain" data-cancel-edit>Annuler</button>
        <button class="btn accent" data-primary data-save-profile>Enregistrer</button>
      </div>
    </div>`;
  }

  _setValue(fieldName, value) {
    this._edit.values[fieldName] = value;
    this._edit.dirty.add(fieldName);
  }

  _bankPayload(season, transform) {
    const banks = {};
    for (const z of this._settings.zones) banks[z.id] = clone(z.profile_banks[season] || []);
    transform(banks);
    return { type: "climate_manager/profiles/save", season, banks };
  }

  async _saveProfile() {
    const e = this._edit; const v = e.values;
    const name = String(v.name || "").trim();
    if (!name) return this._toast("Donne un nom au profil.");
    if (!e.zoneIds.length) return this._toast("Choisis au moins une zone.");
    if (e.scheduled && (!v.active_from || !v.active_to)) return this._toast("Indique le début et la fin de la plage horaire.");
    if (e.original !== name && this._rows(e.season).some((r) => r.name === name)) return this._toast(`Un profil « ${name} » existe déjà.`);
    if (!e.scheduled) { this._setValue("active_from", null); this._setValue("active_to", null); }
    const order = this._rows(e.season).findIndex((r) => r.name === e.original);
    const msg = this._bankPayload(e.season, (banks) => {
      for (const zone of this._settings.zones) {
        const items = banks[zone.id];
        const idx = e.original ? items.findIndex((p) => p.name === e.original) : -1;
        if (!e.zoneIds.includes(zone.id)) { if (idx >= 0) items.splice(idx, 1); continue; }
        const next = idx >= 0 ? { ...items[idx] } : clone(v);
        for (const f of e.dirty) next[f] = v[f];
        next.name = name; next.mode = SEASONS[e.season].mode;
        if (idx >= 0) items[idx] = next;
        else items.splice(order >= 0 ? Math.min(order, items.length) : items.length, 0, next);
      }
    });
    if (await this._ws(msg, "Profil enregistré")) { this._edit = null; this._render(); }
  }

  async _deleteProfile() {
    const e = this._edit;
    if (!confirm(`Supprimer le profil « ${e.original} » ?`)) return;
    const msg = this._bankPayload(e.season, (banks) => { for (const id of Object.keys(banks)) banks[id] = banks[id].filter((p) => p.name !== e.original); });
    if (await this._ws(msg, "Profil supprimé")) { this._edit = null; this._render(); }
  }

  async _moveProfile(delta) {
    const e = this._edit;
    const names = this._rows(e.season).map((r) => r.name);
    const i = names.indexOf(e.original); const j = i + delta;
    if (i < 0 || j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    const msg = this._bankPayload(e.season, (banks) => { for (const id of Object.keys(banks)) banks[id].sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name)); });
    if (await this._ws(msg)) { this._edit = e; this._render(); }
  }

  /* --------------------------------------------------------- installation */

  _renderInstallation() {
    const s = this._settings;
    const eqs = this._equipments();
    const zones = s.zones;
    const head = eqs.map((e) => {
      const accent = e.heat && !e.cool ? "warm" : !e.heat && e.cool ? "cool" : "both";
      return `<th><button class="eq-head ${e.enabled === false ? "out" : accent}" data-edit-eq="${e.id}" title="Modifier">
        <span class="eq-bubble"><ha-icon icon="${this._eqIcon(e)}"></ha-icon>${e.running ? '<span class="live-dot"></span>' : ""}</span>
        <span class="eq-name">${esc(e.name)}</span><span class="eq-sub">${e.enabled === false ? "Hors service" : this._eqDoes(e)}</span></button></th>`;
    }).join("");
    const rows = zones.map((z) => `<tr>
      <th class="zone-head"><button data-open-zone="${z.id}"><span>${esc(zoneName(z))}</span><small>${deg(z.live?.room_temperature)}</small></button></th>
      ${eqs.map((e) => {
        const on = e.zones.includes(z.id);
        const accent = e.enabled === false ? "out" : e.heat && !e.cool ? "warm" : !e.heat && e.cool ? "cool" : "both";
        return `<td><button class="cell ${on ? `on ${accent}` : ""}" data-toggle-cover="${e.id}|${z.id}" title="${on ? "Dessert" : "Ne dessert pas"} ${esc(zoneName(z))}">
          ${on ? '<ha-icon icon="mdi:check"></ha-icon>' : ""}</button></td>`;
      }).join("")}
    </tr>`).join("");
    const shared = eqs.filter((e) => e.zones.length > 1).map((e) => e.zones.length === zones.length ? `${esc(e.name)} dessert toute la maison` : `${esc(e.name)} dessert ${e.zones.length} zones`);
    const matrix = eqs.length && zones.length
      ? `<div class="matrix-wrap"><table class="matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
        <div class="hint">Une case cochée : l'équipement chauffe ou refroidit cette zone.${shared.length ? ` ${shared.join(" · ")}.` : ""}</div>`
      : `<div class="empty-note">${zones.length ? "Ajoute tes équipements : chaudière, climatisations…" : "Commence par tes zones (pièces ou étages), puis tes équipements."}</div>`;
    return `<div class="card">
        ${this._cardHead("mdi:home-lightning-bolt-outline", "Qui dessert quoi")}
        ${matrix}
      </div>
      <div class="card">
        ${this._cardHead("mdi:water-boiler", "Équipements", `<span class="head-meta">${eqs.length}</span>`)}
        <div class="rows">${eqs.map((e) => this._renderEqRow(e)).join("")}
          ${this._eqEdit && !this._eqEdit.id ? `<div class="row open"><div class="row-head static"><span class="row-icon"><ha-icon icon="mdi:plus"></ha-icon></span><span class="row-main"><span class="row-title">Nouvel équipement</span></span></div>${this._renderEqEditor()}</div>`
            : '<button class="add-row" data-add-eq><ha-icon icon="mdi:plus"></ha-icon>Ajouter un équipement</button>'}
        </div>
      </div>
      <div class="card">
        ${this._cardHead("mdi:floor-plan", "Zones", `<span class="head-meta">${zones.length}</span>`)}
        <div class="rows">${zones.map((z) => this._renderZoneRow(z)).join("")}
          ${this._zoneOpen === "new" ? `<div class="row open"><div class="row-head static"><span class="row-icon"><ha-icon icon="mdi:plus"></ha-icon></span><span class="row-main"><span class="row-title">Nouvelle zone</span></span></div>${this._renderZoneEditor("new")}</div>`
            : '<button class="add-row" data-add-zone><ha-icon icon="mdi:plus"></ha-icon>Ajouter une zone</button>'}
        </div>
      </div>`;
  }

  _renderEqRow(e) {
    const open = this._eqEdit && this._eqEdit.id === e.id;
    const zones = this._settings.zones;
    const where = e.zones.length === zones.length && zones.length > 1 ? "toute la maison" : e.zones.map((id) => zoneName(this._zone(id))).join(", ") || "aucune zone";
    const accent = e.heat && !e.cool ? "warm" : !e.heat && e.cool ? "cool" : "both";
    const inService = e.enabled !== false;
    return `<div class="row ${open ? "open" : ""} ${inService ? "" : "out"}">
      <div class="row-head">
        <button class="row-hit" data-edit-eq="${e.id}">
          <span class="row-icon ${inService ? accent : ""}"><ha-icon icon="${this._eqIcon(e)}"></ha-icon></span>
          <span class="row-main"><span class="row-title">${esc(e.name)}${!inService ? '<span class="badge">Hors service</span>' : e.running ? '<span class="badge ok">En marche</span>' : ""}</span>
            <span class="row-meta"><span>${KINDS[e.kind].label}</span><span>${this._eqDoes(e)}</span><span><ha-icon icon="mdi:floor-plan"></ha-icon>${esc(where)}</span></span></span>
        </button>
        <button class="svc-switch" role="switch" aria-checked="${inService}" data-enable-eq="${e.id}" title="${inService ? "En service : Climate Manager peut le démarrer" : "Hors service : Climate Manager n'y touche pas"}"><i></i></button>
        <button class="icon-btn flat" data-edit-eq="${e.id}" aria-label="Modifier"><ha-icon icon="${open ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon></button>
      </div>
      ${open ? this._renderEqEditor() : ""}
    </div>`;
  }

  _openEq(id) {
    if (this._eqEdit && this._eqEdit.id === id) { this._eqEdit = null; this._render(); return; }
    this._eqEdit = id ? clone(this._equipment(id)) : clone(NEW_EQUIPMENT);
    if (!id && this._settings.zones.length) this._eqEdit.zones = this._settings.zones.map((z) => z.id);
    this._render();
    this.shadowRoot.querySelector(".row.open")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  _renderEqEditor() {
    const e = this._eqEdit;
    const central = e.kind === "central";
    const domain = e.entity ? e.entity.split(".")[0] : null;
    const options = e.entity && ["select", "input_select"].includes(domain) ? list(this._hass.states[e.entity]?.attributes?.options) : [];
    const zones = this._settings.zones;
    return `<div class="editor">
      <div class="group">
        ${this._field("Nom", `<input class="text" data-eq-text="name" value="${esc(e.name)}" maxlength="40" placeholder="Chaudière, Clim salon…">`)}
        ${this._field("Type", this._choice("eq-kind", Object.entries(KINDS).map(([k, v]) => [k, v.label]), e.kind), KINDS[e.kind].help)}
        ${this._field("Produit", this._choice("eq-does", [["heat", "Chaud"], ["cool", "Froid"]], [e.heat && "heat", e.cool && "cool"].filter(Boolean), { multi: true }))}
        ${this._field(central ? "Commande" : "Climatisation", `<div class="sel" data-selector="eq|entity"></div>`, central ? "Ce que Climate Manager actionne : mode de la chaudière, interrupteur, thermostat." : "")}
        ${central && options.length ? `${this._field("Marche", this._choice("eq-on", options.map((o) => [o, o]), e.on_option))}
          ${this._field("Arrêt", this._choice("eq-off", options.map((o) => [o, o]), e.off_option))}` : ""}
        ${this._field("Zones", this._choice("eq-zones", zones.map((z) => [z.id, zoneName(z)]), e.zones, { multi: true }), central ? "Il tourne tant qu'une de ces zones le demande." : "Une climatisation dessert une seule zone.")}
      </div>
      <div class="group">
        <div class="group-title">Consommation</div>
        ${this._field("Compteurs", `<div class="sel" data-selector="eq|energy_sensors"></div>`, central ? "Compteur d'énergie de la chaudière (kWh), par exemple celui que donne l'eBUS." : "Compteurs d'énergie de la climatisation (kWh) ; s'il y en a un pour le chaud et un pour le froid, mets les deux.")}
        ${this._field("Énergie", this._choice("eq-energy", ENERGIES, e.energy || (central ? "gas" : "electricity")))}
        ${this._field("Tarif", this._stepper("eq:energy_price", Number(e.energy_price ?? DEFAULT_PRICE[e.energy] ?? 0.2), { step: 0.005, min: 0, max: 2, unit: "€/kWh", digits: 3 }), "Sert à estimer le coût de chaque session.")}
      </div>
      ${central ? `<details class="group advanced" ${e.setpoint_entity || e.running_entity ? "open" : ""}>
        <summary>Réglages avancés</summary>
        ${this._field("Consigne", `<div class="sel" data-selector="eq|setpoint_entity"></div>`, "Facultatif : reçoit la température la plus haute demandée par ses zones.")}
        ${e.setpoint_entity ? this._field("Écart de consigne", this._stepper("eq:setpoint_offset", Number(e.setpoint_offset ?? 1), { step: 0.5, min: 0, max: 5 }), "Ajouté à la consigne pour qu'il ne coupe pas avant la zone.") : ""}
        ${this._field("En marche quand", `<div class="sel" data-selector="eq|running_entity"></div>`, "Facultatif : flamme ou état de marche, pour afficher quand il produit vraiment.")}
      </details>` : ""}
      <div class="editor-foot">
        ${e.id ? '<button class="btn plain danger" data-delete-eq><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer</button>' : ""}
        <span class="spacer"></span>
        <button class="btn plain" data-cancel-eq>Annuler</button>
        <button class="btn accent" data-primary data-save-eq>Enregistrer</button>
      </div>
    </div>`;
  }

  _eqSelector(field) {
    const e = this._eqEdit;
    if (field === "entity") {
      return e.kind === "central"
        ? { entity: { filter: ["select", "input_select", "switch", "input_boolean", "climate", "water_heater"].map((domain) => ({ domain })) } }
        : { entity: { filter: { domain: "climate" } } };
    }
    if (field === "energy_sensors") return { entity: { multiple: true, filter: { domain: "sensor", device_class: "energy" } } };
    if (field === "setpoint_entity") return { entity: { filter: [{ domain: "number" }, { domain: "input_number" }] } };
    return { entity: { filter: [{ domain: "binary_sensor" }, { domain: "switch" }, { domain: "input_boolean" }] } };
  }

  async _saveEq() {
    const e = this._eqEdit;
    if (!String(e.name || "").trim()) return this._toast("Donne un nom à l'équipement.");
    if (!e.entity) return this._toast("Choisis ce que Climate Manager actionne.");
    if (!e.heat && !e.cool) return this._toast("Indique s'il produit du chaud, du froid ou les deux.");
    const domain = e.entity.split(".")[0];
    if (e.kind === "central" && ["select", "input_select"].includes(domain) && (!e.on_option || !e.off_option)) return this._toast("Choisis l'option de marche et celle d'arrêt.");
    if (e.kind === "heat_pump" && e.zones.length > 1) e.zones = e.zones.slice(0, 1);
    const ok = await this._ws({ type: "climate_manager/equipment/save", equipment: e }, "Équipement enregistré");
    if (ok) { this._eqEdit = null; this._render(); }
  }

  async _toggleCover(eqId, zoneId) {
    const e = clone(this._equipment(eqId));
    const on = e.zones.includes(zoneId);
    e.zones = on ? e.zones.filter((z) => z !== zoneId) : e.kind === "heat_pump" ? [zoneId] : [...e.zones, zoneId];
    await this._ws({ type: "climate_manager/equipment/save", equipment: e });
  }

  /* ---------------------------------------------------------------- modes */

  _modeChain(m) {
    const names = m.equipments.map((id) => this._equipment(id)?.name).filter(Boolean);
    if (!names.length) return "aucun équipement";
    const and = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} et ${xs[xs.length - 1]}` : xs[0]);
    if (m.relation === "combined") return names.join(" + ");
    if (m.relation === "additive") return `${names[0]}${names.length > 1 ? `, avec ${and(names.slice(1))} en appoint` : ""}`;
    // Exclusive: a fallback only exists where two equipments serve the same zone.
    const eqs = m.equipments.map((id) => this._equipment(id)).filter(Boolean);
    const shared = eqs.some((e, i) => eqs.slice(i + 1).some((o) => o.zones.some((z) => e.zones.includes(z))));
    return shared ? `${names[0]}, sinon ${names.slice(1).join(", ")}` : and(names);
  }

  _renderModes() {
    const s = this._settings;
    const active = this._activeMode();
    const rows = s.modes.map((m, i) => this._renderModeRow(m, i)).join("");
    const off = `<div class="row ${!active ? "running" : ""}"><div class="row-head static">
        <span class="row-icon"><ha-icon icon="mdi:power"></ha-icon></span>
        <span class="row-main"><span class="row-title">Arrêt${!active ? '<span class="badge">Actif</span>' : ""}</span>
          <span class="row-meta"><span>Rien ne démarre seul. Le pilotage à la main reste possible.</span></span></span>
        ${active ? '<button class="btn small" data-set-mode="">Activer</button>' : ""}
        <span class="icon-btn flat ghost"></span>
      </div></div>`;
    return `<div class="card">
      ${this._cardHead("mdi:tune-variant", "Modes de fonctionnement")}
      <div class="hint">Un mode dit quels appareils ont le droit de tourner, pour chauffer ou pour refroidir (jamais les deux). Un seul est actif à la fois, « Arrêt » coupe tout ; le programme, lui, dit quelle température tu veux. Un appareil mis hors service (onglet Installation ou tableau de bord) est sauté : le mode passe au suivant. Change de mode ici, depuis le tableau de bord ou par une automatisation.</div>
      <div class="rows">${rows}${off}
        ${this._modeEdit && !this._modeEdit.id ? `<div class="row open"><div class="row-head static"><span class="row-icon"><ha-icon icon="mdi:plus"></ha-icon></span><span class="row-main"><span class="row-title">Nouveau mode</span></span></div>${this._renderModeEditor()}</div>`
          : '<button class="add-row" data-add-mode><ha-icon icon="mdi:plus"></ha-icon>Ajouter un mode</button>'}
      </div>
    </div>`;
  }

  _renderModeRow(m) {
    const open = this._modeEdit && this._modeEdit.id === m.id;
    const isActive = this._settings.active_mode === m.id;
    const accent = m.direction === "cool" ? "cool" : "warm";
    return `<div class="row ${open ? "open" : ""} ${isActive ? "running" : ""}">
      <div class="row-head">
        <button class="row-hit" data-edit-mode="${m.id}">
          <span class="row-icon ${accent}"><ha-icon icon="${this._modeIcon(m)}"></ha-icon></span>
          <span class="row-main"><span class="row-title">${esc(m.name)}${isActive ? '<span class="badge">Actif</span>' : ""}</span>
            <span class="row-meta"><span><ha-icon icon="${m.direction === "cool" ? "mdi:snowflake" : "mdi:fire"}"></ha-icon>${m.direction === "cool" ? "Refroidit" : "Chauffe"}</span><span>${esc(this._modeChain(m))}</span></span></span>
        </button>
        ${isActive ? "" : `<button class="btn small" data-set-mode="${m.id}">Activer</button>`}
        <button class="icon-btn flat" data-edit-mode="${m.id}" aria-label="Modifier"><ha-icon icon="${open ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon></button>
      </div>
      ${open ? this._renderModeEditor() : ""}
    </div>`;
  }

  _openMode(id) {
    if (this._modeEdit && this._modeEdit.id === id) { this._modeEdit = null; this._render(); return; }
    this._modeEdit = id ? clone(this._settings.modes.find((m) => m.id === id)) : clone(NEW_MODE);
    this._render();
    this.shadowRoot.querySelector(".row.open")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  _renderModeEditor() {
    const m = this._modeEdit;
    const eligible = this._equipments().filter((e) => (m.direction === "cool" ? e.cool : e.heat));
    const chosen = m.equipments.filter((id) => eligible.some((e) => e.id === id));
    const others = eligible.filter((e) => !chosen.includes(e.id));
    const zones = this._settings.zones;
    const eqLine = (e, rank) => `<div class="eq-line ${rank ? "on" : ""}">
        <button class="check" data-mode-eq="${e.id}" aria-label="${rank ? "Retirer" : "Ajouter"}">${rank ? `<b>${rank}</b>` : '<ha-icon icon="mdi:plus"></ha-icon>'}</button>
        <ha-icon class="eq-ico" icon="${this._eqIcon(e)}"></ha-icon>
        <span class="eq-line-main"><b>${esc(e.name)}</b><small>${e.zones.length === zones.length && zones.length > 1 ? "toute la maison" : esc(e.zones.map((id) => zoneName(this._zone(id))).join(", "))}</small></span>
        ${rank ? `<button class="icon-btn flat" data-mode-eq-move="${e.id}|-1" aria-label="Monter" ${rank === 1 ? "disabled" : ""}><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="icon-btn flat" data-mode-eq-move="${e.id}|1" aria-label="Descendre" ${rank === chosen.length ? "disabled" : ""}><ha-icon icon="mdi:arrow-down"></ha-icon></button>` : ""}
      </div>`;
    const preview = zones.map((z) => {
      const here = chosen.map((id) => this._equipment(id)).filter((e) => e && e.zones.includes(z.id));
      const text = !here.length ? '<span class="danger-text">rien</span>'
        : m.relation === "combined" ? here.map((e) => esc(e.name)).join(" + ")
        : m.relation === "additive" ? `${esc(here[0].name)}${here.length > 1 ? ` <span class="muted">puis</span> ${here.slice(1).map((e) => esc(e.name)).join(" + ")}` : ""}`
        : `${esc(here[0].name)}${here.length > 1 ? ` <span class="muted">sinon</span> ${here.slice(1).map((e) => esc(e.name)).join(", ")}` : ""}`;
      return `<div class="preview-line"><span>${esc(zoneName(z))}</span><span>${text}</span></div>`;
    }).join("");
    return `<div class="editor">
      <div class="group">
        ${this._field("Nom", `<input class="text" data-mode-text="name" value="${esc(m.name)}" maxlength="40" placeholder="Chaudière, Mi-saison, Grand froid…">`)}
        ${this._field("Ce mode", this._choice("mode-direction", [["heat", "Chauffe"], ["cool", "Refroidit"]], m.direction), m.direction === "cool" ? "Il ne fait que du froid : une zone trop fraîche n'est pas chauffée." : "Il ne fait que du chaud : une zone trop chaude n'est pas refroidie.")}
        ${this._field("Équipements", `<div class="eq-lines">${chosen.map((id, i) => eqLine(this._equipment(id), i + 1)).join("")}${others.map((e) => eqLine(e, 0)).join("")}
          ${eligible.length ? "" : `<div class="f-help">Aucun équipement ne produit de ${m.direction === "cool" ? "froid" : "chaud"}.</div>`}</div>`, "Dans l'ordre : le premier passe avant les autres.")}
        ${this._field("Les appareils", this._choice("mode-relation", Object.entries(RELATIONS).map(([k, v]) => [k, v.label]), m.relation), RELATIONS[m.relation].help)}
        ${m.relation === "additive" ? `${this._field("Appoint si l'écart", this._stepper("mode:boost_gap", Number(m.boost_gap), { step: 0.5, min: 0.5, max: 5 }), "La zone est encore à cet écart de sa température…")}
          ${this._field("au bout de", this._stepper("mode:boost_delay_min", Number(m.boost_delay_min), { step: 5, min: 0, max: 240, unit: "min", digits: 0 }), "…ce temps. L'appoint s'arrête quand l'écart est divisé par deux.")}` : ""}
      </div>
      ${zones.length ? `<div class="group"><div class="group-title">Dans chaque zone</div>${preview}</div>` : ""}
      <div class="editor-foot">
        ${m.id ? '<button class="btn plain danger" data-delete-mode><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer</button>' : ""}
        ${m.id ? `<button class="icon-btn" data-move-mode="-1" title="Monter"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
          <button class="icon-btn" data-move-mode="1" title="Descendre"><ha-icon icon="mdi:arrow-down"></ha-icon></button>` : ""}
        <span class="spacer"></span>
        <button class="btn plain" data-cancel-mode>Annuler</button>
        <button class="btn accent" data-primary data-save-mode>Enregistrer</button>
      </div>
    </div>`;
  }

  async _saveMode() {
    const m = this._modeEdit;
    if (!String(m.name || "").trim()) return this._toast("Donne un nom au mode.");
    const eligible = this._settings.equipments.filter((e) => (m.direction === "cool" ? e.cool : e.heat)).map((e) => e.id);
    m.equipments = m.equipments.filter((id) => eligible.includes(id));
    if (!m.equipments.length) return this._toast("Choisis au moins un équipement.");
    m.icon = m.icon && m.icon !== (m.direction === "cool" ? "mdi:fire" : "mdi:snowflake") ? m.icon : null;
    const ok = await this._ws({ type: "climate_manager/mode/save", mode: m }, "Mode enregistré");
    if (ok) { this._modeEdit = null; this._render(); }
  }

  async _moveMode(delta) {
    const ids = this._settings.modes.map((m) => m.id);
    const i = ids.indexOf(this._modeEdit.id); const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const keep = this._modeEdit;
    if (await this._ws({ type: "climate_manager/mode/reorder", mode_ids: ids })) { this._modeEdit = keep; this._render(); }
  }

  /* ---------------------------------------------------------------- zones */

  _zoneDraft(key) {
    if (!this._zoneDrafts[key]) {
      const zone = key === "new" ? null : this._zone(key);
      this._zoneDrafts[key] = zone ? Object.fromEntries(ZONE_KEYS.map((k) => [k, clone(zone[k] ?? NEW_ZONE[k])])) : clone(NEW_ZONE);
    }
    return this._zoneDrafts[key];
  }
  _zoneDirty(key) {
    if (key === "new") return true;
    const zone = this._zone(key); const d = this._zoneDrafts[key];
    return !!d && ZONE_KEYS.some((k) => JSON.stringify(d[k] ?? null) !== JSON.stringify(zone[k] ?? null));
  }

  _renderZoneRow(z) {
    const open = this._zoneOpen === z.id;
    const live = z.live || {};
    const serving = this._equipments().filter((e) => e.zones.includes(z.id));
    return `<div class="row ${open ? "open" : ""}">
      <button class="row-head" data-open-zone="${z.id}">
        <span class="row-icon"><ha-icon icon="mdi:floor-plan"></ha-icon></span>
        <span class="row-main"><span class="row-title">${esc(zoneName(z))}</span>
          <span class="row-meta"><span><ha-icon icon="mdi:thermometer"></ha-icon>${list(z.temperature_sensors).length} capteur${list(z.temperature_sensors).length > 1 ? "s" : ""}</span>
          ${list(z.window_sensors).length ? `<span><ha-icon icon="mdi:window-closed-variant"></ha-icon>${list(z.window_sensors).length} fenêtre${list(z.window_sensors).length > 1 ? "s" : ""}</span>` : ""}
          <span><ha-icon icon="mdi:home-lightning-bolt-outline"></ha-icon>${serving.length ? esc(serving.map((e) => e.name).join(", ")) : "aucun équipement"}</span></span></span>
        <span class="row-temp">${deg(live.room_temperature)}</span>
        <ha-icon class="chev" icon="${open ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon>
      </button>
      ${open ? this._renderZoneEditor(z.id) : ""}
    </div>`;
  }

  _renderZoneEditor(key) {
    const zone = key === "new" ? null : this._zone(key);
    const d = this._zoneDrafts[key] || zone || NEW_ZONE;
    const dirty = this._zoneDirty(key);
    const live = zone?.live || {};
    const focus = zone && this._focusZone && [zone.id, (zone.name || "").toLowerCase()].includes(this._focusZone.toLowerCase());
    const sel = (label, field, help = "") => this._field(label, `<div class="sel" data-selector="${key}|${field}"></div>`, help);
    const stepper = (label, f, step, unit, min, max, digits, help = "") =>
      this._field(label, this._stepper(`zone:${key}:${f}`, Number(d[f] ?? NEW_ZONE[f]), { step, unit, min, max, digits }), help);
    void live; void focus;
    return `<div class="editor" data-zone-card="${key}">
      <div class="group">
        ${this._field("Nom", `<input class="text" data-zone-text="${key}|name" value="${esc(d.name)}" maxlength="40" placeholder="Salon, Étage…">`)}
        ${sel("Température", "temperature_sensors", "La zone prend la moyenne de ces capteurs.")}
        ${sel("Fenêtres", "window_sensors", "Une fenêtre ouverte arrête le chauffage ou le froid de la zone.")}
      </div>
      <details class="group advanced" ${key === "new" ? "open" : ""}>
        <summary>Réglages avancés</summary>
        ${stepper("Reprise auto après", "override_duree_min", 5, "min", 5, 240, 0, "Quand quelqu'un a réglé la climatisation à la main.")}
        ${stepper("Contrôle d'efficacité après", "anomaly_delay_min", 5, "min", 15, 180, 0, "Vérifie ensuite que la pièce gagne bien en température.")}
        ${stepper("Gain minimum en chauffage", "anomaly_heat_gain_per_hour", 0.1, "°C/h", 0, 5, 1)}
        ${stepper("Gain minimum en froid", "anomaly_cool_gain_per_hour", 0.1, "°C/h", 0, 5, 1)}
        ${sel("Alerte envoyée à", "anomaly_notification_service")}
      </details>
      <div class="editor-foot">
        ${zone ? `<button class="btn plain danger" data-delete-zone="${key}"><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer</button>` : ""}
        <span class="spacer"></span>
        <button class="btn plain" data-cancel-zone="${key}">${dirty && zone ? "Annuler" : "Fermer"}</button>
        <button class="btn accent" data-primary data-save-zone="${key}" data-disabled="${dirty ? 0 : 1}" ${dirty && !this._busy ? "" : "disabled"}>${zone ? "Enregistrer" : "Créer la zone"}</button>
      </div>
    </div>`;
  }

  _zoneSelector(field) {
    const notify = Object.keys(this._hass.services?.notify || {}).sort().map((s) => ({ value: `notify.${s}`, label: `notify.${s}` }));
    return {
      temperature_sensors: { entity: { multiple: true, filter: { domain: "sensor", device_class: "temperature" } } },
      window_sensors: { entity: { multiple: true, filter: { domain: "binary_sensor", device_class: ["window", "opening", "door"] } } },
      consumption_sensor_heat: { entity: { filter: { domain: "sensor", device_class: "energy" } } },
      consumption_sensor_cool: { entity: { filter: { domain: "sensor", device_class: "energy" } } },
      anomaly_notification_service: { select: { mode: "dropdown", options: [{ value: "", label: "Aucune" }, ...notify] } },
    }[field];
  }

  async _saveZone(key) {
    const d = this._zoneDraft(key);
    const zone = Object.fromEntries(ZONE_KEYS.map((k) => [k, d[k] === "" ? null : d[k]]));
    zone.name = String(zone.name || "").trim();
    zone.temperature_sensors = list(zone.temperature_sensors); zone.window_sensors = list(zone.window_sensors);
    if (!zone.name) return this._toast("Donne un nom à la zone.");
    if (!zone.temperature_sensors.length) return this._toast("Ajoute au moins un capteur de température.");
    const ok = await this._ws({ type: "climate_manager/zone/save", zone_id: key === "new" ? null : key, zone }, key === "new" ? "Zone créée" : "Zone enregistrée");
    if (ok) { delete this._zoneDrafts[key]; this._zoneOpen = null; this._render(); }
  }

  /* ---------------------------------------------------------------- house */

  _houseState() {
    const pres = this._presence();
    return this._houseDraft || { entity: pres.entity, away: [...pres.away], home: [...pres.home] };
  }

  _renderHouse() {
    const pres = this._presence();
    const d = this._houseState();
    const saved = this._settings.house;
    const dirty = !!this._houseDraft || (pres.inferred && !saved.presence_entity);
    const domain = d.entity ? d.entity.split(".")[0] : null;
    const current = d.entity ? this._hass.states[d.entity]?.state : null;
    const states = [...new Set([...(KNOWN_STATES[domain] || []), ...d.away, ...d.home, ...(current ? [current] : [])])];
    const opts = states.map((s) => [s, STATE_LABELS[s] || s]);
    const status = !current ? null : d.away.includes(current) ? "vide" : d.home.includes(current) ? "occupée" : null;
    return `<div class="card">
      ${this._cardHead("mdi:home-account", "Présence", status ? `<span class="badge ${status === "vide" ? "" : "ok"}">Maison ${status} en ce moment</span>` : "")}
      <div class="hint">Réglée une fois pour toute la maison : les profils « Maison occupée » et « Maison vide » s'appuient dessus.</div>
      ${pres.inferred && !saved.presence_entity ? '<div class="note muted"><ha-icon icon="mdi:lightbulb-on-outline"></ha-icon><span>Proposition tirée de tes profils actuels : vérifie puis enregistre.</span></div>' : ""}
      <div class="group">
        ${this._field("Source", `<div class="sel" data-selector="house|entity"></div>`, "Alarme, personne, groupe ou interrupteur.")}
        ${d.entity ? `${this._field("Occupée quand", this._choice("house-home", opts, d.home, { multi: true }))}
          ${this._field("Vide quand", this._choice("house-away", opts, d.away, { multi: true }))}` : ""}
      </div>
      <div class="card-foot"><span class="spacer"></span>
        ${this._houseDraft ? '<button class="btn plain" data-cancel-house>Annuler</button>' : ""}
        <button class="btn accent" data-primary data-save-house data-disabled="${dirty ? 0 : 1}" ${dirty && !this._busy ? "" : "disabled"}>Enregistrer</button></div>
    </div>`;
  }

  async _saveHouse() {
    const pres = this._presence();
    const d = this._houseState();
    const ok = await this._ws({ type: "climate_manager/house/save", presence_entity: d.entity || null, presence_absent_states: d.away, presence_home_states: d.home }, "Présence enregistrée");
    if (!ok) return;
    // Profiles following the previous "occupied"/"empty" definition follow the new one.
    for (const season of Object.keys(SEASONS)) {
      let changed = false;
      const msg = this._bankPayload(season, (banks) => {
        for (const items of Object.values(banks)) for (const p of items) {
          if (!d.entity || p.presence_entity !== pres.entity) continue;
          const st = list(p.presence_required_state);
          const next = sameSet(st, pres.away) ? d.away : sameSet(st, pres.home) ? d.home : null;
          if (next && (p.presence_entity !== d.entity || !sameSet(st, next))) { p.presence_entity = d.entity; p.presence_required_state = [...next]; changed = true; }
        }
      });
      if (changed) await this._ws(msg);
    }
    this._houseDraft = null; this._render();
  }

  /* --------------------------------------------------------------- events */

  _mountSelectors() {
    this.shadowRoot.querySelectorAll("[data-selector]").forEach((host) => {
      const [key, field] = host.dataset.selector.split("|");
      const el = document.createElement("ha-selector");
      el.hass = this._hass;
      if (key === "eq") {
        el.selector = this._eqSelector(field);
        el.value = this._eqEdit[field] || (field === "energy_sensors" ? [] : "");
      } else if (key === "house") {
        el.selector = { entity: { filter: ["alarm_control_panel", "person", "group", "binary_sensor", "input_boolean", "device_tracker"].map((domain) => ({ domain })) } };
        el.value = this._houseState().entity || "";
      } else {
        el.selector = this._zoneSelector(field);
        const d = this._zoneDrafts[key] || (key === "new" ? NEW_ZONE : this._zone(key));
        el.value = d[field] ?? (el.selector.entity?.multiple ? [] : "");
      }
      el.addEventListener("value-changed", (ev) => {
        const value = ev.detail.value;
        if (key === "eq") {
          this._eqEdit[field] = field === "energy_sensors" ? list(value) : value || null;
          if (field === "entity") { this._eqEdit.on_option = null; this._eqEdit.off_option = null; if (!this._eqEdit.name && value) this._eqEdit.name = this._name(value); }
        } else if (key === "house") {
          const known = KNOWN_STATES[value ? value.split(".")[0] : ""] || [];
          this._houseDraft = { entity: value || null, away: known.filter((s) => AWAY_HINTS.includes(s)), home: known.filter((s) => !AWAY_HINTS.includes(s) && s !== "off") };
        } else {
          this._zoneDraft(key)[field] = value === "" ? null : value;
        }
        this._render();
      });
      host.appendChild(el);
    });
  }

  _wire() {
    const root = this.shadowRoot;
    const on = (sel, fn, evt = "click") => root.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, (ev) => fn(el, ev)));

    on("[data-tab]", (b) => {
      this._tab = b.dataset.tab; this._focusZone = null;
      this._eqEdit = null; this._modeEdit = null;
      if (this._tab === "installation" && !this._settings?.zones.length) { this._zoneDraft("new"); this._zoneOpen = "new"; }
      const url = new URL(window.location.href); url.searchParams.set("tab", this._tab); url.searchParams.delete("zone");
      history.replaceState(null, "", url); this._render();
    });
    on("[data-view-season]", (b) => { this._season = b.dataset.viewSeason; this._edit = null; this._render(); });
    on("[data-set-mode]", (b) => {
      const id = b.dataset.setMode || null;
      const m = this._settings.modes.find((x) => x.id === id);
      this._ws({ type: "climate_manager/mode/set", mode_id: id }, m ? `Mode « ${m.name} » actif` : "Arrêt : rien ne démarre seul");
    });
    on("[data-edit-eq]", (b) => this._openEq(b.dataset.editEq));
    on("[data-add-eq]", () => this._openEq(null));
    on("[data-enable-eq]", (b) => {
      const enabled = b.getAttribute("aria-checked") !== "true";
      const eq = this._equipment(b.dataset.enableEq);
      this._ws({ type: "climate_manager/equipment/enable", equipment_id: b.dataset.enableEq, enabled },
        `${eq ? eq.name : "Équipement"} ${enabled ? "en service" : "hors service"}`);
    });
    on("[data-cancel-eq]", () => { this._eqEdit = null; this._render(); });
    on("[data-save-eq]", () => this._saveEq());
    on("[data-delete-eq]", () => {
      if (!confirm(`Supprimer « ${this._eqEdit.name} » ? Il est aussi retiré des modes.`)) return;
      this._ws({ type: "climate_manager/equipment/delete", equipment_id: this._eqEdit.id }, "Équipement supprimé").then((ok) => { if (ok) { this._eqEdit = null; this._render(); } });
    });
    on("[data-eq-text]", (i) => { this._eqEdit[i.dataset.eqText] = i.value; }, "input");
    on("[data-toggle-cover]", (b) => { const [eq, zone] = b.dataset.toggleCover.split("|"); this._toggleCover(eq, zone); });
    on("[data-edit-mode]", (b) => this._openMode(b.dataset.editMode));
    on("[data-add-mode]", () => this._openMode(null));
    on("[data-cancel-mode]", () => { this._modeEdit = null; this._render(); });
    on("[data-save-mode]", () => this._saveMode());
    on("[data-move-mode]", (b) => this._moveMode(Number(b.dataset.moveMode)));
    on("[data-delete-mode]", () => {
      if (!confirm(`Supprimer le mode « ${this._modeEdit.name} » ?`)) return;
      this._ws({ type: "climate_manager/mode/delete", mode_id: this._modeEdit.id }, "Mode supprimé").then((ok) => { if (ok) { this._modeEdit = null; this._render(); } });
    });
    on("[data-mode-text]", (i) => { this._modeEdit[i.dataset.modeText] = i.value; }, "input");
    on("[data-mode-eq]", (b) => {
      const m = this._modeEdit; const id = b.dataset.modeEq;
      m.equipments = m.equipments.includes(id) ? m.equipments.filter((x) => x !== id) : [...m.equipments, id];
      this._render();
    });
    on("[data-mode-eq-move]", (b) => {
      const [id, d] = b.dataset.modeEqMove.split("|"); const ids = this._modeEdit.equipments;
      const i = ids.indexOf(id); const j = i + Number(d);
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]]; this._render();
    });
    on("[data-open-zone]", (b) => {
      const id = b.dataset.openZone;
      if (this._tab !== "installation") this._tab = "installation";
      this._zoneOpen = this._zoneOpen === id ? null : id; delete this._zoneDrafts[id]; this._render();
      this.shadowRoot.querySelector(".row.open")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    on("[data-edit-profile]", (b) => this._openEditor(this._season, b.dataset.editProfile));
    on("[data-add-profile]", (b) => this._openEditor(b.dataset.addProfile, null));
    on("[data-cancel-edit]", () => { this._edit = null; this._render(); });
    on("[data-save-profile]", () => this._saveProfile());
    on("[data-delete-profile]", () => this._deleteProfile());
    on("[data-move]", (b) => this._moveProfile(Number(b.dataset.move)));
    on("[data-text]", (i) => this._setValue(i.dataset.text, i.value), "input");
    on("[data-time]", (i) => this._setValue(i.dataset.time, i.value || null), "change");

    on("[data-choice] button", (b) => {
      const name = b.closest("[data-choice]").dataset.choice; const val = b.dataset.val;
      if (name === "schedule") {
        this._edit.scheduled = val === "range";
        if (this._edit.scheduled && !this._edit.values.active_from) { this._setValue("active_from", "22:00"); this._setValue("active_to", "06:00"); }
      } else if (name === "occupancy") {
        const pres = this._presence();
        if (val === "any") { this._setValue("presence_entity", null); this._setValue("presence_required_state", null); }
        else if (pres.entity) { this._setValue("presence_entity", pres.entity); this._setValue("presence_required_state", [...(val === "away" ? pres.away : pres.home)]); }
      } else if (name === "zones") {
        const ids = this._edit.zoneIds;
        this._edit.zoneIds = ids.includes(val) ? ids.filter((x) => x !== val) : [...ids, val];
      } else if (name.startsWith("eq-")) {
        const e = this._eqEdit;
        if (name === "eq-kind") {
          e.kind = val;
          if (val === "heat_pump") { e.cool = true; e.heat = true; e.zones = e.zones.slice(0, 1); e.entity = e.entity?.startsWith("climate.") ? e.entity : null; }
          if (!e.id && !(e.energy_sensors || []).length) { e.energy = val === "heat_pump" ? "electricity" : "gas"; e.energy_price = DEFAULT_PRICE[e.energy]; }
        }
        else if (name === "eq-does") { if (val === "heat") e.heat = !e.heat; else e.cool = !e.cool; }
        else if (name === "eq-on") e.on_option = val;
        else if (name === "eq-energy") {
          if (Number(e.energy_price) === DEFAULT_PRICE[e.energy] || e.energy_price == null) e.energy_price = DEFAULT_PRICE[val];
          e.energy = val;
        }
        else if (name === "eq-off") e.off_option = val;
        else if (name === "eq-zones") e.zones = e.kind === "heat_pump" ? [val] : e.zones.includes(val) ? e.zones.filter((x) => x !== val) : [...e.zones, val];
      } else if (name === "mode-direction") {
        this._modeEdit.direction = val;
      } else if (name === "mode-relation") {
        this._modeEdit.relation = val;
      } else if (name === "house-home" || name === "house-away") {
        const d = this._houseDraft || (this._houseDraft = this._houseState());
        const kind = name === "house-home" ? "home" : "away"; const other = kind === "home" ? "away" : "home";
        d[kind] = d[kind].includes(val) ? d[kind].filter((x) => x !== val) : [...d[kind], val];
        d[other] = d[other].filter((x) => x !== val);
      } else {
        this._setValue(name, val);
      }
      this._render();
    });

    on("[data-stepper] button[data-dir]", (b) => {
      const box = b.closest("[data-stepper]"); const field = box.dataset.stepper;
      const step = Number(box.dataset.step); const digits = Number(box.dataset.digits);
      const next = Math.min(Number(box.dataset.max), Math.max(Number(box.dataset.min), Math.round((this._stepperValue(field) + step * Number(b.dataset.dir)) * 100) / 100));
      this._stepperSet(field, next);
      box.querySelector(".value b").textContent = digits ? num(next, digits) : String(next);
    });
    on("[data-enable]", (b) => { this._setValue(b.dataset.enable, Number(this._edit.values.target) + (SEASONS[this._edit.season].mode === "heat" ? 0.5 : -0.5)); this._render(); });
    on("[data-clear]", (b) => { this._setValue(b.dataset.clear, null); this._render(); });

    on("[data-add-zone]", () => { this._zoneDraft("new"); this._zoneOpen = "new"; this._render(); });
    on("[data-zone-text]", (i) => { const [key, f] = i.dataset.zoneText.split("|"); this._zoneDraft(key)[f] = i.value; this._refreshZoneButtons(key); }, "input");
    on("[data-save-zone]", (b) => this._saveZone(b.dataset.saveZone));
    on("[data-cancel-zone]", (b) => { delete this._zoneDrafts[b.dataset.cancelZone]; this._zoneOpen = null; this._render(); });
    on("[data-delete-zone]", (b) => {
      const zone = this._zone(b.dataset.deleteZone);
      if (!confirm(`Supprimer la zone « ${zoneName(zone)} » ? Ses profils et ses entités disparaissent.`)) return;
      this._ws({ type: "climate_manager/zone/delete", zone_id: zone.id }, "Zone supprimée");
    });

    on("[data-save-house]", () => this._saveHouse());
    on("[data-cancel-house]", () => { this._houseDraft = null; this._render(); });
  }

  _stepperValue(field) {
    if (field.startsWith("eq:")) return Number(this._eqEdit[field.slice(3)] ?? 0);
    if (field.startsWith("mode:")) return Number(this._modeEdit[field.slice(5)] ?? 0);
    if (field.startsWith("zone:")) { const [, key, f] = field.split(":"); return Number(this._zoneDraft(key)[f] ?? NEW_ZONE[f]); }
    return Number(this._edit.values[field] ?? 0);
  }
  _stepperSet(field, value) {
    if (field.startsWith("eq:")) { this._eqEdit[field.slice(3)] = value; return; }
    if (field.startsWith("mode:")) { this._modeEdit[field.slice(5)] = value; return; }
    if (field.startsWith("zone:")) { const [, key, f] = field.split(":"); this._zoneDraft(key)[f] = value; this._refreshZoneButtons(key); return; }
    this._setValue(field, value);
  }
  _refreshZoneButtons(key) {
    const card = this.shadowRoot.querySelector(`[data-zone-card="${key}"]`);
    if (!card) return;
    const dirty = this._zoneDirty(key);
    const save = card.querySelector("[data-save-zone]");
    save.dataset.disabled = dirty ? "0" : "1"; save.disabled = !dirty || this._busy;
    if (dirty && !card.querySelector("[data-cancel-zone]")) {
      const cancel = document.createElement("button");
      cancel.className = "btn plain"; cancel.dataset.cancelZone = key; cancel.textContent = "Annuler";
      cancel.addEventListener("click", () => { delete this._zoneDrafts[key]; this._render(); });
      save.before(cancel);
    }
  }
}

/* Same visual language as the dashboard card (climate-manager-card.js). */
const STYLES = `
  :host {
    --dc-cool: #00BCD4; --dc-cool-soft: rgba(0,188,212,.13);
    --dc-warm: #FF8A65; --dc-warm-soft: rgba(255,138,101,.14);
    --dc-accent: var(--primary-color, var(--dc-cool)); --dc-accent-soft: color-mix(in srgb, var(--dc-accent) 14%, transparent);
    --dc-surface: rgba(36,40,50,.045); --dc-surface-strong: rgba(36,40,50,.075);
    --dc-hairline: rgba(36,40,50,.08);
    --dc-fg: var(--primary-text-color, rgba(36,40,50,.94)); --dc-muted: var(--secondary-text-color, rgba(36,40,50,.58));
    --dc-danger: #D05B50; --dc-ok: #3F9D6B;
    --dc-radius: var(--ha-card-border-radius, 26px); --dc-radius-sm: 16px;
    display: block; min-height: 100vh; background: var(--primary-background-color); color: var(--dc-fg);
    font-family: var(--ha-card-font-family, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); font-size: 14px; line-height: 1.45;
  }
  * { box-sizing: border-box; }
  /* Same header as the rest of HA with the « Maison » theme: title left, tabs centred. */
  .toolbar { height: var(--header-height, 56px); display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px;
    padding: 0 16px; background: var(--primary-background-color); color: var(--dc-fg); position: sticky; top: 0; z-index: 2; }
  .toolbar .start { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .toolbar ha-menu-button { --mdc-icon-button-size: 40px; color: var(--secondary-text-color); }
  .title { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin-inline-start: 8px; white-space: nowrap; }
  .toolbar .tabs { margin: 0; }
  .toolbar .busy { justify-self: end; }
  @media (max-width: 720px) {
    .toolbar { grid-template-columns: 1fr auto; height: auto; padding: 8px 12px; row-gap: 8px; }
    .toolbar .tabs { grid-row: 2; grid-column: 1 / -1; justify-self: center; }
  }
  .busy { font-size: 13px; color: var(--dc-muted); }
  .page { max-width: 880px; margin: 0 auto; padding: 20px 16px 48px; display: flex; flex-direction: column; gap: 16px; }

  .pills { display: inline-flex; gap: 4px; padding: 4px; border-radius: 14px; background: var(--dc-surface); flex-wrap: wrap; }
  .pills button { border: 0; background: transparent; color: var(--dc-muted); font: inherit; font-weight: 600; font-size: 14px;
    padding: 9px 16px; border-radius: 10px; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; transition: background .15s, color .15s; }
  .pills button ha-icon { --mdc-icon-size: 18px; }
  .pills button.on { background: var(--card-background-color, #fff); color: var(--dc-fg); box-shadow: 0 1px 4px rgba(0,0,0,.10); }
  .pills.small button { font-size: 13px; padding: 7px 12px; }
  .pills.small button ha-icon { --mdc-icon-size: 16px; }
  .tabs { align-self: center; background: var(--ha-color-form-background, rgba(36,40,50,.07)); border-radius: 16px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dc-accent); }

  .card { background: var(--card-background-color, #fff); border: 1px solid var(--dc-hairline); border-radius: var(--dc-radius); overflow: hidden; }
  .card.accent-warm { --dc-accent: var(--dc-warm); --dc-accent-soft: var(--dc-warm-soft); }
  .card.accent-cool { --dc-accent: var(--dc-cool); --dc-accent-soft: var(--dc-cool-soft); }
  .card.focus { box-shadow: 0 0 0 2px var(--dc-accent); }
  .card-head { display: flex; align-items: center; gap: 12px; padding: 18px 20px 12px; flex-wrap: wrap; }
  .bubble { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; background: var(--dc-accent-soft); color: var(--dc-accent); flex: none; }
  .bubble ha-icon { --mdc-icon-size: 20px; }
  .card-title { font-size: 18px; font-weight: 600; flex: 1; }
  .head-meta { color: var(--dc-muted); font-size: 13px; }
  .head-meta b { color: var(--dc-fg); font-size: 15px; }
  .hint { padding: 0 20px 6px; color: var(--dc-muted); font-size: 13px; }
  .empty-note { padding: 14px 20px 20px; color: var(--dc-muted); }
  .danger-text { color: var(--dc-danger); }
  .card-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px 16px 20px; }
  .spacer { flex: 1; }

  .note { display: flex; align-items: center; gap: 10px; margin: 0 20px 10px; padding: 10px 14px; border-radius: var(--dc-radius-sm);
    background: var(--dc-accent-soft); font-size: 13px; }
  .note ha-icon { --mdc-icon-size: 20px; color: var(--dc-accent); flex: none; }
  .note.muted { background: var(--dc-surface); }
  .note.muted ha-icon { color: var(--dc-muted); }
  .note span { flex: 1; }
  .badge { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--dc-accent-soft); color: var(--dc-accent); white-space: nowrap; }
  .badge.ok { background: rgba(63,157,107,.13); color: var(--dc-ok); }
  .tag { font-size: 12px; font-weight: 500; padding: 2px 8px; border-radius: 999px; background: var(--dc-surface-strong); color: var(--dc-muted); }

  .btn { border: 0; font: inherit; font-weight: 600; font-size: 14px; border-radius: 999px; padding: 9px 18px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px; background: var(--dc-surface); color: var(--dc-fg); white-space: nowrap; }
  .btn ha-icon { --mdc-icon-size: 18px; }
  .btn.small { padding: 6px 14px; font-size: 13px; background: var(--card-background-color, #fff); box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .btn.accent { background: var(--dc-accent); color: #fff; }
  .btn.plain { background: transparent; color: var(--dc-muted); padding: 9px 12px; }
  .btn.danger { color: var(--dc-danger); }
  .btn:disabled { opacity: .4; cursor: default; }
  .icon-btn { border: 0; background: var(--card-background-color, #fff); color: var(--dc-muted); width: 36px; height: 36px; border-radius: 50%;
    display: grid; place-items: center; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .icon-btn ha-icon { --mdc-icon-size: 18px; }

  .rows { padding: 6px 12px 14px; display: flex; flex-direction: column; gap: 4px; }
  .row { border-radius: 20px; transition: background .15s; }
  .row.open { background: var(--dc-surface); }
  .row-head { width: 100%; border: 0; background: transparent; font: inherit; color: inherit; text-align: left; cursor: pointer;
    display: flex; align-items: center; gap: 14px; padding: 12px; border-radius: 20px; }
  .row-head.static { cursor: default; }
  .row:not(.open) .row-head:hover { background: var(--dc-surface); }
  .rank { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; flex: none; font-size: 13px; font-weight: 700;
    background: var(--dc-surface-strong); color: var(--dc-muted); }
  .row.running .rank { background: var(--dc-accent); color: #fff; }
  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .row-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 15px; font-weight: 600; }
  .row-meta { display: flex; flex-wrap: wrap; gap: 4px 18px; color: var(--dc-muted); font-size: 13px; }
  .row-meta span { display: inline-flex; align-items: center; gap: 5px; }
  .row-meta ha-icon { --mdc-icon-size: 15px; }
  .chev { --mdc-icon-size: 20px; color: var(--dc-muted); }
  .add-row { border: 1px dashed rgba(36,40,50,.18); background: transparent; color: var(--dc-muted); border-radius: var(--dc-radius-sm);
    font: inherit; font-weight: 600; padding: 12px; display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; margin-top: 6px; }
  .add-row:hover { color: var(--dc-accent); border-color: var(--dc-accent); }
  .add-row.big { border-radius: var(--dc-radius); padding: 18px; }

  .editor { padding: 0 12px 12px 54px; display: flex; flex-direction: column; gap: 10px; }
  .editor .note { margin: 0; }
  .group { background: var(--card-background-color, #fff); border-radius: var(--dc-radius-sm); padding: 4px 16px; }
  .card > .group { background: transparent; padding: 0 20px 4px; }
  .group-title { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--dc-muted); padding: 12px 0 2px; }
  .f { display: grid; grid-template-columns: 180px 1fr; gap: 16px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--dc-hairline); }
  .group > .f:last-child, details > .f:last-child { border-bottom: 0; }
  .f-label { font-weight: 500; }
  .f-control { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
  .f-control .sel, .f-control ha-selector { width: 100%; display: block; }
  .f-help { font-size: 12px; color: var(--dc-muted); }
  /* Same field as Home Assistant's own pickers (theme form colours). */
  .text { font: inherit; font-size: 15px; color: var(--dc-fg); background: var(--ha-color-form-background, var(--dc-surface)); border: 0;
    border-bottom: 1px solid var(--ha-color-border-neutral-loud, rgba(36,40,50,.2)); border-radius: var(--ha-border-radius-sm, 8px) var(--ha-border-radius-sm, 8px) 0 0;
    height: 56px; padding: 0 16px; width: 100%; outline: none; transition: border-color .15s, background .15s; }
  .text:hover { background: var(--ha-color-form-background-hover, var(--dc-surface-strong)); }
  .text:focus { border-bottom: 2px solid var(--dc-accent); }
  .text.time { width: auto; height: 48px; padding: 0 12px; font-variant-numeric: tabular-nums; }
  .times { display: flex; align-items: center; gap: 8px; color: var(--dc-muted); }
  .stepper { display: inline-flex; align-items: center; gap: 2px; padding: 4px; border-radius: 14px; background: var(--dc-surface); }
  .stepper button { border: 0; width: 34px; height: 34px; border-radius: 10px; background: var(--card-background-color, #fff); color: var(--dc-fg);
    display: grid; place-items: center; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .stepper button ha-icon { --mdc-icon-size: 18px; }
  .stepper .value { min-width: 96px; text-align: center; color: var(--dc-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .stepper .value b { color: var(--dc-fg); font-size: 16px; font-weight: 600; margin-right: 4px; }
  .stepper button.clear { background: transparent; box-shadow: none; color: var(--dc-muted); }
  .stepper.off { border: 1px dashed rgba(36,40,50,.18); background: transparent; color: var(--dc-muted); font: inherit; font-weight: 600; font-size: 13px;
    padding: 9px 14px; gap: 6px; cursor: pointer; }
  .stepper.off ha-icon { --mdc-icon-size: 16px; }
  .editor-foot { display: flex; align-items: center; gap: 8px; padding-top: 2px; }

  details.advanced summary { list-style: none; cursor: pointer; padding: 12px 0; color: var(--dc-muted); font-weight: 600; font-size: 13px;
    display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--dc-hairline); }
  details.advanced summary::-webkit-details-marker { display: none; }
  details.advanced summary::before { content: "›"; font-size: 18px; line-height: 1; transition: transform .15s; }
  details.advanced[open] summary::before { transform: rotate(90deg); }

  .row-icon { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; flex: none; background: var(--dc-surface-strong); color: var(--dc-muted); }
  .row-icon ha-icon { --mdc-icon-size: 20px; }
  .row-icon.warm { background: var(--dc-warm-soft); color: var(--dc-warm); }
  .row-icon.cool { background: var(--dc-cool-soft); color: var(--dc-cool); }
  .row-icon.both { background: linear-gradient(135deg, var(--dc-warm-soft) 50%, var(--dc-cool-soft) 50%); color: var(--dc-fg); }
  .row.running .row-icon:not(.warm):not(.cool) { background: var(--dc-accent); color: #fff; }
  .row-temp { font-weight: 600; font-size: 15px; font-variant-numeric: tabular-nums; }
  .row-head .row-hit { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; color: inherit; text-align: left; cursor: pointer;
    display: flex; align-items: center; gap: 14px; padding: 0; }
  .row-head:has(.row-hit) { cursor: default; }
  .svc-switch { flex: none; width: 40px; height: 24px; border: 0; padding: 0; border-radius: 999px; cursor: pointer; position: relative;
    background: var(--dc-surface-strong); transition: background .15s; }
  .svc-switch i { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff;
    box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform .15s; }
  .svc-switch[aria-checked="true"] { background: var(--dc-accent); }
  .svc-switch[aria-checked="true"] i { transform: translateX(16px); }
  .row.out .row-title { color: var(--dc-muted); }
  .icon-btn.flat { box-shadow: none; background: transparent; }
  .icon-btn.ghost { visibility: hidden; }
  .icon-btn:disabled { opacity: .3; cursor: default; }
  .muted { color: var(--dc-muted); }

  .matrix-wrap { overflow-x: auto; padding: 4px 16px 4px; }
  .matrix { border-collapse: separate; border-spacing: 0; width: 100%; }
  .matrix th, .matrix td { padding: 0; text-align: center; vertical-align: middle; }
  .matrix thead th { padding-bottom: 6px; }
  .matrix tbody tr + tr th, .matrix tbody tr + tr td { border-top: 1px solid var(--dc-hairline); }
  .eq-head { border: 0; background: transparent; font: inherit; color: inherit; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 8px 6px; border-radius: 16px; width: 100%; min-width: 104px; }
  .eq-head:hover { background: var(--dc-surface); }
  .eq-bubble { position: relative; width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: var(--dc-surface-strong); }
  .eq-head.warm .eq-bubble { background: var(--dc-warm-soft); color: var(--dc-warm); }
  .eq-head.cool .eq-bubble { background: var(--dc-cool-soft); color: var(--dc-cool); }
  .eq-head.both .eq-bubble { background: linear-gradient(135deg, var(--dc-warm-soft) 50%, var(--dc-cool-soft) 50%); }
  .eq-bubble ha-icon { --mdc-icon-size: 24px; }
  .live-dot { position: absolute; top: -3px; right: -3px; width: 12px; height: 12px; border-radius: 50%; background: var(--dc-ok); border: 2px solid var(--card-background-color, #fff); }
  .eq-name { font-weight: 600; font-size: 14px; white-space: nowrap; }
  .eq-sub { font-size: 12px; color: var(--dc-muted); }
  .eq-head.out .eq-name { color: var(--dc-muted); }
  .cell.on.out { background: var(--dc-surface-strong); color: var(--dc-muted); }
  .zone-head { text-align: left !important; width: 1%; white-space: nowrap; }
  .zone-head button { border: 0; background: transparent; font: inherit; color: inherit; cursor: pointer; text-align: left; padding: 14px 18px 14px 6px;
    display: flex; flex-direction: column; gap: 1px; border-radius: 12px; }
  .zone-head button span { font-weight: 600; font-size: 15px; }
  .zone-head small { color: var(--dc-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .cell { width: 36px; height: 36px; border-radius: 50%; border: 1.5px dashed rgba(36,40,50,.18); background: transparent; cursor: pointer;
    display: inline-grid; place-items: center; color: #fff; transition: transform .1s, background .15s; }
  .cell:hover { border-color: var(--dc-muted); }
  .cell ha-icon { --mdc-icon-size: 20px; }
  .cell.on { border: 0; }
  .cell.on.warm { background: var(--dc-warm); }
  .cell.on.cool { background: var(--dc-cool); }
  .cell.on.both { background: linear-gradient(135deg, var(--dc-warm) 50%, var(--dc-cool) 50%); }
  .cell:active { transform: scale(.92); }

  .eq-lines { display: flex; flex-direction: column; gap: 6px; width: 100%; }
  .eq-line { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 14px; background: var(--dc-surface); }
  .eq-line:not(.on) { background: transparent; border: 1px dashed rgba(36,40,50,.14); }
  .eq-line:not(.on) .eq-line-main, .eq-line:not(.on) .eq-ico { opacity: .6; }
  .eq-line .check { width: 28px; height: 28px; border-radius: 50%; border: 0; display: grid; place-items: center; cursor: pointer; flex: none;
    background: var(--dc-surface-strong); color: var(--dc-muted); font: inherit; font-size: 13px; }
  .eq-line.on .check { background: var(--dc-accent); color: #fff; }
  .eq-line .check ha-icon { --mdc-icon-size: 16px; }
  .eq-ico { --mdc-icon-size: 20px; color: var(--dc-muted); }
  .eq-line-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .eq-line-main small { color: var(--dc-muted); font-size: 12px; }
  .preview-line { display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--dc-hairline); font-size: 14px; }
  .preview-line:last-child { border-bottom: 0; }
  .preview-line > span:first-child { font-weight: 600; }

  @media (max-width: 700px) {
    .page { padding: 12px 10px 40px; }
    .editor { padding: 0 8px 10px; }
    .f { grid-template-columns: 1fr; gap: 6px; }
    .tabs { align-self: stretch; } .tabs button { flex: 1; justify-content: center; }
  }
`;

if (!customElements.get("climate-manager-panel")) customElements.define("climate-manager-panel", ClimateManagerPanel);
