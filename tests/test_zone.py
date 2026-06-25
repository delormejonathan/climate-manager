"""Tests for the pure-logic Zone (post-v0.20 clean architecture).

The new model:
- States: IDLE | RUNNING | WINDOW_OPEN | MANUAL_OVERRIDE_TIMED|FREE
- A profile is required to enter RUNNING (no profile → IDLE).
- RUNNING maintains room ≈ target via a pendulum setpoint (target ± offset
  depending on the Power knob), never cycling the clim off mid-session.
- Profile change (different one OR none) cuts the clim and goes IDLE.
"""

from __future__ import annotations

import pytest

from custom_components.climate_manager.const import (
    POWER_OFFSETS,
    ProfileMode,
    ZoneMode,
    ZoneState,
)
from custom_components.climate_manager.zone import (
    Profile,
    Zone,
    ZoneConfig,
    ZoneInputs,
)

HVAC_OFF = "off"
HVAC_HEAT = "heat"
HVAC_COOL = "cool"


def _cfg(**overrides) -> ZoneConfig:
    base = dict(
        zone_id="z1",
        name="Z1",
        climate_entity="climate.z1",
        temperature_sensors=["sensor.t"],
    )
    base.update(overrides)
    return ZoneConfig(**base)


def _profile_cool(**overrides) -> Profile:
    base = dict(name="Cool", mode=ProfileMode.COOL, seuil_demarrage=27.0, target=24.5)
    base.update(overrides)
    return Profile(**base)


def _profile_heat(**overrides) -> Profile:
    base = dict(name="Heat", mode=ProfileMode.HEAT, seuil_demarrage=18.0, target=21.0)
    base.update(overrides)
    return Profile(**base)


def _inp(**overrides) -> ZoneInputs:
    base = dict(
        now_ts=1_000.0,
        room_temperature=25.0,
        clim_internal_temperature=25.0,
        clim_current_hvac_mode=HVAC_OFF,
        clim_current_setpoint=None,
        clim_current_fan_mode=None,
        clim_current_swing_mode=None,
        any_window_open=False,
    )
    base.update(overrides)
    return ZoneInputs(**base)


def _find_setpoint(cmds):
    for c in cmds:
        if c.service == "set_temperature":
            return c.data.get("temperature")
    return None


def _find_hvac(cmds):
    for c in cmds:
        if c.service == "set_hvac_mode":
            return c.data.get("hvac_mode")
    return None


# === Démarrage ===


def test_idle_with_no_profile_does_nothing():
    zone = Zone(_cfg())
    cmds = zone.tick(_inp(room_temperature=30.0, active_profile=None))
    assert zone.state.state == ZoneState.IDLE
    assert cmds == []


def test_idle_under_seuil_stays_idle():
    zone = Zone(_cfg())
    p = _profile_cool(seuil_demarrage=27.0)
    cmds = zone.tick(_inp(room_temperature=26.0, active_profile=p))
    assert zone.state.state == ZoneState.IDLE
    assert cmds == []


def test_idle_crosses_cool_seuil_starts_running():
    zone = Zone(_cfg())
    p = _profile_cool(seuil_demarrage=27.0, target=24.5)
    cmds = zone.tick(_inp(room_temperature=27.0, active_profile=p))
    assert zone.state.state == ZoneState.RUNNING
    assert _find_hvac(cmds) == HVAC_COOL


def test_idle_crosses_heat_seuil_starts_running():
    zone = Zone(_cfg())
    p = _profile_heat(seuil_demarrage=18.0, target=21.0)
    cmds = zone.tick(_inp(room_temperature=18.0, active_profile=p))
    assert zone.state.state == ZoneState.RUNNING
    assert _find_hvac(cmds) == HVAC_HEAT


def test_heat_profile_with_warm_room_stays_idle():
    """Un profil HEAT actif à 27° ne doit pas démarrer."""
    zone = Zone(_cfg())
    p = _profile_heat(seuil_demarrage=18.0)
    cmds = zone.tick(_inp(room_temperature=27.0, active_profile=p))
    assert zone.state.state == ZoneState.IDLE
    assert cmds == []


def test_cool_profile_with_cold_room_stays_idle():
    zone = Zone(_cfg())
    p = _profile_cool(seuil_demarrage=27.0)
    cmds = zone.tick(_inp(room_temperature=18.0, active_profile=p))
    assert zone.state.state == ZoneState.IDLE
    assert cmds == []


# === Pendule (maintien en RUNNING) ===


def test_running_far_from_target_pushes_hard_with_power_offset():
    """Room loin de target → consigne = target - offset(power)."""
    zone = Zone(_cfg())
    p = _profile_cool(target=24.5, power="normal")
    zone.state.state = ZoneState.RUNNING
    cmds = zone.tick(_inp(
        room_temperature=28.0,
        active_profile=p,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    sp = _find_setpoint(cmds)
    expected = 24.5 - POWER_OFFSETS["normal"]
    assert sp == pytest.approx(expected, abs=0.5)


def test_running_inside_dead_band_holds_at_target():
    """Room ≈ target → consigne = target (pas d'offset)."""
    zone = Zone(_cfg())
    p = _profile_cool(target=24.5, power="agressif")
    zone.state.state = ZoneState.RUNNING
    cmds = zone.tick(_inp(
        room_temperature=24.4,
        active_profile=p,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    sp = _find_setpoint(cmds)
    assert sp == pytest.approx(24.5, abs=0.5)


def test_running_below_target_holds_at_target():
    """Room sous target en cool → consigne = target, l'inverter idle."""
    zone = Zone(_cfg())
    p = _profile_cool(target=24.5, power="normal")
    zone.state.state = ZoneState.RUNNING
    cmds = zone.tick(_inp(
        room_temperature=23.0,
        active_profile=p,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    sp = _find_setpoint(cmds)
    assert sp == pytest.approx(24.5, abs=0.5)


def test_running_heat_far_from_target_pushes_up():
    zone = Zone(_cfg())
    p = _profile_heat(target=21.0, power="normal")
    zone.state.state = ZoneState.RUNNING
    cmds = zone.tick(_inp(
        room_temperature=17.0,
        clim_internal_temperature=17.0,
        clim_current_hvac_mode=HVAC_HEAT,
        active_profile=p,
    ))
    sp = _find_setpoint(cmds)
    expected = 21.0 + POWER_OFFSETS["normal"]
    assert sp == pytest.approx(expected, abs=0.5)


@pytest.mark.parametrize(("power", "expected_offset"), [
    ("doux", 2.0),
    ("normal", 4.0),
    ("agressif", 7.0),
])
def test_power_knob_controls_pendulum_offset(power, expected_offset):
    zone = Zone(_cfg())
    p = _profile_cool(target=24.5, power=power)
    zone.state.state = ZoneState.RUNNING
    cmds = zone.tick(_inp(
        room_temperature=28.0,
        active_profile=p,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    sp = _find_setpoint(cmds)
    expected = max(18.0, 24.5 - expected_offset)  # clamped à CLIM_MIN_SETPOINT
    assert sp == pytest.approx(expected, abs=0.5)


# === Setpoint sign correctness (the original bug) ===


def test_cool_setpoint_always_at_or_below_target():
    """Le bug historique du YAML : consigne au-dessus de la cible en cool."""
    zone = Zone(_cfg())
    p = _profile_cool(target=24.5)
    zone.state.state = ZoneState.RUNNING
    for room in (26.0, 28.0, 24.5, 22.0):
        cmds = zone.tick(_inp(
            room_temperature=room,
            active_profile=p,
            clim_current_hvac_mode=HVAC_COOL,
        ))
        sp = _find_setpoint(cmds)
        if sp is not None:
            assert sp <= 24.5, f"room={room}: consigne {sp} doit être ≤ target 24.5"


# === Changement de profil → coupe ===


def test_profile_change_during_running_stops_clim():
    zone = Zone(_cfg())
    zone.state.state = ZoneState.RUNNING
    zone.state.cycle_started_ts = 500.0
    zone.state.cycle_start_profile_name = "P1"
    p2 = _profile_cool(name="P2", target=22.0)
    cmds = zone.tick(_inp(
        room_temperature=23.0,
        clim_current_hvac_mode=HVAC_COOL,
        active_profile=p2,
    ))
    assert zone.state.state == ZoneState.IDLE
    assert any(c.service == "turn_off" for c in cmds)


def test_profile_becomes_none_stops_clim():
    zone = Zone(_cfg())
    zone.state.state = ZoneState.RUNNING
    zone.state.cycle_started_ts = 500.0
    zone.state.cycle_start_profile_name = "P"
    cmds = zone.tick(_inp(
        room_temperature=24.0,
        clim_current_hvac_mode=HVAC_COOL,
        active_profile=None,
    ))
    assert zone.state.state == ZoneState.IDLE
    assert any(c.service == "turn_off" for c in cmds)


# === Hard gates ===


def test_window_open_during_running_stops_clim():
    zone = Zone(_cfg(window_sensors=["binary_sensor.w"]))
    p = _profile_cool()
    zone.state.state = ZoneState.RUNNING
    cmds = zone.tick(_inp(
        room_temperature=28.0,
        clim_current_hvac_mode=HVAC_COOL,
        any_window_open=True,
        active_profile=p,
    ))
    assert zone.state.state == ZoneState.WINDOW_OPEN
    assert any(c.service == "turn_off" for c in cmds)


def test_window_closed_after_open_returns_to_idle():
    zone = Zone(_cfg())
    zone.state.state = ZoneState.WINDOW_OPEN
    p = _profile_cool()
    cmds = zone.tick(_inp(
        room_temperature=22.0,
        any_window_open=False,
        active_profile=p,
    ))
    assert zone.state.state == ZoneState.IDLE
    assert cmds == []


# === Override ===


def test_external_override_with_active_profile_is_timed():
    zone = Zone(_cfg(override_duree_min=20))
    zone.on_external_override(now_ts=1_000.0, profile_active=True)
    assert zone.state.state == ZoneState.MANUAL_OVERRIDE_TIMED
    assert zone.state.override_until_ts == 1_000.0 + 20 * 60


def test_external_override_without_active_profile_is_free():
    zone = Zone(_cfg())
    zone.on_external_override(now_ts=1_000.0, profile_active=False)
    assert zone.state.state == ZoneState.MANUAL_OVERRIDE_FREE
    assert zone.state.override_until_ts is None


def test_override_does_not_pilot():
    zone = Zone(_cfg())
    zone.on_external_override(now_ts=1_000.0, profile_active=True)
    cmds = zone.tick(_inp(now_ts=1_001.0, active_profile=_profile_cool()))
    assert cmds == []


def test_override_timed_expires_to_idle():
    zone = Zone(_cfg(override_duree_min=5))
    zone.on_external_override(now_ts=1_000.0, profile_active=True)
    cmds = zone.tick(_inp(
        now_ts=1_000.0 + 5 * 60 + 1,
        room_temperature=22.0,
        active_profile=_profile_cool(seuil_demarrage=27.0),
    ))
    assert zone.state.state == ZoneState.IDLE
    assert cmds == [] or all(c.service == "turn_off" for c in cmds)


def test_reset_override_clim_on_resumes_running():
    """Reprise auto pendant que la clim tourne → on garde RUNNING, on n'éteint pas."""
    zone = Zone(_cfg())
    zone.on_external_override(now_ts=1_000.0, profile_active=True)
    zone.reset_override(
        now_ts=2_000.0,
        clim_current_hvac_mode=HVAC_COOL,
        clim_state_last_changed_ts=1_200.0,
    )
    assert zone.state.state == ZoneState.RUNNING
    assert zone.state.cycle_started_ts == 1_200.0


def test_reset_override_clim_off_goes_idle():
    zone = Zone(_cfg())
    zone.on_external_override(now_ts=1_000.0, profile_active=True)
    zone.reset_override(now_ts=2_000.0, clim_current_hvac_mode=HVAC_OFF)
    assert zone.state.state == ZoneState.IDLE
    assert zone.state.cycle_started_ts is None


# === Mode OFF ===


def test_mode_off_kills_clim():
    zone = Zone(_cfg())
    zone.set_mode(ZoneMode.OFF, now_ts=0.0)
    cmds = zone.tick(_inp(
        room_temperature=28.0,
        clim_current_hvac_mode=HVAC_COOL,
        active_profile=_profile_cool(),
    ))
    assert any(c.service == "turn_off" for c in cmds)


# === Boost ===


def test_boost_pushes_hard_with_fan_4():
    zone = Zone(_cfg())
    zone.trigger_boost(now_ts=1_000.0, direction=HVAC_COOL)
    cmds = zone.tick(_inp(
        room_temperature=28.0,
        clim_internal_temperature=27.0,
        clim_current_hvac_mode=HVAC_OFF,
        active_profile=_profile_cool(),
    ))
    fan = next((c.data.get("fan_mode") for c in cmds if c.service == "set_fan_mode"), None)
    sp = _find_setpoint(cmds)
    assert fan == "4"
    assert sp is not None
    assert sp <= 23.0  # 27 - BOOST_OFFSET(5) avec clamp


# === Sessions ===


def test_session_recorded_on_profile_change():
    zone = Zone(_cfg())
    p2 = _profile_cool(name="P2")
    zone.state.state = ZoneState.RUNNING
    zone.state.cycle_started_ts = 500.0
    zone.state.cycle_start_profile_name = "P1"
    zone.tick(_inp(
        now_ts=1_000.0,
        room_temperature=24.0,
        clim_current_hvac_mode=HVAC_COOL,
        active_profile=p2,
    ))
    assert len(zone.state.completed_sessions) == 1
    sess = zone.state.completed_sessions[0]
    assert sess["profile_name"] == "P1"
    assert sess["start_ts"] == 500.0
    assert sess["end_ts"] == 1_000.0
    assert sess["end_reason"] == "profile_change"


def test_session_recorded_on_window_open():
    zone = Zone(_cfg(window_sensors=["binary_sensor.w"]))
    p = _profile_cool(name="P")
    zone.state.state = ZoneState.RUNNING
    zone.state.cycle_started_ts = 500.0
    zone.state.cycle_start_profile_name = "P"
    zone.tick(_inp(
        now_ts=1_000.0,
        room_temperature=24.0,
        clim_current_hvac_mode=HVAC_COOL,
        any_window_open=True,
        active_profile=p,
    ))
    assert len(zone.state.completed_sessions) == 1
    assert zone.state.completed_sessions[0]["end_reason"] == "window_opened"


# === Defensive ===


def test_no_room_temp_does_nothing():
    zone = Zone(_cfg())
    cmds = zone.tick(_inp(
        room_temperature=None,
        active_profile=_profile_cool(),
    ))
    assert zone.state.state == ZoneState.IDLE
    assert cmds == []
