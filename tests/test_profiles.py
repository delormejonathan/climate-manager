"""Tests for the new Profile (post-v0.20).

A Profile carries its own mode (cool|heat), gate (time window + presence),
seuil_demarrage, target, power, fan_intensity. Roundtrips via from_dict /
to_dict and the time-window helper are exercised here.
"""

from __future__ import annotations

from custom_components.climate_manager.const import ProfileMode
from custom_components.climate_manager.zone import Profile

# === Roundtrip ===


def test_profile_roundtrip_via_dict() -> None:
    p = Profile(
        name="Journée TT",
        mode=ProfileMode.COOL,
        active_from="09:00",
        active_to="22:00",
        presence_entity="alarm_control_panel.maison",
        presence_required_state=["disarmed", "armed_home"],
        seuil_demarrage=27.0,
        target=24.5,
        power="normal",
        fan_intensity="normal",
    )
    p2 = Profile.from_dict(p.to_dict())
    assert p == p2


def test_profile_from_minimal_dict_uses_defaults() -> None:
    p = Profile.from_dict({"name": "X"})
    assert p.name == "X"
    assert p.mode == ProfileMode.COOL
    assert p.active_from is None
    assert p.active_to is None


def test_profile_heat_from_dict_uses_heat_defaults() -> None:
    p = Profile.from_dict({"name": "Hiver", "mode": "heat"})
    assert p.mode == ProfileMode.HEAT
    assert p.target == 21.0
    assert p.seuil_demarrage == 18.0


def test_profile_invalid_mode_falls_back_to_cool() -> None:
    p = Profile.from_dict({"name": "X", "mode": "bogus"})
    assert p.mode == ProfileMode.COOL


def test_profile_empty_strings_for_times_become_none() -> None:
    p = Profile.from_dict({"name": "X", "active_from": "", "active_to": ""})
    assert p.active_from is None
    assert p.active_to is None


# === Time window ===


def test_time_window_no_bounds_always_on() -> None:
    p = Profile(name="default")
    assert p.time_window_contains(0, 0) is True
    assert p.time_window_contains(12, 0) is True
    assert p.time_window_contains(23, 59) is True


def test_time_window_partial_bounds_disabled() -> None:
    p = Profile(name="X", active_from="08:00")
    assert p.time_window_contains(2, 0) is True
    p = Profile(name="X", active_to="22:00")
    assert p.time_window_contains(2, 0) is True


def test_time_window_same_day() -> None:
    p = Profile(name="day", active_from="08:00", active_to="22:00")
    assert p.time_window_contains(7, 59) is False
    assert p.time_window_contains(8, 0) is True
    assert p.time_window_contains(15, 0) is True
    assert p.time_window_contains(21, 59) is True
    assert p.time_window_contains(22, 0) is False
    assert p.time_window_contains(23, 0) is False


def test_time_window_wraps_midnight() -> None:
    p = Profile(name="night", active_from="22:00", active_to="06:00")
    assert p.time_window_contains(22, 0) is True
    assert p.time_window_contains(23, 30) is True
    assert p.time_window_contains(0, 0) is True
    assert p.time_window_contains(5, 59) is True
    assert p.time_window_contains(6, 0) is False
    assert p.time_window_contains(7, 0) is False
    assert p.time_window_contains(21, 59) is False


def test_time_window_malformed_strings_dont_crash() -> None:
    p = Profile(name="bad", active_from="not a time", active_to="08:00")
    assert p.time_window_contains(12, 0) is True


def test_time_window_same_instant_always_on() -> None:
    p = Profile(name="x", active_from="10:00", active_to="10:00")
    assert p.time_window_contains(10, 0) is True
    assert p.time_window_contains(2, 0) is True
