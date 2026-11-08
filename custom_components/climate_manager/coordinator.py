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
    HVACMode,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Context, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .const import (
    CLIM_MAX_SETPOINT,
    CLIM_MIN_SETPOINT,
    CONF_PRESENCE_ABSENT_STATES,
    CONF_PRESENCE_ENTITY,
    CONF_PROFILE_BANKS,
    CONF_SEASON,
    CONF_ZONES,
    DOMAIN,
    OVERRIDE_DEBOUNCE_SECONDS,
    SETPOINT_NOOP_DELTA,
    UPDATE_INTERVAL_SECONDS,
    ClimateSeason,
    ProfileMode,
    ZoneMode,
    ZoneState,
)
from .context_tracker import ContextTracker
from .plant import (
    BANK_FOR_DIRECTION,
    COOL,
    HEAT,
    BoostMemory,
    CentralOrder,
    Equipment,
    EquipmentKind,
    Plant,
    ZoneDemand,
    central_orders,
    engaged_equipment,
)
from .zone import (
    Command,
    Profile,
    Zone,
    ZoneConfig,
    ZoneInputs,
    ZoneRuntimeState,
    detect_temperature_gain_anomalies,
    utc_now_ts,
)

_LOGGER = logging.getLogger(__name__)
KWH_SETTLE_S = 65 * 60

NOTIFICATION_ACTION_EVENT = "mobile_app_notification_action"
ANOMALY_EVENT = "climate_manager_temperature_anomaly"
ANOMALY_CANCEL_ACTION_PREFIX = "CLIMATE_MANAGER_CANCEL_SESSION"


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
        self._unsub_notification_action = None
        self._pending_overrides: dict[str, dict[str, Any]] = {}
        self._runtime_store: Store = Store(
            hass, 3, f"{DOMAIN}_runtime_{entry.entry_id}"
        )
        self._last_runtime_payload: dict[str, Any] | None = None
        self.plant = Plant.from_options(entry.options)
        # Equipment set the platforms were built for (one switch each).
        self.equipment_ids = {e.id for e in self.plant.equipments}
        self._boost: dict[str, BoostMemory] = {}
        self._engaged: dict[str, list[Equipment]] = {}
        self._energy_last: dict[str, float] = {}  # last counter total per equipment
        self._central: dict[str, CentralOrder] = {}
        self._central_sent: dict[tuple[str, str], tuple[Any, float]] = {}
        self._rebuild_zones()

    # === Public API ===

    @property
    def zones(self) -> dict[str, Zone]:
        return self._zones

    def zone(self, zone_id: str) -> Zone | None:
        return self._zones.get(zone_id)

    def update_zone_profiles(self, zone_id: str, profiles: list[dict[str, Any]]) -> None:
        """Remplace la cascade de la saison active d'une zone."""
        zone = self._zones.get(zone_id)
        if not zone:
            return
        parsed = [Profile.from_dict(p) for p in profiles]
        zone.config.set_active_profiles(parsed)
        serialized_banks = {
            name: [p.to_dict() for p in zone.config.profile_banks.get(name, [])]
            for name in ClimateSeason.ALL
        }
        persisted = {
            CONF_PROFILE_BANKS: serialized_banks,
            CONF_SEASON: zone.config.season,
        }
        # ``profiles`` reste un miroir legacy de la banque été. Ainsi un
        # rollback vers v0.23.x ne peut jamais exposer les profils chauffage
        # comme unique cascade active.
        if zone.config.season == ClimateSeason.SUMMER:
            persisted["profiles"] = [p.to_dict() for p in parsed]
        self._persist_zone_config(zone_id, **persisted)
        self.async_set_updated_data(self._build_coordinator_data())

    def set_zone_season(self, zone_id: str, season: str) -> bool:
        """Bascule la banque active sans interrompre la session courante."""
        zone = self._zones.get(zone_id)
        if not zone or not zone.config.set_season(season):
            return False
        serialized_banks = {
            name: [p.to_dict() for p in zone.config.profile_banks.get(name, [])]
            for name in ClimateSeason.ALL
        }
        self._persist_zone_config(
            zone_id,
            **{
                CONF_SEASON: season,
                CONF_PROFILE_BANKS: serialized_banks,
            },
        )
        self.async_set_updated_data(self._build_coordinator_data())
        return True

    def update_zone_bank(
        self, zone_id: str, season: str, profiles: list[dict[str, Any]]
    ) -> bool:
        """Replace one season bank of a zone (active or not)."""
        zone = self._zones.get(zone_id)
        if not zone or season not in ClimateSeason.ALL:
            return False
        parsed = [Profile.from_dict(p) for p in profiles]
        zone.config.profile_banks[season] = parsed
        if zone.config.season == season:
            zone.config.profiles = list(parsed)
        serialized_banks = {
            name: [p.to_dict() for p in zone.config.profile_banks.get(name, [])]
            for name in ClimateSeason.ALL
        }
        persisted: dict[str, Any] = {CONF_PROFILE_BANKS: serialized_banks}
        summer = serialized_banks.get(ClimateSeason.SUMMER, [])
        persisted["profiles"] = summer  # legacy rollback mirror (summer bank)
        self._persist_zone_config(zone_id, **persisted)
        self.async_set_updated_data(self._build_coordinator_data())
        return True

    # --- plant (equipment + operating modes) ---

    def save_plant(self, plant: Plant) -> None:
        """Persist the plant; zones follow the bank of the mode in service."""
        self.plant = plant
        mode = plant.current_mode
        zones = list(self.entry.options.get(CONF_ZONES, []))
        for i, raw in enumerate(zones):
            hp = plant.heat_pump_of(raw.get("id"))
            raw = {**raw, "climate_entity": hp.entity if hp else None}
            if mode is not None:
                raw[CONF_SEASON] = BANK_FOR_DIRECTION[mode.direction]
            zones[i] = raw
        self.hass.config_entries.async_update_entry(
            self.entry, options={**self.entry.options, **plant.to_options(), CONF_ZONES: zones}
        )
        self._apply_plant_to_zones()
        self.async_set_updated_data(self._build_coordinator_data())

    async def async_set_equipment_enabled(self, equipment_id: str, enabled: bool) -> bool:
        """Put an equipment in or out of service; stop it once when it leaves."""
        plant = Plant.from_options({**self.entry.options, **self.plant.to_options()})
        eq = plant.equipment(equipment_id)
        if eq is None:
            return False
        if eq.enabled == enabled:
            return True
        eq.enabled = enabled
        was_ours = any(e.id == eq.id for eqs in self._engaged.values() for e in eqs)
        self.save_plant(plant)
        if not enabled and was_ours:
            await self._stop_equipment(eq)
        await self.async_tick_now()
        return True

    async def _stop_equipment(self, eq: Equipment) -> None:
        """Turn off what Climate Manager had started on this equipment."""
        if eq.kind == EquipmentKind.CENTRAL:
            self._central_sent = {k: v for k, v in self._central_sent.items() if k[0] != eq.id}
            await self._drive_central(eq, CentralOrder(on=False))
            return
        zone = self._zones.get(eq.zones[0]) if eq.zones else None
        mode = self.plant.current_mode
        backup = zone is not None and mode is not None and any(
            e.enabled and e.id != eq.id for e in self.plant.mode_equipments_for(mode, zone.config.zone_id)
        )
        if zone is not None and not backup:
            await self.async_cancel_zone_session(zone)  # nothing else serves the zone
        st = self.hass.states.get(eq.entity) if eq.entity else None
        if st is not None and st.state not in (STATE_OFF, STATE_UNAVAILABLE, STATE_UNKNOWN):
            await self._apply_command(Command("climate", "turn_off", {"entity_id": eq.entity}))

    def set_active_mode(self, mode_id: str | None) -> bool:
        if mode_id is not None and self.plant.mode(mode_id) is None:
            return False
        plant = Plant.from_options({**self.entry.options, **self.plant.to_options()})
        plant.active_mode = mode_id
        self.save_plant(plant)
        return True

    def _apply_plant_to_zones(self) -> None:
        mode = self.plant.current_mode
        for zid, zone in self._zones.items():
            hp = self.plant.heat_pump_of(zid)
            zone.config.climate_entity = hp.entity if hp else None
            if mode is not None:
                zone.config.set_season(BANK_FOR_DIRECTION[mode.direction])

    def set_house_season(self, season: str) -> bool:
        """Switch every zone to the same season bank in one options write."""
        if season not in ClimateSeason.ALL:
            return False
        zones = list(self.entry.options.get(CONF_ZONES, []))
        for i, raw in enumerate(zones):
            zone = self._zones.get(raw.get("id"))
            if zone is not None:
                zone.config.set_season(season)
            zones[i] = {**raw, CONF_SEASON: season}
        self.hass.config_entries.async_update_entry(
            self.entry, options={**self.entry.options, CONF_ZONES: zones}
        )
        self.async_set_updated_data(self._build_coordinator_data())
        return True

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
        # Publish in-memory session mutations immediately so Lovelace does not
        # wait for the full poll/device-command round-trip (notably +1h).
        self.async_set_updated_data(self._build_coordinator_data())
        await self.async_request_refresh()

    async def async_cancel_zone_session(self, zone: Zone) -> None:
        """Cancel a session, apply its physical off command, then publish state."""
        commands = zone.cancel_active_session(now_ts=utc_now_ts())
        for command in commands:
            await self._apply_command(command)
        await self._save_runtime_state_if_changed()
        self.async_set_updated_data(self._build_coordinator_data())
        await self.async_request_refresh()

    # === DataUpdateCoordinator hooks ===

    async def _async_setup(self) -> None:
        if "equipments" not in self.entry.options:
            # First start with the plant model: store the migrated plant so ids stay stable.
            self.save_plant(self.plant)
        await self._load_runtime_state()
        await self._async_backfill_session_kwh()
        await self._setup_state_listeners()
        self._unsub_notification_action = self.hass.bus.async_listen(
            NOTIFICATION_ACTION_EVENT, self._on_notification_action
        )

    async def _async_update_data(self) -> dict[str, Any]:
        demands: dict[str, ZoneDemand] = {}
        for zone in self._zones.values():
            sensor_temps = self._read_sensor_temps(zone)
            inputs = self._gather_inputs(zone, sensor_temps)
            prev_state = zone.state.state
            prev_last = zone.state.completed_sessions[-1] if zone.state.completed_sessions else None
            commands = zone.tick(inputs)
            self._maybe_close_last_session_kwh(zone, prev_last, sensor_temps)
            await self._maybe_seed_sensor_baselines(zone, prev_state, inputs, sensor_temps)
            await self._maybe_detect_temperature_anomalies(zone, inputs, sensor_temps)
            self._maybe_clear_sensor_baselines(zone, prev_state)
            demand = self._zone_demand(zone, inputs)
            demands[zone.config.zone_id] = demand
            commands = self._dispatch_heat_pump(zone, demand, inputs, commands)
            for cmd in commands:
                await self._apply_command(cmd)
        self._account_energy(utc_now_ts())
        self._central = central_orders(self.plant, self._engaged, demands)
        for eq_id, order in self._central.items():
            await self._drive_central(self.plant.equipment(eq_id), order)
        await self._save_runtime_state_if_changed()
        return self._build_coordinator_data()

    # === Plant dispatch ===

    def _zone_demand(self, zone: Zone, inputs: ZoneInputs) -> ZoneDemand:
        running = zone.state.state == ZoneState.RUNNING and zone.state.session_mode in (HEAT, COOL)
        return ZoneDemand(
            zone_id=zone.config.zone_id,
            direction=zone.state.session_mode if running else None,
            target=zone.state.session_target if running else None,
            room=inputs.room_temperature,
            session_started_ts=zone.state.cycle_started_ts if running else None,
            manual=bool(zone.state.session_manual),
        )

    def _equipment_available(self, eq: Equipment) -> bool:
        if not eq.enabled or not eq.entity:
            return False
        st = self.hass.states.get(eq.entity)
        return st is not None and st.state not in (STATE_UNAVAILABLE, STATE_UNKNOWN)

    def _dispatch_heat_pump(
        self, zone: Zone, demand: ZoneDemand, inputs: ZoneInputs, commands: list[Command]
    ) -> list[Command]:
        """Keep the zone's heat pump off when the mode answers with other equipment."""
        zid = zone.config.zone_id
        engaged = engaged_equipment(
            self.plant, demand, utc_now_ts(), self._equipment_available,
            self._boost.setdefault(zid, BoostMemory()),
        )
        self._engaged[zid] = engaged
        hp = self.plant.heat_pump_of(zid)
        commands = [c for c in commands if c.data.get("entity_id")]
        if hp is not None and not hp.enabled:
            # Out of service: never started nor stopped by Climate Manager.
            return []
        if hp is None or demand.direction is None:
            return commands
        if demand.manual and self.plant.current_mode is None:
            # « Arrêt »: nothing starts on its own, but a session started by hand
            # still runs on the zone's heat pump.
            return commands
        if any(e.id == hp.id for e in engaged):
            return commands
        # Automatic session served by other equipment: the heat pump stays off.
        kept = [c for c in commands if c.service == "turn_off"]
        if not kept and inputs.clim_current_hvac_mode not in (STATE_OFF, None):
            kept = [zone._cmd_turn_off()]
        return kept

    async def _drive_central(self, eq: Equipment | None, order: CentralOrder) -> None:
        if eq is None or not eq.entity:
            return
        st = self.hass.states.get(eq.entity)
        if st is None or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return
        domain = eq.entity.split(".", 1)[0]
        calls: list[Command] = []
        if domain == "climate":
            if order.on:
                if st.state != order.direction:
                    calls.append(Command("climate", "set_hvac_mode", {"entity_id": eq.entity, "hvac_mode": order.direction}))
                current = _as_float(st.attributes.get(ATTR_TEMPERATURE))
                if order.setpoint is not None and (current is None or abs(current - order.setpoint) >= SETPOINT_NOOP_DELTA):
                    calls.append(Command("climate", "set_temperature", {"entity_id": eq.entity, "temperature": round(order.setpoint * 2) / 2}))
            elif st.state != STATE_OFF:
                calls.append(Command("climate", "turn_off", {"entity_id": eq.entity}))
        elif domain in ("select", "input_select"):
            wanted = eq.on_option if order.on else eq.off_option
            if wanted and st.state != wanted:
                calls.append(Command(domain, "select_option", {"entity_id": eq.entity, "option": wanted}))
        elif domain in ("switch", "input_boolean", "light", "fan"):
            wanted = STATE_ON if order.on else STATE_OFF
            if st.state != wanted:
                calls.append(Command(domain, f"turn_{wanted}", {"entity_id": eq.entity}))
        if order.on and order.setpoint is not None and eq.setpoint_entity and domain != "climate":
            sp = self.hass.states.get(eq.setpoint_entity)
            value = round(order.setpoint * 2) / 2
            if sp is not None and _as_float(sp.state) != value:
                sp_domain = eq.setpoint_entity.split(".", 1)[0]
                calls.append(Command(sp_domain, "set_value", {"entity_id": eq.setpoint_entity, "value": value}))
        now = utc_now_ts()
        for cmd in calls:
            # The device may report its new state a few seconds later: do not repeat an order.
            key = (eq.id, f"{cmd.domain}.{cmd.service}")
            value = {k: v for k, v in cmd.data.items() if k != "entity_id"}
            last = self._central_sent.get(key)
            if last and last[0] == value and now - last[1] < 90:
                continue
            self._central_sent[key] = (value, now)
            _LOGGER.info("Central %s: %s.%s %s", eq.name, cmd.domain, cmd.service, cmd.data)
            await self._apply_command(cmd)

    def _equipment_running(self, eq: Equipment) -> bool:
        if eq.kind == EquipmentKind.HEAT_PUMP:
            st = self.hass.states.get(eq.entity) if eq.entity else None
            return bool(st and st.state in (HEAT, COOL, "heat_cool", "fan_only"))
        if eq.running_entity:
            st = self.hass.states.get(eq.running_entity)
            return bool(st and st.state == STATE_ON)
        order = self._central.get(eq.id)
        return bool(order and order.on)

    def _plant_payload(self) -> dict[str, Any]:
        mode = self.plant.current_mode
        return {
            "active_mode": mode.id if mode else None,
            "active_mode_name": mode.name if mode else None,
            "direction": mode.direction if mode else None,
            "relation": mode.relation if mode else None,
            "modes": [{"id": m.id, "name": m.name, "direction": m.direction, "icon": m.icon} for m in self.plant.modes],
            "equipments": [
                {
                    "id": e.id, "name": e.name, "kind": e.kind, "zones": list(e.zones), "enabled": e.enabled,
                    "in_mode": bool(mode and e.id in mode.equipments),
                    "on": bool(self._central.get(e.id) and self._central[e.id].on) if e.kind == EquipmentKind.CENTRAL else None,
                    "running": self._equipment_running(e),
                }
                for e in self.plant.equipments
            ],
        }

    def _zone_sources(self, zone_id: str) -> list[dict[str, Any]]:
        mode = self.plant.current_mode
        engaged = {e.id for e in self._engaged.get(zone_id, [])}
        in_mode = {e.id for e in self.plant.mode_equipments_for(mode, zone_id)} if mode else set()
        out = []
        for e in self.plant.serving(zone_id):
            out.append({
                "id": e.id, "name": e.name, "kind": e.kind, "enabled": e.enabled,
                "in_mode": e.id in in_mode,
                "engaged": e.id in engaged,
                "running": self._equipment_running(e) and (e.kind == EquipmentKind.HEAT_PUMP or e.id in engaged or bool(e.running_entity)),
            })
        return out

    async def _load_runtime_state(self) -> None:
        data = await self._runtime_store.async_load() or {}
        zones_data = data.get("zones", {}) if isinstance(data, dict) else {}
        for zid, zone in self._zones.items():
            zone.state = ZoneRuntimeState.from_dict(zones_data.get(zid))
            # No per-zone switch any more: the house mode is the main switch.
            zone.state.mode = ZoneMode.AUTO
        # Last counter readings survive a restart: an hourly counter that moved
        # while HA was down still lands in its session or its late hour.
        # Keyed by equipment and its counters: a counter added or removed in
        # the meantime starts from a fresh reading, never a false jump.
        energy_last = data.get("energy_last", {}) if isinstance(data, dict) else {}
        self._energy_last = {
            k: float(v) for k, v in (energy_last or {}).items()
            if isinstance(v, (int, float))
        }
        self._last_runtime_payload = self._runtime_payload()

    def _runtime_payload(self) -> dict[str, Any]:
        return {
            "zones": {zid: zone.state.to_dict() for zid, zone in self._zones.items()},
            "energy_last": dict(self._energy_last),
        }

    async def _save_runtime_state_if_changed(self) -> None:
        payload = self._runtime_payload()
        if payload != self._last_runtime_payload:
            await self._runtime_store.async_save(payload)
            self._last_runtime_payload = payload

    # === Zone setup ===

    def _rebuild_zones(self) -> None:
        if "equipments" in self.entry.options:
            self.plant = Plant.from_options(self.entry.options)
        zones_cfg = self.entry.options.get(CONF_ZONES, [])
        new_zones: dict[str, Zone] = {}
        for cfg_dict in zones_cfg:
            zc = ZoneConfig.from_dict(cfg_dict)
            existing = self._zones.get(zc.zone_id)
            new_zones[zc.zone_id] = Zone(
                zc, state=existing.state if existing else ZoneRuntimeState()
            )
        self._zones = new_zones
        self._apply_plant_to_zones()

    async def _setup_state_listeners(self) -> None:
        if self._unsub_state_listener:
            self._unsub_state_listener()
            self._unsub_state_listener = None
        self._cancel_pending_overrides()
        if not self._zones:
            return
        entities = [z.config.climate_entity for z in self._zones.values() if z.config.climate_entity]
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
        hp = self.plant.heat_pump_of(zone.config.zone_id)
        if hp is not None and not hp.enabled:
            return  # out of service: used by hand, not an override
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
        inputs = self._gather_inputs(zone)
        if new_state.state == HVACMode.OFF or new_state.state == STATE_OFF:
            zone.on_external_turn_off(inputs)
        else:
            profile_active = inputs.active_profile is not None
            zone.on_external_override(inputs.now_ts, profile_active)
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
        if self._unsub_notification_action:
            self._unsub_notification_action()
            self._unsub_notification_action = None
        await super().async_shutdown()

    @callback
    def _on_notification_action(self, event: Event) -> None:
        """Handle the destructive action from an anomaly mobile notification."""
        action = str(event.data.get("action") or "")
        prefix = f"{ANOMALY_CANCEL_ACTION_PREFIX}_"
        if not action.startswith(prefix):
            return
        payload = action[len(prefix):]
        try:
            zone_id, cycle_started = payload.rsplit("_", 1)
            expected_cycle_started_ms = int(cycle_started)
        except (TypeError, ValueError):
            return
        self.hass.async_create_task(
            self._async_cancel_session_from_notification(
                zone_id, expected_cycle_started_ms
            )
        )

    async def _async_cancel_session_from_notification(
        self, zone_id: str, expected_cycle_started_ms: int
    ) -> None:
        """Cancel only the exact session that emitted the notification."""
        zone = self._zones.get(zone_id)
        if zone is None or zone.state.cycle_started_ts is None:
            return
        if round(zone.state.cycle_started_ts * 1000) != expected_cycle_started_ms:
            _LOGGER.info("Ignored stale anomaly notification action for zone %s", zone_id)
            return
        if zone.state.state not in (
            ZoneState.RUNNING,
            ZoneState.MANUAL_OVERRIDE_TIMED,
            ZoneState.MANUAL_OVERRIDE_FREE,
        ):
            return
        await self.async_cancel_zone_session(zone)

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
        """Premier profil dont les gates matchent (time window + présence).

        No operating mode in service: nothing starts on its own."""
        mode = self.plant.current_mode
        if mode is None:
            return None
        if not any(e.enabled for e in self.plant.mode_equipments_for(mode, zone.config.zone_id)):
            return None  # every equipment of this zone is out of service
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
        clim_state = (
            self.hass.states.get(zone.config.climate_entity) if zone.config.climate_entity else None
        )
        clim_internal = None
        clim_hvac = STATE_OFF
        clim_setpoint = None
        clim_fan = None
        clim_swing = None
        clim_min_setpoint = CLIM_MIN_SETPOINT
        clim_max_setpoint = CLIM_MAX_SETPOINT
        clim_last_changed_ts: float | None = None
        supports_cool = True
        supports_heat = True
        supports_fan_mode = True
        supports_windnice = True
        supports_swing = True
        supports_fan_only = True
        if clim_state and clim_state.state not in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            clim_hvac = clim_state.state
            attrs = clim_state.attributes
            clim_internal = _as_float(attrs.get(ATTR_CURRENT_TEMPERATURE))
            clim_setpoint = _as_float(attrs.get(ATTR_TEMPERATURE))
            clim_fan = attrs.get(ATTR_FAN_MODE)
            clim_swing = attrs.get(ATTR_SWING_MODE)
            clim_min_setpoint = _as_float(attrs.get("min_temp")) or CLIM_MIN_SETPOINT
            clim_max_setpoint = _as_float(attrs.get("max_temp")) or CLIM_MAX_SETPOINT
            hvac_modes = attrs.get("hvac_modes") or []
            fan_modes = attrs.get("fan_modes") or []
            swing_modes = attrs.get("swing_modes") or []
            supports_cool = "cool" in hvac_modes
            supports_heat = "heat" in hvac_modes
            supports_fan_only = HVACMode.FAN_ONLY in hvac_modes or "fan_only" in hvac_modes
            supports_fan_mode = bool(fan_modes)
            supports_windnice = "windnice" in swing_modes
            supports_swing = "swing" in swing_modes
            if clim_state.last_changed is not None:
                clim_last_changed_ts = clim_state.last_changed.timestamp()
        # Heat/cold may come from other equipment than the zone's heat pump.
        serving = self.plant.serving(zone.config.zone_id)
        if any(e.kind == EquipmentKind.CENTRAL for e in serving):
            supports_heat = supports_heat or any(e.heat for e in serving)
            supports_cool = supports_cool or any(e.cool for e in serving)
        if clim_internal is None and not zone.config.climate_entity:
            clim_internal = room_temperature
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
            clim_min_setpoint=clim_min_setpoint,
            clim_max_setpoint=clim_max_setpoint,
            supports_cool=supports_cool,
            supports_heat=supports_heat,
            supports_fan_mode=supports_fan_mode,
            supports_windnice=supports_windnice,
            supports_swing=supports_swing,
            supports_fan_only=supports_fan_only,
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
        """Moyenne de tous les capteurs disponibles de la zone.

        Les anciens ``flagged_sensors`` restent exposés uniquement comme
        information legacy, mais ils ne doivent plus exclure un capteur du
        calcul. En pratique, exclure une pièce "isolée" rendait la température
        de zone trop optimiste à l'étage et pouvait empêcher la climatisation
        de démarrer alors que plusieurs pièces étaient chaudes.
        """
        if not sensor_temps:
            return None
        vals = list(sensor_temps.values())
        return sum(vals) / len(vals)

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

    async def _maybe_seed_sensor_baselines(
        self,
        zone: Zone,
        prev_state: str,
        inputs: ZoneInputs,
        sensor_temps: dict[str, float],
    ) -> None:
        """Capture/répare la référence capteurs au début d'une session.

        Sur un reload/restart HA, l'état runtime peut déjà être RUNNING au
        premier tick. Dans ce cas l'ancienne logique ne capturait jamais de
        baseline, ou la capturait trop tard au moment du redémarrage, donc les
        gains restaient affichés à 0. Si la session existait déjà, on tente de
        restaurer les températures au vrai ``cycle_started_ts`` depuis Recorder.
        """
        if zone.state.state != ZoneState.RUNNING:
            return
        if not sensor_temps:
            return

        current_baselines = zone.state.cycle_baseline_temps
        missing = [sid for sid in sensor_temps if sid not in current_baselines]
        duration_s = None
        if zone.state.cycle_started_ts is not None:
            duration_s = max(0.0, inputs.now_ts - zone.state.cycle_started_ts)

        # Une baseline non vide peut quand même être mauvaise: c'est le cas
        # d'une session restaurée après restart où on a snapshoté les valeurs du
        # restart au lieu des valeurs du début réel de session. On vérifie donc
        # Recorder pour les sessions déjà entamées.
        should_try_history = bool(duration_s and duration_s > 60) and (
            bool(missing) or bool(current_baselines)
        )
        if should_try_history:
            history_baselines = await self._history_sensor_baselines(
                zone, zone.state.cycle_started_ts, inputs.now_ts, sensor_temps
            )
            if history_baselines:
                history_avg = self._average_temp_values(history_baselines)
                current_avg = self._average_temp_values(current_baselines)
                missing_history = any(sid not in current_baselines for sid in history_baselines)
                avg_changed = (
                    history_avg is not None
                    and current_avg is not None
                    and abs(history_avg - current_avg) >= 0.05
                )
                if missing_history or not current_baselines or avg_changed:
                    repaired = dict(current_baselines)
                    repaired.update(history_baselines)
                    zone.state.cycle_baseline_temps = repaired
                    zone.state.flagged_sensors = []
                    zone.state.notified_sensors = []
                    return

        if prev_state == ZoneState.RUNNING and not missing:
            return

        repaired = dict(current_baselines)
        # Capture directe uniquement au véritable début. Un capteur qui revient
        # tard ne doit pas recevoir une baseline "maintenant" puis être divisé
        # par toute la durée de la session.
        if prev_state != ZoneState.RUNNING or not duration_s or duration_s <= 60:
            for sid, value in sensor_temps.items():
                repaired.setdefault(sid, value)
        zone.state.cycle_baseline_temps = repaired
        zone.state.flagged_sensors = []
        zone.state.notified_sensors = []
        if prev_state != ZoneState.RUNNING:
            zone.state.anomaly_detection_done = False

    async def _history_sensor_baselines(
        self,
        zone: Zone,
        started_ts: float | None,
        now_ts: float,
        sensor_temps: dict[str, float],
    ) -> dict[str, float]:
        """Retourne les valeurs capteurs au début réel de session via Recorder."""
        if started_ts is None or started_ts >= now_ts:
            return {}
        try:
            from homeassistant.components.recorder import get_instance, history
        except Exception:  # pragma: no cover - Recorder peut être absent en tests.
            return {}

        start = dt_util.utc_from_timestamp(started_ts)
        # Fenêtre courte: include_start_time_state donne l'état exact/dernier état
        # au début, et la marge couvre les capteurs qui publient juste après.
        end = dt_util.utc_from_timestamp(min(now_ts, started_ts + 10 * 60))
        entity_ids = [sid for sid in zone.config.temperature_sensors if sid in sensor_temps]
        if not entity_ids:
            return {}

        def _read_history() -> dict[str, list[Any]]:
            out: dict[str, list[Any]] = {}
            for entity_id in entity_ids:
                out.update(
                    history.state_changes_during_period(
                        self.hass,
                        start,
                        end,
                        entity_id,
                        include_start_time_state=True,
                        no_attributes=True,
                    )
                )
            return out

        try:
            states_by_entity = await get_instance(self.hass).async_add_executor_job(
                _read_history
            )
        except Exception as err:  # pragma: no cover - dépend de Recorder/DB runtime.
            _LOGGER.debug("Could not restore climate session baselines from recorder: %s", err)
            return {}

        baselines: dict[str, float] = {}
        for sid, states in states_by_entity.items():
            for st in states or []:
                value = _as_float(getattr(st, "state", None))
                if value is not None:
                    baselines[sid] = value
                    break
        return baselines

    def _maybe_clear_sensor_baselines(self, zone: Zone, prev_state: str) -> None:
        """Efface l'ancien état de détection à la sortie de RUNNING."""
        if prev_state == ZoneState.RUNNING and zone.state.state not in (
            ZoneState.RUNNING,
            ZoneState.MANUAL_OVERRIDE_TIMED,
            ZoneState.MANUAL_OVERRIDE_FREE,
        ):
            zone.state.cycle_baseline_temps = {}
            zone.state.flagged_sensors = []
            zone.state.notified_sensors = []
            zone.state.anomaly_detection_done = False

    async def _maybe_detect_temperature_anomalies(
        self, zone: Zone, inputs: ZoneInputs, sensor_temps: dict[str, float]
    ) -> None:
        """Evaluate room gains once, then notify without altering the zone average."""
        if zone.state.state != ZoneState.RUNNING or zone.state.anomaly_detection_done:
            return
        started_ts = zone.state.cycle_started_ts
        if started_ts is None:
            return
        duration_seconds = max(0.0, inputs.now_ts - started_ts)
        delay_seconds = max(1, zone.config.anomaly_delay_min) * 60
        if duration_seconds < delay_seconds:
            return

        # Donne dix minutes à un capteur ayant une vraie baseline mais
        # momentanément indisponible au contrôle. Ensuite, évalue les autres
        # sans bloquer indéfiniment la détection de la session.
        temporarily_missing = set(zone.state.cycle_baseline_temps) - set(sensor_temps)
        if temporarily_missing and duration_seconds < delay_seconds + 10 * 60:
            return

        # A single evaluation measures the attack phase. Re-evaluating during
        # maintenance would make a healthy long session look progressively worse.
        zone.state.anomaly_detection_done = True
        direction = zone.state.session_mode
        if direction == ProfileMode.HEAT:
            threshold = zone.config.anomaly_heat_gain_per_hour
        elif direction == ProfileMode.COOL:
            threshold = zone.config.anomaly_cool_gain_per_hour
        else:
            return

        anomalies = detect_temperature_gain_anomalies(
            zone.state.cycle_baseline_temps,
            sensor_temps,
            direction,
            duration_seconds / 3600,
            threshold,
            target=zone.state.session_target,
        )
        zone.state.flagged_sensors = list(anomalies)
        zone.state.notified_sensors = list(anomalies)
        if not anomalies:
            return

        event_data = {
            "zone_id": zone.config.zone_id,
            "zone_name": zone.config.name,
            "mode": direction,
            "threshold_gain_per_hour": threshold,
            "duration_minutes": round(duration_seconds / 60, 1),
            "sensors": [
                {"entity_id": sid, "name": self._sensor_label(sid), **details}
                for sid, details in anomalies.items()
            ],
            "cycle_started_ts": started_ts,
        }
        self.hass.bus.async_fire(ANOMALY_EVENT, event_data)
        await self._send_temperature_anomaly_notification(zone, event_data)

    async def _send_temperature_anomaly_notification(
        self, zone: Zone, event_data: dict[str, Any]
    ) -> None:
        service_name = zone.config.anomaly_notification_service
        if not service_name:
            _LOGGER.warning(
                "Temperature anomaly detected for %s, but no notification service is configured",
                zone.config.name,
            )
            return
        if service_name.startswith("notify."):
            service_name = service_name.split(".", 1)[1]
        if not self.hass.services.has_service("notify", service_name):
            _LOGGER.warning("Notification service notify.%s is unavailable", service_name)
            return

        mode_label = "chauffage" if event_data["mode"] == ProfileMode.HEAT else "refroidissement"
        sensor_lines = [
            f"{item['name']}: {item['gain']:+.1f} °C ({item['gain_per_hour']:+.1f} °C/h)"
            for item in event_data["sensors"]
        ]
        action = (
            f"{ANOMALY_CANCEL_ACTION_PREFIX}_{zone.config.zone_id}_"
            f"{round(event_data['cycle_started_ts'] * 1000)}"
        )
        await self.hass.services.async_call(
            "notify",
            service_name,
            {
                "title": f"Diffusion anormale · {zone.config.name}",
                "message": (
                    f"Après {event_data['duration_minutes']:.0f} min de {mode_label}, "
                    f"certaines pièces restent sous le seuil de "
                    f"{event_data['threshold_gain_per_hour']:.1f} °C/h.\n"
                    + "\n".join(sensor_lines)
                    + "\nVérifie les portes ou la circulation d'air."
                ),
                "data": {
                    "tag": f"climate_manager_anomaly_{zone.config.zone_id}",
                    "actions": [
                        {
                            "action": action,
                            "title": "Couper la session",
                            "destructive": True,
                        }
                    ],
                },
            },
            blocking=False,
        )

    # === Session energy ===
    # Each equipment has its own kWh counters (clim: electricity, boiler: gas).
    # Every tick, what its counters gained is shared between the sessions it is
    # serving. Counters often report once an hour: what comes in up to
    # KWH_SETTLE_S after a session ended, while the equipment serves nobody,
    # still belongs to that session.

    def _session_consumption_sensor(self, zone: Zone, mode: str | None) -> str | None:
        """Pre-0.28 zone counters, only used to recover old sessions."""
        if mode == ProfileMode.COOL:
            return zone.config.consumption_sensor_cool
        if mode == ProfileMode.HEAT:
            return zone.config.consumption_sensor_heat
        return None

    def _read_kwh(self, entity_id: str | None) -> float | None:
        if not entity_id:
            return None
        st = self.hass.states.get(entity_id)
        if not st or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return None
        return _as_float(st.state)

    def _has_session_runtime(self, zone: Zone) -> bool:
        return zone.state.state in (
            ZoneState.RUNNING,
            ZoneState.MANUAL_OVERRIDE_TIMED,
            ZoneState.MANUAL_OVERRIDE_FREE,
        ) and zone.state.session_target is not None

    def _energy_total(self, eq: Equipment) -> float | None:
        values = [self._read_kwh(s) for s in eq.energy_sensors]
        if not values or any(v is None for v in values):
            return None  # a counter missing this tick: wait, never invent
        return sum(values)

    def _serves(self, eq: Equipment, zone: Zone) -> bool:
        if not self._has_session_runtime(zone):
            return False
        zid = zone.config.zone_id
        engaged = any(e.id == eq.id for e in self._engaged.get(zid, []))
        # A clim in a session works for its zone, even under a manual override.
        return engaged or (eq.kind == EquipmentKind.HEAT_PUMP and zid in eq.zones)

    def _account_energy(self, now_ts: float) -> None:
        # Sessions closed since the last tick (by the zone or by a cancel from
        # the card): open their late window and compute their totals.
        for zone in self._zones.values():
            for rec in zone.state.completed_sessions[-3:]:
                if "energy" in rec and "energy_until_ts" not in rec:
                    # Only what really ran gets the late hour (not a clim on standby).
                    rec["energy"] = {k: v for k, v in rec["energy"].items() if v > 0}
                    rec["energy_until_ts"] = (rec.get("end_ts") or now_ts) + KWH_SETTLE_S
                    self._energy_totals(rec)
        for eq in self.plant.equipments:
            if not eq.energy_sensors:
                continue
            serving = [z for z in self._zones.values() if self._serves(eq, z)]
            for z in serving:
                z.state.session_energy.setdefault(eq.id, 0.0)
            total = self._energy_total(eq)
            if total is None:
                continue
            key = eq.id + "|" + ",".join(sorted(eq.energy_sensors))
            last = self._energy_last.get(key)
            for stale in [k for k in self._energy_last if k.split("|", 1)[0] == eq.id and k != key]:
                del self._energy_last[stale]
            self._energy_last[key] = total
            if last is None or total <= last:
                continue  # first reading, nothing new, or counter reset
            delta = total - last
            if serving:
                for z in serving:
                    z.state.session_energy[eq.id] += delta / len(serving)
                continue
            tails = [
                rec for z in self._zones.values() for rec in z.state.completed_sessions[-3:]
                if eq.id in (rec.get("energy") or {}) and now_ts <= (rec.get("energy_until_ts") or 0)
            ]
            for rec in tails:
                rec["energy"][eq.id] = rec["energy"][eq.id] + delta / len(tails)
                self._energy_totals(rec)

    def _energy_totals(self, rec: dict[str, Any]) -> None:
        """kWh, cost and the detail per equipment of a finished session."""
        detail, kwh, cost = [], 0.0, 0.0
        for eq_id, value in (rec.get("energy") or {}).items():
            if value <= 0:
                continue  # served but did not run (a clim while the boiler heats)
            eq = self.plant.equipment(eq_id)
            price = eq.energy_price if eq else None
            detail.append({
                "name": eq.name if eq else eq_id,
                "energy": eq.energy if eq else None,
                "kwh": round(value, 3),
                "cost": round(value * price, 4) if price is not None else None,
            })
            kwh += value
            cost += value * (price or 0)
        rec["energy_detail"] = detail
        rec["kwh_consumed"] = round(kwh, 3)
        rec["cost_eur"] = round(cost, 4)

    def _maybe_close_last_session_kwh(
        self,
        zone: Zone,
        prev_last: dict[str, Any] | None,
        sensor_temps: dict[str, float] | None = None,
    ) -> None:
        """Patch end details on the session finalized during this tick.

        Compared by identity, not by count: once the history is full, appending
        drops the oldest session and the count stays the same.
        """
        completed = zone.state.completed_sessions
        if not completed or completed[-1] is prev_last:
            return
        last = completed[-1]
        if sensor_temps:
            last["sensor_end_temperatures"] = dict(sensor_temps)

    async def _async_backfill_session_kwh(self) -> None:
        """Fill missing session kWh from the recorder (counter value at start/end).

        Sessions closed while the end reading was skipped (history full, see
        _maybe_close_last_session_kwh) get their consumption back as long as the
        recorder still keeps the counter's history.
        """
        if "recorder" not in self.hass.config.components:
            _LOGGER.debug("Session kWh backfill skipped: no recorder")
            return
        from homeassistant.components.recorder import get_instance, history

        todo = []
        for zone in self._zones.values():
            for s in zone.state.completed_sessions:
                sensor = self._session_consumption_sensor(zone, s.get("session_mode"))
                if sensor and s.get("start_ts") and s.get("end_ts") and "energy" not in s and (
                    s.get("kwh_consumed") is None or not s.get("kwh_settled")
                ):
                    todo.append((sensor, s, zone))
        _LOGGER.debug("Session kWh backfill: %d session(s) without consumption", len(todo))
        if not todo:
            return

        def value_at(entity_id: str, ts: float) -> float | None:
            at = dt_util.utc_from_timestamp(ts)
            states = history.get_significant_states(
                self.hass, at, at + timedelta(seconds=1), [entity_id],
                include_start_time_state=True, significant_changes_only=False, no_attributes=True,
            ).get(entity_id) or []
            return _as_float(states[0].state) if states else None

        now = utc_now_ts()

        def fill() -> int:
            done = 0
            for sensor, s, zone in todo:
                start = s.get("kwh_start")
                if not isinstance(start, (int, float)):
                    start = value_at(sensor, s["start_ts"])
                sessions = zone.state.completed_sessions
                i = next(k for k, x in enumerate(sessions) if x is s)
                nxt = sessions[i + 1].get("start_ts") if i + 1 < len(sessions) else None
                at = min(t for t in (s["end_ts"] + KWH_SETTLE_S, nxt, now - 1) if t)
                end = value_at(sensor, at)
                if start is None or end is None or end < start:
                    continue
                s["kwh_start"], s["kwh_end"], s["kwh_consumed"] = start, end, round(end - start, 3)
                s["kwh_settled"] = True
                done += 1
            return done

        try:
            done = await get_instance(self.hass).async_add_executor_job(fill)
        except Exception:  # history is a bonus, never block the setup
            _LOGGER.debug("Session kWh backfill failed", exc_info=True)
            return
        if done:
            _LOGGER.info("Session kWh recovered from history for %d session(s)", done)
            await self._save_runtime_state_if_changed()

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
        out: dict[str, Any] = {"zones": {}, "plant": self._plant_payload()}
        for zid, zone in self._zones.items():
            sensor_temps = self._read_sensor_temps(zone)
            inputs = self._gather_inputs(zone, sensor_temps)
            entered_ts = zone.state.last_state_transition_ts or None
            active = inputs.active_profile

            direction: str | None = None
            target_temperature: float | None = None
            seuil_demarrage: float | None = None
            if active is not None:
                direction = "cool" if active.mode == ProfileMode.COOL else "heat"
                target_temperature = active.target
                seuil_demarrage = active.seuil_demarrage

            # Session active ou temporairement suspendue par un override manuel :
            # on expose ses paramètres tant qu'elle n'est pas clôturée.
            in_session = zone.state.state in (
                ZoneState.RUNNING,
                ZoneState.MANUAL_OVERRIDE_TIMED,
                ZoneState.MANUAL_OVERRIDE_FREE,
            ) and (zone.state.session_target is not None)
            session = None
            if in_session:
                session = self._build_session_payload(zone, inputs, sensor_temps)

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
                "season": zone.config.season,
                "profile_bank_counts": {
                    name: len(zone.config.profile_banks.get(name, []))
                    for name in ClimateSeason.ALL
                },
                "active_profile_name": active.name if active else None,
                "operating_mode": out["plant"]["active_mode"],
                "operating_mode_name": out["plant"]["active_mode_name"],
                "sources": self._zone_sources(zid),
                "active_profile_mode": active.mode if active else None,
                "session": session,
                "sessions": zone.state.completed_sessions,
                "temperature_sensors": list(zone.config.temperature_sensors),
                "temperature_sensor_details": self._build_temperature_sensor_details(
                    zone, inputs, sensor_temps
                ),
                "flagged_sensors": list(zone.state.flagged_sensors),
                "flagged_sensors_labels": [
                    self._sensor_label(sid) for sid in zone.state.flagged_sensors
                ],
                "anomaly_detection_done": zone.state.anomaly_detection_done,
                "anomaly_delay_min": zone.config.anomaly_delay_min,
                "anomaly_heat_gain_per_hour": zone.config.anomaly_heat_gain_per_hour,
                "anomaly_cool_gain_per_hour": zone.config.anomaly_cool_gain_per_hour,
                "anomaly_notification_service": zone.config.anomaly_notification_service,
                "has_consumption_sensor": bool(
                    zone.config.consumption_sensor_cool
                    or zone.config.consumption_sensor_heat
                ),
            }
        return out

    def _build_session_payload(
        self, zone: Zone, inputs: ZoneInputs, sensor_temps: dict[str, float]
    ) -> dict[str, Any]:
        """Payload lisible de la session active/suspendue pour l'UI."""
        started_ts = zone.state.cycle_started_ts
        start_temperature = self._average_temp_values(zone.state.cycle_baseline_temps)
        current_temperature = inputs.room_temperature
        delta = self._temperature_delta(
            start_temperature, current_temperature, zone.state.session_mode
        )
        duration_min = None
        rate_per_10min = None
        if started_ts is not None:
            duration_min = max(0.0, round((inputs.now_ts - started_ts) / 60, 1))
            if delta is not None and duration_min > 0:
                rate_per_10min = round(delta / duration_min * 10, 2)

        return {
            "parent_profile_name": zone.state.cycle_start_profile_name,
            "manual": zone.state.session_manual,
            "started_ts": started_ts,
            "max_end_ts": zone.state.session_max_end_ts,
            "target": zone.state.session_target,
            "target_cutoff": zone.state.session_target_cutoff,
            "power": zone.state.session_power,
            "fan_intensity": zone.state.session_fan_intensity,
            "mode": zone.state.session_mode,
            "kickstart_until_ts": zone.state.session_kickstart_until_ts,
            "cutoff_held_since_ts": zone.state.session_cutoff_held_since_ts,
            "start_temperature": start_temperature,
            "current_temperature": current_temperature,
            "delta_temperature": delta,
            "duration_minutes": duration_min,
            "rate_per_10min": rate_per_10min,
            "sensors": self._build_temperature_sensor_details(zone, inputs, sensor_temps),
        }

    def _build_temperature_sensor_details(
        self, zone: Zone, inputs: ZoneInputs, sensor_temps: dict[str, float]
    ) -> list[dict[str, Any]]:
        details: list[dict[str, Any]] = []
        avg = inputs.room_temperature
        for sid in zone.config.temperature_sensors:
            current = sensor_temps.get(sid)
            start = zone.state.cycle_baseline_temps.get(sid)
            delta = self._temperature_delta(start, current, zone.state.session_mode)
            distance = None
            if current is not None and avg is not None:
                distance = round(current - avg, 2)
            details.append({
                "entity_id": sid,
                "name": self._sensor_label(sid),
                "current": current,
                "start": start,
                "delta": delta,
                "distance_from_average": distance,
                "included_in_average": current is not None,
                "trend": self._sensor_trend(delta),
            })
        return details

    def _average_temp_values(self, values: dict[str, float]) -> float | None:
        vals = [v for v in values.values() if isinstance(v, (int, float))]
        if not vals:
            return None
        return round(sum(vals) / len(vals), 2)

    def _temperature_delta(
        self, start: float | None, current: float | None, mode: str | None
    ) -> float | None:
        if start is None or current is None:
            return None
        raw = current - start
        # Pour l'UI, un chiffre positif signifie toujours "gain" dans le sens
        # de la session: fraîcheur gagnée en cool, chaleur gagnée en heat.
        if mode == ProfileMode.COOL:
            raw = -raw
        return round(raw, 2)

    def _sensor_trend(self, delta: float | None) -> str:
        if delta is None:
            return "unknown"
        if delta > 0.1:
            return "improving"
        if delta < -0.1:
            return "worsening"
        return "stable"


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
