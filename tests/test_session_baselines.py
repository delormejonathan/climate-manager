"""Tests for active-session temperature baselines."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from custom_components.climate_manager.const import ZoneState
from custom_components.climate_manager.coordinator import DelormejClimateCoordinator


def _zone(state: str = ZoneState.RUNNING, baselines: dict[str, float] | None = None):
    return SimpleNamespace(
        config=SimpleNamespace(temperature_sensors=["sensor.room"]),
        state=SimpleNamespace(
            state=state,
            cycle_started_ts=100.0,
            cycle_baseline_temps=dict(baselines or {}),
            flagged_sensors=["legacy"],
            notified_sensors=["legacy"],
        ),
    )


def _inputs(now_ts: float = 110.0):
    return SimpleNamespace(now_ts=now_ts)


@pytest.mark.asyncio
async def test_running_session_with_empty_baselines_gets_seeded_after_restore() -> None:
    """A restored RUNNING session must not keep gains stuck at 0/unknown."""
    zone = _zone(baselines={})

    await DelormejClimateCoordinator._maybe_seed_sensor_baselines(
        None,  # type: ignore[arg-type]
        zone,
        ZoneState.RUNNING,
        _inputs(),
        {"sensor.room": 26.4},
    )

    assert zone.state.cycle_baseline_temps == {"sensor.room": 26.4}
    assert zone.state.flagged_sensors == []
    assert zone.state.notified_sensors == []


@pytest.mark.asyncio
async def test_running_session_with_existing_baselines_preserves_original_start() -> None:
    """Once captured, baselines must not be overwritten every tick."""
    zone = _zone(baselines={"sensor.room": 27.1})

    await DelormejClimateCoordinator._maybe_seed_sensor_baselines(
        None,  # type: ignore[arg-type]
        zone,
        ZoneState.RUNNING,
        _inputs(),
        {"sensor.room": 26.4},
    )

    assert zone.state.cycle_baseline_temps == {"sensor.room": 27.1}


@pytest.mark.asyncio
async def test_existing_late_baseline_is_repaired_from_recorder_history(monkeypatch) -> None:
    """A restart-time baseline is replaced with the true session-start baseline."""
    zone = _zone(baselines={"sensor.room": 26.4})

    async def fake_history(self, zone_arg, started_ts, now_ts, sensor_temps):
        assert zone_arg is zone
        assert started_ts == 100.0
        assert now_ts == 700.0
        assert sensor_temps == {"sensor.room": 26.3}
        return {"sensor.room": 27.2}

    monkeypatch.setattr(DelormejClimateCoordinator, "_history_sensor_baselines", fake_history)

    await DelormejClimateCoordinator._maybe_seed_sensor_baselines(
        None,  # type: ignore[arg-type]
        zone,
        ZoneState.RUNNING,
        _inputs(now_ts=700.0),
        {"sensor.room": 26.3},
    )

    assert zone.state.cycle_baseline_temps == {"sensor.room": 27.2}
