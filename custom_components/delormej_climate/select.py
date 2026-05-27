"""Select platform: per-zone mode + aggressivity."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, Aggressivity, ZoneMode
from .coordinator import DelormejClimateCoordinator
from .entity_base import DelormejClimateZoneEntity
from .zone import utc_now_ts


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: DelormejClimateCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[SelectEntity] = []
    for zid in coord.zones:
        entities.append(ZoneModeSelect(coord, zid))
        entities.append(ZoneAggressivitySelect(coord, zid))
    async_add_entities(entities)


class ZoneModeSelect(DelormejClimateZoneEntity, SelectEntity):
    _attr_translation_key = "zone_mode"
    _attr_icon = "mdi:tune-variant"
    _attr_options = ZoneMode.ALL

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "mode")

    @property
    def current_option(self) -> str | None:
        d = self._zone_data
        return d.get("mode") if d else None

    async def async_select_option(self, option: str) -> None:
        zone = self.coordinator.zone(self._zone_id)
        if not zone:
            return
        zone.set_mode(option, utc_now_ts())
        await self.coordinator.async_tick_now()


class ZoneAggressivitySelect(DelormejClimateZoneEntity, SelectEntity):
    _attr_translation_key = "zone_aggressivity"
    _attr_icon = "mdi:speedometer"
    _attr_options = Aggressivity.ALL

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "aggressivity")

    @property
    def current_option(self) -> str | None:
        zone = self.coordinator.zone(self._zone_id)
        return zone.config.aggressivity if zone else None

    async def async_select_option(self, option: str) -> None:
        if option not in Aggressivity.ALL:
            return
        self.coordinator.update_zone_config(self._zone_id, aggressivity=option)
        await self.coordinator.async_tick_now()
