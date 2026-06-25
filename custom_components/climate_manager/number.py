"""Number platform: per-zone override duration.

C'est la seule durée encore configurable au niveau zone : combien de temps un
override manuel (= utilisateur a touché la clim) reste actif avant qu'on
reprenne la main automatiquement.
"""

from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    CONF_OVERRIDE_DUREE_MIN,
    DOMAIN,
    MAX_OVERRIDE_DUREE_MIN,
    MIN_OVERRIDE_DUREE_MIN,
)
from .coordinator import DelormejClimateCoordinator
from .entity_base import DelormejClimateZoneEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: DelormejClimateCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[NumberEntity] = []
    for zid in coord.zones:
        entities.append(OverrideDurationNumber(coord, zid))
    async_add_entities(entities)


class OverrideDurationNumber(DelormejClimateZoneEntity, NumberEntity):
    _attr_mode = NumberMode.BOX
    _attr_translation_key = "override_duree_min"
    _attr_native_min_value = MIN_OVERRIDE_DUREE_MIN
    _attr_native_max_value = MAX_OVERRIDE_DUREE_MIN
    _attr_native_step = 1
    _attr_native_unit_of_measurement = "min"
    _attr_icon = "mdi:account-clock-outline"

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "override_duree_min")

    @property
    def native_value(self) -> float | None:
        zone = self.coordinator.zone(self._zone_id)
        if not zone:
            return None
        return zone.config.override_duree_min

    async def async_set_native_value(self, value: float) -> None:
        self.coordinator.update_zone_config(
            self._zone_id, **{CONF_OVERRIDE_DUREE_MIN: int(value)}
        )
        await self.coordinator.async_tick_now()
