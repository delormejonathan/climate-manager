/* Climate Manager — settings panel (sidebar « Climat », admins only).
 *
 * One place for everything that is set once in a while:
 *   Comfort  — season and comfort profiles, edited once for every zone
 *   Zones    — rooms and their equipment (climate entity, sensors, windows…)
 *   House    — presence (who decides "home" / "away")
 * Daily control stays on the dashboard card.
 */

const SEASONS = {
  winter: { label: "Hiver", icon: "mdi:snowflake", mode: "heat", verb: "Chauffe" },
  summer: { label: "Été", icon: "mdi:white-balance-sunny", mode: "cool", verb: "Refroidit" },
};
const POWER = [["doux", "Doux"], ["normal", "Normal"], ["agressif", "Fort"]];
const FAN = [["doux", "Douce"], ["normal", "Normale"], ["fort", "Forte"]];
const STATE_LABELS = {
  disarmed: "Désarmée", armed_home: "Armée, présent", armed_away: "Armée, absent",
  armed_night: "Armée, nuit", armed_vacation: "Armée, vacances", armed_custom_bypass: "Armée, perso",
  triggered: "Déclenchée", home: "À la maison", not_home: "Absent", on: "Oui", off: "Non",
};
const KNOWN_STATES = {
  alarm_control_panel: ["disarmed", "armed_home", "armed_away", "armed_night", "armed_vacation"],
  person: ["home", "not_home"], device_tracker: ["home", "not_home"],
  binary_sensor: ["on", "off"], input_boolean: ["on", "off"], group: ["home", "not_home", "on", "off"],
};
const AWAY_HINTS = ["armed_away", "armed_vacation", "not_home", "away"];
const PROFILE_TEXT_FIELDS = ["active_from", "active_to"];
const PROFILE_NUMBER_FIELDS = ["seuil_demarrage", "target", "target_cutoff", "kickstart_minutes"];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const deg = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? "—" : `${Number(v).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} °C`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const sameSet = (a, b) => {
  const x = [].concat(a || []).sort(); const y = [].concat(b || []).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

class ClimateManagerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "comfort";
    this._settings = null;
    this._error = null;
    this._editor = null;     // profile editor state
    this._zoneDrafts = {};   // zone_id|"new" -> draft
    this._houseDraft = null;
    this._busy = false;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      const params = new URLSearchParams(window.location.search);
      if (["comfort", "zones", "house"].includes(params.get("tab"))) this._tab = params.get("tab");
      this._focusZone = params.get("zone");
      this._load();
    }
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.hass = hass;
  }
  set narrow(v) { this._narrow = v; const m = this.shadowRoot.querySelector("ha-menu-button"); if (m) m.narrow = v; }
  set panel(v) { this._panel = v; }
  set route(v) { this._route = v; }

  async _load() {
    try {
      this._settings = await this._hass.callWS({ type: "climate_manager/settings" });
      this._error = null;
    } catch (err) {
      this._error = err?.message || String(err);
    }
    this._render();
  }

  async _ws(msg, okText) {
    this._busy = true; this._render();
    try {
      await this._hass.callWS(msg);
      if (okText) this._toast(okText);
      await new Promise((r) => setTimeout(r, 400));
      await this._load();
      return true;
    } catch (err) {
      this._toast(`Erreur : ${err?.message || err}`);
      return false;
    } finally {
      this._busy = false; this._render();
    }
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  /* ------------------------------------------------------------------ helpers */

  _name(entityId) {
    const st = this._hass?.states?.[entityId];
    return st?.attributes?.friendly_name || entityId;
  }
  _zoneLabel(zone) { return zone?.name || zone?.id || "?"; }
  _entities(domain, deviceClass) {
    const classes = [].concat(deviceClass || []);
    return Object.values(this._hass.states)
      .filter((s) => s.entity_id.startsWith(`${domain}.`))
      .filter((s) => !classes.length || classes.includes(s.attributes.device_class))
      .map((s) => s.entity_id)
      .sort((a, b) => this._name(a).localeCompare(this._name(b), "fr"));
  }
  _notifyServices() {
    return Object.keys(this._hass.services?.notify || {}).map((s) => `notify.${s}`).sort();
  }

  /** Presence of the house: saved value, or inferred from the profiles. */
  _presence() {
    const h = this._settings.house;
    if (h.presence_entity) {
      return { entity: h.presence_entity, away: h.presence_absent_states || [], home: h.presence_home_states || [], inferred: false };
    }
    const counts = {}; const away = new Set(); const home = new Set();
    for (const z of this._settings.zones) {
      for (const bank of Object.values(z.profile_banks)) {
        for (const p of bank) {
          if (!p.presence_entity) continue;
          counts[p.presence_entity] = (counts[p.presence_entity] || 0) + 1;
          const states = [].concat(p.presence_required_state || []);
          const target = states.every((s) => AWAY_HINTS.includes(s)) ? away : home;
          states.forEach((s) => target.add(s));
        }
      }
    }
    const entity = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    return { entity, away: [...away], home: [...home], inferred: !!entity };
  }

  _occupancy(p) {
    if (!p.presence_entity) return "any";
    const pres = this._presence();
    const states = [].concat(p.presence_required_state || []);
    if (p.presence_entity === pres.entity) {
      if (sameSet(states, pres.away)) return "away";
      if (sameSet(states, pres.home)) return "home";
    }
    return "custom";
  }
  _occupancyLabel(p) {
    const o = this._occupancy(p);
    if (o === "any") return "Toujours";
    if (o === "away") return "Maison vide";
    if (o === "home") return "Maison occupée";
    const states = [].concat(p.presence_required_state || []).map((s) => STATE_LABELS[s] || s).join(" ou ");
    return `${this._name(p.presence_entity)} : ${states}`;
  }
  _whenLabel(p) {
    if (!p.active_from || !p.active_to || p.active_from === p.active_to) return "Toute la journée";
    return `${p.active_from} → ${p.active_to}`;
  }
  _comfortLabel(p, season) {
    const below = SEASONS[season].mode === "heat";
    return `${below ? "sous" : "au-dessus de"} ${deg(p.seuil_demarrage)} → vise ${deg(p.target)}`;
  }
  _deviceLabel(p) {
    const power = (POWER.find(([v]) => v === p.power) || [, p.power || "Normal"])[1];
    const fan = (FAN.find(([v]) => v === p.fan_intensity) || [, p.fan_intensity || "Normale"])[1];
    const kick = Number(p.kickstart_minutes) > 0 ? ` · démarrage renforcé ${p.kickstart_minutes} min` : "";
    return `${power}, ventilation ${fan.toLowerCase()}${kick}`;
  }

  /** Profiles of one season merged by name across zones, in priority order. */
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
    const ref = row.zones[ids[0]];
    const keys = ["active_from", "active_to", "presence_entity", "presence_required_state", "seuil_demarrage", "target", "target_cutoff", "power", "fan_intensity", "kickstart_minutes"];
    const differs = keys.filter((k) => ids.some((id) => JSON.stringify(row.zones[id][k] ?? null) !== JSON.stringify(ref[k] ?? null)));
    if (!differs.length) return [];
    return ids.map((id) => {
      const zone = this._settings.zones.find((z) => z.id === id);
      return `${this._zoneLabel(zone)} : ${this._deviceLabel(row.zones[id])}${differs.some((k) => !["power", "fan_intensity", "kickstart_minutes"].includes(k)) ? ` · ${this._whenLabel(row.zones[id])} · ${deg(row.zones[id].seuil_demarrage)} → ${deg(row.zones[id].target)}` : ""}`;
    });
  }

  /* ------------------------------------------------------------------ render */

  _render() {
    const root = this.shadowRoot;
    const focus = root.activeElement;
    const focusKey = focus?.dataset?.key;
    root.innerHTML = `<style>${STYLES}</style>
      <div class="toolbar">
        <ha-menu-button></ha-menu-button>
        <div class="title">Climat</div>
        <div class="spacer"></div>
        ${this._busy ? '<div class="busy">Enregistrement…</div>' : ""}
      </div>
      <div class="tabs">
        ${[["comfort", "mdi:calendar-clock", "Confort"], ["zones", "mdi:floor-plan", "Zones"], ["house", "mdi:home-account", "Maison"]]
          .map(([id, icon, label]) => `<button class="tab ${this._tab === id ? "on" : ""}" data-tab="${id}"><ha-icon icon="${icon}"></ha-icon>${label}</button>`).join("")}
      </div>
      <div class="content">${this._renderBody()}</div>
      ${this._editor ? this._renderEditor() : ""}`;
    const menu = root.querySelector("ha-menu-button");
    if (menu) { menu.hass = this._hass; menu.narrow = this._narrow; }
    this._wire();
    if (focusKey) root.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }

  _renderBody() {
    if (this._error) return `<div class="card error">Climate Manager ne répond pas : ${esc(this._error)}</div>`;
    if (!this._settings) return `<div class="card muted">Chargement…</div>`;
    if (this._tab === "zones") return this._renderZones();
    if (this._tab === "house") return this._renderHouse();
    return this._renderComfort();
  }

  _renderComfort() {
    const s = this._settings;
    if (!s.zones.length) {
      return `<div class="card empty"><ha-icon icon="mdi:floor-plan"></ha-icon><div><b>Aucune zone</b><p>Commence par déclarer une pièce et sa climatisation.</p></div>
        <button class="primary" data-tab="zones">Ajouter une zone</button></div>`;
    }
    const active = s.house.season;
    const live = s.zones.map((z) => {
      const st = z.live || {};
      return `<div class="live"><span class="live-name">${esc(this._zoneLabel(z))}</span>
        <span class="live-temp">${deg(st.room_temperature)}</span>
        <span class="live-profile">${st.active_profile_name ? `${esc(st.active_profile_name)}` : "aucun profil actif"}</span></div>`;
    }).join("");
    const seasons = ["winter", "summer"].sort((a, b) => (a === active ? -1 : b === active ? 1 : 0));
    return `
      <div class="card season-card">
        <div class="season-head">
          <div><div class="label">Saison</div><div class="hint">Toutes les zones suivent le programme de la saison choisie.</div></div>
          <div class="seg">${["winter", "summer"].map((k) => `<button data-season="${k}" class="${active === k ? "on" : ""}"><ha-icon icon="${SEASONS[k].icon}"></ha-icon>${SEASONS[k].label}</button>`).join("")}</div>
        </div>
        ${active === "mixed" ? '<div class="warn">Les zones ne sont pas sur la même saison : choisis-en une.</div>' : ""}
        <div class="lives">${live}</div>
      </div>
      ${seasons.map((season) => this._renderProgram(season, season === active)).join("")}`;
  }

  _renderProgram(season, isActive) {
    const rows = this._rows(season);
    const zones = this._settings.zones;
    const activeNames = new Set(zones.map((z) => isActive && z.live?.active_profile_name).filter(Boolean));
    const body = rows.length ? rows.map((row, i) => {
      const ref = Object.values(row.zones)[0];
      const zoneIds = Object.keys(row.zones);
      const allZones = zoneIds.length === zones.length;
      const diffs = this._rowDiffs(row);
      return `<div class="row ${activeNames.has(row.name) ? "is-active" : ""}" data-edit="${season}|${esc(row.name)}">
          <div class="rank">${i + 1}</div>
          <div class="cell name"><b>${esc(row.name)}</b>${activeNames.has(row.name) ? '<span class="badge">En cours</span>' : ""}</div>
          <div class="cell"><ha-icon icon="mdi:clock-outline"></ha-icon>${esc(this._whenLabel(ref))}</div>
          <div class="cell"><ha-icon icon="mdi:home-outline"></ha-icon>${esc(this._occupancyLabel(ref))}</div>
          <div class="cell"><ha-icon icon="mdi:thermometer"></ha-icon>${esc(this._comfortLabel(ref, season))}</div>
          <div class="cell zones">${allZones ? "Toutes les zones" : zoneIds.map((id) => esc(this._zoneLabel(zones.find((z) => z.id === id)))).join(", ")}</div>
          <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
          ${diffs.length ? `<div class="diffs">${diffs.map((d) => `<span>${esc(d)}</span>`).join("")}</div>` : `<div class="diffs single"><span>${esc(this._deviceLabel(ref))}</span></div>`}
        </div>`;
    }).join("") : `<div class="muted pad">Aucun profil : la climatisation ne démarrera jamais seule en ${SEASONS[season].label.toLowerCase()}.</div>`;
    return `<div class="card program ${isActive ? "" : "dim"}">
        <div class="card-head">
          <div><ha-icon icon="${SEASONS[season].icon}"></ha-icon><b>Programme ${SEASONS[season].label.toLowerCase()}</b>
            ${isActive ? '<span class="badge">En service</span>' : '<span class="muted small">en réserve</span>'}</div>
          <button class="ghost" data-add="${season}"><ha-icon icon="mdi:plus"></ha-icon>Profil</button>
        </div>
        <div class="hint pad-x">Le premier profil dont l'horaire et la présence correspondent s'applique. ${SEASONS[season].verb} quand la pièce passe le seuil, jusqu'à la température visée.</div>
        <div class="rows">${body}</div>
      </div>`;
  }

  /* -------------------------------------------------------------- editor */

  _openEditor(season, name) {
    const zones = this._settings.zones;
    const row = name !== null ? this._rows(season).find((r) => r.name === name) : null;
    const base = row ? clone(Object.values(row.zones)[0]) : {
      name: "", mode: SEASONS[season].mode, active_from: null, active_to: null, presence_entity: null,
      presence_required_state: null, seuil_demarrage: season === "winter" ? 19 : 27, target: season === "winter" ? 20 : 25,
      target_cutoff: null, power: "normal", fan_intensity: "normal", kickstart_minutes: 0,
    };
    this._editor = {
      season, original: row ? row.name : null,
      zoneIds: row ? Object.keys(row.zones) : zones.map((z) => z.id),
      perZone: row ? clone(row.zones) : {},
      values: base, dirty: new Set(row ? [] : Object.keys(base)),
      diffLines: row ? this._rowDiffs(row) : [],
    };
    this._render();
  }

  _renderEditor() {
    const e = this._editor; const v = e.values; const zones = this._settings.zones;
    const occ = this._occupancy(v);
    const pres = this._presence();
    const allDay = !v.active_from || !v.active_to;
    const seg = (field, options, current) => `<div class="seg small">${options.map(([val, label]) => `<button data-set="${field}" data-val="${val}" class="${current === val ? "on" : ""}">${label}</button>`).join("")}</div>`;
    const heat = SEASONS[e.season].mode === "heat";
    return `<div class="overlay" data-close="1">
      <div class="dialog" role="dialog">
        <div class="dialog-head"><b>${e.original ? `Profil « ${esc(e.original)} »` : "Nouveau profil"}</b><span class="muted small">${SEASONS[e.season].label}</span>
          <button class="icon" data-close="1"><ha-icon icon="mdi:close"></ha-icon></button></div>
        <div class="dialog-body">
          ${e.diffLines.length ? `<div class="warn">Ce profil diffère selon la zone. Le formulaire montre ${esc(this._zoneLabel(zones.find((z) => z.id === e.zoneIds[0])))}.</div>` : ""}
          <label class="field"><span>Nom</span><input data-key="name" data-field="name" value="${esc(v.name)}" placeholder="Présent, Nuit…"></label>
          <div class="group-title">Quand</div>
          <div class="line">
            <label class="check"><input type="checkbox" data-allday ${allDay ? "checked" : ""}>Toute la journée</label>
            ${allDay ? "" : `<label class="field inline"><span>De</span><input type="time" data-key="from" data-field="active_from" value="${esc(v.active_from || "")}"></label>
            <label class="field inline"><span>À</span><input type="time" data-key="to" data-field="active_to" value="${esc(v.active_to || "")}"></label>`}
          </div>
          <div class="field"><span>Présence</span>
            ${occ === "custom"
              ? `<div class="muted small">Condition personnalisée : ${esc(this._occupancyLabel(v))}</div>${seg("occupancy", [["any", "Toujours"], ["home", "Maison occupée"], ["away", "Maison vide"]], "")}`
              : seg("occupancy", [["any", "Toujours"], ["home", "Maison occupée"], ["away", "Maison vide"]], occ)}
            ${pres.entity ? "" : '<div class="warn">Règle d\'abord la présence dans l\'onglet Maison.</div>'}
          </div>
          <div class="group-title">Températures</div>
          <div class="line">
            <label class="field inline"><span>Démarre ${heat ? "sous" : "au-dessus de"}</span><span class="unit"><input type="number" step="0.5" data-key="start" data-field="seuil_demarrage" value="${esc(v.seuil_demarrage)}">°C</span></label>
            <label class="field inline"><span>Vise</span><span class="unit"><input type="number" step="0.5" data-key="target" data-field="target" value="${esc(v.target)}">°C</span></label>
            <label class="field inline"><span>Coupe à <i>(option)</i></span><span class="unit"><input type="number" step="0.5" data-key="cutoff" data-field="target_cutoff" value="${esc(v.target_cutoff ?? "")}" placeholder="—">°C</span></label>
          </div>
          <div class="group-title">Climatisation</div>
          <div class="line"><div class="field inline"><span>Puissance</span>${seg("power", POWER, v.power || "normal")}</div>
            <div class="field inline"><span>Ventilation</span>${seg("fan_intensity", FAN, v.fan_intensity || "normal")}</div></div>
          <label class="field inline"><span>Démarrage renforcé</span><span class="unit"><input type="number" min="0" step="5" data-key="kick" data-field="kickstart_minutes" value="${esc(v.kickstart_minutes || 0)}">min</span></label>
          <div class="group-title">Zones</div>
          <div class="line">${zones.map((z) => `<label class="check"><input type="checkbox" data-zone="${z.id}" ${e.zoneIds.includes(z.id) ? "checked" : ""}>${esc(this._zoneLabel(z))}</label>`).join("")}</div>
          ${e.diffLines.length ? `<div class="warn">Réglages actuels par zone : ${e.diffLines.map(esc).join("<br>")}<br>Seuls les champs que tu modifies s'appliquent à toutes les zones.</div>` : ""}
        </div>
        <div class="dialog-foot">
          ${e.original ? `<button class="danger" data-delete="1"><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer</button>
            <button class="ghost" data-move="-1" title="Plus prioritaire"><ha-icon icon="mdi:arrow-up"></ha-icon></button>
            <button class="ghost" data-move="1" title="Moins prioritaire"><ha-icon icon="mdi:arrow-down"></ha-icon></button>` : ""}
          <div class="spacer"></div>
          <button class="ghost" data-close="1">Annuler</button>
          <button class="primary" data-save="1" ${this._busy ? "disabled" : ""}>Enregistrer</button>
        </div>
      </div></div>`;
  }

  _editorSet(field, value) {
    const e = this._editor;
    if (field === "occupancy") {
      const pres = this._presence();
      if (value === "any") { e.values.presence_entity = null; e.values.presence_required_state = null; }
      else {
        e.values.presence_entity = pres.entity;
        e.values.presence_required_state = value === "away" ? [...pres.away] : [...pres.home];
      }
      e.dirty.add("presence_entity"); e.dirty.add("presence_required_state");
      return;
    }
    if (PROFILE_NUMBER_FIELDS.includes(field)) value = value === "" ? null : Number(value);
    if (PROFILE_TEXT_FIELDS.includes(field)) value = value || null;
    e.values[field] = value;
    e.dirty.add(field);
  }

  _bankPayload(season, transform) {
    const banks = {};
    for (const z of this._settings.zones) banks[z.id] = clone(z.profile_banks[season] || []);
    transform(banks);
    return { type: "climate_manager/profiles/save", season, banks };
  }

  async _saveEditor() {
    const e = this._editor; const v = e.values;
    if (!String(v.name || "").trim()) { this._toast("Donne un nom au profil."); return; }
    if (!e.zoneIds.length) { this._toast("Choisis au moins une zone."); return; }
    const name = v.name.trim();
    const clash = e.original !== name && this._rows(e.season).some((r) => r.name === name);
    if (clash) { this._toast(`Un profil « ${name} » existe déjà.`); return; }
    const msg = this._bankPayload(e.season, (banks) => {
      for (const zone of this._settings.zones) {
        const list = banks[zone.id];
        const idx = e.original ? list.findIndex((p) => p.name === e.original) : -1;
        if (!e.zoneIds.includes(zone.id)) { if (idx >= 0) list.splice(idx, 1); continue; }
        const current = idx >= 0 ? list[idx] : clone(e.perZone[zone.id] || v);
        const next = { ...current };
        for (const f of (idx >= 0 ? e.dirty : Object.keys(v))) next[f] = v[f];
        next.name = name; next.mode = SEASONS[e.season].mode;
        if (idx >= 0) list[idx] = next;
        else {
          // keep the priority of the row when added to a new zone
          const order = this._rows(e.season).findIndex((r) => r.name === e.original);
          list.splice(order >= 0 ? Math.min(order, list.length) : list.length, 0, next);
        }
      }
    });
    if (await this._ws(msg, "Profil enregistré")) { this._editor = null; this._render(); }
  }

  async _deleteProfile() {
    const e = this._editor;
    if (!confirm(`Supprimer le profil « ${e.original} » de toutes les zones ?`)) return;
    const msg = this._bankPayload(e.season, (banks) => {
      for (const id of Object.keys(banks)) banks[id] = banks[id].filter((p) => p.name !== e.original);
    });
    if (await this._ws(msg, "Profil supprimé")) { this._editor = null; this._render(); }
  }

  async _moveProfile(delta) {
    const e = this._editor;
    const names = this._rows(e.season).map((r) => r.name);
    const i = names.indexOf(e.original); const j = i + delta;
    if (i < 0 || j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]];
    const msg = this._bankPayload(e.season, (banks) => {
      for (const id of Object.keys(banks)) banks[id].sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
    });
    await this._ws(msg, "Ordre enregistré");
  }

  /* -------------------------------------------------------------- zones */

  _zoneDraft(zone) {
    const key = zone ? zone.id : "new";
    if (!this._zoneDrafts[key]) {
      this._zoneDrafts[key] = zone ? clone(zone) : {
        name: "", climate_entity: "", temperature_sensors: [], window_sensors: [],
        consumption_sensor_cool: null, consumption_sensor_heat: null, override_duree_min: 30,
        anomaly_delay_min: 60, anomaly_heat_gain_per_hour: 0.5, anomaly_cool_gain_per_hour: 0.5,
        anomaly_notification_service: null, _new: true,
      };
    }
    return this._zoneDrafts[key];
  }

  _renderZones() {
    const zones = this._settings.zones;
    const cards = zones.map((z) => this._renderZoneCard(z)).join("");
    const adding = this._zoneDrafts.new;
    return `${cards}${adding ? this._renderZoneCard(null) : `<button class="add-card" data-add-zone="1"><ha-icon icon="mdi:plus"></ha-icon>Ajouter une zone</button>`}`;
  }

  _select(key, value, options, placeholder) {
    return `<select data-key="${key}" data-zfield="${key.split(":")[1]}">
      <option value="">${esc(placeholder)}</option>
      ${options.map((id) => `<option value="${esc(id)}" ${id === value ? "selected" : ""}>${esc(this._name(id))}</option>`).join("")}
      ${value && !options.includes(value) ? `<option value="${esc(value)}" selected>${esc(value)}</option>` : ""}
    </select>`;
  }

  _chips(zkey, field, values, options, addLabel) {
    const rest = options.filter((o) => !values.includes(o));
    return `<div class="chips">${values.map((id) => {
      const st = this._hass.states[id];
      const val = st ? (st.attributes.unit_of_measurement ? deg(st.state) : (STATE_LABELS[st.state] || st.state)) : "introuvable";
      return `<span class="chip ${st ? "" : "bad"}">${esc(this._name(id))}<em>${esc(val)}</em><button data-remove="${zkey}|${field}|${esc(id)}" title="Retirer"><ha-icon icon="mdi:close"></ha-icon></button></span>`;
    }).join("")}
      <select data-append="${zkey}|${field}"><option value="">${esc(addLabel)}</option>${rest.map((id) => `<option value="${esc(id)}">${esc(this._name(id))}</option>`).join("")}</select></div>`;
  }

  _renderZoneCard(zone) {
    const zkey = zone ? zone.id : "new";
    const d = this._zoneDraft(zone);
    const dirty = zone ? JSON.stringify(this._zoneFields(d)) !== JSON.stringify(this._zoneFields(zone)) : true;
    const k = (f) => `${zkey}:${f}`;
    const num = (f, step, unit, min = 0) => `<span class="unit"><input type="number" min="${min}" step="${step}" data-key="${k(f)}" data-zfield="${f}" value="${esc(d[f] ?? "")}">${unit}</span>`;
    const live = zone?.live || {};
    return `<div class="card zone ${this._focusZone && zone && (this._focusZone === zone.id || this._focusZone.toLowerCase() === zone.name.toLowerCase()) ? "focus" : ""}" data-zone-card="${zkey}">
      <div class="card-head">
        <div><ha-icon icon="mdi:floor-plan"></ha-icon><b>${zone ? esc(this._zoneLabel(zone)) : "Nouvelle zone"}</b>
          ${zone ? `<span class="muted small">${deg(live.room_temperature)}${live.active_profile_name ? ` · ${esc(live.active_profile_name)}` : ""}</span>` : ""}</div>
      </div>
      <div class="zone-grid">
        <label class="field"><span>Nom</span><input data-key="${k("name")}" data-zfield="name" value="${esc(d.name)}"></label>
        <label class="field"><span>Climatisation</span>${this._select(k("climate_entity"), d.climate_entity, this._entities("climate"), "Choisir un appareil")}</label>
        <div class="field wide"><span>Capteurs de température <i>(la zone prend leur moyenne)</i></span>${this._chips(zkey, "temperature_sensors", d.temperature_sensors, this._entities("sensor", "temperature"), "Ajouter un capteur…")}</div>
        <div class="field wide"><span>Fenêtres <i>(ouverte = la climatisation s'arrête)</i></span>${this._chips(zkey, "window_sensors", d.window_sensors, this._entities("binary_sensor", ["window", "opening", "door"]), "Ajouter une fenêtre…")}</div>
      </div>
      <details ${zone ? "" : "open"}><summary>Réglages avancés</summary>
        <div class="zone-grid">
          <label class="field"><span>Compteur kWh chauffage</span>${this._select(k("consumption_sensor_heat"), d.consumption_sensor_heat, this._entities("sensor", "energy"), "Aucun")}</label>
          <label class="field"><span>Compteur kWh froid</span>${this._select(k("consumption_sensor_cool"), d.consumption_sensor_cool, this._entities("sensor", "energy"), "Aucun")}</label>
          <label class="field"><span>Après une commande à la main, reprise auto dans</span>${num("override_duree_min", 5, "min", 5)}</label>
          <label class="field"><span>Contrôle d'efficacité après</span>${num("anomaly_delay_min", 5, "min", 15)}</label>
          <label class="field"><span>Gain minimum en chauffage</span>${num("anomaly_heat_gain_per_hour", 0.1, "°C/h")}</label>
          <label class="field"><span>Gain minimum en froid</span>${num("anomaly_cool_gain_per_hour", 0.1, "°C/h")}</label>
          <label class="field wide"><span>Alerte envoyée à</span>${this._select(k("anomaly_notification_service"), d.anomaly_notification_service, this._notifyServices(), "Aucune notification")}</label>
        </div>
      </details>
      <div class="card-foot">
        ${zone ? `<button class="danger" data-delete-zone="${zone.id}"><ha-icon icon="mdi:delete-outline"></ha-icon>Supprimer</button>` : `<button class="ghost" data-cancel-zone="new">Annuler</button>`}
        <div class="spacer"></div>
        ${zone && dirty ? `<button class="ghost" data-cancel-zone="${zkey}">Annuler</button>` : ""}
        <button class="primary" data-save-zone="${zkey}" ${dirty && !this._busy ? "" : "disabled"}>${zone ? "Enregistrer" : "Créer la zone"}</button>
      </div>
    </div>`;
  }

  _zoneFields(z) {
    const keys = ["name", "climate_entity", "temperature_sensors", "window_sensors", "consumption_sensor_cool", "consumption_sensor_heat",
      "override_duree_min", "anomaly_delay_min", "anomaly_heat_gain_per_hour", "anomaly_cool_gain_per_hour", "anomaly_notification_service"];
    return Object.fromEntries(keys.map((k) => [k, z[k] === "" ? null : z[k] ?? null]));
  }

  async _saveZone(zkey) {
    const d = this._zoneDrafts[zkey];
    const zone = this._zoneFields(d);
    if (!zone.name?.trim()) return this._toast("Donne un nom à la zone.");
    if (!zone.climate_entity) return this._toast("Choisis la climatisation de la zone.");
    if (!zone.temperature_sensors.length) return this._toast("Ajoute au moins un capteur de température.");
    for (const f of ["override_duree_min", "anomaly_delay_min", "anomaly_heat_gain_per_hour", "anomaly_cool_gain_per_hour"]) zone[f] = Number(zone[f]);
    const ok = await this._ws({ type: "climate_manager/zone/save", zone_id: zkey === "new" ? null : zkey, zone }, zkey === "new" ? "Zone créée" : "Zone enregistrée");
    if (ok) { delete this._zoneDrafts[zkey]; this._render(); }
  }

  /* -------------------------------------------------------------- house */

  _renderHouse() {
    const pres = this._presence();
    const d = this._houseDraft || (this._houseDraft = { entity: pres.entity, away: [...pres.away], home: [...pres.home] });
    const domain = d.entity ? d.entity.split(".")[0] : null;
    const current = d.entity ? this._hass.states[d.entity]?.state : null;
    const states = [...new Set([...(KNOWN_STATES[domain] || []), ...d.away, ...d.home, ...(current ? [current] : [])])];
    const candidates = ["alarm_control_panel", "person", "group", "binary_sensor", "input_boolean", "device_tracker"].flatMap((dom) => this._entities(dom));
    const saved = this._settings.house.presence_entity;
    const dirty = !saved || d.entity !== saved || !sameSet(d.away, this._settings.house.presence_absent_states) || !sameSet(d.home, this._settings.house.presence_home_states);
    const toggles = (kind) => `<div class="chips">${states.map((s) => `<button class="toggle ${d[kind].includes(s) ? "on" : ""}" data-pstate="${kind}|${esc(s)}">${esc(STATE_LABELS[s] || s)}${s === current ? " <em>maintenant</em>" : ""}</button>`).join("")}</div>`;
    return `<div class="card">
      <div class="card-head"><div><ha-icon icon="mdi:home-account"></ha-icon><b>Présence</b></div></div>
      <div class="hint pad-x">Les profils « Maison occupée » et « Maison vide » s'appuient sur ce réglage, une seule fois pour toute la maison.</div>
      ${pres.inferred && !saved ? '<div class="warn mx">Proposition tirée de tes profils actuels : vérifie puis enregistre.</div>' : ""}
      <div class="zone-grid">
        <label class="field wide"><span>Ce qui indique si la maison est occupée</span>
          <select data-house="entity"><option value="">Aucun</option>${candidates.map((id) => `<option value="${esc(id)}" ${id === d.entity ? "selected" : ""}>${esc(this._name(id))}</option>`).join("")}</select></label>
        ${d.entity ? `<div class="field wide"><span>Maison occupée quand l'état est</span>${toggles("home")}</div>
        <div class="field wide"><span>Maison vide quand l'état est</span>${toggles("away")}</div>` : ""}
      </div>
      <div class="card-foot"><div class="spacer"></div>
        <button class="primary" data-save-house="1" ${dirty && !this._busy ? "" : "disabled"}>Enregistrer</button></div>
    </div>
    <div class="card">
      <div class="card-head"><div><ha-icon icon="mdi:view-dashboard-outline"></ha-icon><b>Au quotidien</b></div></div>
      <div class="hint pad-x pad-b">Allumer, couper, booster et suivre les sessions se fait depuis la carte Climate Manager du tableau de bord. Ce panneau ne sert qu'aux réglages.</div>
    </div>`;
  }

  async _saveHouse() {
    const d = this._houseDraft;
    const oldPres = this._presence();
    const ok = await this._ws({
      type: "climate_manager/house/save",
      presence_entity: d.entity || null, presence_absent_states: d.away, presence_home_states: d.home,
    }, "Présence enregistrée");
    if (!ok) return;
    // Profiles that followed the old "home"/"away" definition follow the new one.
    for (const season of Object.keys(SEASONS)) {
      let changed = false;
      const msg = this._bankPayload(season, (banks) => {
        for (const list of Object.values(banks)) for (const p of list) {
          if (!p.presence_entity || p.presence_entity !== oldPres.entity) continue;
          const st = [].concat(p.presence_required_state || []);
          const kind = sameSet(st, oldPres.away) ? "away" : sameSet(st, oldPres.home) ? "home" : null;
          if (!kind || !d.entity) continue;
          const next = kind === "away" ? d.away : d.home;
          if (p.presence_entity !== d.entity || !sameSet(st, next)) { p.presence_entity = d.entity; p.presence_required_state = [...next]; changed = true; }
        }
      });
      if (changed) await this._ws(msg);
    }
    this._houseDraft = null; this._render();
  }

  /* -------------------------------------------------------------- events */

  _wire() {
    const root = this.shadowRoot;
    root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      this._tab = b.dataset.tab;
      if (this._tab === "zones" && !this._settings?.zones.length) this._zoneDraft(null);
      const url = new URL(window.location.href); url.searchParams.set("tab", this._tab); url.searchParams.delete("zone");
      history.replaceState(null, "", url); this._focusZone = null; this._render();
    }));
    root.querySelectorAll("[data-season]").forEach((b) => b.addEventListener("click", () => {
      if (b.classList.contains("on")) return;
      this._ws({ type: "climate_manager/season/set", season: b.dataset.season }, `Saison : ${SEASONS[b.dataset.season].label}`);
    }));
    root.querySelectorAll("[data-edit]").forEach((r) => r.addEventListener("click", () => {
      const [season, ...rest] = r.dataset.edit.split("|"); this._openEditor(season, rest.join("|"));
    }));
    root.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => this._openEditor(b.dataset.add, null)));

    // editor
    root.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", (ev) => {
      if (ev.target !== el && !el.matches("button")) return;
      this._editor = null; this._render();
    }));
    root.querySelectorAll("[data-field]").forEach((input) => input.addEventListener("change", () => { this._editorSet(input.dataset.field, input.value); }));
    root.querySelectorAll("[data-field]").forEach((input) => input.addEventListener("input", () => { this._editorSet(input.dataset.field, input.value); }));
    root.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => { this._editorSet(b.dataset.set, b.dataset.val); this._render(); }));
    root.querySelector("[data-allday]")?.addEventListener("change", (ev) => {
      if (ev.target.checked) { this._editorSet("active_from", null); this._editorSet("active_to", null); }
      else { this._editorSet("active_from", "07:00"); this._editorSet("active_to", "23:00"); }
      this._render();
    });
    root.querySelectorAll("[data-zone]").forEach((c) => c.addEventListener("change", () => {
      const ids = this._editor.zoneIds;
      this._editor.zoneIds = c.checked ? [...new Set([...ids, c.dataset.zone])] : ids.filter((i) => i !== c.dataset.zone);
    }));
    root.querySelector("[data-save]")?.addEventListener("click", () => this._saveEditor());
    root.querySelector("[data-delete]")?.addEventListener("click", () => this._deleteProfile());
    root.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", () => this._moveProfile(Number(b.dataset.move))));

    // zones
    root.querySelector("[data-add-zone]")?.addEventListener("click", () => { this._zoneDraft(null); this._render(); });
    root.querySelectorAll("[data-zfield]").forEach((input) => {
      const card = input.closest("[data-zone-card]"); const zkey = card.dataset.zoneCard;
      const update = (rerender) => {
        const d = this._zoneDrafts[zkey] || this._zoneDraft(this._settings.zones.find((z) => z.id === zkey));
        d[input.dataset.zfield] = input.value === "" ? null : input.value;
        if (rerender) this._render(); else this._refreshZoneFoot(zkey);
      };
      input.addEventListener("input", () => update(false));
      input.addEventListener("change", () => update(input.tagName === "SELECT"));
    });
    root.querySelectorAll("[data-append]").forEach((sel) => sel.addEventListener("change", () => {
      const [zkey, field] = sel.dataset.append.split("|");
      const d = this._zoneDrafts[zkey] || this._zoneDraft(this._settings.zones.find((z) => z.id === zkey));
      if (sel.value) d[field] = [...(d[field] || []), sel.value];
      this._render();
    }));
    root.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", () => {
      const [zkey, field, id] = b.dataset.remove.split("|");
      const d = this._zoneDrafts[zkey] || this._zoneDraft(this._settings.zones.find((z) => z.id === zkey));
      d[field] = d[field].filter((x) => x !== id);
      this._render();
    }));
    root.querySelectorAll("[data-save-zone]").forEach((b) => b.addEventListener("click", () => this._saveZone(b.dataset.saveZone)));
    root.querySelectorAll("[data-cancel-zone]").forEach((b) => b.addEventListener("click", () => { delete this._zoneDrafts[b.dataset.cancelZone]; this._render(); }));
    root.querySelectorAll("[data-delete-zone]").forEach((b) => b.addEventListener("click", () => {
      const zone = this._settings.zones.find((z) => z.id === b.dataset.deleteZone);
      if (!confirm(`Supprimer la zone « ${this._zoneLabel(zone)} » ? Ses profils et ses entités disparaissent.`)) return;
      this._ws({ type: "climate_manager/zone/delete", zone_id: zone.id }, "Zone supprimée");
    }));

    // house
    root.querySelector('[data-house="entity"]')?.addEventListener("change", (ev) => {
      const entity = ev.target.value || null;
      const dom = entity ? entity.split(".")[0] : null;
      const known = KNOWN_STATES[dom] || [];
      this._houseDraft = { entity, away: known.filter((s) => AWAY_HINTS.includes(s)), home: known.filter((s) => !AWAY_HINTS.includes(s) && s !== "off") };
      this._render();
    });
    root.querySelectorAll("[data-pstate]").forEach((b) => b.addEventListener("click", () => {
      const [kind, s] = b.dataset.pstate.split("|"); const other = kind === "away" ? "home" : "away";
      const d = this._houseDraft;
      d[kind] = d[kind].includes(s) ? d[kind].filter((x) => x !== s) : [...d[kind], s];
      d[other] = d[other].filter((x) => x !== s);
      this._render();
    }));
    root.querySelector("[data-save-house]")?.addEventListener("click", () => this._saveHouse());
  }

  _refreshZoneFoot(zkey) {
    const zone = this._settings.zones.find((z) => z.id === zkey);
    const btn = this.shadowRoot.querySelector(`[data-save-zone="${zkey}"]`);
    if (!btn || !zone) return;
    const dirty = JSON.stringify(this._zoneFields(this._zoneDrafts[zkey])) !== JSON.stringify(this._zoneFields(zone));
    btn.disabled = !dirty || this._busy;
  }
}

const STYLES = `
  :host { display: block; min-height: 100vh; background: var(--primary-background-color); color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, inherit); --cm-radius: 14px; --cm-line: var(--divider-color, rgba(0,0,0,.12)); }
  .toolbar { height: var(--header-height, 56px); display: flex; align-items: center; gap: 8px; padding: 0 12px;
    background: var(--app-header-background-color, var(--primary-background-color)); color: var(--app-header-text-color, var(--primary-text-color));
    border-bottom: 1px solid var(--app-header-border-bottom, var(--cm-line)); box-sizing: border-box; }
  .title { font-size: 20px; font-weight: 400; margin-left: 4px; }
  .spacer { flex: 1; }
  .busy { font-size: 13px; color: var(--secondary-text-color); }
  .tabs { display: flex; gap: 4px; padding: 12px 16px 0; max-width: 1100px; margin: 0 auto; box-sizing: border-box; }
  .tab { display: inline-flex; align-items: center; gap: 8px; border: 0; background: none; padding: 10px 16px; font: inherit; font-size: 14px;
    color: var(--secondary-text-color); border-bottom: 2px solid transparent; cursor: pointer; }
  .tab ha-icon { --mdc-icon-size: 18px; }
  .tab.on { color: var(--primary-color); border-bottom-color: var(--primary-color); font-weight: 500; }
  .content { max-width: 1100px; margin: 0 auto; padding: 16px; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; }
  .card { background: var(--card-background-color); border: 1px solid var(--cm-line); border-radius: var(--cm-radius); }
  .card.dim { opacity: .82; }
  .card.focus { box-shadow: 0 0 0 2px var(--primary-color); }
  .card.error { padding: 16px; color: var(--error-color); }
  .card-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 4px; }
  .card-head > div { display: flex; align-items: center; gap: 10px; }
  .card-head ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); }
  .card-foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--cm-line); margin-top: 8px; }
  .hint { font-size: 13px; color: var(--secondary-text-color); line-height: 1.45; }
  .pad { padding: 16px; } .pad-x { padding: 0 16px; } .pad-b { padding-bottom: 16px; } .mx { margin: 8px 16px 0; }
  .muted { color: var(--secondary-text-color); } .small { font-size: 12px; }
  .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: rgba(var(--rgb-primary-color, 3,169,244), .14); color: var(--primary-color); }
  .warn { font-size: 13px; padding: 8px 12px; border-radius: 10px; background: rgba(var(--rgb-warning-color, 255,166,0), .14); color: var(--primary-text-color); }
  button { font: inherit; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  .primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border: 0; border-radius: 10px; padding: 8px 16px; font-weight: 500; }
  .ghost { background: none; border: 1px solid var(--cm-line); color: var(--primary-text-color); border-radius: 10px; padding: 7px 12px; display: inline-flex; align-items: center; gap: 6px; }
  .danger { background: none; border: 0; color: var(--error-color); display: inline-flex; align-items: center; gap: 6px; padding: 7px 4px; }
  .ghost ha-icon, .danger ha-icon { --mdc-icon-size: 18px; }
  .icon { background: none; border: 0; color: var(--secondary-text-color); padding: 4px; margin-left: auto; }

  .season-card { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
  .season-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .label { font-weight: 600; font-size: 15px; }
  .seg { display: inline-flex; border: 1px solid var(--cm-line); border-radius: 12px; padding: 3px; gap: 2px; background: var(--primary-background-color); flex-wrap: wrap; }
  .seg button { border: 0; background: none; padding: 7px 14px; border-radius: 9px; color: var(--secondary-text-color); display: inline-flex; align-items: center; gap: 6px; }
  .seg button ha-icon { --mdc-icon-size: 18px; }
  .seg button.on { background: var(--card-background-color); color: var(--primary-text-color); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
  .seg.small button { padding: 5px 11px; font-size: 13px; }
  .lives { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
  .live { display: flex; align-items: baseline; gap: 10px; padding: 10px 12px; border-radius: 10px; background: var(--primary-background-color); }
  .live-name { font-weight: 600; } .live-temp { font-variant-numeric: tabular-nums; } .live-profile { margin-left: auto; font-size: 12px; color: var(--secondary-text-color); }

  .program .card-head b { font-size: 15px; }
  .rows { padding: 8px 8px 10px; display: flex; flex-direction: column; gap: 2px; }
  .row { display: grid; grid-template-columns: 28px minmax(120px, 1.1fr) minmax(130px, 1fr) minmax(130px, 1fr) minmax(200px, 1.5fr) minmax(110px, .9fr) 20px;
    align-items: center; gap: 4px 12px; padding: 10px 8px; border-radius: 10px; cursor: pointer; }
  .row:hover { background: var(--secondary-background-color, rgba(0,0,0,.04)); }
  .row.is-active { background: rgba(var(--rgb-primary-color, 3,169,244), .07); }
  .rank { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 600;
    background: var(--primary-background-color); color: var(--secondary-text-color); }
  .cell { display: flex; align-items: center; gap: 6px; font-size: 14px; min-width: 0; }
  .cell ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text-color); flex: none; }
  .cell.name { gap: 8px; } .cell.zones { font-size: 13px; color: var(--secondary-text-color); }
  .chev { --mdc-icon-size: 18px; color: var(--secondary-text-color); }
  .diffs { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--secondary-text-color); }

  .zone-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; padding: 12px 16px; }
  .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .field > span:first-child { color: var(--secondary-text-color); }
  .field i { font-style: normal; opacity: .8; }
  .field.wide { grid-column: 1 / -1; }
  .field.inline { flex: 1; min-width: 120px; }
  input, select { font: inherit; font-size: 14px; color: var(--primary-text-color); background: var(--card-background-color);
    border: 1px solid var(--cm-line); border-radius: 10px; padding: 8px 10px; box-sizing: border-box; min-width: 0; }
  input:focus, select:focus { outline: 2px solid rgba(var(--rgb-primary-color, 3,169,244), .35); border-color: var(--primary-color); }
  .unit { display: inline-flex; align-items: center; gap: 6px; color: var(--secondary-text-color); }
  .unit input { width: 90px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 4px 4px 10px; border-radius: 16px; background: var(--primary-background-color); font-size: 13px; }
  .chip em { font-style: normal; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .chip.bad { color: var(--error-color); }
  .chip button { border: 0; background: none; padding: 2px; color: var(--secondary-text-color); display: grid; }
  .chip button ha-icon { --mdc-icon-size: 14px; }
  .chips select { border-style: dashed; padding: 5px 8px; font-size: 13px; }
  .toggle { border: 1px solid var(--cm-line); background: none; border-radius: 16px; padding: 5px 12px; font-size: 13px; color: var(--primary-text-color); }
  .toggle.on { background: rgba(var(--rgb-primary-color, 3,169,244), .14); border-color: var(--primary-color); color: var(--primary-color); font-weight: 500; }
  .toggle em { font-style: normal; font-size: 11px; opacity: .7; }
  details { border-top: 1px solid var(--cm-line); }
  summary { padding: 12px 16px 0; font-size: 13px; color: var(--secondary-text-color); cursor: pointer; }
  details:not([open]) summary { padding-bottom: 12px; }
  .add-card { border: 1px dashed var(--cm-line); background: none; border-radius: var(--cm-radius); padding: 18px; color: var(--secondary-text-color);
    display: flex; align-items: center; justify-content: center; gap: 8px; }
  .empty { display: flex; align-items: center; gap: 16px; padding: 20px; }
  .empty ha-icon { --mdc-icon-size: 32px; color: var(--secondary-text-color); }
  .empty p { margin: 4px 0 0; color: var(--secondary-text-color); font-size: 14px; }
  .empty .primary { margin-left: auto; }

  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: grid; place-items: center; z-index: 10; padding: 16px; }
  .dialog { background: var(--card-background-color); border-radius: 18px; width: min(620px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
  .dialog-head { display: flex; align-items: center; gap: 10px; padding: 16px 16px 8px 20px; font-size: 16px; }
  .dialog-body { padding: 4px 20px 12px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
  .dialog-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--cm-line); }
  .group-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color); margin-top: 8px; }
  .line { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-end; }
  .check { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; padding: 8px 0; }
  .check input { width: 18px; height: 18px; padding: 0; }

  @media (max-width: 860px) {
    .row { grid-template-columns: 28px 1fr 20px; }
    .row .cell:not(.name) { grid-column: 2; }
    .row .chev { grid-row: 1; grid-column: 3; }
    .zone-grid { grid-template-columns: 1fr; }
    .content { padding: 12px; }
  }
`;

customElements.define("climate-manager-panel", ClimateManagerPanel);
