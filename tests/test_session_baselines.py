"""Tests for active-session temperature baselines."""

from __future__ import annotations

from types import SimpleNamespace

from custom_components.climate_manager.const import ZoneState
from custom_components.climate_manager.coordinator import DelormejClimateCoordinator


def _zone(state: str = ZoneState.RUNNING, baselines: dict[str, float] | None = None):
    return SimpleNamespace(
        state=SimpleNamespace(
            state=state,
            cycle_baseline_temps=dict(baselines or {}),
            flagged_sensors=["legacy"],
            notified_sensors=["legacy"],
        )
    )


def test_running_session_with_empty_baselines_gets_seeded_after_restore() -> None:
    """A restored RUNNING session must not keep gains stuck at 0/unknown."""
    zone = _zone(baselines={})

    DelormejClimateCoordinator._maybe_seed_sensor_baselines(
        None,  # type: ignore[arg-type]
        zone,
        ZoneState.RUNNING,
        {"sensor.room": 26.4},
    )

    assert zone.state.cycle_baseline_temps == {"sensor.room": 26.4}
    assert zone.state.flagged_sensors == []
    assert zone.state.notified_sensors == []


def test_running_session_with_existing_baselines_preserves_original_start() -> None:
    """Once captured, baselines must not be overwritten every tick."""
    zone = _zone(baselines={"sensor.room": 27.1})

    DelormejClimateCoordinator._maybe_seed_sensor_baselines(
        None,  # type: ignore[arg-type]
        zone,
        ZoneState.RUNNING,
        {"sensor.room": 26.4},
    )

    assert zone.state.cycle_baseline_temps == {"sensor.room": 27.1}
