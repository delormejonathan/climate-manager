"""Switch platform: one « En service » switch per equipment.

Out of service, Climate Manager never starts the equipment and the operating
mode falls back on the next one; the equipment stays usable by hand.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import DelormejClimateCoordinator
from .plant import EquipmentKind


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: DelormejClimateCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(EquipmentSwitch(coord, eq.id) for eq in coord.plant.equipments)


class EquipmentSwitch(CoordinatorEntity[DelormejClimateCoordinator], SwitchEntity):
    """On = in service."""

    _attr_has_entity_name = True

    def __init__(self, coord: DelormejClimateCoordinator, equipment_id: str) -> None:
        super().__init__(coord)
        self._equipment_id = equipment_id
        self._attr_unique_id = f"{coord.entry.entry_id}_equipment_{equipment_id}"
        eq = coord.plant.equipment(equipment_id)
        self._attr_name = eq.name if eq else equipment_id
        self._attr_icon = "mdi:water-boiler" if eq and eq.kind == EquipmentKind.CENTRAL else "mdi:air-conditioner"

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, f"{self.coordinator.entry.entry_id}_house")},
            name="Climate Manager",
            manufacturer="delormej",
            model="Smart Climate House",
        )

    @property
    def available(self) -> bool:
        return super().available and self.coordinator.plant.equipment(self._equipment_id) is not None

    @property
    def is_on(self) -> bool:
        eq = self.coordinator.plant.equipment(self._equipment_id)
        return bool(eq and eq.enabled)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        eq = self.coordinator.plant.equipment(self._equipment_id)
        return {"equipment_id": self._equipment_id, "kind": eq.kind if eq else None, "zones": list(eq.zones) if eq else []}

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.async_set_equipment_enabled(self._equipment_id, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.async_set_equipment_enabled(self._equipment_id, False)
