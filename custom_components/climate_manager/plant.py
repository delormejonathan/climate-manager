"""The house's heating and cooling plant: equipment and operating modes.

Equipment
    Something that produces heat or cold. Two kinds:
    - ``heat_pump``: a ``climate.*`` unit serving one zone, driven finely by
      the zone (pendulum setpoint, fan, swing). Daikin units are this kind.
    - ``central``: an on/off source serving one or several zones (gas boiler
      through its thermostat, a ducted unit, a relay). It runs while at least
      one of its zones asks for it, and stops when none does.

Operating mode
    Which equipment produces heat (or cold) and how they combine. Only one
    mode is in service at a time; « no mode » means nothing starts on its own.
    - ``exclusive``: one equipment at a time per zone, the first available
      in the mode's order;
    - ``combined``: every equipment of the zone runs together;
    - ``additive``: the first one runs; the next ones join while the zone is
      still far from its target after a delay, and leave once it is close.

Zones keep their comfort programme (target per time and presence); the active
mode only decides which equipment answers a zone's demand.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar

HEAT = "heat"
COOL = "cool"
DIRECTIONS = (HEAT, COOL)

# Profile banks are still stored per « season »: the heat bank is the winter
# one, the cool bank the summer one (keeps the stored data and the rollback).
BANK_FOR_DIRECTION = {HEAT: "winter", COOL: "summer"}
DIRECTION_FOR_BANK = {v: k for k, v in BANK_FOR_DIRECTION.items()}


class EquipmentKind:
    HEAT_PUMP = "heat_pump"
    CENTRAL = "central"
    ALL: ClassVar[list[str]] = [HEAT_PUMP, CENTRAL]


class Relation:
    EXCLUSIVE = "exclusive"
    COMBINED = "combined"
    ADDITIVE = "additive"
    ALL: ClassVar[list[str]] = [EXCLUSIVE, COMBINED, ADDITIVE]


DEFAULT_BOOST_GAP = 1.0
DEFAULT_BOOST_DELAY_MIN = 20
DEFAULT_SETPOINT_OFFSET = 1.0


def new_id() -> str:
    return uuid.uuid4().hex[:8]


@dataclass
class Equipment:
    id: str
    name: str
    kind: str
    entity: str | None
    zones: list[str] = field(default_factory=list)
    heat: bool = True
    cool: bool = False
    # central only
    on_option: str | None = None  # select option that lets it run
    off_option: str | None = None  # select option that stops it
    setpoint_entity: str | None = None  # number.* written while it runs
    setpoint_offset: float = DEFAULT_SETPOINT_OFFSET
    running_entity: str | None = None  # binary_sensor.* « it is producing » (flame)
    # « En service »: off means Climate Manager never starts it (the mode falls
    # back on the next equipment) and leaves it alone otherwise.
    enabled: bool = True

    def supports(self, direction: str) -> bool:
        return self.heat if direction == HEAT else self.cool

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Equipment:
        kind = d.get("kind") if d.get("kind") in EquipmentKind.ALL else EquipmentKind.HEAT_PUMP
        zones = [z for z in d.get("zones") or [] if z]
        if kind == EquipmentKind.HEAT_PUMP:
            zones = zones[:1]
        return cls(
            id=d.get("id") or new_id(),
            name=str(d.get("name") or "").strip() or "Équipement",
            kind=kind,
            entity=d.get("entity") or None,
            zones=zones,
            heat=bool(d.get("heat", True)),
            cool=bool(d.get("cool", kind == EquipmentKind.HEAT_PUMP)),
            on_option=d.get("on_option") or None,
            off_option=d.get("off_option") or None,
            setpoint_entity=d.get("setpoint_entity") or None,
            setpoint_offset=float(d.get("setpoint_offset", DEFAULT_SETPOINT_OFFSET)),
            running_entity=d.get("running_entity") or None,
            enabled=bool(d.get("enabled", True)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "entity": self.entity,
            "zones": list(self.zones),
            "heat": self.heat,
            "cool": self.cool,
            "on_option": self.on_option,
            "off_option": self.off_option,
            "setpoint_entity": self.setpoint_entity,
            "setpoint_offset": self.setpoint_offset,
            "running_entity": self.running_entity,
            "enabled": self.enabled,
        }


@dataclass
class OperatingMode:
    id: str
    name: str
    direction: str
    relation: str
    equipments: list[str] = field(default_factory=list)  # priority order
    boost_gap: float = DEFAULT_BOOST_GAP
    boost_delay_min: int = DEFAULT_BOOST_DELAY_MIN
    icon: str | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> OperatingMode:
        return cls(
            id=d.get("id") or new_id(),
            name=str(d.get("name") or "").strip() or "Mode",
            direction=d.get("direction") if d.get("direction") in DIRECTIONS else HEAT,
            relation=d.get("relation") if d.get("relation") in Relation.ALL else Relation.EXCLUSIVE,
            equipments=[e for e in d.get("equipments") or [] if e],
            boost_gap=float(d.get("boost_gap", DEFAULT_BOOST_GAP)),
            boost_delay_min=int(d.get("boost_delay_min", DEFAULT_BOOST_DELAY_MIN)),
            icon=d.get("icon") or None,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "direction": self.direction,
            "relation": self.relation,
            "equipments": list(self.equipments),
            "boost_gap": self.boost_gap,
            "boost_delay_min": self.boost_delay_min,
            "icon": self.icon,
        }


@dataclass
class Plant:
    equipments: list[Equipment] = field(default_factory=list)
    modes: list[OperatingMode] = field(default_factory=list)
    active_mode: str | None = None

    # ---- lookup -----------------------------------------------------------
    def equipment(self, eq_id: str | None) -> Equipment | None:
        return next((e for e in self.equipments if e.id == eq_id), None)

    def mode(self, mode_id: str | None) -> OperatingMode | None:
        return next((m for m in self.modes if m.id == mode_id), None)

    @property
    def current_mode(self) -> OperatingMode | None:
        return self.mode(self.active_mode)

    def heat_pump_of(self, zone_id: str) -> Equipment | None:
        return next(
            (e for e in self.equipments if e.kind == EquipmentKind.HEAT_PUMP and zone_id in e.zones),
            None,
        )

    def serving(self, zone_id: str) -> list[Equipment]:
        return [e for e in self.equipments if zone_id in e.zones]

    def mode_equipments_for(self, mode: OperatingMode, zone_id: str) -> list[Equipment]:
        """Equipment of ``mode`` that serve ``zone_id`` in its direction, in order."""
        out = []
        for eq_id in mode.equipments:
            eq = self.equipment(eq_id)
            if eq and zone_id in eq.zones and eq.supports(mode.direction):
                out.append(eq)
        return out

    # ---- storage ----------------------------------------------------------
    @classmethod
    def from_options(cls, options: dict[str, Any]) -> Plant:
        if "equipments" not in options:
            return cls.migrate(options)
        plant = cls(
            equipments=[Equipment.from_dict(e) for e in options.get("equipments") or []],
            modes=[OperatingMode.from_dict(m) for m in options.get("modes") or []],
            active_mode=options.get("active_mode"),
        )
        if plant.active_mode and plant.mode(plant.active_mode) is None:
            plant.active_mode = None
        return plant

    def to_options(self) -> dict[str, Any]:
        return {
            "equipments": [e.to_dict() for e in self.equipments],
            "modes": [m.to_dict() for m in self.modes],
            "active_mode": self.active_mode,
        }

    @classmethod
    def migrate(cls, options: dict[str, Any]) -> Plant:
        """Pre-plant installs: one heat pump per zone, one mode per season."""
        zones = options.get("zones") or []
        equipments = [
            Equipment(
                id=f"hp_{z['id']}",
                name=f"Climatisation {zone_label(z.get('name') or z['id'])}",
                kind=EquipmentKind.HEAT_PUMP,
                entity=z.get("climate_entity"),
                zones=[z["id"]],
                heat=True,
                cool=True,
            )
            for z in zones
            if z.get("id") and z.get("climate_entity")
        ]
        ids = [e.id for e in equipments]
        modes = [
            OperatingMode(id="heat", name="Chauffage", direction=HEAT, relation=Relation.EXCLUSIVE,
                          equipments=list(ids), icon="mdi:fire"),
            OperatingMode(id="cool", name="Rafraîchissement", direction=COOL,
                          relation=Relation.EXCLUSIVE, equipments=list(ids), icon="mdi:snowflake"),
        ]
        seasons = {z.get("season") for z in zones if z.get("season")}
        active = "cool" if seasons == {"summer"} else "heat"
        return cls(equipments=equipments, modes=modes, active_mode=active if zones else None)


def zone_label(name: str) -> str:
    name = str(name)
    return name.upper() if len(name) <= 3 else name[:1].upper() + name[1:]


# ---- planning ---------------------------------------------------------------


@dataclass
class ZoneDemand:
    """What a zone asks for this tick (from its session state machine)."""

    zone_id: str
    direction: str | None  # heat / cool while a session runs, else None
    target: float | None
    room: float | None
    session_started_ts: float | None
    manual: bool = False


@dataclass
class BoostMemory:
    """Hysteresis of the additive mode, one per zone."""

    engaged: bool = False


def engaged_equipment(
    plant: Plant,
    demand: ZoneDemand,
    now_ts: float,
    available: Callable[[Equipment], bool],
    boost: BoostMemory,
) -> list[Equipment]:
    """Equipment that must run for this zone now, per the mode in service."""
    mode = plant.current_mode
    if mode is None or demand.direction != mode.direction:
        boost.engaged = False
        return []
    candidates = [e for e in plant.mode_equipments_for(mode, demand.zone_id) if available(e)]
    if not candidates:
        boost.engaged = False
        return []
    if mode.relation == Relation.EXCLUSIVE:
        boost.engaged = False
        return candidates[:1]
    if mode.relation == Relation.COMBINED:
        boost.engaged = False
        return candidates
    # additive
    if len(candidates) > 1 and demand.room is not None and demand.target is not None:
        gap = demand.target - demand.room if mode.direction == HEAT else demand.room - demand.target
        waited = (
            demand.session_started_ts is not None
            and now_ts - demand.session_started_ts >= mode.boost_delay_min * 60
        )
        if not boost.engaged and waited and gap >= mode.boost_gap:
            boost.engaged = True
        elif boost.engaged and gap < mode.boost_gap / 2:
            boost.engaged = False
    else:
        boost.engaged = False
    return candidates if boost.engaged else candidates[:1]


@dataclass
class CentralOrder:
    """Desired state of a central equipment."""

    on: bool
    direction: str | None = None
    setpoint: float | None = None
    zones: list[str] = field(default_factory=list)


def central_orders(
    plant: Plant, engaged_by_zone: dict[str, list[Equipment]], demands: dict[str, ZoneDemand]
) -> dict[str, CentralOrder]:
    """One order per central equipment: on while any of its zones engages it."""
    orders: dict[str, CentralOrder] = {}
    for eq in plant.equipments:
        if eq.kind != EquipmentKind.CENTRAL or not eq.enabled:
            continue  # out of service: Climate Manager leaves it alone
        zones = [zid for zid, eqs in engaged_by_zone.items() if any(e.id == eq.id for e in eqs)]
        if not zones:
            orders[eq.id] = CentralOrder(on=False)
            continue
        direction = demands[zones[0]].direction
        targets = [demands[z].target for z in zones if demands[z].target is not None]
        setpoint = None
        if targets:
            setpoint = (
                max(targets) + eq.setpoint_offset if direction == HEAT else min(targets) - eq.setpoint_offset
            )
        orders[eq.id] = CentralOrder(on=True, direction=direction, setpoint=setpoint, zones=zones)
    return orders
