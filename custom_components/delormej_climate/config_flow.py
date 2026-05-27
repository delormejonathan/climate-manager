"""Config flow: integration-level setup + OptionsFlow for zones."""

from __future__ import annotations

import uuid
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_AGGRESSIVE_WHEN_ABSENT,
    CONF_CLIMATE_ENTITY,
    CONF_DUREE_COOLDOWN_MIN,
    CONF_DUREE_STABILISATION_MIN,
    CONF_FAN_INTENSITY,
    CONF_OVERRIDE_DUREE_MIN,
    CONF_POWER,
    CONF_PRESENCE_ABSENT_STATES,
    CONF_PRESENCE_ENTITY,
    CONF_SCHEDULE_ENTITY,
    CONF_SEUIL_DEBUT_CHAUFFAGE,
    CONF_SEUIL_DEBUT_REFROIDISSEMENT,
    CONF_SEUIL_FIN_CHAUFFAGE,
    CONF_SEUIL_FIN_REFROIDISSEMENT,
    CONF_TEMPERATURE_SENSORS,
    CONF_WINDOW_SENSORS,
    CONF_ZONE_ID,
    CONF_ZONE_NAME,
    CONF_ZONES,
    DEFAULT_DUREE_COOLDOWN_MIN,
    DEFAULT_DUREE_STABILISATION_MIN,
    DEFAULT_FAN_INTENSITY,
    DEFAULT_OVERRIDE_DUREE_MIN,
    DEFAULT_POWER,
    DEFAULT_SEUIL_DEBUT_CHAUFFAGE,
    DEFAULT_SEUIL_DEBUT_REFROIDISSEMENT,
    DEFAULT_SEUIL_FIN_CHAUFFAGE,
    DEFAULT_SEUIL_FIN_REFROIDISSEMENT,
    DOMAIN,
    MAX_DUREE_MIN,
    MAX_OVERRIDE_DUREE_MIN,
    MAX_SEUIL,
    MIN_DUREE_MIN,
    MIN_OVERRIDE_DUREE_MIN,
    MIN_SEUIL,
    FanIntensity,
    Power,
)

# States typically considered "absent" for an alarm_control_panel
DEFAULT_ABSENT_STATES = ["armed_away", "armed_vacation"]
KNOWN_ALARM_STATES = [
    "disarmed",
    "armed_home",
    "armed_away",
    "armed_night",
    "armed_vacation",
    "armed_custom_bypass",
    "pending",
    "triggered",
    "arming",
    "disarming",
]


def _integration_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    defaults = defaults or {}
    return vol.Schema(
        {
            vol.Required(
                CONF_PRESENCE_ENTITY, default=defaults.get(CONF_PRESENCE_ENTITY, vol.UNDEFINED)
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="alarm_control_panel")
            ),
            vol.Required(
                CONF_PRESENCE_ABSENT_STATES,
                default=defaults.get(CONF_PRESENCE_ABSENT_STATES, DEFAULT_ABSENT_STATES),
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=KNOWN_ALARM_STATES, multiple=True, custom_value=True
                )
            ),
        }
    )


def _zone_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    defaults = defaults or {}
    return vol.Schema(
        {
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
                CONF_SCHEDULE_ENTITY,
                default=defaults.get(CONF_SCHEDULE_ENTITY, vol.UNDEFINED),
            ): selector.EntitySelector(selector.EntitySelectorConfig(domain="schedule")),
            vol.Optional(
                CONF_WINDOW_SENSORS, default=defaults.get(CONF_WINDOW_SENSORS, [])
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(
                    domain="binary_sensor",
                    # `opening` covers Ajax window sensors (which don't use the
                    # narrower "window" device_class) as well as generic openings.
                    device_class=["window", "opening", "door"],
                    multiple=True,
                )
            ),
            vol.Required(
                CONF_SEUIL_DEBUT_CHAUFFAGE,
                default=defaults.get(
                    CONF_SEUIL_DEBUT_CHAUFFAGE, DEFAULT_SEUIL_DEBUT_CHAUFFAGE
                ),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=MIN_SEUIL, max=MAX_SEUIL, step=0.5, unit_of_measurement="°C"
                )
            ),
            vol.Required(
                CONF_SEUIL_FIN_CHAUFFAGE,
                default=defaults.get(CONF_SEUIL_FIN_CHAUFFAGE, DEFAULT_SEUIL_FIN_CHAUFFAGE),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=MIN_SEUIL, max=MAX_SEUIL, step=0.5, unit_of_measurement="°C"
                )
            ),
            vol.Required(
                CONF_SEUIL_DEBUT_REFROIDISSEMENT,
                default=defaults.get(
                    CONF_SEUIL_DEBUT_REFROIDISSEMENT, DEFAULT_SEUIL_DEBUT_REFROIDISSEMENT
                ),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=MIN_SEUIL, max=MAX_SEUIL, step=0.5, unit_of_measurement="°C"
                )
            ),
            vol.Required(
                CONF_SEUIL_FIN_REFROIDISSEMENT,
                default=defaults.get(
                    CONF_SEUIL_FIN_REFROIDISSEMENT, DEFAULT_SEUIL_FIN_REFROIDISSEMENT
                ),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=MIN_SEUIL, max=MAX_SEUIL, step=0.5, unit_of_measurement="°C"
                )
            ),
            vol.Optional(
                CONF_DUREE_STABILISATION_MIN,
                default=defaults.get(
                    CONF_DUREE_STABILISATION_MIN, DEFAULT_DUREE_STABILISATION_MIN
                ),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=MIN_DUREE_MIN, max=MAX_DUREE_MIN, step=1)
            ),
            vol.Optional(
                CONF_DUREE_COOLDOWN_MIN,
                default=defaults.get(CONF_DUREE_COOLDOWN_MIN, DEFAULT_DUREE_COOLDOWN_MIN),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(min=MIN_DUREE_MIN, max=MAX_DUREE_MIN, step=1)
            ),
            vol.Optional(
                CONF_OVERRIDE_DUREE_MIN,
                default=defaults.get(CONF_OVERRIDE_DUREE_MIN, DEFAULT_OVERRIDE_DUREE_MIN),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=MIN_OVERRIDE_DUREE_MIN, max=MAX_OVERRIDE_DUREE_MIN, step=1
                )
            ),
            vol.Optional(
                CONF_AGGRESSIVE_WHEN_ABSENT,
                default=defaults.get(CONF_AGGRESSIVE_WHEN_ABSENT, True),
            ): bool,
            vol.Optional(
                CONF_POWER,
                default=defaults.get(CONF_POWER, DEFAULT_POWER),
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=Power.ALL,
                    mode=selector.SelectSelectorMode.LIST,
                    translation_key="power",
                )
            ),
            vol.Optional(
                CONF_FAN_INTENSITY,
                default=defaults.get(CONF_FAN_INTENSITY, DEFAULT_FAN_INTENSITY),
            ): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=FanIntensity.ALL,
                    mode=selector.SelectSelectorMode.LIST,
                    translation_key="fan_intensity",
                )
            ),
        }
    )


class DelormejClimateConfigFlow(ConfigFlow, domain=DOMAIN):
    """Initial setup of the integration."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is None:
            return self.async_show_form(step_id="user", data_schema=_integration_schema())
        return self.async_create_entry(
            title="Delormej Climate",
            data=user_input,
            options={CONF_ZONES: []},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return DelormejClimateOptionsFlow(config_entry)


class DelormejClimateOptionsFlow(OptionsFlow):
    """Manage presence settings + zones via a menu."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._entry = config_entry
        self._editing_zone_id: str | None = None

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return self.async_show_menu(
            step_id="init",
            menu_options=["add_zone", "edit_zone", "remove_zone", "presence"],
        )

    # --- presence ---

    async def async_step_presence(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is None:
            return self.async_show_form(
                step_id="presence",
                data_schema=_integration_schema(defaults=dict(self._entry.data)),
            )
        self.hass.config_entries.async_update_entry(self._entry, data=user_input)
        return self.async_create_entry(title="", data=self._entry.options)

    # --- add zone ---

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

    # --- edit zone (two-step: pick, then form) ---

    async def async_step_edit_zone(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        zones = self._entry.options.get(CONF_ZONES, [])
        if not zones:
            return self.async_abort(reason="no_zones")
        if user_input is None:
            return self.async_show_form(
                step_id="edit_zone",
                data_schema=vol.Schema(
                    {
                        vol.Required("zone_id"): vol.In(
                            {z[CONF_ZONE_ID]: z[CONF_ZONE_NAME] for z in zones}
                        )
                    }
                ),
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
        new_zone = {CONF_ZONE_ID: zone[CONF_ZONE_ID], **user_input}
        new_zones = [new_zone if z[CONF_ZONE_ID] == self._editing_zone_id else z for z in zones]
        new_options = {**self._entry.options, CONF_ZONES: new_zones}
        return self.async_create_entry(title="", data=new_options)

    # --- remove zone ---

    async def async_step_remove_zone(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        zones = self._entry.options.get(CONF_ZONES, [])
        if not zones:
            return self.async_abort(reason="no_zones")
        if user_input is None:
            return self.async_show_form(
                step_id="remove_zone",
                data_schema=vol.Schema(
                    {
                        vol.Required("zone_id"): vol.In(
                            {z[CONF_ZONE_ID]: z[CONF_ZONE_NAME] for z in zones}
                        )
                    }
                ),
            )
        zid = user_input["zone_id"]
        new_zones = [z for z in zones if z[CONF_ZONE_ID] != zid]
        new_options = {**self._entry.options, CONF_ZONES: new_zones}
        return self.async_create_entry(title="", data=new_options)
