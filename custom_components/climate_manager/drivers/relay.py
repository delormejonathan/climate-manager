"""Relay driver: an on/off source serving one or several zones.

Gas boiler through a mode select, a ducted unit, a relay: it runs while one of
its zones engages it and stops when none does. A setpoint entity, when given,
receives the highest target asked by its zones (plus an offset).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar

from .base import Command, Driver, round_half

SETPOINT_NOOP_DELTA = 0.5


@dataclass(frozen=True)
class EntityReading:
    """State of one Home Assistant entity, as the driver needs it."""

    state: str
    attributes: dict[str, Any] = field(default_factory=dict)


@dataclass
class RelayOrder:
    on: bool
    direction: str | None = None
    setpoint: float | None = None


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class RelayDriver(Driver):
    kind: ClassVar[str] = "central"

    def plan(
        self,
        entity: str,
        reading: EntityReading,
        order: RelayOrder,
        *,
        on_option: str | None = None,
        off_option: str | None = None,
        setpoint_entity: str | None = None,
        setpoint_reading: EntityReading | None = None,
    ) -> list[Command]:
        domain = entity.split(".", 1)[0]
        calls: list[Command] = []
        st = reading.state
        if domain == "climate":
            if order.on:
                if st != order.direction:
                    calls.append(Command("climate", "set_hvac_mode", {"entity_id": entity, "hvac_mode": order.direction}))
                current = _as_float(reading.attributes.get("temperature"))
                if order.setpoint is not None and (current is None or abs(current - order.setpoint) >= SETPOINT_NOOP_DELTA):
                    calls.append(Command("climate", "set_temperature", {"entity_id": entity, "temperature": round_half(order.setpoint)}))
            elif st != "off":
                calls.append(Command("climate", "turn_off", {"entity_id": entity}))
        elif domain in ("select", "input_select"):
            wanted = on_option if order.on else off_option
            if wanted and st != wanted:
                calls.append(Command(domain, "select_option", {"entity_id": entity, "option": wanted}))
        elif domain in ("switch", "input_boolean", "light", "fan"):
            wanted = "on" if order.on else "off"
            if st != wanted:
                calls.append(Command(domain, f"turn_{wanted}", {"entity_id": entity}))
        if order.on and order.setpoint is not None and setpoint_entity and domain != "climate":
            value = round_half(order.setpoint)
            if setpoint_reading is not None and _as_float(setpoint_reading.state) != value:
                sp_domain = setpoint_entity.split(".", 1)[0]
                calls.append(Command(sp_domain, "set_value", {"entity_id": setpoint_entity, "value": value}))
        return calls
