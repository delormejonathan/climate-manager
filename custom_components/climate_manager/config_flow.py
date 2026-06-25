"""Config flow + OptionsFlow.

L'OptionsFlow gère uniquement le périmètre matériel + global :
  - Ajout / édition / suppression d'une zone
  - Présence globale optionnelle (driver de l'attribut house_is_absent)

Les profils (créneaux, seuils, target, power, fan, présence par profil) sont
gérés inline dans la carte Lovelace §Profils.
"""

from __future__ import annotations

import uuid
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_CLIMATE_ENTITY,
    CONF_CONSUMPTION_SENSOR_COOL,
    CONF_CONSUMPTION_SENSOR_HEAT,
    CONF_OVERRIDE_DUREE_MIN,
    CONF_PRESENCE_ABSENT_STATES,
    CONF_PRESENCE_ENTITY,
    CONF_TEMPERATURE_SENSORS,
    CONF_WINDOW_SENSORS,
    CONF_ZONE_ID,
    CONF_ZONE_NAME,
    CONF_ZONES,
    DEFAULT_OVERRIDE_DUREE_MIN,
    DOMAIN,
    MAX_OVERRIDE_DUREE_MIN,
    MIN_OVERRIDE_DUREE_MIN,
)

PRESENCE_DOMAINS = [
    "person", "device_tracker", "binary_sensor", "input_boolean", "alarm_control_panel",
]

DEFAULT_ABSENT_STATES = ["armed_away", "not_home", "off"]
KNOWN_ABSENT_STATES = [
    "armed_away", "armed_vacation", "armed_night", "armed_home",
    "not_home", "away",
    "off", "on",
]


def _zone_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    """Schéma matériel d'une zone."""
    defaults = defaults or {}
    return vol.Schema({
        vol.Required(
            CONF_ZONE_NAME, default=defaults.get(CONF_ZONE_NAME, vol.UNDEFINED)
        ): str,
        vol.Required(
            CONF_CLIMATE_ENTITY,
            default=defaults.get(CONF_CLIMATE_ENTITY, vol.UNDEFINED),
        ): selector.EntitySelector(selector.EntitySelectorConfig(domain="climate")),
        vol.Required(
            CONF_TEMPERATURE_SENSORS,
            default=defaults.get(CONF_TEMPERATURE_SENSORS, []),
        ): selector.EntitySelector(
            selector.EntitySelectorConfig(
                domain="sensor", device_class="temperature", multiple=True
            )
        ),
        vol.Optional(
            CONF_WINDOW_SENSORS, default=defaults.get(CONF_WINDOW_SENSORS, [])
        ): selector.EntitySelector(
            selector.EntitySelectorConfig(
                domain="binary_sensor",
                device_class=["window", "opening", "door"],
                multiple=True,
            )
        ),
        vol.Optional(
            CONF_CONSUMPTION_SENSOR_COOL,
            default=defaults.get(CONF_CONSUMPTION_SENSOR_COOL, vol.UNDEFINED),
        ): selector.EntitySelector(
            selector.EntitySelectorConfig(domain="sensor", device_class="energy")
        ),
        vol.Optional(
            CONF_CONSUMPTION_SENSOR_HEAT,
            default=defaults.get(CONF_CONSUMPTION_SENSOR_HEAT, vol.UNDEFINED),
        ): selector.EntitySelector(
            selector.EntitySelectorConfig(domain="sensor", device_class="energy")
        ),
        vol.Optional(
            CONF_OVERRIDE_DUREE_MIN,
            default=defaults.get(CONF_OVERRIDE_DUREE_MIN, DEFAULT_OVERRIDE_DUREE_MIN),
        ): selector.NumberSelector(
            selector.NumberSelectorConfig(
                min=MIN_OVERRIDE_DUREE_MIN, max=MAX_OVERRIDE_DUREE_MIN, step=1,
                unit_of_measurement="min",
            )
        ),
    })


def _presence_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    defaults = defaults or {}
    return vol.Schema({
        vol.Optional(
            CONF_PRESENCE_ENTITY,
            default=defaults.get(CONF_PRESENCE_ENTITY, vol.UNDEFINED),
        ): selector.EntitySelector(
            selector.EntitySelectorConfig(domain=PRESENCE_DOMAINS)
        ),
        vol.Optional(
            CONF_PRESENCE_ABSENT_STATES,
            default=defaults.get(CONF_PRESENCE_ABSENT_STATES, DEFAULT_ABSENT_STATES),
        ): selector.SelectSelector(
            selector.SelectSelectorConfig(
                options=KNOWN_ABSENT_STATES, multiple=True, custom_value=True
            )
        ),
    })


class DelormejClimateConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 2

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is None:
            return self.async_show_form(step_id="user", data_schema=vol.Schema({}))
        return self.async_create_entry(
            title="Climate Manager",
            data={},
            options={CONF_ZONES: []},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return DelormejClimateOptionsFlow(config_entry)


class DelormejClimateOptionsFlow(OptionsFlow):
    def __init__(self, config_entry: ConfigEntry) -> None:
        self._entry = config_entry
        self._editing_zone_id: str | None = None

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        zones = self._entry.options.get(CONF_ZONES, [])
        menu = ["add_zone"]
        if zones:
            menu += ["edit_zone", "remove_zone"]
        menu.append("presence")
        return self.async_show_menu(step_id="init", menu_options=menu)

    async def async_step_presence(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is None:
            return self.async_show_form(
                step_id="presence",
                data_schema=_presence_schema(defaults=dict(self._entry.data)),
            )
        clean = {k: v for k, v in user_input.items() if v not in (None, "", [])}
        self.hass.config_entries.async_update_entry(self._entry, data=clean)
        return self.async_create_entry(title="", data=self._entry.options)

    async def async_step_add_zone(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is None:
            return self.async_show_form(step_id="add_zone", data_schema=_zone_schema())
        zone_id = uuid.uuid4().hex[:8]
        new_zone = {CONF_ZONE_ID: zone_id, **user_input}
        zones = list(self._entry.options.get(CONF_ZONES, []))
        zones.append(new_zone)
        new_options = {**self._entry.options, CONF_ZONES: zones}
        return self.async_create_entry(title="", data=new_options)

    async def async_step_edit_zone(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        zones = self._entry.options.get(CONF_ZONES, [])
        if not zones:
            return self.async_abort(reason="no_zones")
        if user_input is None:
            return self.async_show_form(
                step_id="edit_zone",
                data_schema=vol.Schema({
                    vol.Required("zone_id"): vol.In(
                        {z[CONF_ZONE_ID]: z[CONF_ZONE_NAME] for z in zones}
                    )
                }),
            )
        self._editing_zone_id = user_input["zone_id"]
        return await self.async_step_edit_zone_form()

    async def async_step_edit_zone_form(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        zones = self._entry.options.get(CONF_ZONES, [])
        zone = next((z for z in zones if z[CONF_ZONE_ID] == self._editing_zone_id), None)
        if zone is None:
            return self.async_abort(reason="unknown_zone")
        if user_input is None:
            return self.async_show_form(
                step_id="edit_zone_form", data_schema=_zone_schema(defaults=zone)
            )
        new_zone = {**zone, **user_input, CONF_ZONE_ID: zone[CONF_ZONE_ID]}
        new_zones = [
            new_zone if z[CONF_ZONE_ID] == self._editing_zone_id else z for z in zones
        ]
        new_options = {**self._entry.options, CONF_ZONES: new_zones}
        return self.async_create_entry(title="", data=new_options)

    async def async_step_remove_zone(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        zones = self._entry.options.get(CONF_ZONES, [])
        if not zones:
            return self.async_abort(reason="no_zones")
        if user_input is None:
            return self.async_show_form(
                step_id="remove_zone",
                data_schema=vol.Schema({
                    vol.Required("zone_id"): vol.In(
                        {z[CONF_ZONE_ID]: z[CONF_ZONE_NAME] for z in zones}
                    )
                }),
            )
        zid = user_input["zone_id"]
        new_zones = [z for z in zones if z[CONF_ZONE_ID] != zid]
        new_options = {**self._entry.options, CONF_ZONES: new_zones}
        return self.async_create_entry(title="", data=new_options)
