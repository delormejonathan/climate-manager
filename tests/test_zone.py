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


def _seed_running_session(
    zone: Zone,
    *,
    mode: str = ProfileMode.COOL,
    target: float = 24.5,
    power: str = "normal",
    fan: str = "normal",
    parent: str = "Test",
    started_ts: float = 500.0,
    max_end_ts: float | None = None,
    target_cutoff: float | None = None,
) -> None:
    """Helper test : pré-positionne la zone dans une session active."""
    zone.state.state = ZoneState.RUNNING
    zone.state.cycle_started_ts = started_ts
    zone.state.cycle_start_profile_name = parent
    zone.state.session_target = target
    zone.state.session_target_cutoff = target_cutoff
    zone.state.session_power = power
    zone.state.session_fan_intensity = fan
    zone.state.session_mode = mode
    zone.state.session_max_end_ts = max_end_ts


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


# === Pendule (maintien pendant la session) ===


def test_session_far_from_target_pushes_hard_with_power_offset():
    """Room loin de target → consigne = target - offset(power)."""
    zone = Zone(_cfg())
    _seed_running_session(zone, target=24.5, power="normal")
    cmds = zone.tick(_inp(
        room_temperature=28.0,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    sp = _find_setpoint(cmds)
    expected = 24.5 - POWER_OFFSETS["normal"]
    assert sp == pytest.approx(expected, abs=0.5)


def test_session_inside_dead_band_holds_at_target():
    zone = Zone(_cfg())
    _seed_running_session(zone, target=24.5, power="agressif")
    cmds = zone.tick(_inp(
        room_temperature=24.4,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    sp = _find_setpoint(cmds)
    assert sp == pytest.approx(24.5, abs=0.5)


def test_session_below_target_holds_at_target():
    zone = Zone(_cfg())
    _seed_running_session(zone, target=24.5, power="normal")
    cmds = zone.tick(_inp(
        room_temperature=23.0,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    sp = _find_setpoint(cmds)
    assert sp == pytest.approx(24.5, abs=0.5)


def test_session_heat_far_from_target_pushes_up():
    zone = Zone(_cfg())
    _seed_running_session(zone, mode=ProfileMode.HEAT, target=21.0, power="normal")
    cmds = zone.tick(_inp(
        room_temperature=17.0,
        clim_internal_temperature=17.0,
        clim_current_hvac_mode=HVAC_HEAT,
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
    _seed_running_session(zone, target=24.5, power=power)
    cmds = zone.tick(_inp(
        room_temperature=28.0,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    sp = _find_setpoint(cmds)
    expected = max(18.0, 24.5 - expected_offset)
    assert sp == pytest.approx(expected, abs=0.5)


# === Setpoint sign correctness (the original bug) ===


def test_cool_setpoint_always_at_or_below_target():
    """Le bug historique du YAML : consigne au-dessus de la cible en cool."""
    zone = Zone(_cfg())
    _seed_running_session(zone, target=24.5)
    for room in (26.0, 28.0, 24.5, 22.0):
        cmds = zone.tick(_inp(
            room_temperature=room,
            clim_current_hvac_mode=HVAC_COOL,
        ))
        sp = _find_setpoint(cmds)
        if sp is not None:
            assert sp <= 24.5, f"room={room}: consigne {sp} doit être ≤ target 24.5"


# === Session protégée des changements de cascade ===


def test_profile_change_during_session_does_not_stop():
    """Cœur du modèle session : la cascade peut changer librement, la session
    en cours est immortelle aux changements de profil."""
    zone = Zone(_cfg())
    _seed_running_session(zone, target=24.5, parent="P1", started_ts=500.0)
    p2 = _profile_cool(name="P2", target=22.0)
    zone.tick(_inp(
        now_ts=1000.0,
        room_temperature=23.0,
        clim_current_hvac_mode=HVAC_COOL,
        active_profile=p2,
    ))
    assert zone.state.state == ZoneState.RUNNING, "session doit continuer"
    assert zone.state.session_target == 24.5, "params session non modifiés"
    assert zone.state.cycle_start_profile_name == "P1", "parent profile inchangé"


def test_profile_becomes_none_does_not_stop_session():
    zone = Zone(_cfg())
    _seed_running_session(zone, parent="P", started_ts=500.0)
    zone.tick(_inp(
        now_ts=1000.0,
        room_temperature=24.0,
        clim_current_hvac_mode=HVAC_COOL,
        active_profile=None,
    ))
    assert zone.state.state == ZoneState.RUNNING


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


def test_override_timed_without_suspended_session_expires_to_idle():
    zone = Zone(_cfg(override_duree_min=5))
    zone.on_external_override(now_ts=1_000.0, profile_active=True)
    cmds = zone.tick(_inp(
        now_ts=1_000.0 + 5 * 60 + 1,
        room_temperature=22.0,
        active_profile=_profile_cool(seuil_demarrage=27.0),
    ))
    assert zone.state.state == ZoneState.IDLE
    assert cmds == [] or all(c.service == "turn_off" for c in cmds)


def test_override_during_running_suspends_then_resumes_session_without_turn_off():
    zone = Zone(_cfg(override_duree_min=5))
    _seed_running_session(
        zone,
        started_ts=500.0,
        target=24.5,
        power="normal",
        fan="doux",
        max_end_ts=10_000.0,
    )

    zone.on_external_override(now_ts=1_000.0, profile_active=True)

    assert zone.state.state == ZoneState.MANUAL_OVERRIDE_TIMED
    assert zone.state.cycle_started_ts == 500.0
    assert zone.state.session_target == 24.5
    assert zone.state.completed_sessions == []

    cmds = zone.tick(_inp(
        now_ts=1_000.0 + 5 * 60 + 1,
        room_temperature=25.0,
        clim_internal_temperature=26.0,
        clim_current_hvac_mode=HVAC_COOL,
        clim_current_setpoint=25.0,
        clim_current_fan_mode="quiet",
        active_profile=_profile_cool(seuil_demarrage=27.0),
    ))

    assert zone.state.state == ZoneState.RUNNING
    assert zone.state.cycle_started_ts == 500.0
    assert zone.state.session_target == 24.5
    assert not any(c.service == "turn_off" for c in cmds)


def test_override_expiry_with_suspended_session_and_clim_off_cancels_session():
    zone = Zone(_cfg(override_duree_min=5))
    _seed_running_session(zone, started_ts=500.0, max_end_ts=10_000.0)
    zone.on_external_override(now_ts=1_000.0, profile_active=True)

    cmds = zone.tick(_inp(
        now_ts=1_000.0 + 5 * 60 + 1,
        room_temperature=25.0,
        clim_current_hvac_mode=HVAC_OFF,
        active_profile=_profile_cool(seuil_demarrage=27.0),
    ))

    assert zone.state.state == ZoneState.IDLE
    assert zone.state.session_target is None
    assert zone.state.completed_sessions[-1]["end_reason"] == "user_canceled"
    assert cmds == []


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


def test_reset_override_with_suspended_session_preserves_original_session():
    zone = Zone(_cfg())
    _seed_running_session(zone, started_ts=500.0, target=24.5, max_end_ts=10_000.0)
    zone.on_external_override(now_ts=1_000.0, profile_active=True)

    zone.reset_override(
        now_ts=2_000.0,
        clim_current_hvac_mode=HVAC_COOL,
        clim_state_last_changed_ts=1_200.0,
    )

    assert zone.state.state == ZoneState.RUNNING
    assert zone.state.cycle_started_ts == 500.0
    assert zone.state.session_target == 24.5
    assert zone.state.completed_sessions == []


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


def test_session_recorded_on_window_open():
    zone = Zone(_cfg(window_sensors=["binary_sensor.w"]))
    _seed_running_session(zone, parent="P", started_ts=500.0)
    zone.tick(_inp(
        now_ts=1_000.0,
        room_temperature=24.0,
        clim_current_hvac_mode=HVAC_COOL,
        any_window_open=True,
        active_profile=_profile_cool(name="P"),
    ))
    assert len(zone.state.completed_sessions) == 1
    assert zone.state.completed_sessions[0]["end_reason"] == "window_opened"


def test_session_ends_on_max_end_ts():
    zone = Zone(_cfg())
    _seed_running_session(zone, target=24.5, started_ts=500.0, max_end_ts=1_000.0)
    cmds = zone.tick(_inp(
        now_ts=1_001.0,
        room_temperature=24.5,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    assert zone.state.state == ZoneState.IDLE
    assert any(c.service == "turn_off" for c in cmds)
    assert zone.state.completed_sessions[-1]["end_reason"] == "max_end_reached"


def test_session_ends_on_target_cutoff_held():
    """target_cutoff atteinte et tenue TARGET_CUTOFF_HOLD_SECONDS → fin."""
    from custom_components.climate_manager.const import TARGET_CUTOFF_HOLD_SECONDS
    zone = Zone(_cfg())
    _seed_running_session(
        zone, mode=ProfileMode.COOL, target=24.5,
        target_cutoff=24.0, started_ts=0.0, max_end_ts=10_000.0,
    )
    # Tick 1 : on atteint 23.5°C → on commence à compter
    zone.tick(_inp(
        now_ts=1_000.0,
        room_temperature=23.5,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    assert zone.state.state == ZoneState.RUNNING
    assert zone.state.session_cutoff_held_since_ts == 1_000.0
    # Tick 2 : tenu pendant TARGET_CUTOFF_HOLD_SECONDS → fin
    cmds = zone.tick(_inp(
        now_ts=1_000.0 + TARGET_CUTOFF_HOLD_SECONDS + 1,
        room_temperature=23.4,
        clim_current_hvac_mode=HVAC_COOL,
    ))
    assert zone.state.state == ZoneState.IDLE
    assert any(c.service == "turn_off" for c in cmds)
    assert zone.state.completed_sessions[-1]["end_reason"] == "target_cutoff_reached"


def test_session_cutoff_reset_if_temp_rises_again():
    """T° remonte au-dessus du cutoff → on remet à zéro le compteur."""
    zone = Zone(_cfg())
    _seed_running_session(
        zone, target=24.5, target_cutoff=24.0, started_ts=0.0, max_end_ts=10_000.0,
    )
    zone.tick(_inp(now_ts=1_000.0, room_temperature=23.5, clim_current_hvac_mode=HVAC_COOL))
    assert zone.state.session_cutoff_held_since_ts == 1_000.0
    # T° remonte → reset
    zone.tick(_inp(now_ts=1_500.0, room_temperature=24.5, clim_current_hvac_mode=HVAC_COOL))
    assert zone.state.session_cutoff_held_since_ts is None
    assert zone.state.state == ZoneState.RUNNING


# === Démarrage manuel + modification de session ===


def test_start_manual_session_works_even_without_active_profile():
    """Le user peut lancer une session ad-hoc sans qu'aucun profil ne match."""
    zone = Zone(_cfg())
    zone.start_manual_session(
        now_ts=100.0,
        mode=ProfileMode.COOL,
        target=24.0,
        max_end_ts=10_000.0,
        power="agressif",
        fan_intensity="fort",
        parent_profile_name="Ad-hoc",
    )
    assert zone.state.state == ZoneState.RUNNING
    assert zone.state.session_target == 24.0
    assert zone.state.session_power == "agressif"
    assert zone.state.session_manual is True
    assert zone.state.cycle_start_profile_name == "Ad-hoc"


def test_extend_active_session_is_idempotent():
    """Chaque appel ajoute la durée au max_end_ts existant."""
    zone = Zone(_cfg())
    _seed_running_session(zone, started_ts=0.0, max_end_ts=1_000.0)
    assert zone.extend_active_session(3600) is True
    assert zone.state.session_max_end_ts == 1_000.0 + 3600
    assert zone.extend_active_session(3600) is True
    assert zone.state.session_max_end_ts == 1_000.0 + 7200


def test_update_active_session_changes_params_in_flight():
    zone = Zone(_cfg())
    _seed_running_session(zone, target=24.5, power="doux", fan="doux")
    assert zone.update_active_session(target=25.0, power="agressif") is True
    assert zone.state.session_target == 25.0
    assert zone.state.session_power == "agressif"
    assert zone.state.session_fan_intensity == "doux", "fan inchangé"


def test_update_session_power_cancels_kickstart():
    """User change power manuellement → la bascule kickstart est annulée."""
    zone = Zone(_cfg())
    _seed_running_session(zone, power="agressif")
    zone.state.session_kickstart_until_ts = 5_000.0
    zone.state.session_post_kickstart_power = "doux"
    zone.update_active_session(power="normal")
    assert zone.state.session_power == "normal"
    assert zone.state.session_kickstart_until_ts is None


def test_cancel_active_session_ends_immediately():
    zone = Zone(_cfg())
    _seed_running_session(zone, started_ts=100.0)
    cmds = zone.cancel_active_session(now_ts=500.0)
    assert zone.state.state == ZoneState.IDLE
    assert any(c.service == "turn_off" for c in cmds)
    assert zone.state.completed_sessions[-1]["end_reason"] == "user_canceled"


# === Kickstart ===


def test_kickstart_uses_strong_power_at_start():
    """Profil avec kickstart_minutes=30 → spawn avec kickstart_power."""
    zone = Zone(_cfg())
    p = _profile_cool(
        seuil_demarrage=27.0, target=24.5,
        power="doux", fan_intensity="doux",
        kickstart_minutes=30,
        kickstart_power="agressif",
        kickstart_fan_intensity="fort",
    )
    zone.tick(_inp(
        now_ts=1_000.0,
        room_temperature=28.0,
        clim_current_hvac_mode=HVAC_OFF,
        active_profile=p,
    ))
    assert zone.state.state == ZoneState.RUNNING
    assert zone.state.session_power == "agressif"
    assert zone.state.session_fan_intensity == "fort"
    assert zone.state.session_post_kickstart_power == "doux"
    assert zone.state.session_post_kickstart_fan_intensity == "doux"


def test_kickstart_expires_and_reverts_to_steady_params():
    zone = Zone(_cfg())
    p = _profile_cool(
        seuil_demarrage=27.0, target=24.5,
        power="doux", fan_intensity="doux",
        kickstart_minutes=30,
        kickstart_power="agressif",
        kickstart_fan_intensity="fort",
    )
    zone.tick(_inp(
        now_ts=1_000.0, room_temperature=28.0, active_profile=p,
    ))
    # Avancer >30 min → tick à 31 min
    zone.tick(_inp(
        now_ts=1_000.0 + 31 * 60,
        room_temperature=27.0,
        clim_current_hvac_mode=HVAC_COOL,
        active_profile=p,
    ))
    assert zone.state.session_power == "doux"
    assert zone.state.session_fan_intensity == "doux"
    assert zone.state.session_kickstart_until_ts is None


# === Defensive ===


def test_no_room_temp_does_nothing():
    zone = Zone(_cfg())
    cmds = zone.tick(_inp(
        room_temperature=None,
        active_profile=_profile_cool(),
    ))
    assert zone.state.state == ZoneState.IDLE
    assert cmds == []
