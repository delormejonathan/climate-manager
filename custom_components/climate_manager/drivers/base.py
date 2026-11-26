"""What every equipment driver shares.

The plant decides what the house needs (which equipment, heat or cool, which
temperature). A driver turns that into the service calls its kind of device
understands. Drivers are pure logic: they read plain values and return
``Command`` objects; the coordinator reads Home Assistant and applies them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar


@dataclass(frozen=True)
class Command:
    """A Home Assistant service call the coordinator will run."""

    domain: str
    service: str
    data: dict[str, Any]


class Driver:
    """One kind of equipment (heat pump, relay, thermostat...)."""

    kind: ClassVar[str] = ""

    def release(self, entity: str | None, state: str | None) -> list[Command]:
        """Commands that hand the device back when Climate Manager lets it go."""
        return []


def round_half(value: float) -> float:
    """Setpoints move by half degrees."""
    return round(value * 2) / 2
