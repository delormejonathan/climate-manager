/* Climate Manager — settings panel (sidebar « Climat », admins only).
 *
 * The only place where Climate Manager is configured:
 *   Programme — season in service and comfort profiles (all zones at once)
 *   Zones     — rooms and their equipment
 *   Maison    — presence (who says the house is occupied or empty)
 * The dashboard card is for daily use only. Both share the same look
 * (soft surfaces, pills, cool/warm accent).
 */

const SEASONS = {
  winter: { label: "Hiver", icon: "mdi:snowflake", mode: "heat", accent: "warm" },
  summer: { label: "Été", icon: "mdi:white-balance-sunny", mode: "cool", accent: "cool" },
};
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
  name: "", climate_entity: null, temperature_sensors: [], window_sensors: [],
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
    this._tab = "programme";
    this._settings = null;
    this._error = null;
    this._season = null;      // season shown in the Programme tab
    this._edit = null;        // { season, original, values, zoneIds, dirty, diffLines, scheduled }
    this._zoneDrafts = {};    // zone_id | "new" -> draft
    this._houseDraft = null;
    this._busy = false;
  }

  /* ------------------------------------------------------------ lifecycle */

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      const params = new URLSearchParams(window.location.search);
      if (["programme", "zones", "maison"].includes(params.get("tab"))) this._tab = params.get("tab");
      this._focusZone = params.get("zone");
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
  _hasDrafts() { return Object.keys(this._zoneDrafts).length > 0 || !!this._houseDraft; }

  async _load() {
    try {
      this._settings = await this._hass.callWS({ type: "climate_manager/settings" });
      this._error = null;
      if (!SEASONS[this._season]) this._season = SEASONS[this._settings.house.season] ? this._settings.house.season : "winter";
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
        <ha-menu-button></ha-menu-button>
        <div class="title">Climat</div>
        <div class="busy" data-busy>${this._busy ? "Enregistrement…" : ""}</div>
      </div>
      <div class="page">
        <div class="pills tabs">
          ${[["programme", "mdi:calendar-clock", "Programme"], ["zones", "mdi:floor-plan", "Zones"], ["maison", "mdi:home-account", "Maison"]]
            .map(([id, icon, label]) => `<button class="${this._tab === id ? "on" : ""}" data-tab="${id}"><ha-icon icon="${icon}"></ha-icon>${label}</button>`).join("")}
        </div>
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
    if (this._tab === "zones") return this._renderZones();
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
        <div class="empty-note">Déclare d'abord une pièce et sa climatisation dans l'onglet Zones.</div>
        <div class="card-foot"><span class="spacer"></span><button class="btn accent" data-tab="zones">Ajouter une zone</button></div></div>`;
    }
    const inService = s.house.season;
    const season = this._season;
    const rows = this._rows(season);
    const seasonPills = `<div class="pills small">${Object.entries(SEASONS).map(([k, v]) =>
      `<button data-view-season="${k}" class="${season === k ? "on" : ""}"><ha-icon icon="${v.icon}"></ha-icon>${v.label}${inService === k ? '<span class="dot" title="En service"></span>' : ""}</button>`).join("")}</div>`;
    const banner = inService === season
      ? `<div class="note"><ha-icon icon="mdi:check-circle-outline"></ha-icon><span>Programme <b>${SEASONS[season].label.toLowerCase()}</b> en service : la maison ${SEASONS[season].mode === "heat" ? "chauffe" : "se rafraîchit"} selon ces profils.</span></div>`
      : `<div class="note muted"><ha-icon icon="mdi:pause-circle-outline"></ha-icon><span>Le programme ${SEASONS[season].label.toLowerCase()} est en réserve${inService === "mixed" ? " : les zones ne sont pas sur la même saison" : ""}.</span>
        <button class="btn small" data-set-season="${season}">Le mettre en service</button></div>`;
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
        ${this._field("Coupe à", this._stepper("target_cutoff", v.target_cutoff, { optional: true }), "Facultatif : arrête la climatisation à cette température.")}
      </div>
      <div class="group">
        <div class="group-title">Climatisation</div>
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

  _renderZones() {
    return `${this._settings.zones.map((z) => this._renderZoneCard(z.id)).join("")}
      ${this._zoneDrafts.new ? this._renderZoneCard("new") : `<button class="add-row big" data-add-zone><ha-icon icon="mdi:plus"></ha-icon>Ajouter une zone</button>`}`;
  }

  _renderZoneCard(key) {
    const zone = key === "new" ? null : this._zone(key);
    const d = this._zoneDrafts[key] || zone || NEW_ZONE;
    const dirty = this._zoneDirty(key);
    const live = zone?.live || {};
    const focus = zone && this._focusZone && [zone.id, (zone.name || "").toLowerCase()].includes(this._focusZone.toLowerCase());
    const sel = (label, field, help = "") => this._field(label, `<div class="sel" data-selector="${key}|${field}"></div>`, help);
    const stepper = (label, f, step, unit, min, max, digits, help = "") =>
      this._field(label, this._stepper(`zone:${key}:${f}`, Number(d[f] ?? NEW_ZONE[f]), { step, unit, min, max, digits }), help);
    const right = zone ? `<span class="head-meta"><b>${deg(live.room_temperature)}</b>${live.active_profile_name ? ` · ${esc(live.active_profile_name)}` : ""}</span>` : "";
    return `<div class="card ${focus ? "focus" : ""}" data-zone-card="${key}">
      ${this._cardHead("mdi:floor-plan", zone ? esc(zoneName(zone)) : "Nouvelle zone", right)}
      <div class="group">
        ${this._field("Nom", `<input class="text" data-zone-text="${key}|name" value="${esc(d.name)}" maxlength="40" placeholder="Salon, Étage…">`)}
        ${sel("Climatisation", "climate_entity")}
        ${sel("Température", "temperature_sensors", "La zone prend la moyenne de ces capteurs.")}
        ${sel("Fenêtres", "window_sensors", "Une fenêtre ouverte arrête la climatisation.")}
      </div>
      <details class="group advanced" ${key === "new" ? "open" : ""}>
        <summary>Réglages avancés</summary>
        ${sel("Compteur chauffage", "consumption_sensor_heat", "Sert à calculer la consommation de chaque session.")}
        ${sel("Compteur froid", "consumption_sensor_cool")}
        ${stepper("Reprise auto après", "override_duree_min", 5, "min", 5, 240, 0, "Quand quelqu'un a réglé la climatisation à la main.")}
        ${stepper("Contrôle d'efficacité après", "anomaly_delay_min", 5, "min", 15, 180, 0, "Vérifie ensuite que la pièce gagne bien en température.")}
        ${stepper("Gain minimum en chauffage", "anomaly_heat_gain_per_hour", 0.1, "°C/h", 0, 5, 1)}
        ${stepper("Gain minimum en froid", "anomaly_cool_gain_per_hour", 0.1, "°C/h", 0, 5, 1)}
        ${sel("Alerte envoyée à", "anomaly_notification_service")}
      </details>
      <div class="card-foot">
        ${zone ? `<button class="btn plain danger" data-delete-zone="${key}"><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer la zone</button>` : ""}
        <span class="spacer"></span>
        ${dirty ? `<button class="btn plain" data-cancel-zone="${key}">Annuler</button>` : ""}
        <button class="btn accent" data-primary data-save-zone="${key}" data-disabled="${dirty ? 0 : 1}" ${dirty && !this._busy ? "" : "disabled"}>${zone ? "Enregistrer" : "Créer la zone"}</button>
      </div>
    </div>`;
  }

  _zoneSelector(field) {
    const notify = Object.keys(this._hass.services?.notify || {}).sort().map((s) => ({ value: `notify.${s}`, label: `notify.${s}` }));
    return {
      climate_entity: { entity: { filter: { domain: "climate" } } },
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
    if (!zone.climate_entity) return this._toast("Choisis la climatisation de la zone.");
    if (!zone.temperature_sensors.length) return this._toast("Ajoute au moins un capteur de température.");
    const ok = await this._ws({ type: "climate_manager/zone/save", zone_id: key === "new" ? null : key, zone }, key === "new" ? "Zone créée" : "Zone enregistrée");
    if (ok) { delete this._zoneDrafts[key]; this._render(); }
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
      if (key === "house") {
        el.selector = { entity: { filter: ["alarm_control_panel", "person", "group", "binary_sensor", "input_boolean", "device_tracker"].map((domain) => ({ domain })) } };
        el.value = this._houseState().entity || "";
      } else {
        el.selector = this._zoneSelector(field);
        const d = this._zoneDrafts[key] || (key === "new" ? NEW_ZONE : this._zone(key));
        el.value = d[field] ?? (el.selector.entity?.multiple ? [] : "");
      }
      el.addEventListener("value-changed", (ev) => {
        const value = ev.detail.value;
        if (key === "house") {
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
      if (this._tab === "zones" && !this._settings?.zones.length) this._zoneDraft("new");
      const url = new URL(window.location.href); url.searchParams.set("tab", this._tab); url.searchParams.delete("zone");
      history.replaceState(null, "", url); this._render();
    });
    on("[data-view-season]", (b) => { this._season = b.dataset.viewSeason; this._edit = null; this._render(); });
    on("[data-set-season]", (b) => this._ws({ type: "climate_manager/season/set", season: b.dataset.setSeason }, `Programme ${SEASONS[b.dataset.setSeason].label.toLowerCase()} en service`));
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

    on("[data-add-zone]", () => { this._zoneDraft("new"); this._render(); });
    on("[data-zone-text]", (i) => { const [key, f] = i.dataset.zoneText.split("|"); this._zoneDraft(key)[f] = i.value; this._refreshZoneButtons(key); }, "input");
    on("[data-save-zone]", (b) => this._saveZone(b.dataset.saveZone));
    on("[data-cancel-zone]", (b) => { delete this._zoneDrafts[b.dataset.cancelZone]; this._render(); });
    on("[data-delete-zone]", (b) => {
      const zone = this._zone(b.dataset.deleteZone);
      if (!confirm(`Supprimer la zone « ${zoneName(zone)} » ? Ses profils et ses entités disparaissent.`)) return;
      this._ws({ type: "climate_manager/zone/delete", zone_id: zone.id }, "Zone supprimée");
    });

    on("[data-save-house]", () => this._saveHouse());
    on("[data-cancel-house]", () => { this._houseDraft = null; this._render(); });
  }

  _stepperValue(field) {
    if (field.startsWith("zone:")) { const [, key, f] = field.split(":"); return Number(this._zoneDraft(key)[f] ?? NEW_ZONE[f]); }
    return Number(this._edit.values[field] ?? 0);
  }
  _stepperSet(field, value) {
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
    --dc-accent: var(--dc-cool); --dc-accent-soft: var(--dc-cool-soft);
    --dc-surface: rgba(36,40,50,.045); --dc-surface-strong: rgba(36,40,50,.075);
    --dc-hairline: rgba(36,40,50,.08);
    --dc-fg: var(--primary-text-color, rgba(36,40,50,.94)); --dc-muted: var(--secondary-text-color, rgba(36,40,50,.58));
    --dc-danger: #D05B50; --dc-ok: #3F9D6B;
    --dc-radius: 26px; --dc-radius-sm: 16px;
    display: block; min-height: 100vh; background: var(--primary-background-color); color: var(--dc-fg);
    font-family: var(--ha-card-font-family, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif); font-size: 14px; line-height: 1.45;
  }
  * { box-sizing: border-box; }
  .toolbar { height: var(--header-height, 56px); display: flex; align-items: center; gap: 4px; padding: 0 12px;
    background: var(--app-header-background-color, var(--primary-background-color)); color: var(--app-header-text-color, var(--dc-fg));
    border-bottom: 1px solid var(--app-header-border-bottom, var(--divider-color)); }
  .title { font-size: 20px; font-weight: 400; flex: 1; }
  .busy { font-size: 13px; color: var(--dc-muted); }
  .page { max-width: 880px; margin: 0 auto; padding: 20px 16px 48px; display: flex; flex-direction: column; gap: 16px; }

  .pills { display: inline-flex; gap: 4px; padding: 4px; border-radius: 14px; background: var(--dc-surface); flex-wrap: wrap; }
  .pills button { border: 0; background: transparent; color: var(--dc-muted); font: inherit; font-weight: 600; font-size: 14px;
    padding: 9px 16px; border-radius: 10px; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; transition: background .15s, color .15s; }
  .pills button ha-icon { --mdc-icon-size: 18px; }
  .pills button.on { background: var(--card-background-color, #fff); color: var(--dc-fg); box-shadow: 0 1px 4px rgba(0,0,0,.10); }
  .pills.small button { font-size: 13px; padding: 7px 12px; }
  .pills.small button ha-icon { --mdc-icon-size: 16px; }
  .tabs { align-self: center; background: rgba(36,40,50,.07); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dc-accent); }

  .card { background: var(--card-background-color, #fff); border: 1px solid var(--dc-hairline); border-radius: var(--dc-radius); overflow: hidden; }
  .card.accent-warm { --dc-accent: var(--dc-warm); --dc-accent-soft: var(--dc-warm-soft); }
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
  .text { font: inherit; font-size: 14px; color: var(--dc-fg); background: var(--dc-surface); border: 1px solid transparent; border-radius: 12px;
    padding: 10px 14px; width: 100%; max-width: 360px; outline: none; transition: border-color .15s, background .15s; }
  .text:focus { border-color: var(--dc-accent); background: var(--card-background-color, #fff); }
  .text.time { width: auto; padding: 8px 12px; font-variant-numeric: tabular-nums; }
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

  @media (max-width: 700px) {
    .page { padding: 12px 10px 40px; }
    .editor { padding: 0 8px 10px; }
    .f { grid-template-columns: 1fr; gap: 6px; }
    .tabs { align-self: stretch; } .tabs button { flex: 1; justify-content: center; }
  }
`;

if (!customElements.get("climate-manager-panel")) customElements.define("climate-manager-panel", ClimateManagerPanel);
