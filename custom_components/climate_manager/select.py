"""Select platform: per-zone mode (auto/off/boost).

Power et fan_intensity sont désormais portés par les profils — plus de select
au niveau zone pour ces deux knobs.
"""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, ClimateSeason, ZoneMode
from .coordinator import DelormejClimateCoordinator
from .entity_base import DelormejClimateZoneEntity
from .zone import utc_now_ts


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: DelormejClimateCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[SelectEntity] = []
    for zid in coord.zones:
        entities.extend((ZoneModeSelect(coord, zid), ZoneSeasonSelect(coord, zid)))
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


class ZoneSeasonSelect(DelormejClimateZoneEntity, SelectEntity):
    """Sélectionne la banque Été/Hiver d'une zone."""

    _attr_translation_key = "zone_season"
    _attr_icon = "mdi:sun-snowflake-variant"
    _attr_options = ClimateSeason.ALL

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "season")

    @property
    def current_option(self) -> str | None:
        d = self._zone_data
        return d.get("season") if d else None

    async def async_select_option(self, option: str) -> None:
        if self.coordinator.set_zone_season(self._zone_id, option):
            await self.coordinator.async_tick_now()
