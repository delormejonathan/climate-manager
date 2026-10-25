from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from custom_components.climate_manager.const import ProfileMode, ZoneState
from custom_components.climate_manager.coordinator import DelormejClimateCoordinator
from custom_components.climate_manager.zone import (
    Zone,
    ZoneConfig,
    ZoneInputs,
    ZoneRuntimeState,
    detect_temperature_gain_anomalies,
)


def test_heat_gain_anomaly_uses_oriented_hourly_rate() -> None:
    anomalies = detect_temperature_gain_anomalies(
        {"elina": 20.2, "bureau": 19.5, "ami": 19.5},
        {"elina": 22.4, "bureau": 19.5, "ami": 19.5},
        ProfileMode.HEAT,
        duration_hours=1.0,
        min_gain_per_hour=0.5,
    )

    assert set(anomalies) == {"bureau", "ami"}
    assert anomalies["bureau"]["gain"] == 0.0
    assert anomalies["bureau"]["gain_per_hour"] == 0.0


def test_cool_gain_anomaly_reverses_temperature_delta() -> None:
    anomalies = detect_temperature_gain_anomalies(
        {"open": 27.0, "closed": 27.0},
        {"open": 26.0, "closed": 26.8},
        ProfileMode.COOL,
        duration_hours=1.0,
        min_gain_per_hour=0.5,
    )

    assert set(anomalies) == {"closed"}
    assert anomalies["closed"]["gain"] == 0.2


def test_room_already_at_target_is_not_an_anomaly() -> None:
    anomalies = detect_temperature_gain_anomalies(
        {"comfortable": 21.1, "cold": 19.0},
        {"comfortable": 21.1, "cold": 19.1},
        ProfileMode.HEAT,
        duration_hours=1.0,
        min_gain_per_hour=0.5,
        target=21.0,
    )

    assert set(anomalies) == {"cold"}


def _running_zone() -> Zone:
    return Zone(
        ZoneConfig(
            zone_id="etage",
            name="Étage",
            climate_entity="climate.escalier",
            temperature_sensors=["sensor.elina", "sensor.bureau", "sensor.ami"],
            anomaly_delay_min=60,
            anomaly_heat_gain_per_hour=0.5,
            anomaly_cool_gain_per_hour=0.4,
            anomaly_notification_service="notify.mobile_app_iphone",
        ),
        ZoneRuntimeState(
            state=ZoneState.RUNNING,
            cycle_started_ts=1_000.0,
            cycle_start_profile_name="Présent",
            cycle_baseline_temps={
                "sensor.elina": 20.2,
                "sensor.bureau": 19.5,
                "sensor.ami": 19.5,
            },
            session_mode=ProfileMode.HEAT,
            session_target=21.0,
        ),
    )


def _inputs(now_ts: float) -> ZoneInputs:
    return ZoneInputs(
        now_ts=now_ts,
        room_temperature=20.6,
        clim_internal_temperature=24.0,
        clim_current_hvac_mode="heat",
        clim_current_setpoint=26.0,
        clim_current_fan_mode="quiet",
        clim_current_swing_mode="swing",
        any_window_open=False,
    )


@pytest.mark.asyncio
async def test_detection_waits_for_configured_delay() -> None:
    zone = _running_zone()
    coordinator = object.__new__(DelormejClimateCoordinator)
    coordinator.hass = SimpleNamespace()

    await coordinator._maybe_detect_temperature_anomalies(
        zone,
        _inputs(1_000.0 + 59 * 60),
        {"sensor.elina": 22.0, "sensor.bureau": 19.6, "sensor.ami": 19.6},
    )

    assert zone.state.anomaly_detection_done is False
    assert zone.state.flagged_sensors == []


@pytest.mark.asyncio
async def test_detection_notifies_once_with_cancel_action() -> None:
    zone = _running_zone()
    bus = SimpleNamespace(async_fire=Mock())
    services = SimpleNamespace(has_service=Mock(return_value=True), async_call=AsyncMock())
    coordinator = object.__new__(DelormejClimateCoordinator)
    coordinator.hass = SimpleNamespace(bus=bus, services=services)
    coordinator._sensor_label = lambda entity_id: entity_id.split(".")[-1].title()

    temps = {"sensor.elina": 22.4, "sensor.bureau": 19.5, "sensor.ami": 19.5}
    await coordinator._maybe_detect_temperature_anomalies(
        zone, _inputs(1_000.0 + 60 * 60), temps
    )
    await coordinator._maybe_detect_temperature_anomalies(
        zone, _inputs(1_000.0 + 61 * 60), temps
    )

    assert zone.state.anomaly_detection_done is True
    assert set(zone.state.flagged_sensors) == {"sensor.bureau", "sensor.ami"}
    bus.async_fire.assert_called_once()
    services.async_call.assert_awaited_once()
    payload = services.async_call.await_args.args[2]
    assert payload["data"]["actions"] == [
        {
            "action": "CLIMATE_MANAGER_CANCEL_SESSION_etage_1000000",
            "title": "Couper la session",
            "destructive": True,
        }
    ]


@pytest.mark.asyncio
async def test_cancel_action_is_bound_to_exact_session() -> None:
    cancel = Mock()
    zone = SimpleNamespace(
        state=SimpleNamespace(state=ZoneState.RUNNING, cycle_started_ts=1_000.5),
        cancel_active_session=cancel,
    )
    coordinator = object.__new__(DelormejClimateCoordinator)
    coordinator._zones = {"etage": zone}
    coordinator.async_cancel_zone_session = AsyncMock()

    await coordinator._async_cancel_session_from_notification("etage", 1_000_499)
    cancel.assert_not_called()

    await coordinator._async_cancel_session_from_notification("etage", 1_000_500)
    cancel.assert_not_called()
    coordinator.async_cancel_zone_session.assert_awaited_once_with(zone)


@pytest.mark.asyncio
async def test_detection_retries_when_started_sensor_is_temporarily_missing() -> None:
    zone = _running_zone()
    coordinator = object.__new__(DelormejClimateCoordinator)
    coordinator.hass = SimpleNamespace()

    await coordinator._maybe_detect_temperature_anomalies(
        zone,
        _inputs(1_000.0 + 60 * 60),
        {"sensor.elina": 22.4, "sensor.bureau": 19.5},
    )

    assert zone.state.anomaly_detection_done is False


@pytest.mark.asyncio
async def test_cancel_coordinator_applies_physical_off_command() -> None:
    command = SimpleNamespace(service="turn_off")
    zone = SimpleNamespace(cancel_active_session=Mock(return_value=[command]))
    coordinator = object.__new__(DelormejClimateCoordinator)
    coordinator._apply_command = AsyncMock()
    coordinator._save_runtime_state_if_changed = AsyncMock()
    coordinator._build_coordinator_data = Mock(return_value={"zones": {}})
    coordinator.async_set_updated_data = Mock()
    coordinator.async_request_refresh = AsyncMock()

    await coordinator.async_cancel_zone_session(zone)

    coordinator._apply_command.assert_awaited_once_with(command)
    coordinator._save_runtime_state_if_changed.assert_awaited_once()
    coordinator.async_request_refresh.assert_awaited_once()


def test_cancel_automatic_session_blocks_same_profile_restart() -> None:
    zone = _running_zone()

    commands = zone.cancel_active_session(now_ts=5_000.0)

    assert any(command.service == "turn_off" for command in commands)
    assert zone.state.manually_stopped_profile_name == "Présent"
