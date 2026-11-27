"""Thermostat driver: one steady setpoint from time plan and presence."""

from custom_components.climate_manager.drivers.thermostat import (
    AWAY,
    DAY,
    HOLIDAY,
    MANUAL,
    NIGHT,
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


def reading(now_min, *, ts=T0, absent=False, room=20.0, setpoint=21.0, schedule_on=False,
            holiday_on=False, target=None):
    return ThermostatReading(
        now_ts=ts, now_min=now_min, absent=absent, room=room, setpoint=setpoint,
        schedule_on=schedule_on, holiday_on=holiday_on, holiday_setpoint=10.0, target_in_force=target,
    )


def live(**kw):
    return ThermostatSettings(observe=False, **kw)


def test_day_and_night():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    assert d.plan(E, s, reading(hm(14)), m).reason == DAY
    p = d.plan(E, s, reading(hm(23), room=19.0), m)
    assert (p.reason, p.wanted) == (NIGHT, 19.0)


def test_away_needs_confirmation_then_lowest_wins_at_night():
    d, s, m = ThermostatDriver(), live(), ThermostatMemory()
    p = d.plan(E, s, reading(hm(14), absent=True), m)
    assert p.reason == DAY  # not yet confirmed
    p = d.plan(E, s, reading(hm(14, 20), ts=T0 + 20 * 60, absent=True), m)
    assert (p.reason, p.wanted) == (AWAY, 18.5)
    # Absent at night: the lowest of night (19) and away (18.5).
    p = d.plan(E, s, reading(hm(23), ts=T0 + 9 * 3600, absent=True), m)
    assert (p.reason, p.wanted) == (AWAY, 18.5)
    # A night set lower than away keeps the night value.
    p = d.plan(E, live(night=18.0), reading(hm(23), ts=T0 + 9 * 3600, absent=True), m)
    assert (p.reason, p.wanted) == (NIGHT, 18.0)


def test_floor():
    d, m = ThermostatDriver(), ThermostatMemory()
    p = d.plan(E, live(night=15.0, floor=17.0), reading(hm(2), room=17.0, setpoint=17.0), m)
    assert p.wanted == 17.0


def test_day_starts_exactly_at_night_end_never_earlier():
    d, s = ThermostatDriver(), live()  # comfort 21, night ends 06:00 (morning heating start)
    # Even with a slow learnt rate and a cold room, the day setpoint waits for 06:00.
    m = ThermostatMemory(heat_rate=0.3)
    for t in (hm(3, 0), hm(4, 56), hm(5, 59)):
        p = d.plan(E, s, reading(t, room=18.0, setpoint=19.0), m)
        assert (p.reason, p.wanted) == (NIGHT, 19.0)
    p = d.plan(E, s, reading(hm(6, 0), room=18.0, setpoint=19.0), m)
    assert (p.reason, p.wanted) == (DAY, 21.0)
    # Old settings still carrying preheat_max_min load fine and ignore it.
    assert "preheat_max_min" not in ThermostatSettings.from_dict({"preheat_max_min": 120}).to_dict()


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
    assert (p.reason, p.wanted) == (STANDBY, 18.5)


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
    s = ThermostatSettings.from_dict({"comfort": 40, "night_start": "7:5", "observe": False})
    assert s.comfort == 26 and s.night_start == "07:05" and s.observe is False
    assert ThermostatSettings.from_dict(s.to_dict()) == s
    assert ThermostatMemory.from_dict({"heat_rate": 1.4, "junk": 1}).heat_rate == 1.4
