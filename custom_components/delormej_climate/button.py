"""Button platform: boost + reset_override per zone."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import DelormejClimateCoordinator
from .entity_base import DelormejClimateZoneEntity
from .zone import utc_now_ts


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
        zone.trigger_boost(utc_now_ts())
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
        zone.reset_override(utc_now_ts())
        await self.coordinator.async_tick_now()


class ZoneForceStartCoolButton(DelormejClimateZoneEntity, ButtonEntity):
    _attr_translation_key = "zone_force_start_cool"
    _attr_icon = "mdi:snowflake"

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "force_start_cool")

    @property
    def available(self) -> bool:
        return super().available and bool(self._zone_data and self._zone_data.get("supports_cool", True))

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
        return super().available and bool(self._zone_data and self._zone_data.get("supports_heat", True))

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
