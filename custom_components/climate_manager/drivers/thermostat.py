"""Thermostat driver: a boiler whose room thermostat regulates on its own.

Gas boiler + room thermostat (Saunier Duval Exacontrol on eBUS): the
thermostat already regulates with its own sensor and heating curve, and the
boiler and radiators have a lot of inertia. There is no session and no
pendulum: the driver keeps one steady setpoint and only rewrites it when the
comfort plan changes.

The plan is a list of periods, each one a time slot (or the whole day) tied
to the house presence (always, occupied, empty) with a setpoint. The first
period that matches the time and the presence gives the setpoint, as the
zone profiles do; none matches: ``floor``. The house counts as empty once it
has been so for ``away_delay_min``. A period start is a heating start: the
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

FLOOR = "floor"  # no period matches
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


def _hhmm(value: Any, default: str) -> int:
    try:
        h, m = str(value or default).split(":")[:2]
        return (int(h) % 24) * 60 + int(m) % 60
    except (TypeError, ValueError):
        h, m = default.split(":")
        return int(h) * 60 + int(m)




def in_window(now_min: int, start_min: int, end_min: int) -> bool:
    if start_min == end_min:
        return False
    if start_min < end_min:
        return start_min <= now_min < end_min
    return now_min >= start_min or now_min < end_min


PRESENCES = ("any", "home", "away")
MAX_PERIODS = 8


def _hhmm_str(value: Any) -> str | None:
    """« 7:5 » -> « 07:05 »; empty or malformed -> None (whole day)."""
    if not value:
        return None
    try:
        h, m = str(value).split(":")[:2]
        return f"{int(h) % 24:02d}:{int(m) % 60:02d}"
    except (TypeError, ValueError):
        return None


@dataclass
class ThermostatPeriod:
    name: str
    setpoint: float
    start: str | None = None  # None (with end None) = the whole day
    end: str | None = None
    presence: str = "any"  # any | home (house occupied) | away (house empty)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ThermostatPeriod:
        try:
            setpoint = float(d.get("setpoint"))
        except (TypeError, ValueError):
            setpoint = 19.0
        start, end = _hhmm_str(d.get("start")), _hhmm_str(d.get("end"))
        if start is None or end is None or start == end:
            start = end = None
        presence = d.get("presence") if d.get("presence") in PRESENCES else "any"
        name = str(d.get("name") or "").strip()[:30] or "Plage"
        return cls(name=name, setpoint=max(5.0, min(26.0, setpoint)), start=start, end=end, presence=presence)

    def matches(self, now_min: int, away: bool) -> bool:
        if (self.presence == "home" and away) or (self.presence == "away" and not away):
            return False
        if self.start is None or self.end is None:
            return True
        return in_window(now_min, _hhmm(self.start, "00:00"), _hhmm(self.end, "00:00"))


def default_periods() -> list[ThermostatPeriod]:
    return [
        ThermostatPeriod("Absence", 18.5, presence="away"),
        ThermostatPeriod("Nuit", 19.0, "22:30", "06:00"),
        ThermostatPeriod("Jour", 21.0, presence="home"),
    ]


def _legacy_periods(d: dict[str, Any]) -> list[ThermostatPeriod]:
    """Settings saved before periods (comfort / night / away): same behaviour."""
    def f(key: str, default: float) -> float:
        try:
            return float(d.get(key, default))
        except (TypeError, ValueError):
            return default
    return [
        ThermostatPeriod("Absence", f("away", 18.5), presence="away"),
        ThermostatPeriod.from_dict({"name": "Nuit", "setpoint": f("night", 19.0),
                                    "start": d.get("night_start") or "22:30", "end": d.get("night_end") or "06:00"}),
        ThermostatPeriod("Jour", f("comfort", 21.0), presence="home"),
    ]


@dataclass
class ThermostatSettings:
    periods: list[ThermostatPeriod] = field(default_factory=default_periods)
    floor: float = 17.0
    away_delay_min: int = 15
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

        raw = d.get("periods")
        if isinstance(raw, list):
            periods = [ThermostatPeriod.from_dict(p) for p in raw if isinstance(p, dict)][:MAX_PERIODS]
        elif any(k in d for k in ("comfort", "night", "away", "night_start", "night_end")):
            periods = _legacy_periods(d)
        else:
            periods = default_periods()
        return cls(
            periods=periods,
            floor=num("floor", 10, 22),
            away_delay_min=int(num("away_delay_min", 0, 240)),
            min_write_interval_min=int(num("min_write_interval_min", 1, 240)),
            holiday_after_h=num("holiday_after_h", 0, 24 * 30),
            holiday_setpoint=num("holiday_setpoint", 5, 20),
            observe=bool(d.get("observe", base.observe)),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def standby_setpoint(self) -> float:
        """Kept while another equipment heats: the empty-house setpoint."""
        away = next((p.setpoint for p in self.periods if p.presence == "away"), self.floor)
        return max(self.floor, away)


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
        """Setpoint the plan asks for now, with its reason (the period name)."""
        away_confirmed = (
            r.absent
            and mem.absent_since_ts is not None
            and r.now_ts - mem.absent_since_ts >= s.away_delay_min * 60
        )
        for p in s.periods:
            if p.matches(r.now_min, away_confirmed):
                return round_half(max(s.floor, p.setpoint)), p.name
        return round_half(s.floor), FLOOR

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
            wanted, reason = round_half(min(wanted, s.standby_setpoint())), STANDBY

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
