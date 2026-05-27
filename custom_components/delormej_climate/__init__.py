"""The Delormej Climate integration."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, PLATFORMS, ZoneMode
from .coordinator import DelormejClimateCoordinator
from .zone import utc_now_ts

_LOGGER = logging.getLogger(__name__)


SERVICE_SET_MODE = "set_mode"
SERVICE_FORCE_OFF = "force_off"
SERVICE_RESET_OVERRIDE = "reset_override"
SERVICE_BOOST = "boost"
SERVICE_RELOAD_ZONES = "reload_zones"

SCHEMA_ZONE_ID = vol.Schema({vol.Required("zone_id"): cv.string})
SCHEMA_SET_MODE = vol.Schema(
    {vol.Required("zone_id"): cv.string, vol.Required("mode"): vol.In(ZoneMode.ALL)}
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Delormej Climate from a config entry."""
    coordinator = DelormejClimateCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    _register_services(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        hass.data[DOMAIN].pop(entry.entry_id, None)
        if not hass.data[DOMAIN]:
            _unregister_services(hass)
    return unload_ok


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Called when entry data/options change (e.g. zone added/removed)."""
    coordinator: DelormejClimateCoordinator = hass.data[DOMAIN][entry.entry_id]
    await coordinator.async_reload_zones()


# === Services ===


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_SET_MODE):
        return

    async def _set_mode(call: ServiceCall) -> None:
        zone_id = call.data["zone_id"]
        mode = call.data["mode"]
        for coord in _all_coordinators(hass):
            zone = coord.zone(zone_id)
            if zone:
                zone.set_mode(mode, utc_now_ts())
                await coord.async_tick_now()
                return

    async def _force_off(call: ServiceCall) -> None:
        zone_id = call.data["zone_id"]
        for coord in _all_coordinators(hass):
            zone = coord.zone(zone_id)
            if zone:
                zone.set_mode(ZoneMode.OFF, utc_now_ts())
                await coord.async_tick_now()
                return

    async def _reset_override(call: ServiceCall) -> None:
        zone_id = call.data["zone_id"]
        for coord in _all_coordinators(hass):
            zone = coord.zone(zone_id)
            if zone:
                zone.reset_override(utc_now_ts())
                await coord.async_tick_now()
                return

    async def _boost(call: ServiceCall) -> None:
        zone_id = call.data["zone_id"]
        for coord in _all_coordinators(hass):
            zone = coord.zone(zone_id)
            if zone:
                zone.trigger_boost(utc_now_ts())
                await coord.async_tick_now()
                return

    async def _reload(_: ServiceCall) -> None:
        for coord in _all_coordinators(hass):
            await coord.async_reload_zones()

    hass.services.async_register(DOMAIN, SERVICE_SET_MODE, _set_mode, schema=SCHEMA_SET_MODE)
    hass.services.async_register(DOMAIN, SERVICE_FORCE_OFF, _force_off, schema=SCHEMA_ZONE_ID)
    hass.services.async_register(
        DOMAIN, SERVICE_RESET_OVERRIDE, _reset_override, schema=SCHEMA_ZONE_ID
    )
    hass.services.async_register(DOMAIN, SERVICE_BOOST, _boost, schema=SCHEMA_ZONE_ID)
    hass.services.async_register(DOMAIN, SERVICE_RELOAD_ZONES, _reload)


def _unregister_services(hass: HomeAssistant) -> None:
    for service in (
        SERVICE_SET_MODE, SERVICE_FORCE_OFF, SERVICE_RESET_OVERRIDE,
        SERVICE_BOOST, SERVICE_RELOAD_ZONES,
    ):
        hass.services.async_remove(DOMAIN, service)


def _all_coordinators(hass: HomeAssistant) -> list[DelormejClimateCoordinator]:
    return list(hass.data.get(DOMAIN, {}).values())


def _data_for_entry(hass: HomeAssistant, entry_id: str) -> dict[str, Any]:
    return hass.data.get(DOMAIN, {}).get(entry_id, {})
