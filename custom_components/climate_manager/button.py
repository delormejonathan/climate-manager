"""Button platform: boost + reset_override + force_start per zone."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, ProfileMode
from .coordinator import DelormejClimateCoordinator
from .entity_base import DelormejClimateZoneEntity
from .zone import Zone, utc_now_ts


def _infer_boost_direction(zone: Zone, zone_data: dict) -> str | None:
    """Choisir cool ou heat pour un boost manuel."""
    if zone_data.get("direction") in ("cool", "heat"):
        return zone_data["direction"]
    supports_cool = zone_data.get("supports_cool", True)
    supports_heat = zone_data.get("supports_heat", True)
    if supports_cool and not supports_heat:
        return "cool"
    if supports_heat and not supports_cool:
        return "heat"
    # Si un profil est configuré, suivre son mode
    if zone.config.profiles:
        first = zone.config.profiles[0]
        return "cool" if first.mode == ProfileMode.COOL else "heat"
    return "cool"


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: DelormejClimateCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[ButtonEntity] = []
    for zid in coord.zones:
        entities += [
            ZoneBoostButton(coord, zid),
            ZoneResetOverrideButton(coord, zid),
            ZoneForceStartCoolButton(coord, zid),
            ZoneForceStartHeatButton(coord, zid),
            ZoneExtendSessionButton(coord, zid),
            ZoneCancelSessionButton(coord, zid),
        ]
    async_add_entities(entities)


class ZoneBoostButton(DelormejClimateZoneEntity, ButtonEntity):
    _attr_translation_key = "zone_boost"
    _attr_icon = "mdi:rocket-launch"

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "boost")

    async def async_press(self) -> None:
        zone = self.coordinator.zone(self._zone_id)
        if not zone:
            return
        direction = _infer_boost_direction(zone, self._zone_data or {})
        zone.trigger_boost(utc_now_ts(), direction=direction)
        await self.coordinator.async_tick_now()


class ZoneResetOverrideButton(DelormejClimateZoneEntity, ButtonEntity):
    _attr_translation_key = "zone_reset_override"
    _attr_icon = "mdi:account-cancel"

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "reset_override")

    async def async_press(self) -> None:
        zone = self.coordinator.zone(self._zone_id)
        if not zone:
            return
        clim_state = self.hass.states.get(zone.config.climate_entity)
        clim_mode = clim_state.state if clim_state else "off"
        clim_last_changed = (
            clim_state.last_changed.timestamp()
            if clim_state and clim_state.last_changed is not None
            else None
        )
        zone.reset_override(
            utc_now_ts(),
            clim_current_hvac_mode=clim_mode,
            clim_state_last_changed_ts=clim_last_changed,
        )
        await self.coordinator.async_tick_now()


class ZoneForceStartCoolButton(DelormejClimateZoneEntity, ButtonEntity):
    _attr_translation_key = "zone_force_start_cool"
    _attr_icon = "mdi:snowflake"

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "force_start_cool")

    @property
    def available(self) -> bool:
        return super().available and bool(
            self._zone_data and self._zone_data.get("supports_cool", True)
        )

    async def async_press(self) -> None:
        zone = self.coordinator.zone(self._zone_id)
        if not zone:
            return
        supports = {
            "cool": self._zone_data.get("supports_cool", True),
            "heat": self._zone_data.get("supports_heat", True),
        } if self._zone_data else None
        zone.force_start("cool", utc_now_ts(), supports=supports)
        await self.coordinator.async_tick_now()


class ZoneForceStartHeatButton(DelormejClimateZoneEntity, ButtonEntity):
    _attr_translation_key = "zone_force_start_heat"
    _attr_icon = "mdi:fire"

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "force_start_heat")

    @property
    def available(self) -> bool:
        return super().available and bool(
            self._zone_data and self._zone_data.get("supports_heat", True)
        )

    async def async_press(self) -> None:
        zone = self.coordinator.zone(self._zone_id)
        if not zone:
            return
        supports = {
            "cool": self._zone_data.get("supports_cool", True),
            "heat": self._zone_data.get("supports_heat", True),
        } if self._zone_data else None
        zone.force_start("heat", utc_now_ts(), supports=supports)
        await self.coordinator.async_tick_now()


class ZoneExtendSessionButton(DelormejClimateZoneEntity, ButtonEntity):
    """Bouton idempotent : ajoute EXTEND_SESSION_HOURS au max_end_ts."""

    _attr_translation_key = "zone_extend_session"
    _attr_icon = "mdi:clock-plus-outline"

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "extend_session_1h")

    @property
    def available(self) -> bool:
        return super().available and bool(
            self._zone_data and self._zone_data.get("session")
        )

    async def async_press(self) -> None:
        zone = self.coordinator.zone(self._zone_id)
        if not zone:
            return
        from .const import EXTEND_SESSION_HOURS
        zone.extend_active_session(EXTEND_SESSION_HOURS * 3600)
        await self.coordinator.async_tick_now()


class ZoneCancelSessionButton(DelormejClimateZoneEntity, ButtonEntity):
    """Annule la session active immédiatement."""

    _attr_translation_key = "zone_cancel_session"
    _attr_icon = "mdi:stop-circle-outline"

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "cancel_session")

    @property
    def available(self) -> bool:
        return super().available and bool(
            self._zone_data and self._zone_data.get("session")
        )

    async def async_press(self) -> None:
        zone = self.coordinator.zone(self._zone_id)
        if not zone:
            return
        zone.cancel_active_session(now_ts=utc_now_ts())
        await self.coordinator.async_tick_now()
