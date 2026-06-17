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

from .const import (
    CONF_PRESENCE_ABSENT_STATES,
    CONF_PRESENCE_ENTITY,
    CONF_ZONES,
    DOMAIN,
    OVERRIDE_DEBOUNCE_SECONDS,
    SETPOINT_NOOP_DELTA,
    UPDATE_INTERVAL_SECONDS,
    ZoneMode,
    ZoneState,
)
from .context_tracker import ContextTracker
from .zone import Command, Profile, Zone, ZoneConfig, ZoneInputs, ZoneRuntimeState, utc_now_ts

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
        # Per-entity debounced override decisions. Each entry holds the original
        # old_state (from the first event in a flap burst), the latest new_state,
        # and the asyncio TimerHandle that will fire _resolve_pending_override.
        self._pending_overrides: dict[str, dict[str, Any]] = {}
        # Cycle history persistence — one Store per entry, keyed by zone_id.
        # Loaded once in _async_setup; written after any tick that produced a
        # newly-completed cycle (detected by per-zone length comparison).
        self._cycle_store: Store = Store(
            hass, 1, f"{DOMAIN}_cycles_{entry.entry_id}"
        )
        self._cycle_counts: dict[str, int] = {}
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

    def update_zone_profiles(self, zone_id: str, profiles: list[dict[str, Any]]) -> None:
        """Replace the cascade of profiles for a zone (called by the card via service).

        Persists the full list to ConfigEntry.options and hot-reloads the
        zone's in-memory config — the active cycle is preserved (we do not
        rebuild the Zone, only swap the profile list).
        """
        zone = self._zones.get(zone_id)
        if not zone:
            return
        parsed = [Profile.from_dict(p) for p in profiles]
        zone.config.profiles = parsed
        self._persist_zone_config(zone_id, profiles=[p.to_dict() for p in parsed])
        self.async_set_updated_data(self._build_coordinator_data())

    async def async_tick_now(self) -> None:
        """Force an immediate tick (used after a service call)."""
        await self.async_request_refresh()

    # === DataUpdateCoordinator hooks ===

    async def _async_setup(self) -> None:
        """Register state-change listeners — called once before first refresh."""
        await self._load_cycle_history()
        await self._setup_state_listeners()

    async def _async_update_data(self) -> dict[str, Any]:
        """Tick all zones."""
        for zone in self._zones.values():
            inputs = self._gather_inputs(zone)
            commands = zone.tick(inputs)
            for cmd in commands:
                await self._apply_command(cmd)
        await self._save_cycle_history_if_changed()
        return self._build_coordinator_data()

    async def _load_cycle_history(self) -> None:
        """Restore per-zone completed cycles from disk into runtime state."""
        data = await self._cycle_store.async_load() or {}
        zones_data = data.get("zones", {}) if isinstance(data, dict) else {}
        for zid, zone in self._zones.items():
            zone.state.completed_cycles = list(zones_data.get(zid, []))
            self._cycle_counts[zid] = len(zone.state.completed_cycles)

    async def _save_cycle_history_if_changed(self) -> None:
        """Persist if any zone's completed_cycles grew during this tick."""
        changed = False
        out: dict[str, list[dict[str, Any]]] = {}
        for zid, zone in self._zones.items():
            out[zid] = zone.state.completed_cycles
            prev_count = self._cycle_counts.get(zid, 0)
            if len(zone.state.completed_cycles) != prev_count:
                changed = True
                self._cycle_counts[zid] = len(zone.state.completed_cycles)
        if changed:
            await self._cycle_store.async_save({"zones": out})

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
        # A rebuild invalidates any pending override decisions: the zones may
        # be different, and we'd resolve against a stale Zone reference.
        self._cancel_pending_overrides()
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
        # Debounce: the Daikin BRP integration occasionally emits temperature
        # flaps (X→Y→X) on poll, in two events at the same timestamp. Reacting
        # to the first wrongly trips MANUAL_OVERRIDE_TIMED. Coalesce events per
        # entity, then at fire time compare the cumulative diff to what we last
        # commanded — if it's an echo of our intent, ignore it.
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
        """Fire after the debounce window. Decide if it's a real override."""
        pending = self._pending_overrides.pop(entity_id, None)
        if pending is None:
            return
        old_state = pending["old_state"]
        new_state = pending["new_state"]
        # Echo check: latest state matches what we last commanded → no override.
        if _is_echo_of_intent(zone, new_state.attributes or {}):
            return
        # Cumulative diff: in the X→Y→X flap, old.temperature == new.temperature
        # so _user_action_changed returns False here and we bail.
        if old_state.state == new_state.state and not self._user_action_changed(
            old_state, new_state
        ):
            return
        now = utc_now_ts()
        schedule_on = self._active_profile(zone) is not None
        zone.on_external_override(now, schedule_on)
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

    def _active_profile(self, zone: Zone) -> Profile | None:
        """Return the first profile whose gate matches the current state, or None.

        Cascade rules:
        - A profile's schedule entity must be ON (or be None, meaning "always on")
        - If presence_entity is set, its current state must be in the
          presence_required_state (str or list of str). Both being None means
          no presence condition.

        Order matters: the user puts the more specific conditions (e.g. needing
        absence) at the top of the list, and a generic fallback last.
        """
        for p in zone.config.profiles:
            if not self._profile_schedule_on(p):
                continue
            if not self._profile_presence_match(p):
                continue
            return p
        return None

    def _profile_schedule_on(self, p: Profile) -> bool:
        if not p.schedule_entity:
            return True
        st = self.hass.states.get(p.schedule_entity)
        if not st or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return True  # fail-open like _read_schedule_on for the zone-level entity
        return st.state == STATE_ON

    def _profile_presence_match(self, p: Profile) -> bool:
        if not p.presence_entity:
            return True
        required = p.presence_required_state
        if required is None:
            return True
        st = self.hass.states.get(p.presence_entity)
        if not st or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return False  # fail-closed on presence: don't assume the condition holds
        if isinstance(required, str):
            return st.state == required
        return st.state in required

    def _gather_inputs(self, zone: Zone) -> ZoneInputs:
        now = utc_now_ts()
        room_temperature = self._average_temperature(zone.config.temperature_sensors)
        clim_state = self.hass.states.get(zone.config.climate_entity)
        clim_internal = None
        clim_hvac = STATE_OFF
        clim_setpoint = None
        clim_fan = None
        clim_swing = None
        clim_last_changed_ts: float | None = None
        # Capability flags — default permissive when we have no state yet
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
            schedule_is_on=active_profile is not None,
            any_window_open=self._any_window_open(zone),
            house_is_absent=self._house_is_absent(),
            supports_cool=supports_cool,
            supports_heat=supports_heat,
            supports_fan_mode=supports_fan_mode,
            supports_windnice=supports_windnice,
            clim_state_last_changed_ts=clim_last_changed_ts,
            active_profile=active_profile,
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

    def _schedule_next_event(self, zone: Zone) -> str | None:
        """ISO timestamp of the next schedule transition, or None.

        With multi-profile, we surface the next transition of the *currently
        active* profile's schedule if there is one; otherwise the first
        upcoming transition across the configured profiles.
        """
        active = self._active_profile(zone)
        candidates = []
        if active and active.schedule_entity:
            candidates.append(active.schedule_entity)
        for p in zone.config.profiles:
            if p.schedule_entity and p.schedule_entity not in candidates:
                candidates.append(p.schedule_entity)
        for ent in candidates:
            st = self.hass.states.get(ent)
            if not st:
                continue
            nxt = st.attributes.get("next_event")
            if nxt:
                return str(nxt)
        return None

    def _any_window_open(self, zone: Zone) -> bool:
        for ent in zone.config.window_sensors:
            st = self.hass.states.get(ent)
            if st and st.state == STATE_ON:
                return True
        return False

    def _window_counts(self, zone: Zone) -> tuple[int, int]:
        """Return (open_count, total_count) for the zone's window sensors."""
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
            # Thresholds come from the active profile when there is one;
            # fallback to zone defaults if not (e.g. zone idle without a
            # matching profile, or transition gap).
            active = inputs.active_profile or zone.config.profiles[0]
            clim_mode = inputs.clim_current_hvac_mode
            direction: str | None = None
            target_temperature: float | None = None
            if clim_mode == "cool":
                direction = "cool"
                target_temperature = active.seuil_fin_refroidissement
            elif clim_mode == "heat":
                direction = "heat"
                target_temperature = active.seuil_fin_chauffage
            elif zone.state.state in (ZoneState.STARTING, ZoneState.RUNNING):
                rt = inputs.room_temperature
                if rt is not None and rt > active.seuil_debut_refroidissement:
                    direction, target_temperature = "cool", active.seuil_fin_refroidissement
                elif rt is not None and rt < active.seuil_debut_chauffage:
                    direction, target_temperature = "heat", active.seuil_fin_chauffage

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
                "cycle_started_ts": zone.state.cycle_started_ts,
                "direction": direction,
                "target_temperature": target_temperature,
                "aggressivity": zone.config.aggressivity,  # legacy alias
                "power": active.power,
                "fan_intensity": active.fan_intensity,
                "supports_cool": inputs.supports_cool,
                "supports_heat": inputs.supports_heat,
                "supports_fan_mode": inputs.supports_fan_mode,
                "supports_windnice": inputs.supports_windnice,
                "schedule_next_event": self._schedule_next_event(zone),
                "windows_open": self._window_counts(zone)[0],
                "windows_total": self._window_counts(zone)[1],
                # Profiles surfaced for the card §2: list of profiles in priority
                # order + the name of the currently active one (or None when no
                # profile matches → zone gated off).
                "profiles": [p.to_dict() for p in zone.config.profiles],
                "active_profile_name": (
                    inputs.active_profile.name if inputs.active_profile else None
                ),
                # Historical cycles for §5 of the card. List of dicts, newest
                # at the end; coordinator persists across HA restarts.
                "cycle_history": zone.state.completed_cycles,
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
    """Pure helper: True iff the post-debounce attributes match what the zone
    last commanded — i.e. this state_changed burst is just the Daikin
    integration echoing our own writes back at us.

    We only consider it an echo when *every* attribute we have an intent for
    matches. Attributes we never set (preset_mode, swing_horizontal_mode,
    target_temp_high/low) are not considered: any movement on those still
    counts as a user action and falls through to the cumulative-diff check.
    """
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
