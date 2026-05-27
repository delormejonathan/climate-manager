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
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import (
    CONF_PRESENCE_ABSENT_STATES,
    CONF_PRESENCE_ENTITY,
    CONF_ZONES,
    DOMAIN,
    UPDATE_INTERVAL_SECONDS,
    ZoneMode,
    ZoneState,
)
from .context_tracker import ContextTracker
from .zone import Command, Zone, ZoneConfig, ZoneInputs, ZoneRuntimeState, utc_now_ts

_LOGGER = logging.getLogger(__name__)


class DelormejClimateCoordinator(DataUpdateCoordinator):
    """Owns Zone state machines, ticks them, applies commands."""

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
        self._rebuild_zones()

    # === Public API for platforms ===

    @property
    def zones(self) -> dict[str, Zone]:
        return self._zones

    def zone(self, zone_id: str) -> Zone | None:
        return self._zones.get(zone_id)

    def update_zone_config(self, zone_id: str, **kwargs: Any) -> None:
        """Update a zone's static config (e.g. thresholds from number entities)."""
        zone = self._zones.get(zone_id)
        if not zone:
            return
        for k, v in kwargs.items():
            if hasattr(zone.config, k):
                setattr(zone.config, k, v)
        self._persist_zone_config(zone_id, **kwargs)
        self.async_set_updated_data(self._build_coordinator_data())

    async def async_tick_now(self) -> None:
        """Force an immediate tick (used after a service call)."""
        await self.async_request_refresh()

    # === DataUpdateCoordinator hooks ===

    async def _async_setup(self) -> None:
        """Register state-change listeners — called once before first refresh."""
        await self._setup_state_listeners()

    async def _async_update_data(self) -> dict[str, Any]:
        """Tick all zones."""
        for zone in self._zones.values():
            inputs = self._gather_inputs(zone)
            commands = zone.tick(inputs)
            for cmd in commands:
                await self._apply_command(cmd)
        return self._build_coordinator_data()

    # === Zone setup / rebuild ===

    def _rebuild_zones(self) -> None:
        """(Re)build zones from ConfigEntry.options['zones']."""
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
        """Re-register state listeners on each rebuild."""
        if self._unsub_state_listener:
            self._unsub_state_listener()
            self._unsub_state_listener = None
        if not self._zones:
            return
        entities = [z.config.climate_entity for z in self._zones.values()]
        self._unsub_state_listener = async_track_state_change_event(
            self.hass, entities, self._on_clim_state_changed
        )

    async def async_reload_zones(self) -> None:
        """Rebuild zones (after a config update)."""
        self._rebuild_zones()
        await self._setup_state_listeners()
        await self.async_request_refresh()

    # === State listener: detect external overrides ===

    # Attributes on a climate.* entity that a user (or app) actively chooses.
    # A change to current_temperature, last_updated, etc. is the integration's
    # own polling — NOT an override. Detecting override on those was the v0.1.x
    # bug where every Daikin poll silently flipped the zone to MANUAL_OVERRIDE_TIMED.
    _OVERRIDE_TRIGGER_ATTRS = frozenset(
        {
            "temperature",  # setpoint
            "fan_mode",
            "swing_mode",
            "swing_horizontal_mode",
            "preset_mode",
            "target_temp_high",
            "target_temp_low",
        }
    )

    @callback
    def _on_clim_state_changed(self, event: Event[EventStateChangedData]) -> None:
        entity_id = event.data["entity_id"]
        new_state = event.data.get("new_state")
        old_state = event.data.get("old_state")
        if new_state is None:
            return
        zone = next(
            (z for z in self._zones.values() if z.config.climate_entity == entity_id), None
        )
        if zone is None:
            return
        if self._context_tracker.is_ours(event.context):
            return
        # Did anything user-actionable actually change? If old_state is None this
        # is the initial state (HA boot or integration reload) — not an override.
        if old_state is None:
            return
        if old_state.state == new_state.state and not self._user_action_changed(
            old_state, new_state
        ):
            return
        # External override
        now = utc_now_ts()
        schedule_on = self._read_schedule_on(zone)
        zone.on_external_override(now, schedule_on)
        self.hass.async_create_task(self.async_request_refresh())

    def _user_action_changed(self, old_state, new_state) -> bool:
        """Return True iff a user-actionable attribute differs between old and new."""
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

    # === Inputs gathering ===

    def _gather_inputs(self, zone: Zone) -> ZoneInputs:
        now = utc_now_ts()
        room_temperature = self._average_temperature(zone.config.temperature_sensors)
        clim_state = self.hass.states.get(zone.config.climate_entity)
        clim_internal = None
        clim_hvac = STATE_OFF
        clim_setpoint = None
        clim_fan = None
        clim_swing = None
        if clim_state and clim_state.state not in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            clim_hvac = clim_state.state
            attrs = clim_state.attributes
            clim_internal = _as_float(attrs.get(ATTR_CURRENT_TEMPERATURE))
            clim_setpoint = _as_float(attrs.get(ATTR_TEMPERATURE))
            clim_fan = attrs.get(ATTR_FAN_MODE)
            clim_swing = attrs.get(ATTR_SWING_MODE)
        return ZoneInputs(
            now_ts=now,
            room_temperature=room_temperature,
            clim_internal_temperature=clim_internal,
            clim_current_hvac_mode=clim_hvac,
            clim_current_setpoint=clim_setpoint,
            clim_current_fan_mode=clim_fan,
            clim_current_swing_mode=clim_swing,
            schedule_is_on=self._read_schedule_on(zone),
            any_window_open=self._any_window_open(zone),
            house_is_absent=self._house_is_absent(),
        )

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

    def _read_schedule_on(self, zone: Zone) -> bool:
        ent = zone.config.schedule_entity
        if not ent:
            return True  # no schedule configured → always allowed
        st = self.hass.states.get(ent)
        if not st or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return True  # fail-open: don't lock the zone if schedule entity missing
        return st.state == STATE_ON

    def _any_window_open(self, zone: Zone) -> bool:
        for ent in zone.config.window_sensors:
            st = self.hass.states.get(ent)
            if st and st.state == STATE_ON:
                return True
        return False

    def _house_is_absent(self) -> bool:
        ent = self.entry.data.get(CONF_PRESENCE_ENTITY)
        absent_states = self.entry.data.get(CONF_PRESENCE_ABSENT_STATES, [])
        if not ent or not absent_states:
            return False
        st = self.hass.states.get(ent)
        if not st:
            return False
        return st.state in absent_states

    # === Persistence of mutable zone config ===

    def _persist_zone_config(self, zone_id: str, **kwargs: Any) -> None:
        """Save changed zone fields back to ConfigEntry.options."""
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
            # Derived: when we entered the current state, and (for timed states)
            # when we'll leave it. Exposing these lets the Lovelace card render
            # narrative timers like "stabilisation jusqu'à 11:25".
            entered_ts = zone.state.last_state_transition_ts or None
            stabilization_ends_ts = None
            cooldown_ends_ts = None
            if zone.state.state == ZoneState.STABILIZING and entered_ts:
                stabilization_ends_ts = entered_ts + zone.config.duree_stabilisation_min * 60
            if zone.state.state == ZoneState.COOLDOWN and entered_ts:
                cooldown_ends_ts = entered_ts + zone.config.duree_cooldown_min * 60

            # Direction & target temperature inferred from underlying clim mode
            # (more reliable than guessing from thresholds + room temp).
            clim_mode = inputs.clim_current_hvac_mode
            direction: str | None = None
            target_temperature: float | None = None
            if clim_mode == "cool":
                direction = "cool"
                target_temperature = zone.config.seuil_fin_refroidissement
            elif clim_mode == "heat":
                direction = "heat"
                target_temperature = zone.config.seuil_fin_chauffage
            elif zone.state.state in (ZoneState.STARTING, ZoneState.RUNNING):
                # Just decided to start but no clim mode echoed yet — guess from
                # the thresholds vs current temperature.
                rt = inputs.room_temperature
                if rt is not None and rt > zone.config.seuil_debut_refroidissement:
                    direction, target_temperature = "cool", zone.config.seuil_fin_refroidissement
                elif rt is not None and rt < zone.config.seuil_debut_chauffage:
                    direction, target_temperature = "heat", zone.config.seuil_fin_chauffage

            out["zones"][zid] = {
                "config": zone.config,
                "state": zone.state.state,
                "regime": zone.state.regime,
                "mode": zone.state.mode,
                "room_temperature": inputs.room_temperature,
                "clim_internal_temperature": inputs.clim_internal_temperature,
                "clim_current_setpoint": inputs.clim_current_setpoint,
                "last_setpoint_sent": zone.state.last_setpoint_sent,
                "override_until_ts": zone.state.override_until_ts,
                "boost_until_ts": zone.state.boost_until_ts,
                "schedule_on": inputs.schedule_is_on,
                "any_window_open": inputs.any_window_open,
                "house_is_absent": inputs.house_is_absent,
                "in_override": zone.state.state
                in (ZoneState.MANUAL_OVERRIDE_TIMED, ZoneState.MANUAL_OVERRIDE_FREE),
                "is_off_mode": zone.state.mode == ZoneMode.OFF,
                "state_entered_ts": entered_ts,
                "stabilization_ends_ts": stabilization_ends_ts,
                "cooldown_ends_ts": cooldown_ends_ts,
                "direction": direction,
                "target_temperature": target_temperature,
            }
        return out


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
