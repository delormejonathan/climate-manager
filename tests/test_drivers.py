"""Equipment drivers: same orders as before the split."""

from custom_components.climate_manager.drivers.heat_pump import HeatPumpDriver, SentMemory
from custom_components.climate_manager.drivers.relay import EntityReading, RelayDriver, RelayOrder
from custom_components.climate_manager.zone import ZoneInputs


def _inp(**kw):
    base = dict(
        now_ts=1_000.0, room_temperature=19.0, clim_internal_temperature=20.0,
        clim_current_hvac_mode="off", clim_current_setpoint=None, clim_current_fan_mode=None,
        clim_current_swing_mode=None, any_window_open=False,
    )
    base.update(kw)
    return ZoneInputs(**base)


def test_heat_pump_session_heat_pushes_relative_to_internal_sensor():
    plan = HeatPumpDriver().plan_session(
        "climate.salon", _inp(), mode="heat", target=21.0, power="normal",
        fan_intensity="normal", sent=SentMemory(),
    )
    services = [(c.service, c.data) for c in plan.commands]
    assert services[0] == ("set_hvac_mode", {"entity_id": "climate.salon", "hvac_mode": "heat"})
    assert ("set_temperature", {"entity_id": "climate.salon", "temperature": 24.0}) in services
    assert plan.setpoint_sent == 24.0 and plan.hvac_sent == "heat" and plan.fan_sent == "auto"


def test_heat_pump_rate_limit_keeps_the_same_setpoint():
    sent = SentMemory(last_command_ts=990.0, last_setpoint_sent=24.0)
    assert not HeatPumpDriver.setpoint_should_send(24.0, _inp(clim_current_setpoint=20.0), sent)
    assert HeatPumpDriver.setpoint_should_send(25.0, _inp(clim_current_setpoint=20.0), sent)


def test_heat_pump_release_turns_off_only_a_running_unit():
    d = HeatPumpDriver()
    assert d.release("climate.salon", "off") == []
    assert [c.service for c in d.release("climate.salon", "heat")] == ["turn_off"]


def test_relay_select_and_setpoint():
    calls = RelayDriver().plan(
        "select.opmode", EntityReading("off"), RelayOrder(on=True, direction="heat", setpoint=21.2),
        on_option="day", off_option="off",
        setpoint_entity="number.sp", setpoint_reading=EntityReading("19.0"),
    )
    assert [(c.service, c.data) for c in calls] == [
        ("select_option", {"entity_id": "select.opmode", "option": "day"}),
        ("set_value", {"entity_id": "number.sp", "value": 21.0}),
    ]


def test_relay_switch_off_and_nothing_when_already_off():
    d = RelayDriver()
    assert [c.service for c in d.plan("switch.b", EntityReading("on"), RelayOrder(on=False))] == ["turn_off"]
    assert d.plan("switch.b", EntityReading("off"), RelayOrder(on=False)) == []
