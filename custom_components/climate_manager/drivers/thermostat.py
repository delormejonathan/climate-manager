"""Thermostat driver: a boiler whose room thermostat regulates on its own.

Gas boiler + room thermostat (Saunier Duval Exacontrol on eBUS): the
thermostat already regulates with its own sensor and heating curve, and the
boiler and radiators have a lot of inertia. There is no session and no
pendulum: the driver keeps one steady setpoint and only rewrites it when the
comfort plan changes.

The comfort plan is the one of the zones: the coordinator passes the target
of the heating profile in force (time slot + presence, first match wins, the
highest across the zones the boiler heats) as ``ThermostatReading.demand``.
No profile in force: ``floor``. A profile start is a heating start: the
setpoint changes exactly then, never earlier (the heating rate learnt on real
rises is information only). A long absence switches the thermostat to its
holiday mode. A setpoint changed by hand on the thermostat is respected for a
while.

The thermostat keeps its setpoint in non-volatile memory: writes are rare
(only on change, at least ``min_write_interval_min`` apart).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, ClassVar

from .base import Command, Driver, round_half

FLOOR = "floor"  # no zone profile in force
HOLIDAY = "holiday"
MANUAL = "manual"
STANDBY = "standby"

HEAT_RATE_DEFAULT = 1.0  # °C per hour, before anything is learnt
HEAT_RATE_MIN = 0.3
HEAT_RATE_MAX = 4.0
HEAT_RATE_SMOOTHING = 0.3  # weight of a new measure in the running average
RISE_MIN_GAP = 1.0  # a target at least this far above the room starts a rise
RISE_DONE_MARGIN = 0.2
RISE_MAX_HOURS = 6.0
RISE_MIN_HOURS = 0.25
MANUAL_HOLD_HOURS = 3.0
WRITE_ECHO_SECONDS = 180  # the thermostat reports a written value a bit later
SETPOINT_STEP = 0.5


@dataclass
class ThermostatSettings:
    floor: float = 17.0
    min_write_interval_min: int = 15
    holiday_after_h: float = 24.0
    holiday_setpoint: float = 16.0
    observe: bool = True  # compute and show, write nothing

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> ThermostatSettings:
        d = d or {}
        base = cls()

        def num(key: str, lo: float, hi: float) -> float:
            try:
                v = float(d.get(key, getattr(base, key)))
            except (TypeError, ValueError):
                v = getattr(base, key)
            return max(lo, min(hi, v))

        return cls(
            floor=num("floor", 10, 22),
            min_write_interval_min=int(num("min_write_interval_min", 1, 240)),
            holiday_after_h=num("holiday_after_h", 0, 24 * 30),
            holiday_setpoint=num("holiday_setpoint", 5, 20),
            observe=bool(d.get("observe", base.observe)),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ThermostatEntities:
    setpoint: str | None  # number.* the thermostat regulates on (comfort setpoint)
    schedule: str | None = None  # switch.* the thermostat's own time programme
    holiday: str | None = None  # switch.* holiday mode
    holiday_setpoint: str | None = None  # number.* holiday setpoint
    room_sensor: str | None = None  # the thermostat's room temperature


@dataclass(frozen=True)
class ThermostatReading:
    now_ts: float
    now_min: int  # local minutes since midnight
    absent: bool
    room: float | None
    setpoint: float | None  # value the thermostat holds now
    schedule_on: bool | None
    holiday_on: bool | None
    holiday_setpoint: float | None = None
    target_in_force: float | None = None  # what the thermostat aims now (programme, override...)
    demand: float | None = None  # target of the zone heating profile in force, None: none
    demand_name: str | None = None  # that profile's name


@dataclass
class ThermostatMemory:
    last_write_ts: float | None = None
    last_written: float | None = None
    last_seen: float | None = None
    absent_since_ts: float | None = None
    manual_value: float | None = None
    manual_until_ts: float | None = None
    holiday_by_us: bool = False
    taken_over: bool = False  # Climate Manager drives the setpoint (programme off)
    heat_rate: float = HEAT_RATE_DEFAULT
    heat_rate_samples: int = 0
    rise_start_ts: float | None = None
    rise_start_temp: float | None = None
    rise_target: float | None = None
    last_wanted: float | None = None
    last_reason: str | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> ThermostatMemory:
        d = d or {}
        known = {k: d[k] for k in cls.__dataclass_fields__ if k in d}
        try:
            return cls(**known)
        except TypeError:
            return cls()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ThermostatPlan:
    wanted: float | None
    reason: str
    commands: list[Command] = field(default_factory=list)
    take_over: bool = False  # the time programme must be switched off
    holiday: bool = False
    blocked_until_ts: float | None = None  # write wanted but too soon after the previous one


class ThermostatDriver(Driver):
    kind: ClassVar[str] = "thermostat"

    def wanted(
        self, s: ThermostatSettings, r: ThermostatReading, mem: ThermostatMemory
    ) -> tuple[float, str]:
        """Setpoint the zones' heating profiles ask for now, with the profile name."""
        if r.demand is None:
            return round_half(s.floor), FLOOR
        return round_half(max(s.floor, r.demand)), r.demand_name or FLOOR

    def plan(
        self,
        e: ThermostatEntities,
        s: ThermostatSettings,
        r: ThermostatReading,
        mem: ThermostatMemory,
        *,
        role: str = "pilot",
    ) -> ThermostatPlan:
        """Orders for this tick. ``role``: ``pilot`` (the mode uses the boiler)
        or ``standby`` (another equipment heats: keep the boiler low).

        Updates ``mem`` (absence start, learnt rate, manual hold, last write).
        """
        self._track_absence(r, mem)
        self._learn_heat_rate(r, mem)

        wanted, reason = self.wanted(s, r, mem)
        if role == STANDBY:
            wanted, reason = round_half(s.floor), STANDBY

        holiday = (
            r.absent
            and s.holiday_after_h > 0
            and mem.absent_since_ts is not None
            and r.now_ts - mem.absent_since_ts >= s.holiday_after_h * 3600
        )
        if holiday:
            reason = HOLIDAY
            wanted = round_half(max(5.0, s.holiday_setpoint))

        self._track_manual(s, r, mem, wanted)
        if mem.manual_value is not None and not holiday:
            reason, wanted = MANUAL, mem.manual_value

        plan = ThermostatPlan(wanted=wanted, reason=reason, holiday=holiday)
        mem.last_wanted, mem.last_reason = wanted, reason
        if s.observe:
            return plan

        cmds = plan.commands
        mem.taken_over = True
        if r.schedule_on and e.schedule:
            plan.take_over = True
            cmds.append(Command("switch", "turn_off", {"entity_id": e.schedule}))

        if holiday:
            if e.holiday_setpoint and r.holiday_setpoint is not None and abs(r.holiday_setpoint - wanted) >= SETPOINT_STEP:
                cmds.append(self._set_value(e.holiday_setpoint, wanted))
            if e.holiday and r.holiday_on is False:
                cmds.append(Command("switch", "turn_on", {"entity_id": e.holiday}))
                mem.holiday_by_us = True
            return plan
        if mem.holiday_by_us:
            if e.holiday and r.holiday_on:
                cmds.append(Command("switch", "turn_off", {"entity_id": e.holiday}))
            mem.holiday_by_us = False

        if reason == MANUAL or not e.setpoint:
            return plan
        if r.setpoint is None:
            # Not read yet (HA or ebusd just restarted): never write blind,
            # the zones may not be loaded either (a passing « floor »).
            return plan
        if r.setpoint is not None and abs(r.setpoint - wanted) < SETPOINT_STEP:
            return plan
        if mem.last_write_ts is not None:
            ready = mem.last_write_ts + s.min_write_interval_min * 60
            if r.now_ts < ready:
                plan.blocked_until_ts = ready
                return plan
        cmds.append(self._set_value(e.setpoint, wanted))
        mem.last_write_ts, mem.last_written = r.now_ts, wanted
        return plan

    def release(self, entity: str | None, state: str | None) -> list[Command]:
        """Give the house back to the thermostat's own time programme."""
        if not entity or state in (None, "on", "unavailable", "unknown"):
            return []
        return [Command("switch", "turn_on", {"entity_id": entity})]

    # --- internals --------------------------------------------------------
    @staticmethod
    def _set_value(entity: str, value: float) -> Command:
        domain = entity.split(".", 1)[0]
        return Command(domain, "set_value", {"entity_id": entity, "value": value})

    @staticmethod
    def _track_absence(r: ThermostatReading, mem: ThermostatMemory) -> None:
        if r.absent:
            if mem.absent_since_ts is None:
                mem.absent_since_ts = r.now_ts
        elif mem.absent_since_ts is not None:
            mem.absent_since_ts = None
            mem.manual_value = mem.manual_until_ts = None  # coming home resets a hand setting

    @staticmethod
    def _track_manual(
        s: ThermostatSettings, r: ThermostatReading, mem: ThermostatMemory, wanted: float
    ) -> None:
        """A setpoint changed on the thermostat itself is held for a while."""
        seen = r.setpoint
        if mem.manual_until_ts is not None and r.now_ts >= mem.manual_until_ts:
            mem.manual_value = mem.manual_until_ts = None
        if (
            not s.observe
            and seen is not None
            and mem.last_seen is not None
            and abs(seen - mem.last_seen) >= SETPOINT_STEP
            and (mem.last_written is None or abs(seen - mem.last_written) >= SETPOINT_STEP)
            and (mem.last_write_ts is None or r.now_ts - mem.last_write_ts >= WRITE_ECHO_SECONDS)
            and not r.schedule_on
        ):
            mem.manual_value = seen
            mem.manual_until_ts = r.now_ts + MANUAL_HOLD_HOURS * 3600
        if mem.manual_value is not None and abs(mem.manual_value - wanted) < SETPOINT_STEP:
            mem.manual_value = mem.manual_until_ts = None  # the plan caught up
        if seen is not None:
            mem.last_seen = seen

    @staticmethod
    def _learn_heat_rate(r: ThermostatReading, mem: ThermostatMemory) -> None:
        """Measure how fast the house warms up when the target jumps up."""
        target = r.target_in_force
        room = r.room
        if target is None or room is None:
            return
        if mem.rise_start_ts is None:
            if target - room >= RISE_MIN_GAP:
                mem.rise_start_ts, mem.rise_start_temp, mem.rise_target = r.now_ts, room, target
            return
        hours = (r.now_ts - mem.rise_start_ts) / 3600
        start_temp = mem.rise_start_temp if mem.rise_start_temp is not None else room
        if mem.rise_target is not None and target < mem.rise_target - RISE_DONE_MARGIN:
            # Target dropped (night, departure): drop the measure.
            mem.rise_start_ts = mem.rise_start_temp = mem.rise_target = None
            return
        reached = mem.rise_target is not None and room >= mem.rise_target - RISE_DONE_MARGIN
        if reached or hours >= RISE_MAX_HOURS:
            gain = room - start_temp
            if hours >= RISE_MIN_HOURS and gain >= 0.5:
                rate = max(HEAT_RATE_MIN, min(HEAT_RATE_MAX, gain / hours))
                if mem.heat_rate_samples == 0:
                    mem.heat_rate = round(rate, 2)
                else:
                    mem.heat_rate = round(
                        (1 - HEAT_RATE_SMOOTHING) * mem.heat_rate + HEAT_RATE_SMOOTHING * rate, 2
                    )
                mem.heat_rate_samples += 1
            mem.rise_start_ts = mem.rise_start_temp = mem.rise_target = None
