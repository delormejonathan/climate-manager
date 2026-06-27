"""Tests for Climate Manager effective zone temperature."""

from __future__ import annotations

from types import SimpleNamespace

from custom_components.climate_manager.coordinator import DelormejClimateCoordinator


def test_effective_room_temp_uses_all_available_sensors_even_when_flagged() -> None:
    """Flagged sensors are legacy info only and must not bias the average."""
    zone = SimpleNamespace(
        state=SimpleNamespace(flagged_sensors=["sensor.hot_room", "sensor.warm_room"])
    )

    assert DelormejClimateCoordinator._effective_room_temp(
        None,  # type: ignore[arg-type]
        zone,
        {
            "sensor.cool_room": 26.0,
            "sensor.hot_room": 27.3,
            "sensor.warm_room": 26.8,
        },
    ) == (26.0 + 27.3 + 26.8) / 3


def test_effective_room_temp_returns_none_without_valid_sensors() -> None:
    zone = SimpleNamespace(state=SimpleNamespace(flagged_sensors=[]))

    assert DelormejClimateCoordinator._effective_room_temp(
        None,  # type: ignore[arg-type]
        zone,
        {},
    ) is None
