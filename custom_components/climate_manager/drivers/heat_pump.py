"""Heat pump driver: a reversible ``climate.*`` unit (Daikin) serving one zone.

The zone state machine decides when a session runs and with which target; this
driver decides what to send to the unit: hvac mode, a pendulum setpoint
relative to the unit's own sensor, fan and swing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar, Protocol

from ..const import (
    BOOST_FAN_MODE,
    BOOST_OFFSET,
    CLIM_MAX_SETPOINT,
    CLIM_MIN_SETPOINT,
    DEFAULT_FAN_INTENSITY,
    DEFAULT_HEAT_SWING_MODE,
    DEFAULT_POWER,
    DEFAULT_SWING_MODE,
    FAN_MODES,
    FAN_SESSION_FAN_MODE,
    HEAT_APPROACH_MIN_OFFSET_C,
    HEAT_APPROACH_POWER_RATIO,
    HEAT_HOLD_RELEASE_OFFSET_C,
    POWER_OFFSETS,
    RATE_LIMIT_SECONDS,
    SETPOINT_NOOP_DELTA,
    TARGET_DEAD_BAND,
    ProfileMode,
)
from .base import Command, Driver, round_half

HVAC_OFF = "off"
HVAC_HEAT = "heat"
HVAC_COOL = "cool"
HVAC_FAN_ONLY = "fan_only"


class ClimateReading(Protocol):
    """What the driver reads from the unit (``ZoneInputs`` provides it)."""

    now_ts: float
    room_temperature: float | None
    clim_internal_temperature: float | None
    clim_current_hvac_mode: str
    clim_current_setpoint: float | None
    clim_current_fan_mode: str | None
    clim_current_swing_mode: str | None
    clim_min_setpoint: float
    clim_max_setpoint: float
    supports_fan_mode: bool
    supports_windnice: bool
    supports_swing: bool
    supports_fan_only: bool


@dataclass
class SentMemory:
    """Last orders sent to the unit (kept in the zone runtime state)."""

    last_command_ts: float | None = None
    last_setpoint_sent: float | None = None


@dataclass
class HeatPumpPlan:
    commands: list[Command] = field(default_factory=list)
    hvac_sent: str | None = None
    setpoint_sent: float | None = None
    fan_sent: str | None = None


class HeatPumpDriver(Driver):
    kind: ClassVar[str] = "heat_pump"

    # --- commands ---------------------------------------------------------
    @staticmethod
    def turn_off(entity: str | None) -> Command:
        return Command("climate", "turn_off", {"entity_id": entity})

    @staticmethod
    def set_hvac_mode(entity: str | None, mode: str) -> Command:
        return Command("climate", "set_hvac_mode", {"entity_id": entity, "hvac_mode": mode})

    @staticmethod
    def set_temperature(entity: str | None, temp: float) -> Command:
        return Command("climate", "set_temperature", {"entity_id": entity, "temperature": temp})

    @staticmethod
    def set_fan_mode(entity: str | None, mode: str) -> Command:
        return Command("climate", "set_fan_mode", {"entity_id": entity, "fan_mode": mode})

    @staticmethod
    def set_swing_mode(entity: str | None, mode: str) -> Command:
        return Command("climate", "set_swing_mode", {"entity_id": entity, "swing_mode": mode})

    def release(self, entity: str | None, state: str | None) -> list[Command]:
        if not entity or state in (None, HVAC_OFF, "unavailable", "unknown"):
            return []
        return [self.turn_off(entity)]

    # --- session ----------------------------------------------------------
    def plan_session(
        self,
        entity: str | None,
        inp: ClimateReading,
        *,
        mode: str | None,
        target: float | None,
        power: str | None,
        fan_intensity: str | None,
        sent: SentMemory,
    ) -> HeatPumpPlan:
        """Orders for a running session (heat, cool or fan only)."""
        plan = HeatPumpPlan()
        cmds = plan.commands
        if mode is None:
            return plan
        if mode == ProfileMode.FAN_ONLY:
            if not inp.supports_fan_only:
                return plan
            if inp.clim_current_hvac_mode != HVAC_FAN_ONLY:
                cmds.append(self.set_hvac_mode(entity, HVAC_FAN_ONLY))
                plan.hvac_sent = HVAC_FAN_ONLY
            if inp.supports_fan_mode and inp.clim_current_fan_mode != FAN_SESSION_FAN_MODE:
                cmds.append(self.set_fan_mode(entity, FAN_SESSION_FAN_MODE))
                plan.fan_sent = FAN_SESSION_FAN_MODE
            return plan

        if target is None or inp.room_temperature is None:
            return plan

        target_mode = HVAC_COOL if mode == ProfileMode.COOL else HVAC_HEAT
        power = power or DEFAULT_POWER
        fan_intensity = fan_intensity or DEFAULT_FAN_INTENSITY

        if inp.clim_current_hvac_mode != target_mode:
            cmds.append(self.set_hvac_mode(entity, target_mode))
            plan.hvac_sent = target_mode

        setpoint = self.pendulum_setpoint(
            inp.room_temperature,
            inp.clim_internal_temperature,
            inp.clim_min_setpoint,
            inp.clim_max_setpoint,
            target,
            power,
            mode,
        )
        if setpoint is not None and self.setpoint_should_send(setpoint, inp, sent):
            cmds.append(self.set_temperature(entity, setpoint))
            plan.setpoint_sent = setpoint

        if inp.supports_fan_mode:
            target_fan = FAN_MODES.get(fan_intensity, FAN_MODES[DEFAULT_FAN_INTENSITY])
            if inp.clim_current_fan_mode != target_fan:
                cmds.append(self.set_fan_mode(entity, target_fan))
                plan.fan_sent = target_fan

        target_swing = None
        if mode == ProfileMode.HEAT and inp.supports_swing:
            target_swing = DEFAULT_HEAT_SWING_MODE
        elif inp.supports_windnice:
            target_swing = DEFAULT_SWING_MODE
        if target_swing and inp.clim_current_swing_mode != target_swing:
            cmds.append(self.set_swing_mode(entity, target_swing))
        return plan

    def plan_boost(
        self, entity: str | None, inp: ClimateReading, target_mode: str, sent: SentMemory
    ) -> HeatPumpPlan:
        """Legacy 15 min boost: strong offset, fan 4, swing."""
        plan = HeatPumpPlan()
        cmds = plan.commands
        if inp.clim_current_hvac_mode != target_mode:
            cmds.append(self.set_hvac_mode(entity, target_mode))
        setpoint = self.boost_setpoint(inp.clim_internal_temperature, target_mode)
        if setpoint is not None and self.setpoint_should_send(setpoint, inp, sent):
            cmds.append(self.set_temperature(entity, setpoint))
            plan.setpoint_sent = setpoint
        if inp.supports_fan_mode and inp.clim_current_fan_mode != BOOST_FAN_MODE:
            cmds.append(self.set_fan_mode(entity, BOOST_FAN_MODE))
            plan.fan_sent = BOOST_FAN_MODE
        if inp.supports_windnice and inp.clim_current_swing_mode != "swing":
            cmds.append(self.set_swing_mode(entity, "swing"))
        return plan

    # --- setpoints --------------------------------------------------------
    @staticmethod
    def pendulum_setpoint(
        room: float,
        clim_internal: float | None,
        clim_min_setpoint: float,
        clim_max_setpoint: float,
        target: float,
        power: str,
        mode: str,
    ) -> float | None:
        """Drive the unit with a relative correction and a clear release.

        While the zone asks for effort, the unit's own sensor is the relative
        zero (internal ± offset). At target a small reverse correction is not
        always enough to stop the compressor, so the opposite physical bound is
        sent (minimum when heating, maximum when cooling).
        """
        if clim_internal is None:
            return None
        offset = POWER_OFFSETS.get(power, POWER_OFFSETS[DEFAULT_POWER])
        if mode == ProfileMode.COOL:
            if room > target + TARGET_DEAD_BAND:
                raw = clim_internal - offset
            elif room <= target:
                raw = clim_max_setpoint
            else:
                raw = clim_internal
        else:
            if room < target - TARGET_DEAD_BAND:
                raw = clim_internal + offset
            elif room < target:
                # Keep heating through the last half degree, with less effort as
                # the zone gets closer, so it does not cross the target with
                # too much inertia.
                remaining_ratio = min(1.0, max(0.0, (target - room) / TARGET_DEAD_BAND))
                approach_offset = max(
                    HEAT_APPROACH_MIN_OFFSET_C,
                    offset * HEAT_APPROACH_POWER_RATIO * remaining_ratio,
                )
                raw = clim_internal + approach_offset
            elif room < target + TARGET_DEAD_BAND:
                # A setpoint equal to the unit sensor can still heat (Daikin
                # hysteresis): release slightly before the physical minimum.
                raw = clim_internal - HEAT_HOLD_RELEASE_OFFSET_C
            else:
                raw = clim_min_setpoint
        return max(clim_min_setpoint, min(clim_max_setpoint, round_half(raw)))

    @staticmethod
    def boost_setpoint(clim_internal: float | None, target_mode: str) -> float | None:
        if clim_internal is None:
            return None
        signed = BOOST_OFFSET if target_mode == HVAC_HEAT else -BOOST_OFFSET
        return max(CLIM_MIN_SETPOINT, min(CLIM_MAX_SETPOINT, round_half(clim_internal + signed)))

    @staticmethod
    def setpoint_should_send(setpoint: float, inp: Any, sent: SentMemory) -> bool:
        """No resend when close to the current setpoint or too soon."""
        if (
            inp.clim_current_setpoint is not None
            and abs(setpoint - inp.clim_current_setpoint) < SETPOINT_NOOP_DELTA
        ):
            return False
        return not (
            sent.last_command_ts
            and (inp.now_ts - sent.last_command_ts) < RATE_LIMIT_SECONDS
            and sent.last_setpoint_sent is not None
            and abs(setpoint - sent.last_setpoint_sent) < SETPOINT_NOOP_DELTA
        )
