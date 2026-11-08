"""Button platform: boost per zone (sessions are driven by services and the card)."""

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
        entities.append(ZoneBoostButton(coord, zid))
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
