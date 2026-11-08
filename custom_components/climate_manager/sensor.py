"""Sensor platform for climate_manager."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import DelormejClimateCoordinator
from .entity_base import DelormejClimateZoneEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coord: DelormejClimateCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities: list[SensorEntity] = []
    for zid in coord.zones:
        entities += [
            ZoneStateSensor(coord, zid),
            ZoneRoomTemperatureSensor(coord, zid),
            ZoneSetpointSentSensor(coord, zid),
        ]
    async_add_entities(entities)


class ZoneStateSensor(DelormejClimateZoneEntity, SensorEntity):
    _attr_translation_key = "zone_state"
    _attr_icon = "mdi:state-machine"

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "state")

    @property
    def native_value(self) -> str | None:
        d = self._zone_data
        return d["state"] if d else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        d = self._zone_data
        if not d:
            return None
        attrs = {
            "any_window_open": d.get("any_window_open"),
            "house_is_absent": d.get("house_is_absent"),
            "in_override": d.get("in_override"),
            "direction": d.get("direction"),
            "target_temperature": d.get("target_temperature"),
            "seuil_demarrage": d.get("seuil_demarrage"),
            "power": d.get("power"),
            "fan_intensity": d.get("fan_intensity"),
            "supports_cool": d.get("supports_cool", True),
            "supports_heat": d.get("supports_heat", True),
            "windows_open": d.get("windows_open"),
            "windows_total": d.get("windows_total"),
            "season": d.get("season", "summer"),
            "profile_bank_counts": d.get("profile_bank_counts", {}),
            "profiles": d.get("profiles", []),
            "active_profile_name": d.get("active_profile_name"),
            "active_profile_mode": d.get("active_profile_mode"),
            "sessions": d.get("sessions", []),
            "last_session": (
                d.get("sessions")[-1] if d.get("sessions") else None
            ),
            "has_consumption_sensor": d.get("has_consumption_sensor", False),
            "temperature_sensors": d.get("temperature_sensors", []),
            "temperature_sensor_details": d.get("temperature_sensor_details", []),
            "flagged_sensors": d.get("flagged_sensors", []),
            "flagged_sensors_labels": d.get("flagged_sensors_labels", []),
            "anomaly_detection_done": d.get("anomaly_detection_done", False),
            "anomaly_delay_min": d.get("anomaly_delay_min"),
            "anomaly_heat_gain_per_hour": d.get("anomaly_heat_gain_per_hour"),
            "anomaly_cool_gain_per_hour": d.get("anomaly_cool_gain_per_hour"),
            "anomaly_notification_service": d.get("anomaly_notification_service"),
            "session": d.get("session"),
            "zone_id": self._zone_id,
        }
        sess = d.get("session")
        if sess:
            attrs["session_start_temperature"] = sess.get("start_temperature")
            attrs["session_current_temperature"] = sess.get("current_temperature")
            attrs["session_delta_temperature"] = sess.get("delta_temperature")
            attrs["session_duration_minutes"] = sess.get("duration_minutes")
            attrs["session_rate_per_10min"] = sess.get("rate_per_10min")
            attrs["session_sensor_breakdown"] = sess.get("sensors", [])
            for ts_key in ("started_ts", "max_end_ts", "kickstart_until_ts", "cutoff_held_since_ts"):
                ts = sess.get(ts_key)
                if ts:
                    attrs[f"session_{ts_key.replace('_ts','_at')}"] = (
                        datetime.fromtimestamp(ts, tz=UTC).isoformat()
                    )
        for ts_key in ("state_entered_ts", "cycle_started_ts", "override_until_ts"):
            ts = d.get(ts_key)
            if ts:
                attrs[ts_key.replace("_ts", "_at")] = datetime.fromtimestamp(ts, tz=UTC).isoformat()
        return attrs


class ZoneRoomTemperatureSensor(DelormejClimateZoneEntity, SensorEntity):
    _attr_translation_key = "zone_room_temperature"
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "room_temperature")

    @property
    def native_value(self) -> float | None:
        d = self._zone_data
        if not d or d.get("room_temperature") is None:
            return None
        return round(d["room_temperature"], 2)


class ZoneSetpointSentSensor(DelormejClimateZoneEntity, SensorEntity):
    _attr_translation_key = "zone_setpoint_sent"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS

    def __init__(self, coord: DelormejClimateCoordinator, zone_id: str) -> None:
        super().__init__(coord, zone_id, "setpoint_sent")

    @property
    def native_value(self) -> float | None:
        d = self._zone_data
        return d.get("last_setpoint_sent") if d else None
