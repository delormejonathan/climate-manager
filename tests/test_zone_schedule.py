"""Programme as a zone card shows it: in force now, next change, on return."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

from custom_components.climate_manager.const import ZoneState
from custom_components.climate_manager.coordinator import DelormejClimateCoordinator
from custom_components.climate_manager.zone import Profile

STATES = {"alarm.house": "disarmed"}
HOME = {"presence_entity": "alarm.house", "presence_required_state": ["disarmed", "armed_home"]}
AWAY = {"presence_entity": "alarm.house", "presence_required_state": "armed_away"}


def _coord():
    profiles = [Profile.from_dict({"mode": "heat", **p}) for p in (
        {"name": "Absent", "target": 18, **AWAY},
        {"name": "Nuit", "target": 20, "active_from": "23:00", "active_to": "07:00"},
        {"name": "Présent", "target": 21, "active_from": "07:00", "active_to": "23:00", **HOME},
    )]
    zone = SimpleNamespace(config=SimpleNamespace(profiles=profiles), state=SimpleNamespace(
        state=ZoneState.IDLE, session_manual=False, manually_stopped_profile_name=None))
    c = object.__new__(DelormejClimateCoordinator)
    c.hass = SimpleNamespace(states=SimpleNamespace(
        get=lambda e: SimpleNamespace(state=STATES[e]) if e in STATES else None))
    c.entry = SimpleNamespace(data={"presence_entity": "alarm.house", "presence_home_states": ["disarmed"],
                                    "presence_absent_states": ["armed_away"]})
    c._house_is_absent = lambda: STATES["alarm.house"] == "armed_away"
    return c, zone


def at(h, m=0):
    return datetime(2026, 11, 27, h, m).astimezone()


def test_home_now_and_next_change():
    c, zone = _coord()
    s = c._zone_schedule(zone, at(10, 13))
    assert s["programme"]["name"] == "Présent" and s["on_return"] is None
    nxt = s["next_change"]
    assert (nxt["name"], nxt["target"]) == ("Nuit", 20)
    assert datetime.fromtimestamp(nxt["ts"]).astimezone().strftime("%H:%M") == "23:00"


def test_empty_house_shows_what_happens_on_return():
    c, zone = _coord()
    STATES["alarm.house"] = "armed_away"
    try:
        s = c._zone_schedule(zone, at(10))
        assert s["programme"]["name"] == "Absent"
        assert s["next_change"] is None  # nothing changes while nobody comes home
        assert s["on_return"]["name"] == "Présent"
    finally:
        STATES["alarm.house"] = "disarmed"


def test_control_reflects_the_zone_state():
    c, zone = _coord()
    assert c._zone_control(zone) == "auto"
    zone.state.manually_stopped_profile_name = "Présent"
    assert c._zone_control(zone) == "off"
    zone.state.state, zone.state.session_manual = ZoneState.RUNNING, True
    assert c._zone_control(zone) == "force"
    zone.state.state = ZoneState.MANUAL_OVERRIDE_FREE
    assert c._zone_control(zone) == "manual"
