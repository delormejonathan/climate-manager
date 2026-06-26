"""DataUpdateCoordinator: orchestrates zones, reads HA state, applies commands."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.components.climate import (
    ATTR_CURRENT_TEMPERATURE,
    ATTR_FAN_MODE,
    ATTR_SWING_MODE,
    ATTR_TEMPERATURE,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Context, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .const import (
    CONF_PRESENCE_ABSENT_STATES,
    CONF_PRESENCE_ENTITY,
    CONF_ZONES,
    DOMAIN,
    OVERRIDE_DEBOUNCE_SECONDS,
    SENSOR_LAG_MIN_DETECTION_SECONDS,
    SENSOR_LAG_THRESHOLD_C,
    SETPOINT_NOOP_DELTA,
    UPDATE_INTERVAL_SECONDS,
    ProfileMode,
    ZoneMode,
    ZoneState,
)
from .context_tracker import ContextTracker
from .zone import (
    Command,
    Profile,
    Zone,
    ZoneConfig,
    ZoneInputs,
    ZoneRuntimeState,
    detect_lagging_sensors,
    utc_now_ts,
)

_LOGGER = logging.getLogger(__name__)


class DelormejClimateCoordinator(DataUpdateCoordinator):
    """Tick chaque zone, applique les commandes, persiste l'état."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=UPDATE_INTERVAL_SECONDS),
        )
        self.entry = entry
        self._context_tracker = ContextTracker()
        self._zones: dict[str, Zone] = {}
        self._unsub_state_listener = None
        self._pending_overrides: dict[str, dict[str, Any]] = {}
        self._runtime_store: Store = Store(
            hass, 3, f"{DOMAIN}_runtime_{entry.entry_id}"
        )
        self._last_runtime_payload: dict[str, Any] | None = None
        self._rebuild_zones()

    # === Public API ===

    @property
    def zones(self) -> dict[str, Zone]:
        return self._zones

    def zone(self, zone_id: str) -> Zone | None:
        return self._zones.get(zone_id)

    def update_zone_profiles(self, zone_id: str, profiles: list[dict[str, Any]]) -> None:
        """Remplace la cascade de profils d'une zone."""
        zone = self._zones.get(zone_id)
        if not zone:
            return
        parsed = [Profile.from_dict(p) for p in profiles]
        zone.config.profiles = parsed
        self._persist_zone_config(zone_id, profiles=[p.to_dict() for p in parsed])
        self.async_set_updated_data(self._build_coordinator_data())

    def update_zone_config(self, zone_id: str, **kwargs: Any) -> None:
        zone = self._zones.get(zone_id)
        if not zone:
            return
        for k, v in kwargs.items():
            if hasattr(zone.config, k):
                setattr(zone.config, k, v)
        self._persist_zone_config(zone_id, **kwargs)
        self.async_set_updated_data(self._build_coordinator_data())

    async def async_tick_now(self) -> None:
        await self.async_request_refresh()

    # === DataUpdateCoordinator hooks ===

    async def _async_setup(self) -> None:
        await self._load_runtime_state()
        await self._setup_state_listeners()

    async def _async_update_data(self) -> dict[str, Any]:
        for zone in self._zones.values():
            sensor_temps = self._read_sensor_temps(zone)
            inputs = self._gather_inputs(zone, sensor_temps)
            self._maybe_seed_cycle_start_kwh(zone, inputs)
            prev_state = zone.state.state
            commands = zone.tick(inputs)
            self._maybe_close_last_session_kwh(zone, prev_state)
            self._maybe_seed_sensor_baselines(zone, prev_state, sensor_temps)
            self._maybe_detect_lagging_sensors(zone, inputs, sensor_temps)
            self._maybe_clear_sensor_baselines(zone, prev_state)
            for cmd in commands:
                await self._apply_command(cmd)
        await self._save_runtime_state_if_changed()
        return self._build_coordinator_data()

    async def _load_runtime_state(self) -> None:
        data = await self._runtime_store.async_load() or {}
        zones_data = data.get("zones", {}) if isinstance(data, dict) else {}
        for zid, zone in self._zones.items():
            zone.state = ZoneRuntimeState.from_dict(zones_data.get(zid))
        self._last_runtime_payload = self._runtime_payload()

    def _runtime_payload(self) -> dict[str, Any]:
        return {
            "zones": {zid: zone.state.to_dict() for zid, zone in self._zones.items()}
        }

    async def _save_runtime_state_if_changed(self) -> None:
        payload = self._runtime_payload()
        if payload != self._last_runtime_payload:
            await self._runtime_store.async_save(payload)
            self._last_runtime_payload = payload

    # === Zone setup ===

    def _rebuild_zones(self) -> None:
        zones_cfg = self.entry.options.get(CONF_ZONES, [])
        new_zones: dict[str, Zone] = {}
        for cfg_dict in zones_cfg:
            zc = ZoneConfig.from_dict(cfg_dict)
            existing = self._zones.get(zc.zone_id)
            new_zones[zc.zone_id] = Zone(
                zc, state=existing.state if existing else ZoneRuntimeState()
            )
        self._zones = new_zones

    async def _setup_state_listeners(self) -> None:
        if self._unsub_state_listener:
            self._unsub_state_listener()
            self._unsub_state_listener = None
        self._cancel_pending_overrides()
        if not self._zones:
            return
        entities = [z.config.climate_entity for z in self._zones.values()]
        self._unsub_state_listener = async_track_state_change_event(
            self.hass, entities, self._on_clim_state_changed
        )

    async def async_reload_zones(self) -> None:
        self._rebuild_zones()
        await self._setup_state_listeners()
        await self.async_request_refresh()

    # === State listener: external override detection ===

    _OVERRIDE_TRIGGER_ATTRS = frozenset({
        "temperature", "fan_mode", "swing_mode", "swing_horizontal_mode",
        "preset_mode", "target_temp_high", "target_temp_low",
    })

    @callback
    def _on_clim_state_changed(self, event: Event[EventStateChangedData]) -> None:
        entity_id = event.data["entity_id"]
        new_state = event.data.get("new_state")
        old_state = event.data.get("old_state")
        if new_state is None or old_state is None:
            return
        zone = next(
            (z for z in self._zones.values() if z.config.climate_entity == entity_id), None
        )
        if zone is None:
            return
        if self._context_tracker.is_ours(event.context):
            return
        if old_state.state == new_state.state and not self._user_action_changed(
            old_state, new_state
        ):
            return
        # Debounce flap (X→Y→X) du polling Daikin BRP
        pending = self._pending_overrides.get(entity_id)
        if pending is None:
            pending = {"old_state": old_state, "new_state": new_state, "handle": None}
            self._pending_overrides[entity_id] = pending
        else:
            pending["new_state"] = new_state
            if pending["handle"] is not None:
                pending["handle"].cancel()
        pending["handle"] = self.hass.loop.call_later(
            OVERRIDE_DEBOUNCE_SECONDS,
            self._resolve_pending_override,
            entity_id,
            zone,
        )

    @callback
    def _resolve_pending_override(self, entity_id: str, zone: Zone) -> None:
        pending = self._pending_overrides.pop(entity_id, None)
        if pending is None:
            return
        old_state = pending["old_state"]
        new_state = pending["new_state"]
        if _is_echo_of_intent(zone, new_state.attributes or {}):
            return
        if old_state.state == new_state.state and not self._user_action_changed(
            old_state, new_state
        ):
            return
        now = utc_now_ts()
        profile_active = self._active_profile(zone) is not None
        zone.on_external_override(now, profile_active)
        self.hass.async_create_task(self.async_request_refresh())

    def _cancel_pending_overrides(self) -> None:
        for pending in self._pending_overrides.values():
            handle = pending.get("handle")
            if handle is not None:
                handle.cancel()
        self._pending_overrides.clear()

    async def async_shutdown(self) -> None:  # type: ignore[override]
        self._cancel_pending_overrides()
        if self._unsub_state_listener:
            self._unsub_state_listener()
            self._unsub_state_listener = None
        await super().async_shutdown()

    def _user_action_changed(self, old_state, new_state) -> bool:
        old_attrs = old_state.attributes or {}
        new_attrs = new_state.attributes or {}
        for attr in self._OVERRIDE_TRIGGER_ATTRS:
            if old_attrs.get(attr) != new_attrs.get(attr):
                return True
        return False

    # === Apply commands ===

    async def _apply_command(self, cmd: Command) -> None:
        ctx = Context()
        self._context_tracker.track(ctx)
        try:
            await self.hass.services.async_call(
                cmd.domain, cmd.service, cmd.data, blocking=False, context=ctx
            )
        except Exception:
            _LOGGER.exception("Failed to call %s.%s with %s", cmd.domain, cmd.service, cmd.data)

    # === Profile cascade ===

    def _active_profile(self, zone: Zone) -> Profile | None:
        """Premier profil dont les gates matchent (time window + présence)."""
        for p in zone.config.profiles:
            if not self._profile_time_window_on(p):
                continue
            if not self._profile_presence_match(p):
                continue
            return p
        return None

    def _profile_time_window_on(self, p: Profile) -> bool:
        if not p.active_from and not p.active_to:
            return True
        now_local = dt_util.now()
        return p.time_window_contains(now_local.hour, now_local.minute)

    def _profile_presence_match(self, p: Profile) -> bool:
        if not p.presence_entity:
            return True
        required = p.presence_required_state
        if required is None or required == "" or required == []:
            return True
        st = self.hass.states.get(p.presence_entity)
        if not st or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return False
        if isinstance(required, str):
            return st.state == required
        return st.state in required

    # === Inputs gathering ===

    def _gather_inputs(
        self, zone: Zone, sensor_temps: dict[str, float] | None = None
    ) -> ZoneInputs:
        now = utc_now_ts()
        if sensor_temps is None:
            sensor_temps = self._read_sensor_temps(zone)
        room_temperature = self._effective_room_temp(zone, sensor_temps)
        clim_state = self.hass.states.get(zone.config.climate_entity)
        clim_internal = None
        clim_hvac = STATE_OFF
        clim_setpoint = None
        clim_fan = None
        clim_swing = None
        clim_last_changed_ts: float | None = None
        supports_cool = True
        supports_heat = True
        supports_fan_mode = True
        supports_windnice = True
        if clim_state and clim_state.state not in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            clim_hvac = clim_state.state
            attrs = clim_state.attributes
            clim_internal = _as_float(attrs.get(ATTR_CURRENT_TEMPERATURE))
            clim_setpoint = _as_float(attrs.get(ATTR_TEMPERATURE))
            clim_fan = attrs.get(ATTR_FAN_MODE)
            clim_swing = attrs.get(ATTR_SWING_MODE)
            hvac_modes = attrs.get("hvac_modes") or []
            fan_modes = attrs.get("fan_modes") or []
            swing_modes = attrs.get("swing_modes") or []
            supports_cool = "cool" in hvac_modes
            supports_heat = "heat" in hvac_modes
            supports_fan_mode = bool(fan_modes)
            supports_windnice = "windnice" in swing_modes
            if clim_state.last_changed is not None:
                clim_last_changed_ts = clim_state.last_changed.timestamp()
        active_profile = self._active_profile(zone)
        return ZoneInputs(
            now_ts=now,
            room_temperature=room_temperature,
            clim_internal_temperature=clim_internal,
            clim_current_hvac_mode=clim_hvac,
            clim_current_setpoint=clim_setpoint,
            clim_current_fan_mode=clim_fan,
            clim_current_swing_mode=clim_swing,
            any_window_open=self._any_window_open(zone),
            supports_cool=supports_cool,
            supports_heat=supports_heat,
            supports_fan_mode=supports_fan_mode,
            supports_windnice=supports_windnice,
            clim_state_last_changed_ts=clim_last_changed_ts,
            active_profile=active_profile,
        )

    def _read_sensor_temps(self, zone: Zone) -> dict[str, float]:
        """Lecture de chaque capteur de la zone, dict {entity_id: temp °C}."""
        out: dict[str, float] = {}
        for sid in zone.config.temperature_sensors:
            st = self.hass.states.get(sid)
            if not st or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
                continue
            v = _as_float(st.state)
            if v is not None:
                out[sid] = v
        return out

    def _effective_room_temp(
        self, zone: Zone, sensor_temps: dict[str, float]
    ) -> float | None:
        """Moyenne des capteurs **non flagués**. Si tous flagués, fallback sur
        la moyenne globale (mieux que None car ça laisserait le tick passer
        sans rien faire alors qu'il faut quand même réagir)."""
        flagged = set(zone.state.flagged_sensors)
        active = [t for sid, t in sensor_temps.items() if sid not in flagged]
        if active:
            return sum(active) / len(active)
        if sensor_temps:
            vals = list(sensor_temps.values())
            return sum(vals) / len(vals)
        return None

    def _average_temperature(self, sensors: list[str]) -> float | None:
        values: list[float] = []
        for sid in sensors:
            st = self.hass.states.get(sid)
            if not st or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
                continue
            v = _as_float(st.state)
            if v is not None:
                values.append(v)
        if not values:
            return None
        return sum(values) / len(values)

    def _any_window_open(self, zone: Zone) -> bool:
        for ent in zone.config.window_sensors:
            st = self.hass.states.get(ent)
            if st and st.state == STATE_ON:
                return True
        return False

    def _window_counts(self, zone: Zone) -> tuple[int, int]:
        total = len(zone.config.window_sensors)
        open_n = 0
        for ent in zone.config.window_sensors:
            st = self.hass.states.get(ent)
            if st and st.state == STATE_ON:
                open_n += 1
        return open_n, total

    def _house_is_absent(self) -> bool:
        ent = self.entry.data.get(CONF_PRESENCE_ENTITY)
        absent_states = self.entry.data.get(CONF_PRESENCE_ABSENT_STATES, [])
        if not ent or not absent_states:
            return False
        st = self.hass.states.get(ent)
        if not st:
            return False
        return st.state in absent_states

    def _sensor_label(self, entity_id: str) -> str:
        st = self.hass.states.get(entity_id)
        if not st:
            return entity_id
        return st.attributes.get("friendly_name") or entity_id

    # === Sensor lag detection ===

    def _maybe_seed_sensor_baselines(
        self, zone: Zone, prev_state: str, sensor_temps: dict[str, float]
    ) -> None:
        """À l'entrée en RUNNING, snapshot les valeurs courantes par capteur
        comme référence de comparaison pour le reste du cycle."""
        if prev_state == ZoneState.RUNNING:
            return
        if zone.state.state != ZoneState.RUNNING:
            return
        zone.state.cycle_baseline_temps = dict(sensor_temps)
        zone.state.flagged_sensors = []
        zone.state.notified_sensors = []

    def _maybe_clear_sensor_baselines(self, zone: Zone, prev_state: str) -> None:
        """À la sortie de RUNNING, on garde flagged_sensors visibles dans les
        attrs (pour que l'utilisateur voie qui était isolé) mais on libère les
        baselines (plus utiles). Reset complet au prochain démarrage."""
        if prev_state == ZoneState.RUNNING and zone.state.state != ZoneState.RUNNING:
            zone.state.cycle_baseline_temps = {}

    def _maybe_detect_lagging_sensors(
        self, zone: Zone, inputs: ZoneInputs, sensor_temps: dict[str, float]
    ) -> None:
        """Pendant RUNNING, après MIN_DETECTION_TIME, marquer les capteurs
        qui ne suivent pas la médiane des autres."""
        if zone.state.state != ZoneState.RUNNING:
            return
        start_ts = zone.state.cycle_started_ts
        if start_ts is None:
            return
        elapsed = inputs.now_ts - start_ts
        if elapsed < SENSOR_LAG_MIN_DETECTION_SECONDS:
            return
        if inputs.active_profile is None:
            return
        direction = inputs.active_profile.mode
        baselines = zone.state.cycle_baseline_temps
        flagged = set(zone.state.flagged_sensors)
        deltas: dict[str, float] = {}
        for sid, current in sensor_temps.items():
            if sid in flagged:
                continue
            base = baselines.get(sid)
            if base is None:
                continue
            deltas[sid] = current - base
        lagging = detect_lagging_sensors(
            deltas, direction, threshold=SENSOR_LAG_THRESHOLD_C
        )
        if not lagging:
            return
        for sid in lagging:
            flagged.add(sid)
            if sid not in zone.state.notified_sensors:
                zone.state.notified_sensors.append(sid)
                self._notify_sensor_lag(zone, sid, deltas[sid], direction)
        zone.state.flagged_sensors = list(flagged)

    def _notify_sensor_lag(
        self, zone: Zone, sensor_id: str, delta: float, direction: str
    ) -> None:
        """Crée une persistent_notification + fire un event HA pour l'automation."""
        st = self.hass.states.get(sensor_id)
        label = (
            st.attributes.get("friendly_name", sensor_id)
            if st else sensor_id
        )
        action = "refroidissement" if direction == "cool" else "chauffage"
        msg = (
            f"Pendant le {action} de la zone **{zone.config.name}**, le capteur "
            f"**{label}** n'a quasi pas bougé ({delta:+.1f}°C) alors que les autres "
            f"capteurs de la zone réagissent normalement.\n\n"
            f"Probablement porte fermée ou pièce isolée. Le capteur est exclu du "
            f"calcul de la température moyenne jusqu'à la fin du cycle."
        )
        self.hass.async_create_task(
            self.hass.services.async_call(
                "persistent_notification",
                "create",
                {
                    "title": f"Climate Manager — {zone.config.name} : capteur isolé",
                    "message": msg,
                    "notification_id": (
                        f"climate_manager_lag_{zone.config.zone_id}_{sensor_id}"
                    ),
                },
            )
        )
        self.hass.bus.async_fire(
            "climate_manager_sensor_lagging",
            {
                "zone_id": zone.config.zone_id,
                "zone_name": zone.config.name,
                "sensor_id": sensor_id,
                "sensor_name": label,
                "delta": round(delta, 2),
                "direction": direction,
            },
        )

    # === Session kWh tracking ===

    def _consumption_sensor_for(self, zone: Zone, active_profile: Profile | None) -> str | None:
        if active_profile is None:
            return None
        if active_profile.mode == ProfileMode.COOL:
            return zone.config.consumption_sensor_cool
        return zone.config.consumption_sensor_heat

    def _read_kwh(self, entity_id: str | None) -> float | None:
        if not entity_id:
            return None
        st = self.hass.states.get(entity_id)
        if not st or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return None
        return _as_float(st.state)

    def _maybe_seed_cycle_start_kwh(self, zone: Zone, inputs: ZoneInputs) -> None:
        """Snapshot le compteur kWh juste avant qu'on entre en RUNNING."""
        if zone.state.state != ZoneState.IDLE:
            return
        if inputs.active_profile is None or inputs.room_temperature is None:
            return
        # On ne snapshot que si le tick va probablement transitionner.
        p = inputs.active_profile
        will_start = (
            (p.mode == ProfileMode.COOL and inputs.room_temperature >= p.seuil_demarrage)
            or (p.mode == ProfileMode.HEAT and inputs.room_temperature <= p.seuil_demarrage)
        )
        if not will_start:
            return
        sensor = self._consumption_sensor_for(zone, p)
        kwh = self._read_kwh(sensor)
        # On l'écrit ; sera utilisé par Zone._finalize_session.
        zone.state.cycle_start_kwh = kwh

    def _maybe_close_last_session_kwh(self, zone: Zone, prev_state: str) -> None:
        """Si une session vient d'être finalisée par Zone.tick, patcher
        kwh_end et kwh_consumed."""
        if not zone.state.completed_sessions:
            return
        last = zone.state.completed_sessions[-1]
        if last.get("kwh_end") is not None:
            return  # déjà patché
        # On ne snapshot la fin que si la session vient d'être ajoutée ce tick.
        # Heuristique : prev_state == RUNNING et state != RUNNING.
        if prev_state != ZoneState.RUNNING or zone.state.state == ZoneState.RUNNING:
            return
        # Détecter quel sensor : le `session_mode` enregistré est la source
        # de vérité (vrai sens de la session, pas du profil cascade qui a pu
        # changer en cours).
        cool_sensor = zone.config.consumption_sensor_cool
        heat_sensor = zone.config.consumption_sensor_heat
        mode = last.get("session_mode")
        if mode is None:
            profile_name = last.get("profile_name")
            for p in zone.config.profiles:
                if p.name == profile_name:
                    mode = p.mode
                    break
        sensor = cool_sensor if mode == ProfileMode.COOL else heat_sensor
        kwh_end = self._read_kwh(sensor)
        if kwh_end is None:
            return
        last["kwh_end"] = kwh_end
        start_kwh = last.get("kwh_start")
        if start_kwh is not None and isinstance(start_kwh, (int, float)):
            delta = kwh_end - start_kwh
            if delta < 0:
                # Compteur a reset (changement d'année) — on n'invente rien.
                delta = None
            last["kwh_consumed"] = delta

    # === Persistence of mutable zone config ===

    def _persist_zone_config(self, zone_id: str, **kwargs: Any) -> None:
        zones = list(self.entry.options.get(CONF_ZONES, []))
        for i, z in enumerate(zones):
            if z.get("id") == zone_id:
                zones[i] = {**z, **kwargs}
                break
        new_opts = {**self.entry.options, CONF_ZONES: zones}
        self.hass.config_entries.async_update_entry(self.entry, options=new_opts)

    # === Data exposed to platforms ===

    def _build_coordinator_data(self) -> dict[str, Any]:
        out: dict[str, Any] = {"zones": {}}
        for zid, zone in self._zones.items():
            inputs = self._gather_inputs(zone)
            entered_ts = zone.state.last_state_transition_ts or None
            active = inputs.active_profile

            direction: str | None = None
            target_temperature: float | None = None
            seuil_demarrage: float | None = None
            if active is not None:
                direction = "cool" if active.mode == ProfileMode.COOL else "heat"
                target_temperature = active.target
                seuil_demarrage = active.seuil_demarrage

            # Session active ? on expose ses paramètres SI la zone est en RUNNING
            in_session = zone.state.state == ZoneState.RUNNING and (
                zone.state.session_target is not None
            )
            session = None
            if in_session:
                session = {
                    "parent_profile_name": zone.state.cycle_start_profile_name,
                    "manual": zone.state.session_manual,
                    "started_ts": zone.state.cycle_started_ts,
                    "max_end_ts": zone.state.session_max_end_ts,
                    "target": zone.state.session_target,
                    "target_cutoff": zone.state.session_target_cutoff,
                    "power": zone.state.session_power,
                    "fan_intensity": zone.state.session_fan_intensity,
                    "mode": zone.state.session_mode,
                    "kickstart_until_ts": zone.state.session_kickstart_until_ts,
                    "cutoff_held_since_ts": zone.state.session_cutoff_held_since_ts,
                }

            # Direction/target/seuil dans la carte :
            # - Si session active : direction + target depuis la SESSION (pas du profil cascade)
            # - Sinon : depuis le profil de la cascade
            if in_session:
                direction = "cool" if zone.state.session_mode == "cool" else "heat"
                target_temperature = zone.state.session_target
                seuil_demarrage = None  # n'a pas de sens pendant une session
                power_out = zone.state.session_power
                fan_out = zone.state.session_fan_intensity

            else:
                power_out = active.power if active else None
                fan_out = active.fan_intensity if active else None

            out["zones"][zid] = {
                "config": zone.config,
                "state": zone.state.state,
                "mode": zone.state.mode,
                "room_temperature": inputs.room_temperature,
                "clim_internal_temperature": inputs.clim_internal_temperature,
                "clim_current_setpoint": inputs.clim_current_setpoint,
                "last_setpoint_sent": zone.state.last_setpoint_sent,
                "override_until_ts": zone.state.override_until_ts,
                "boost_until_ts": zone.state.boost_until_ts,
                "any_window_open": inputs.any_window_open,
                "house_is_absent": self._house_is_absent(),
                "in_override": zone.state.state
                in (ZoneState.MANUAL_OVERRIDE_TIMED, ZoneState.MANUAL_OVERRIDE_FREE),
                "is_off_mode": zone.state.mode == ZoneMode.OFF,
                "state_entered_ts": entered_ts,
                "cycle_started_ts": zone.state.cycle_started_ts,
                "direction": direction,
                "target_temperature": target_temperature,
                "seuil_demarrage": seuil_demarrage,
                "power": power_out,
                "fan_intensity": fan_out,
                "supports_cool": inputs.supports_cool,
                "supports_heat": inputs.supports_heat,
                "supports_fan_mode": inputs.supports_fan_mode,
                "supports_windnice": inputs.supports_windnice,
                "windows_open": self._window_counts(zone)[0],
                "windows_total": self._window_counts(zone)[1],
                "profiles": [p.to_dict() for p in zone.config.profiles],
                "active_profile_name": active.name if active else None,
                "active_profile_mode": active.mode if active else None,
                "session": session,
                "sessions": zone.state.completed_sessions,
                "temperature_sensors": list(zone.config.temperature_sensors),
                "flagged_sensors": list(zone.state.flagged_sensors),
                "flagged_sensors_labels": [
                    self._sensor_label(sid) for sid in zone.state.flagged_sensors
                ],
                "has_consumption_sensor": bool(
                    zone.config.consumption_sensor_cool
                    or zone.config.consumption_sensor_heat
                ),
            }
        return out


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _is_echo_of_intent(zone: Zone, new_attrs: dict[str, Any]) -> bool:
    """True si les attributs post-debounce matchent ce qu'on a écrit nous-mêmes."""
    last_sp = zone.state.last_setpoint_sent
    if last_sp is None:
        return False
    cur_sp = _as_float(new_attrs.get(ATTR_TEMPERATURE))
    if cur_sp is None or abs(cur_sp - last_sp) >= SETPOINT_NOOP_DELTA:
        return False
    last_fan = zone.state.last_fan_sent
    if last_fan is not None and new_attrs.get(ATTR_FAN_MODE) != last_fan:
        return False
    return True
