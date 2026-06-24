"""Tests for the multi-profile cascade introduced in v0.10.

Each zone now carries an ordered list of `Profile`s. At each tick the
coordinator picks the first profile whose gate (schedule + optional presence)
matches. The picked profile drives every cooling parameter (thresholds, power,
fan intensity). No profile matches → zone idle.

These tests exercise the pure-logic pieces: the Profile dataclass round-trip,
the zone falling back to its synthesised default profile, and the Zone reading
its thresholds from `inp.active_profile` when one is supplied.
"""

from __future__ import annotations

from custom_components.climate_manager.const import POWER_PROFILES, ZoneState
from custom_components.climate_manager.zone import Profile, Zone, ZoneConfig, ZoneInputs

HVAC_OFF = "off"
HVAC_COOL = "cool"


def _cfg(**overrides) -> ZoneConfig:
    base = dict(
        zone_id="z1",
        name="Z1",
        climate_entity="climate.z1",
        temperature_sensors=["sensor.t"],
        schedule_entity=None,
        seuil_debut_refroidissement=26.5,
        seuil_fin_refroidissement=24.0,
    )
    base.update(overrides)
    return ZoneConfig(**base)


def _inp(**overrides) -> ZoneInputs:
    base = dict(
        now_ts=1_000.0,
        room_temperature=25.0,
        clim_internal_temperature=25.0,
        clim_current_hvac_mode=HVAC_OFF,
        clim_current_setpoint=None,
        clim_current_fan_mode=None,
        clim_current_swing_mode=None,
        schedule_is_on=True,
        any_window_open=False,
        house_is_absent=False,
    )
    base.update(overrides)
    return ZoneInputs(**base)


# ---------- Profile round-trip ----------


def test_profile_roundtrip_via_dict() -> None:
    p = Profile(
        name="Jour vide",
        schedule_entity="schedule.maison_vide",
        presence_entity="alarm_control_panel.maison",
        presence_required_state="armed_away",
        seuil_debut_refroidissement=24.0,
        seuil_fin_refroidissement=21.0,
        power="agressif",
        fan_intensity="normal",
    )
    p2 = Profile.from_dict(p.to_dict())
    assert p == p2


def test_profile_from_minimal_dict_uses_defaults() -> None:
    p = Profile.from_dict({"name": "X"})
    assert p.name == "X"
    assert p.schedule_entity is None
    assert p.presence_entity is None
    # Defaults from const.DEFAULT_* — assert structural rather than literal
    assert isinstance(p.seuil_fin_refroidissement, float)
    assert p.power in POWER_PROFILES


# ---------- ZoneConfig migration ----------


def test_zoneconfig_synthesises_default_profile_when_empty() -> None:
    """A config built without explicit profiles must auto-create one from the
    legacy fields so behaviour is preserved across upgrades."""
    cfg = _cfg(power="agressif", fan_intensity="fort")
    assert len(cfg.profiles) == 1
    p = cfg.profiles[0]
    assert p.seuil_fin_refroidissement == 24.0
    assert p.power == "agressif"
    assert p.fan_intensity == "fort"


def test_zoneconfig_keeps_explicit_profiles() -> None:
    explicit = [
        Profile(name="A", schedule_entity="schedule.a", seuil_fin_refroidissement=21.0),
        Profile(name="B", schedule_entity="schedule.b", seuil_fin_refroidissement=24.0),
    ]
    cfg = _cfg(profiles=explicit)
    assert cfg.profiles == explicit  # __post_init__ does not overwrite


# ---------- Zone uses active_profile thresholds ----------


def test_zone_uses_active_profile_thresholds_over_config() -> None:
    """Active profile's seuils take precedence over the legacy zone seuils.

    The config has cool_start=26.5 but the active profile says 23.0 — so the
    zone must start cooling at room=24.0°C (below 26.5 but above 23)."""
    cfg = _cfg(seuil_debut_refroidissement=26.5)
    zone = Zone(cfg)
    active = Profile(name="Agressif jour", seuil_debut_refroidissement=23.0,
                     seuil_fin_refroidissement=20.0)
    cmds = zone.tick(_inp(room_temperature=24.0, active_profile=active))
    assert zone.state.state in (ZoneState.STARTING, ZoneState.RUNNING)
    assert any(c.service == "set_hvac_mode" for c in cmds)


def test_zone_falls_back_to_default_profile_without_active() -> None:
    """When no active_profile is provided (e.g. early test path), the zone
    uses the auto-synthesised default profile (= legacy fields)."""
    cfg = _cfg(seuil_debut_refroidissement=26.5, seuil_fin_refroidissement=24.0)
    zone = Zone(cfg)
    # Room=25.0, default profile cool_start=26.5 → should stay idle
    zone.tick(_inp(room_temperature=25.0))
    assert zone.state.state == ZoneState.IDLE


def test_active_profile_drives_power_offset() -> None:
    """Switching the active profile's power knob changes the setpoint offset
    on the next emit, even though the legacy zone power stays the same."""
    cfg = _cfg(power="doux")  # legacy default doux → 3°C offset
    zone = Zone(cfg)
    zone.state.state = ZoneState.RUNNING
    # Profile overrides to agressif → 7°C offset
    profile = Profile(
        name="Agressif",
        seuil_debut_refroidissement=23.0,
        seuil_fin_refroidissement=20.0,
        power="agressif",
    )
    cmds = zone.tick(_inp(
        room_temperature=24.0,
        clim_internal_temperature=24.0,
        clim_current_hvac_mode=HVAC_COOL,
        active_profile=profile,
    ))
    setpoint = next((c.data["temperature"] for c in cmds if c.service == "set_temperature"), None)
    # Expected = 24.0 - 7.0 = 17.0 (then clamped to CLIM_MIN_SETPOINT=18.0)
    assert setpoint is not None
    assert setpoint <= 18.5, f"Agressif profile must apply 7°C offset; got {setpoint}"


# ---------- Profile time window ----------


def test_time_window_no_bounds_always_on() -> None:
    p = Profile(name="default")
    assert p.time_window_contains(0, 0) is True
    assert p.time_window_contains(12, 0) is True
    assert p.time_window_contains(23, 59) is True


def test_time_window_partial_bounds_disabled() -> None:
    """Only one of from/to set → fail open (treat as no window)."""
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
    assert p.time_window_contains(22, 0) is False  # half-open interval
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
    # Fail open rather than throw
    assert p.time_window_contains(12, 0) is True


# ---------- Profile per-instance stabilization override ----------


def test_profile_stab_override_takes_precedence() -> None:
    """A profile with its own duree_stabilisation_min wins over the zone."""
    cfg = _cfg(duree_stabilisation_min=60)
    zone = Zone(cfg)
    zone.state.state = ZoneState.STABILIZING
    zone.state.last_state_transition_ts = 0.0
    # 10-min profile override: at t=11min STAB must have ended (→ COOLDOWN)
    short = Profile(name="précool", duree_stabilisation_min=10,
                    seuil_debut_refroidissement=24.0, seuil_fin_refroidissement=21.0)
    zone.tick(_inp(now_ts=11 * 60, active_profile=short))
    assert zone.state.state == ZoneState.COOLDOWN, "Profile's 10min STAB must have ended by now"


def test_profile_stab_falls_back_to_zone_when_none() -> None:
    """Profile with duree_stabilisation_min=None → uses zone's value."""
    cfg = _cfg(duree_stabilisation_min=30)
    zone = Zone(cfg)
    zone.state.state = ZoneState.STABILIZING
    zone.state.last_state_transition_ts = 0.0
    p = Profile(name="default", duree_stabilisation_min=None,
                seuil_debut_refroidissement=24.0, seuil_fin_refroidissement=21.0)
    # At t=10min: zone STAB is 30min, profile is None → still STABILIZING
    zone.tick(_inp(now_ts=10 * 60, active_profile=p))
    assert zone.state.state == ZoneState.STABILIZING
    # At t=31min: zone's 30min limit reached
    zone.tick(_inp(now_ts=31 * 60, active_profile=p))
    assert zone.state.state == ZoneState.COOLDOWN


def test_profile_stab_roundtrip_via_dict() -> None:
    """The new fields survive a from_dict/to_dict cycle."""
    p = Profile(name="custom", active_from="09:00", active_to="22:00",
                duree_stabilisation_min=45)
    p2 = Profile.from_dict(p.to_dict())
    assert p2.active_from == "09:00"
    assert p2.active_to == "22:00"
    assert p2.duree_stabilisation_min == 45


def test_profile_stab_empty_string_treated_as_none() -> None:
    """Empty string from the form input UI must round-trip to None, not crash."""
    p = Profile.from_dict({"name": "X", "duree_stabilisation_min": ""})
    assert p.duree_stabilisation_min is None
