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



def _plant(*eqs):
    from custom_components.climate_manager import plant
    return plant.Plant(equipments=[plant.Equipment.from_dict(e) for e in eqs], modes=[], active_mode=None)


def test_session_energy_closed_even_when_history_is_full() -> None:
    """History full (count stays 20) or cancelled outside a tick: the session still gets its totals."""
    old = [{"session_mode": "heat", "kwh_consumed": 0.1} for _ in range(20)]
    new = {"session_mode": "heat", "end_ts": 1000.0, "energy": {"boiler": 2.0, "hp": 0.5}, "kwh_consumed": None}
    zone = SimpleNamespace(state=SimpleNamespace(completed_sessions=[*old[1:], new]))
    coordinator = object.__new__(DelormejClimateCoordinator)
    coordinator.plant = _plant(
        {"id": "boiler", "name": "Chaudière", "kind": "central", "entity": "select.b", "energy_price": 0.1},
        {"id": "hp", "name": "Clim", "kind": "heat_pump", "entity": "climate.c"},
    )
    coordinator._zones = {"z": zone}
    coordinator._energy_last = {}
    DelormejClimateCoordinator._account_energy(coordinator, 1100.0)
    assert new["kwh_consumed"] == pytest.approx(2.5)
    assert new["cost_eur"] == pytest.approx(2.0 * 0.1 + 0.5 * 0.2)
    assert [d["energy"] for d in new["energy_detail"]] == ["gas", "electricity"]
    assert new["energy_until_ts"] > 1000.0


def test_energy_shared_between_sessions_then_late_hour_goes_to_the_ended_one() -> None:
    """The boiler serves two zones: shared. Its hourly counter reporting after the end still counts."""
    from custom_components.climate_manager.const import ZoneState
    coordinator = object.__new__(DelormejClimateCoordinator)
    coordinator.plant = _plant({"id": "boiler", "name": "Chaudière", "kind": "central", "entity": "select.b",
                                "zones": ["a", "b"], "energy_sensors": ["sensor.gas"]})
    boiler = coordinator.plant.equipment("boiler")
    reading = {"v": "100.0"}
    coordinator.hass = SimpleNamespace(states=SimpleNamespace(get=lambda e: SimpleNamespace(state=reading["v"])))
    coordinator._energy_last = {}

    def zone(zid):
        return SimpleNamespace(config=SimpleNamespace(zone_id=zid), state=SimpleNamespace(
            state=ZoneState.RUNNING, session_target=20.0, session_energy={}, completed_sessions=[]))
    a, b = zone("a"), zone("b")
    coordinator._zones = {"a": a, "b": b}
    coordinator._engaged = {"a": [boiler], "b": [boiler]}
    DelormejClimateCoordinator._account_energy(coordinator, 0.0)  # first reading: baseline
    reading["v"] = "103.0"
    DelormejClimateCoordinator._account_energy(coordinator, 30.0)
    assert a.state.session_energy == {"boiler": 1.5} and b.state.session_energy == {"boiler": 1.5}
    # a ends; b too: nobody served, the counter reports its last hour 20 min later
    for z in (a, b):
        z.state.state = ZoneState.IDLE
        z.state.completed_sessions.append({"energy": {**z.state.session_energy, "hp": 0.0}, "end_ts": 60.0})
    coordinator._engaged = {}
    reading["v"] = "104.0"
    DelormejClimateCoordinator._account_energy(coordinator, 1260.0)
    assert a.state.completed_sessions[-1]["kwh_consumed"] == pytest.approx(2.0)
    # a clim served but never ran: it does not get the late hour
    assert "hp" not in a.state.completed_sessions[-1]["energy"]
    # too late: no longer counted
    reading["v"] = "110.0"
    DelormejClimateCoordinator._account_energy(coordinator, 9999.0)
    assert a.state.completed_sessions[-1]["kwh_consumed"] == pytest.approx(2.0)
