"""Select platform: per-zone mode (auto/off/boost).

Power et fan_intensity sont désormais portés par les profils — plus de select
au niveau zone pour ces deux knobs.
"""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, ZoneMode
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
    entities.append(OperatingModeSelect(coord))
    async_add_entities(entities)


OFF_OPTION = "Arrêt"


class OperatingModeSelect(CoordinatorEntity[DelormejClimateCoordinator], SelectEntity):
    """House operating mode (which equipment heats or cools). For Siri and automations."""

    _attr_has_entity_name = True
    _attr_translation_key = "operating_mode"
    _attr_icon = "mdi:home-thermometer-outline"

    def __init__(self, coord: DelormejClimateCoordinator) -> None:
        super().__init__(coord)
        self._attr_unique_id = f"{coord.entry.entry_id}_operating_mode"

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, f"{self.coordinator.entry.entry_id}_house")},
            name="Climate Manager",
            manufacturer="delormej",
            model="Smart Climate House",
        )

    @property
    def options(self) -> list[str]:
        return [m.name for m in self.coordinator.plant.modes] + [OFF_OPTION]

    @property
    def current_option(self) -> str | None:
        mode = self.coordinator.plant.current_mode
        return mode.name if mode else OFF_OPTION

    @property
    def extra_state_attributes(self) -> dict:
        data = (self.coordinator.data or {}).get("plant") or {}
        return {
            "mode_id": data.get("active_mode"),
            "direction": data.get("direction"),
            "relation": data.get("relation"),
            "equipments": data.get("equipments", []),
        }

    async def async_select_option(self, option: str) -> None:
        mode = next((m for m in self.coordinator.plant.modes if m.name == option), None)
        self.coordinator.set_active_mode(mode.id if mode else None)
        await self.coordinator.async_tick_now()


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
