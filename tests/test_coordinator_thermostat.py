"""Coordinator wiring of a thermostat equipment (observation and take-over)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from custom_components.climate_manager.coordinator import DelormejClimateCoordinator
from custom_components.climate_manager.plant import Equipment, OperatingMode, Plant

STATES = {
    "number.sp": "21.0",
    "switch.prog": "on",
    "switch.hol": "off",
    "sensor.room": "20.1",
    "sensor.target": "21.0",
}


def _coord(observe: bool, mode: str | None = "chauffage"):
    eq = Equipment.from_dict({
        "id": "boiler", "name": "Chaudière", "kind": "thermostat", "entity": "number.sp",
        "schedule_entity": "switch.prog", "holiday_entity": "switch.hol",
        "room_sensor": "sensor.room", "target_entity": "sensor.target",
        "heat": True, "cool": False, "zones": [],
        "thermostat": {"observe": observe, "night_start": "00:00", "night_end": "00:00"},
    })
    plant = Plant(
        equipments=[eq],
        modes=[OperatingMode(id="chauffage", name="Chauffage", direction="heat", relation="exclusive", equipments=["boiler"])],
        active_mode=mode,
    )
    c = object.__new__(DelormejClimateCoordinator)
    c.hass = SimpleNamespace(states=SimpleNamespace(
        get=lambda e: SimpleNamespace(state=STATES[e], attributes={}) if e in STATES else None
    ))
    c.plant = plant
    c._thermo_mem, c._thermo_plan, c._thermo_journal = {}, {}, {}
    c.sent = []

    async def apply(cmd):
        c.sent.append(cmd)

    c._apply_command = apply
    c._house_is_absent = lambda: False
    return c, eq


def test_observation_computes_and_logs_but_writes_nothing():
    c, eq = _coord(observe=True)
    asyncio.run(c._drive_thermostat(eq))
    assert c.sent == []
    payload = c._thermostat_payload(eq)
    assert payload["observe"] and payload["wanted"] == 21.0 and payload["reason"] == "day"
    assert payload["schedule_on"] is True and payload["taken_over"] is False
    assert len(payload["journal"]) == 1
    asyncio.run(c._drive_thermostat(eq))
    assert len(c._thermo_journal["boiler"]) == 1  # unchanged plan: no new line


def test_take_over_then_hand_back_on_stop_mode():
    c, eq = _coord(observe=False)
    asyncio.run(c._drive_thermostat(eq))
    assert [(x.data["entity_id"], x.service) for x in c.sent] == [("switch.prog", "turn_off")]
    assert c._thermo_mem["boiler"].taken_over
    STATES["switch.prog"] = "off"
    try:
        c.plant.active_mode = None
        c.sent.clear()
        asyncio.run(c._drive_thermostat(eq))
        assert [(x.data["entity_id"], x.service) for x in c.sent] == [("switch.prog", "turn_on")]
        assert not c._thermo_mem["boiler"].taken_over
    finally:
        STATES["switch.prog"] = "on"
