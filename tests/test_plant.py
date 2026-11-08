"""Plant model: migration, which equipment answers a zone, central orders."""

import importlib.util
import sys
from pathlib import Path

_PATH = Path(__file__).resolve().parent.parent / "custom_components" / "climate_manager" / "plant.py"
_spec = importlib.util.spec_from_file_location("cm_plant", _PATH)
plant = importlib.util.module_from_spec(_spec)
sys.modules["cm_plant"] = plant
_spec.loader.exec_module(plant)


def house():
    p = plant.Plant(
        equipments=[
            plant.Equipment("boiler", "Chaudière", plant.EquipmentKind.CENTRAL, "select.opmode",
                            zones=["rdc", "etage"], heat=True, cool=False, on_option="day", off_option="off"),
            plant.Equipment("hp_rdc", "Clim RDC", plant.EquipmentKind.HEAT_PUMP, "climate.salon", zones=["rdc"], cool=True),
            plant.Equipment("hp_etage", "Clim Étage", plant.EquipmentKind.HEAT_PUMP, "climate.escalier", zones=["etage"], cool=True),
        ],
        modes=[
            plant.OperatingMode("boiler", "Chaudière", "heat", "exclusive", ["boiler", "hp_rdc", "hp_etage"]),
            plant.OperatingMode("both", "Tout", "heat", "combined", ["boiler", "hp_rdc", "hp_etage"]),
            plant.OperatingMode("boost", "Fort", "heat", "additive", ["boiler", "hp_rdc", "hp_etage"],
                                boost_gap=1.0, boost_delay_min=20),
            plant.OperatingMode("cool", "Froid", "cool", "exclusive", ["hp_rdc", "hp_etage"]),
        ],
    )
    return p


def ids(eqs):
    return [e.id for e in eqs]


def demand(zone="rdc", direction="heat", target=20.0, room=18.0, started=0.0):
    return plant.ZoneDemand(zone, direction, target, room, started)


def test_migration_one_heat_pump_per_zone_and_two_modes():
    p = plant.Plant.from_options({"zones": [
        {"id": "rdc", "name": "rdc", "climate_entity": "climate.salon", "season": "winter"},
        {"id": "etage", "name": "Étage", "climate_entity": "climate.escalier", "season": "winter"},
    ]})
    assert ids(p.equipments) == ["hp_rdc", "hp_etage"]
    assert p.equipments[0].name == "Climatisation RDC"
    assert [m.direction for m in p.modes] == ["heat", "cool"]
    assert p.current_mode.direction == "heat"
    assert plant.Plant.from_options(p.to_options()).to_options() == p.to_options()


def test_exclusive_takes_the_first_available():
    p = house()
    p.active_mode = "boiler"
    up = lambda e: True  # noqa: E731
    assert ids(plant.engaged_equipment(p, demand(), 0, up, plant.BoostMemory())) == ["boiler"]
    no_boiler = lambda e: e.id != "boiler"  # noqa: E731
    assert ids(plant.engaged_equipment(p, demand(), 0, no_boiler, plant.BoostMemory())) == ["hp_rdc"]


def test_combined_runs_everything_of_the_zone():
    p = house()
    p.active_mode = "both"
    got = plant.engaged_equipment(p, demand(zone="etage"), 0, lambda e: True, plant.BoostMemory())
    assert ids(got) == ["boiler", "hp_etage"]


def test_additive_joins_after_delay_when_far_and_leaves_when_close():
    p = house()
    p.active_mode = "boost"
    mem = plant.BoostMemory()
    up = lambda e: True  # noqa: E731
    assert ids(plant.engaged_equipment(p, demand(room=18.0), 60, up, mem)) == ["boiler"]
    assert ids(plant.engaged_equipment(p, demand(room=18.0), 21 * 60, up, mem)) == ["boiler", "hp_rdc"]
    assert ids(plant.engaged_equipment(p, demand(room=19.2), 30 * 60, up, mem)) == ["boiler", "hp_rdc"]
    assert ids(plant.engaged_equipment(p, demand(room=19.6), 31 * 60, up, mem)) == ["boiler"]


def test_wrong_direction_or_no_mode_engages_nothing():
    p = house()
    p.active_mode = "cool"
    assert plant.engaged_equipment(p, demand(direction="heat"), 0, lambda e: True, plant.BoostMemory()) == []
    p.active_mode = None
    assert plant.engaged_equipment(p, demand(), 0, lambda e: True, plant.BoostMemory()) == []


def test_central_runs_while_one_zone_needs_it_with_the_warmest_target():
    p = house()
    p.active_mode = "boiler"
    boiler = p.equipment("boiler")
    engaged = {"rdc": [boiler], "etage": [boiler]}
    demands = {"rdc": demand(target=20.0), "etage": demand(zone="etage", target=21.0)}
    order = plant.central_orders(p, engaged, demands)["boiler"]
    assert order.on and order.setpoint == 22.0 and order.zones == ["rdc", "etage"]
    assert plant.central_orders(p, {"rdc": [], "etage": []}, demands)["boiler"].on is False


def test_heat_pump_serves_one_zone_only():
    eq = plant.Equipment.from_dict({"kind": "heat_pump", "name": "X", "entity": "climate.x", "zones": ["a", "b"]})
    assert eq.zones == ["a"]
