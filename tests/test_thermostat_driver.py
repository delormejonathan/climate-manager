"""Thermostat driver: one steady setpoint from time plan and presence."""

from custom_components.climate_manager.drivers.thermostat import (
    FLOOR,
    HOLIDAY,
    MANUAL,
    STANDBY,
    ThermostatDriver,
    ThermostatEntities,
    ThermostatMemory,
    ThermostatReading,
    ThermostatSettings,
)

E = ThermostatEntities(
    setpoint="number.sp", schedule="switch.prog", holiday="switch.hol",
    holiday_setpoint="number.hol_sp", room_sensor="sensor.room",
)
T0 = 1_000_000.0


def hm(h, m=0):
    return h * 60 + m


DAY, NIGHT, AWAY = "Présent", "Nuit", "Absent"  # zone heating profiles used below


def zones_demand(now_min, absent):
    """Stand-in for the zones' heating profiles (the coordinator picks them)."""
    if absent:
        return 18.5, AWAY
    if now_min >= hm(22, 30) or now_min < hm(6):
        return 19.0, NIGHT
    return 21.0, DAY


def reading(now_min, *, ts=T0, absent=False, room=20.0, setpoint=21.0, schedule_on=False,
            holiday_on=False, target=None, demand=...):
    value, name = zones_demand(now_min, absent) if demand is ... else (demand, None)
    return ThermostatReading(
        now_ts=ts, now_min=now_min, absent=absent, room=room, setpoint=setpoint,
        schedule_on=schedule_on, holiday_on=holiday_on, holiday_setpoint=10.0, target_in_force=target,
        demand=value, demand_name=name,
    )


def live(**kw):
    return ThermostatSettings(observe=False, **kw)


def test_setpoint_is_the_zone_profile_target():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    assert d.plan(E, s, reading(hm(14)), m).reason == DAY
    p = d.plan(E, s, reading(hm(23), room=19.0), m)
    assert (p.reason, p.wanted) == (NIGHT, 19.0)


def test_no_profile_in_force_gives_the_floor():
    d, m = ThermostatDriver(), ThermostatMemory()
    p = d.plan(E, live(floor=16.0), reading(hm(9), demand=None), m)
    assert (p.reason, p.wanted) == (FLOOR, 16.0)


def test_floor():
    d, m = ThermostatDriver(), ThermostatMemory()
    p = d.plan(E, live(floor=17.0), reading(hm(2), room=17.0, setpoint=17.0, demand=15.0), m)
    assert p.wanted == 17.0


def test_no_preheat_the_setpoint_moves_when_the_profile_does():
    d, s = ThermostatDriver(), live()  # night until 06:00, then day
    # Even with a slow learnt rate and a cold room, the day setpoint waits for 06:00.
    m = ThermostatMemory(heat_rate=0.3)
    for t in (hm(3, 0), hm(4, 56), hm(5, 59)):
        p = d.plan(E, s, reading(t, room=18.0, setpoint=19.0), m)
        assert (p.reason, p.wanted) == (NIGHT, 19.0)
    p = d.plan(E, s, reading(hm(6, 0), room=18.0, setpoint=19.0), m)
    assert (p.reason, p.wanted) == (DAY, 21.0)


def test_writes_only_on_change_and_not_too_often():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    p = d.plan(E, s, reading(hm(14), setpoint=21.0), m)
    assert p.commands == []
    p = d.plan(E, s, reading(hm(23), ts=T0, setpoint=21.0), m)
    assert [(c.service, c.data["value"]) for c in p.commands] == [("set_value", 19.0)]
    # Back to day 5 min later (clock jump): too soon, nothing written.
    p = d.plan(E, s, reading(hm(14), ts=T0 + 300, setpoint=19.0), m)
    assert p.commands == [] and p.blocked_until_ts == T0 + 15 * 60
    p = d.plan(E, s, reading(hm(14), ts=T0 + 16 * 60, setpoint=19.0), m)
    assert [c.data["value"] for c in p.commands] == [21.0]


def test_observe_writes_nothing():
    d, m = ThermostatDriver(), ThermostatMemory()
    p = d.plan(E, ThermostatSettings(), reading(hm(23), setpoint=21.0, schedule_on=True), m)
    assert (p.wanted, p.commands, p.take_over) == (19.0, [], False)


def test_take_over_switches_the_programme_off():
    d, m = ThermostatDriver(), ThermostatMemory()
    p = d.plan(E, live(), reading(hm(14), setpoint=21.0, schedule_on=True), m)
    assert p.take_over and [(c.domain, c.service) for c in p.commands] == [("switch", "turn_off")]


def test_hand_setting_is_respected_then_resumed():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    d.plan(E, s, reading(hm(14), ts=T0, setpoint=21.0), m)
    p = d.plan(E, s, reading(hm(14, 1), ts=T0 + 3600, setpoint=22.5), m)
    assert (p.reason, p.wanted, p.commands) == (MANUAL, 22.5, [])
    p = d.plan(E, s, reading(hm(17), ts=T0 + 3600 + 3 * 3600 + 1, setpoint=22.5), m)
    assert p.reason == DAY and [c.data["value"] for c in p.commands] == [21.0]


def test_own_write_echo_is_not_a_hand_setting():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    d.plan(E, s, reading(hm(23), ts=T0, setpoint=21.0), m)  # writes 19
    p = d.plan(E, s, reading(hm(23, 1), ts=T0 + 60, setpoint=19.0), m)
    assert p.reason == NIGHT


def test_long_absence_goes_to_holiday_and_back():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory(absent_since_ts=T0 - 25 * 3600)
    p = d.plan(E, s, reading(hm(14), absent=True, setpoint=18.5), m)
    assert p.reason == HOLIDAY and p.wanted == 16.0
    assert [(c.data["entity_id"], c.service) for c in p.commands] == [
        ("number.hol_sp", "set_value"), ("switch.hol", "turn_on"),
    ]
    p = d.plan(E, s, reading(hm(18), ts=T0 + 60, absent=False, setpoint=18.5, holiday_on=True), m)
    services = [(c.data["entity_id"], c.service) for c in p.commands]
    assert ("switch.hol", "turn_off") in services and ("number.sp", "set_value") in services


def test_standby_keeps_the_boiler_low():
    d, m = ThermostatDriver(), ThermostatMemory()
    p = d.plan(E, live(), reading(hm(14), setpoint=21.0), m, role=STANDBY)
    assert (p.reason, p.wanted) == (STANDBY, 17.0)  # the floor


def test_heat_rate_learnt_on_a_real_rise():
    d, s, m = ThermostatDriver(), ThermostatSettings(), ThermostatMemory()
    d.plan(E, s, reading(hm(7), ts=T0, room=19.0, target=21.0), m)
    assert m.rise_start_ts == T0
    d.plan(E, s, reading(hm(8), ts=T0 + 3600, room=20.0, target=21.0), m)
    d.plan(E, s, reading(hm(9), ts=T0 + 2 * 3600, room=20.9, target=21.0), m)
    assert m.heat_rate == 0.95 and m.heat_rate_samples == 1 and m.rise_start_ts is None
    # A rise cut short by the target going down is not measured.
    d.plan(E, s, reading(hm(17), ts=T0 + 9 * 3600, room=19.5, target=21.0), m)
    d.plan(E, s, reading(hm(17, 30), ts=T0 + 9.5 * 3600, room=19.8, target=19.0), m)
    assert m.heat_rate_samples == 1 and m.rise_start_ts is None


def test_settings_round_trip_and_bounds():
    s = ThermostatSettings.from_dict({"floor": 40, "holiday_setpoint": 2, "observe": False})
    assert (s.floor, s.holiday_setpoint, s.observe) == (22, 5, False)
    assert ThermostatSettings.from_dict(s.to_dict()) == s
    assert ThermostatMemory.from_dict({"heat_rate": 1.4, "junk": 1}).heat_rate == 1.4


def test_settings_saved_with_their_own_plan_load_without_it():
    s = ThermostatSettings.from_dict({"comfort": 21.5, "night": 18.5, "periods": [{"name": "x"}],
                                      "preheat_max_min": 120, "floor": 16.5})
    assert s.floor == 16.5 and set(s.to_dict()) == {"floor", "min_write_interval_min", "holiday_after_h",
                                                    "holiday_setpoint", "observe"}


def test_nothing_written_while_the_setpoint_is_unknown():
    """After a restart the thermostat is not read yet: no blind write."""
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    p = d.plan(E, s, reading(hm(14), setpoint=None, demand=None), m)
    assert not any(c.service == "set_value" for c in p.commands)
    assert m.last_write_ts is None
    p = d.plan(E, s, reading(hm(14), setpoint=21.0, demand=18.0), m)
    assert any(c.service == "set_value" and c.data["value"] == 18.0 for c in p.commands)


def house_reading(now_min, *, room, house, setpoint, ts=T0):
    r = reading(now_min, room=room, setpoint=setpoint, ts=ts)
    return ThermostatReading(**{**r.__dict__, "house": house})


def test_rooms_warmer_than_the_entrance_lower_the_setpoint():
    # Saturday 9:30: entrance thermostat 22.0, rooms 23.0 for 21 wanted.
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    p = d.plan(E, s, house_reading(hm(9, 30), room=22.0, house=23.0, setpoint=21.0), m)
    assert (p.wanted, p.target, p.correction) == (21.0, 20.0, -1.0)
    assert p.commands[-1].data == {"entity_id": "number.sp", "value": 20.0}


def test_cold_rooms_raise_the_setpoint_within_bounds():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    p = d.plan(E, s, house_reading(hm(9), room=21.0, house=18.0, setpoint=21.0), m)
    assert p.target == 22.5  # +1.5 at most


def test_small_gap_inside_the_dead_band_writes_nothing():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    p = d.plan(E, s, house_reading(hm(9), room=20.2, house=20.5, setpoint=21.0), m)
    assert p.commands == []


def test_no_house_temperature_keeps_the_plain_target():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    p = d.plan(E, s, house_reading(hm(9), room=20.0, house=None, setpoint=20.0), m)
    assert p.target == 21.0
    assert p.commands[-1].data["value"] == 21.0


def test_manual_setpoint_is_not_corrected():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    d.plan(E, s, house_reading(hm(9), room=21.0, house=21.0, setpoint=21.0, ts=T0), m)
    p = d.plan(E, s, house_reading(hm(9, 30), room=21.0, house=23.0, setpoint=23.0, ts=T0 + 1800), m)
    assert (p.reason, p.target, p.commands) == (MANUAL, 23.0, [])
