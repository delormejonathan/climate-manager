"""Websocket API used by the Climate Manager settings panel.

The panel is the only place where the integration is configured: zones
(equipment), comfort profiles (per season) and house settings. Daily use
stays on the dashboard card.
"""

from __future__ import annotations

import uuid
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback

from .const import (
    CONF_ANOMALY_COOL_GAIN_PER_HOUR,
    CONF_ANOMALY_DELAY_MIN,
    CONF_ANOMALY_HEAT_GAIN_PER_HOUR,
    CONF_ANOMALY_NOTIFICATION_SERVICE,
    CONF_CLIMATE_ENTITY,
    CONF_CONSUMPTION_SENSOR_COOL,
    CONF_CONSUMPTION_SENSOR_HEAT,
    CONF_OVERRIDE_DUREE_MIN,
    CONF_PRESENCE_ABSENT_STATES,
    CONF_PRESENCE_ENTITY,
    CONF_PRESENCE_HOME_STATES,
    CONF_PROFILE_BANKS,
    CONF_SEASON,
    CONF_TEMPERATURE_SENSORS,
    CONF_WINDOW_SENSORS,
    CONF_ZONE_ID,
    CONF_ZONE_NAME,
    CONF_ZONES,
    DEFAULT_ANOMALY_COOL_GAIN_PER_HOUR,
    DEFAULT_ANOMALY_DELAY_MIN,
    DEFAULT_ANOMALY_HEAT_GAIN_PER_HOUR,
    DEFAULT_OVERRIDE_DUREE_MIN,
    DOMAIN,
    MAX_ANOMALY_DELAY_MIN,
    MAX_OVERRIDE_DUREE_MIN,
    MIN_ANOMALY_DELAY_MIN,
    MIN_OVERRIDE_DUREE_MIN,
    ClimateSeason,
)
from .plant import DIRECTIONS, Equipment, EquipmentKind, OperatingMode, Plant, Relation
from .zone import Profile, ZoneConfig

_REGISTERED = "_ws_registered"

EQUIPMENT_KEYS = (
    CONF_ZONE_NAME,
    CONF_CLIMATE_ENTITY,
    CONF_TEMPERATURE_SENSORS,
    CONF_WINDOW_SENSORS,
    CONF_CONSUMPTION_SENSOR_COOL,
    CONF_CONSUMPTION_SENSOR_HEAT,
    CONF_OVERRIDE_DUREE_MIN,
    CONF_ANOMALY_DELAY_MIN,
    CONF_ANOMALY_HEAT_GAIN_PER_HOUR,
    CONF_ANOMALY_COOL_GAIN_PER_HOUR,
    CONF_ANOMALY_NOTIFICATION_SERVICE,
)


def _entity_id(domain: str):
    def validate(value: Any) -> str:
        value = str(value or "").strip()
        if not value.startswith(f"{domain}."):
            raise vol.Invalid(f"expected a {domain}.* entity")
        return value

    return validate


def _optional_entity(domain: str):
    check = _entity_id(domain)

    def validate(value: Any) -> str | None:
        if value in (None, ""):
            return None
        return check(value)

    return validate


ZONE_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_ZONE_NAME): vol.All(str, vol.Strip, vol.Length(min=1, max=40)),
        vol.Optional(CONF_CLIMATE_ENTITY): _optional_entity("climate"),
        vol.Required(CONF_TEMPERATURE_SENSORS): vol.All(
            [_entity_id("sensor")], vol.Length(min=1)
        ),
        vol.Optional(CONF_WINDOW_SENSORS, default=list): [_entity_id("binary_sensor")],
        vol.Optional(CONF_CONSUMPTION_SENSOR_COOL): _optional_entity("sensor"),
        vol.Optional(CONF_CONSUMPTION_SENSOR_HEAT): _optional_entity("sensor"),
        vol.Optional(CONF_OVERRIDE_DUREE_MIN, default=DEFAULT_OVERRIDE_DUREE_MIN): vol.All(
            vol.Coerce(int), vol.Range(min=MIN_OVERRIDE_DUREE_MIN, max=MAX_OVERRIDE_DUREE_MIN)
        ),
        vol.Optional(CONF_ANOMALY_DELAY_MIN, default=DEFAULT_ANOMALY_DELAY_MIN): vol.All(
            vol.Coerce(int), vol.Range(min=MIN_ANOMALY_DELAY_MIN, max=MAX_ANOMALY_DELAY_MIN)
        ),
        vol.Optional(
            CONF_ANOMALY_HEAT_GAIN_PER_HOUR, default=DEFAULT_ANOMALY_HEAT_GAIN_PER_HOUR
        ): vol.All(vol.Coerce(float), vol.Range(min=0, max=5)),
        vol.Optional(
            CONF_ANOMALY_COOL_GAIN_PER_HOUR, default=DEFAULT_ANOMALY_COOL_GAIN_PER_HOUR
        ): vol.All(vol.Coerce(float), vol.Range(min=0, max=5)),
        vol.Optional(CONF_ANOMALY_NOTIFICATION_SERVICE): vol.Any(None, str),
    }
)

PROFILE_SCHEMA = vol.Schema(
    {
        vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=40)),
        vol.Required("mode"): vol.In(["cool", "heat"]),
        vol.Optional("active_from"): vol.Any(None, vol.Match(r"^\d{2}:\d{2}$")),
        vol.Optional("active_to"): vol.Any(None, vol.Match(r"^\d{2}:\d{2}$")),
        vol.Optional("presence_entity"): vol.Any(None, str),
        vol.Optional("presence_required_state"): vol.Any(None, str, [str]),
        vol.Required("seuil_demarrage"): vol.Coerce(float),
        vol.Required("target"): vol.Coerce(float),
        vol.Optional("target_cutoff"): vol.Any(None, vol.Coerce(float)),
        vol.Optional("power"): str,
        vol.Optional("fan_intensity"): str,
        vol.Optional("kickstart_minutes"): vol.Coerce(int),
        vol.Optional("kickstart_power"): vol.Any(None, str),
        vol.Optional("kickstart_fan_intensity"): vol.Any(None, str),
    },
    extra=vol.REMOVE_EXTRA,
)


def _any_entity(value: Any) -> str | None:
    value = str(value or "").strip()
    if not value:
        return None
    if "." not in value:
        raise vol.Invalid("expected an entity id")
    return value


EQUIPMENT_SCHEMA = vol.Schema(
    {
        vol.Optional("id"): vol.Any(None, str),
        vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=40)),
        vol.Required("kind"): vol.In(EquipmentKind.ALL),
        vol.Required("entity"): _any_entity,
        vol.Optional("zones", default=list): [str],
        vol.Optional("heat", default=True): bool,
        vol.Optional("cool", default=False): bool,
        vol.Optional("on_option"): vol.Any(None, str),
        vol.Optional("off_option"): vol.Any(None, str),
        vol.Optional("setpoint_entity"): vol.Any(None, _any_entity),
        vol.Optional("setpoint_offset", default=1.0): vol.All(vol.Coerce(float), vol.Range(min=0, max=5)),
        vol.Optional("running_entity"): vol.Any(None, _any_entity),
        vol.Optional("enabled"): bool,
        vol.Optional("energy_sensors", default=list): [_any_entity],
        vol.Optional("energy"): vol.In(("electricity", "gas")),
        vol.Optional("energy_price"): vol.Any(None, vol.All(vol.Coerce(float), vol.Range(min=0, max=10))),
    },
    extra=vol.REMOVE_EXTRA,
)

MODE_SCHEMA = vol.Schema(
    {
        vol.Optional("id"): vol.Any(None, str),
        vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=40)),
        vol.Required("direction"): vol.In(list(DIRECTIONS)),
        vol.Required("relation"): vol.In(Relation.ALL),
        vol.Optional("equipments", default=list): [str],
        vol.Optional("boost_gap", default=1.0): vol.All(vol.Coerce(float), vol.Range(min=0.2, max=5)),
        vol.Optional("boost_delay_min", default=20): vol.All(vol.Coerce(int), vol.Range(min=0, max=240)),
        vol.Optional("icon"): vol.Any(None, str),
    },
    extra=vol.REMOVE_EXTRA,
)


def _entry_and_coordinator(hass: HomeAssistant):
    entries: list[ConfigEntry] = hass.config_entries.async_entries(DOMAIN)
    for entry in entries:
        coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id)
        if coordinator is not None:
            return entry, coordinator
    return None, None


def _zone_payload(raw: dict[str, Any]) -> dict[str, Any]:
    config = ZoneConfig.from_dict(raw)
    return {
        "id": config.zone_id,
        CONF_ZONE_NAME: config.name,
        CONF_CLIMATE_ENTITY: config.climate_entity,
        CONF_TEMPERATURE_SENSORS: config.temperature_sensors,
        CONF_WINDOW_SENSORS: config.window_sensors,
        CONF_CONSUMPTION_SENSOR_COOL: config.consumption_sensor_cool,
        CONF_CONSUMPTION_SENSOR_HEAT: config.consumption_sensor_heat,
        CONF_OVERRIDE_DUREE_MIN: config.override_duree_min,
        CONF_ANOMALY_DELAY_MIN: config.anomaly_delay_min,
        CONF_ANOMALY_HEAT_GAIN_PER_HOUR: config.anomaly_heat_gain_per_hour,
        CONF_ANOMALY_COOL_GAIN_PER_HOUR: config.anomaly_cool_gain_per_hour,
        CONF_ANOMALY_NOTIFICATION_SERVICE: config.anomaly_notification_service,
        CONF_SEASON: config.season,
        CONF_PROFILE_BANKS: {
            name: [p.to_dict() for p in config.profile_banks.get(name, [])]
            for name in ClimateSeason.ALL
        },
    }


def _settings_payload(hass: HomeAssistant, entry: ConfigEntry, coordinator) -> dict[str, Any]:
    zones = [_zone_payload(z) for z in entry.options.get(CONF_ZONES, [])]
    runtime = (coordinator.data or {}).get("zones", {})
    for zone in zones:
        live = runtime.get(zone["id"], {})
        zone["live"] = {
            "state": live.get("state"),
            "room_temperature": live.get("room_temperature"),
            "active_profile_name": live.get("active_profile_name"),
        }
    seasons = {z[CONF_SEASON] for z in zones}
    plant: Plant = coordinator.plant
    live_plant = (coordinator.data or {}).get("plant") or {}
    live_eq = {e["id"]: e for e in live_plant.get("equipments", [])}
    for zone in zones:
        zone["sources"] = (runtime.get(zone["id"], {}) or {}).get("sources", [])
    return {
        "equipments": [{**e.to_dict(), "running": live_eq.get(e.id, {}).get("running", False)} for e in plant.equipments],
        "modes": [m.to_dict() for m in plant.modes],
        "active_mode": plant.active_mode,
        "entry_id": entry.entry_id,
        "house": {
            CONF_PRESENCE_ENTITY: entry.data.get(CONF_PRESENCE_ENTITY),
            CONF_PRESENCE_ABSENT_STATES: entry.data.get(CONF_PRESENCE_ABSENT_STATES, []),
            CONF_PRESENCE_HOME_STATES: entry.data.get(CONF_PRESENCE_HOME_STATES, []),
            "season": seasons.pop() if len(seasons) == 1 else ("mixed" if seasons else None),
        },
        "zones": zones,
    }


@callback
def async_register(hass: HomeAssistant) -> None:
    if hass.data.setdefault(DOMAIN, {}).get(_REGISTERED):
        return
    hass.data[DOMAIN][_REGISTERED] = True
    for handler in (
        ws_get_settings,
        ws_save_zone,
        ws_delete_zone,
        ws_save_profiles,
        ws_set_season,
        ws_save_house,
        ws_save_equipment,
        ws_enable_equipment,
        ws_delete_equipment,
        ws_save_mode,
        ws_delete_mode,
        ws_set_mode,
        ws_reorder_modes,
    ):
        websocket_api.async_register_command(hass, handler)


def _not_loaded(connection, msg) -> None:
    connection.send_error(msg["id"], "not_loaded", "Climate Manager is not set up")


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/settings"})
@websocket_api.require_admin
@callback
def ws_get_settings(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    connection.send_result(msg["id"], _settings_payload(hass, entry, coordinator))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/zone/save",
        vol.Optional("zone_id"): vol.Any(None, str),
        vol.Required("zone"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_zone(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    try:
        data = ZONE_SCHEMA(msg["zone"])
    except vol.Invalid as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    zones = list(entry.options.get(CONF_ZONES, []))
    zone_id = msg.get("zone_id")
    if zone_id:
        index = next((i for i, z in enumerate(zones) if z.get(CONF_ZONE_ID) == zone_id), None)
        if index is None:
            connection.send_error(msg["id"], "not_found", f"Unknown zone {zone_id}")
            return
        zones[index] = {**zones[index], **data}
    else:
        zone_id = uuid.uuid4().hex[:8]
        zones.append({CONF_ZONE_ID: zone_id, **data, CONF_SEASON: _house_season(zones)})
    hass.config_entries.async_update_entry(entry, options={**entry.options, CONF_ZONES: zones})
    connection.send_result(msg["id"], {"zone_id": zone_id})


def _house_season(zones: list[dict[str, Any]]) -> str:
    seasons = [z.get(CONF_SEASON) for z in zones if z.get(CONF_SEASON) in ClimateSeason.ALL]
    return seasons[0] if seasons else ClimateSeason.WINTER


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/zone/delete", vol.Required("zone_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_zone(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    zones = [z for z in entry.options.get(CONF_ZONES, []) if z.get(CONF_ZONE_ID) != msg["zone_id"]]
    hass.config_entries.async_update_entry(entry, options={**entry.options, CONF_ZONES: zones})
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/profiles/save",
        vol.Required("season"): vol.In(ClimateSeason.ALL),
        # zone_id -> ordered profile list
        vol.Required("banks"): {str: [dict]},
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_profiles(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    try:
        banks = {
            zone_id: [Profile.from_dict(PROFILE_SCHEMA(p)).to_dict() for p in profiles]
            for zone_id, profiles in msg["banks"].items()
        }
    except vol.Invalid as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    unknown = [zone_id for zone_id in banks if coordinator.zone(zone_id) is None]
    if unknown:
        connection.send_error(msg["id"], "not_found", f"Unknown zones {unknown}")
        return
    for zone_id, profiles in banks.items():
        coordinator.update_zone_bank(zone_id, msg["season"], profiles)
    await coordinator.async_tick_now()
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/season/set",
        vol.Required("season"): vol.In(ClimateSeason.ALL),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_season(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    direction = "heat" if msg["season"] == ClimateSeason.WINTER else "cool"
    mode = next((m for m in coordinator.plant.modes if m.direction == direction), None)
    if mode is not None:
        coordinator.set_active_mode(mode.id)
    else:
        coordinator.set_house_season(msg["season"])
    await coordinator.async_tick_now()
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/house/save",
        vol.Optional(CONF_PRESENCE_ENTITY): vol.Any(None, str),
        vol.Optional(CONF_PRESENCE_ABSENT_STATES): [str],
        vol.Optional(CONF_PRESENCE_HOME_STATES): [str],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_house(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    data = dict(entry.data)
    for key in (CONF_PRESENCE_ENTITY, CONF_PRESENCE_ABSENT_STATES, CONF_PRESENCE_HOME_STATES):
        if key in msg:
            value = msg[key]
            if value in (None, "", []):
                data.pop(key, None)
            else:
                data[key] = value
    hass.config_entries.async_update_entry(entry, data=data)
    connection.send_result(msg["id"], {})


# === Plant: equipment and operating modes ===


def _plant_copy(coordinator) -> Plant:
    return Plant.from_options(coordinator.plant.to_options())


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/equipment/save", vol.Required("equipment"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_equipment(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    try:
        data = EQUIPMENT_SCHEMA(msg["equipment"])
    except vol.Invalid as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    if not data["heat"] and not data["cool"]:
        connection.send_error(msg["id"], "invalid_format", "heat or cool required")
        return
    plant = _plant_copy(coordinator)
    known_zones = set(coordinator.zones)
    data["zones"] = [z for z in data["zones"] if z in known_zones]
    if "enabled" not in data:
        previous = plant.equipment(data.get("id") or "")
        data["enabled"] = previous.enabled if previous else True
    eq = Equipment.from_dict(data)
    if eq.kind == EquipmentKind.HEAT_PUMP:
        # A zone has one heat pump at most: the new one replaces it there.
        for other in plant.equipments:
            if other.id != eq.id and other.kind == EquipmentKind.HEAT_PUMP:
                other.zones = [z for z in other.zones if z not in eq.zones]
    index = next((i for i, e in enumerate(plant.equipments) if e.id == eq.id), None)
    if index is None:
        plant.equipments.append(eq)
    else:
        plant.equipments[index] = eq
    coordinator.save_plant(plant)
    await coordinator.async_tick_now()
    connection.send_result(msg["id"], {"equipment_id": eq.id})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/equipment/enable",
        vol.Required("equipment_id"): str,
        vol.Required("enabled"): bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_enable_equipment(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    if not await coordinator.async_set_equipment_enabled(msg["equipment_id"], msg["enabled"]):
        connection.send_error(msg["id"], "not_found", "unknown equipment")
        return
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/equipment/delete", vol.Required("equipment_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_equipment(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    plant = _plant_copy(coordinator)
    plant.equipments = [e for e in plant.equipments if e.id != msg["equipment_id"]]
    for mode in plant.modes:
        mode.equipments = [e for e in mode.equipments if e != msg["equipment_id"]]
    coordinator.save_plant(plant)
    await coordinator.async_tick_now()
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/mode/save", vol.Required("mode"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save_mode(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    try:
        data = MODE_SCHEMA(msg["mode"])
    except vol.Invalid as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    plant = _plant_copy(coordinator)
    known = {e.id for e in plant.equipments}
    data["equipments"] = [e for e in dict.fromkeys(data["equipments"]) if e in known]
    mode = OperatingMode.from_dict(data)
    if any(m.name.lower() == mode.name.lower() and m.id != mode.id for m in plant.modes):
        connection.send_error(msg["id"], "invalid_format", "name already used")
        return
    index = next((i for i, m in enumerate(plant.modes) if m.id == mode.id), None)
    if index is None:
        plant.modes.append(mode)
    else:
        plant.modes[index] = mode
    coordinator.save_plant(plant)
    await coordinator.async_tick_now()
    connection.send_result(msg["id"], {"mode_id": mode.id})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/mode/delete", vol.Required("mode_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_mode(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    plant = _plant_copy(coordinator)
    plant.modes = [m for m in plant.modes if m.id != msg["mode_id"]]
    if plant.active_mode == msg["mode_id"]:
        plant.active_mode = None
    coordinator.save_plant(plant)
    await coordinator.async_tick_now()
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/mode/reorder", vol.Required("mode_ids"): [str]}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_reorder_modes(hass: HomeAssistant, connection, msg) -> None:
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    plant = _plant_copy(coordinator)
    order = {mid: i for i, mid in enumerate(msg["mode_ids"])}
    plant.modes.sort(key=lambda m: order.get(m.id, len(order)))
    coordinator.save_plant(plant)
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/mode/set", vol.Optional("mode_id"): vol.Any(None, str)}
)
@websocket_api.async_response
async def ws_set_mode(hass: HomeAssistant, connection, msg) -> None:
    """Put a mode in service (or none). Allowed to every user: it is daily use."""
    entry, coordinator = _entry_and_coordinator(hass)
    if entry is None:
        _not_loaded(connection, msg)
        return
    if not coordinator.set_active_mode(msg.get("mode_id")):
        connection.send_error(msg["id"], "not_found", "Unknown mode")
        return
    await coordinator.async_tick_now()
    connection.send_result(msg["id"], {})
