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

    coordinator = object.__new__(DelormejClimateCoordinator)
    await DelormejClimateCoordinator._maybe_seed_sensor_baselines(
        coordinator,
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

    coordinator = object.__new__(DelormejClimateCoordinator)
    await DelormejClimateCoordinator._maybe_seed_sensor_baselines(
        coordinator,
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

    coordinator = object.__new__(DelormejClimateCoordinator)
    await DelormejClimateCoordinator._maybe_seed_sensor_baselines(
        coordinator,
        zone,
        ZoneState.RUNNING,
        _inputs(now_ts=700.0),
        {"sensor.room": 26.3},
    )

    assert zone.state.cycle_baseline_temps == {"sensor.room": 27.2}


@pytest.mark.asyncio
async def test_sensor_returning_late_without_history_is_not_seeded(monkeypatch) -> None:
    """Do not compare a late current value against the whole session duration."""
    zone = _zone(baselines={})

    async def no_history(*args, **kwargs):
        return {}

    monkeypatch.setattr(DelormejClimateCoordinator, "_history_sensor_baselines", no_history)

    coordinator = object.__new__(DelormejClimateCoordinator)
    await DelormejClimateCoordinator._maybe_seed_sensor_baselines(
        coordinator,
        zone,
        ZoneState.RUNNING,
        _inputs(now_ts=700.0),
        {"sensor.room": 26.3},
    )

    assert zone.state.cycle_baseline_temps == {}


def test_session_kwh_closed_when_history_is_full() -> None:
    """History full: append drops the oldest, the count stays 20, the end reading must still be taken."""
    old = [{"session_mode": "heat", "kwh_start": float(i), "kwh_end": float(i)} for i in range(20)]
    new = {"session_mode": "heat", "kwh_start": 58.2, "kwh_end": None, "kwh_consumed": None}
    zone = SimpleNamespace(
        config=SimpleNamespace(consumption_sensor_heat="sensor.heat", consumption_sensor_cool=None, profiles=[]),
        state=SimpleNamespace(completed_sessions=[*old[1:], new]),
    )
    coordinator = object.__new__(DelormejClimateCoordinator)
    coordinator.hass = SimpleNamespace(states=SimpleNamespace(get=lambda e: SimpleNamespace(state="59.0")))
    new["end_ts"] = 1000.0
    DelormejClimateCoordinator._maybe_close_last_session_kwh(coordinator, zone, old[-1])
    assert new["kwh_end"] == 59.0
    assert new["kwh_consumed"] == pytest.approx(0.8)
    # nothing new this tick: untouched
    new["kwh_end"] = None
    DelormejClimateCoordinator._maybe_close_last_session_kwh(coordinator, zone, new)
    assert new["kwh_end"] is None


def test_session_kwh_settles_after_the_counter_reported() -> None:
    """Hourly counters: the end reading is taken again an hour later (or at the next session)."""
    s1 = {"session_mode": "heat", "end_ts": 1000.0, "kwh_start": 10.0, "kwh_end": 10.0, "kwh_consumed": 0.0, "kwh_settle_ts": 1000.0 + 3900}
    zone = SimpleNamespace(
        config=SimpleNamespace(consumption_sensor_heat="sensor.heat", consumption_sensor_cool=None),
        state=SimpleNamespace(completed_sessions=[s1], state="idle", session_target=None, cycle_start_kwh=None),
    )
    coordinator = object.__new__(DelormejClimateCoordinator)
    coordinator.hass = SimpleNamespace(states=SimpleNamespace(get=lambda e: SimpleNamespace(state="10.7")))
    DelormejClimateCoordinator._settle_session_kwh(coordinator, zone, 2000.0)
    assert s1["kwh_consumed"] == 0.0 and "kwh_settle_ts" in s1  # too early
    DelormejClimateCoordinator._settle_session_kwh(coordinator, zone, 5000.0)
    assert s1["kwh_consumed"] == pytest.approx(0.7) and "kwh_settle_ts" not in s1 and s1["kwh_settled"]
