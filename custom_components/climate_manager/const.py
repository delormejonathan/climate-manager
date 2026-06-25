"""Constants for the Climate Manager integration."""

from __future__ import annotations

from typing import ClassVar

from homeassistant.const import Platform

DOMAIN = "climate_manager"

PLATFORMS: list[Platform] = [
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.SELECT,
    Platform.NUMBER,
    Platform.BUTTON,
]

UPDATE_INTERVAL_SECONDS = 30

# === ConfigEntry data keys ===

CONF_PRESENCE_ENTITY = "presence_entity"
CONF_PRESENCE_ABSENT_STATES = "presence_absent_states"

# === Zone config keys ===

CONF_ZONES = "zones"
CONF_ZONE_ID = "id"
CONF_ZONE_NAME = "name"
CONF_CLIMATE_ENTITY = "climate_entity"
CONF_TEMPERATURE_SENSORS = "temperature_sensors"
CONF_WINDOW_SENSORS = "window_sensors"
CONF_CONSUMPTION_SENSOR_COOL = "consumption_sensor_cool"
CONF_CONSUMPTION_SENSOR_HEAT = "consumption_sensor_heat"
CONF_OVERRIDE_DUREE_MIN = "override_duree_min"

# === Defaults ===

DEFAULT_OVERRIDE_DUREE_MIN = 30
MIN_OVERRIDE_DUREE_MIN = 5
MAX_OVERRIDE_DUREE_MIN = 240

# Bornes de consigne envoyée à la clim
CLIM_MIN_SETPOINT = 18.0
CLIM_MAX_SETPOINT = 32.0

# Rate-limiting des commandes setpoint
RATE_LIMIT_SECONDS = 60
SETPOINT_NOOP_DELTA = 0.5

# Override
CONTEXT_WINDOW_SECONDS = 30
OVERRIDE_DEBOUNCE_SECONDS = 2

# Sensor lag detection (porte fermée, pièce isolée)
SENSOR_LAG_MIN_DETECTION_SECONDS = 20 * 60  # attendre 20min après start avant de juger
SENSOR_LAG_THRESHOLD_C = 0.5  # écart à la médiane pour considérer qu'un capteur lag

# Boost
BOOST_DURATION_MIN = 15
BOOST_OFFSET = 5.0
BOOST_FAN_MODE = "4"

# Swing
DEFAULT_SWING_MODE = "windnice"

# === Profile defaults ===

DEFAULT_MODE = "cool"
DEFAULT_SEUIL_DEMARRAGE_COOL = 27.0
DEFAULT_TARGET_COOL = 24.5
DEFAULT_SEUIL_DEMARRAGE_HEAT = 18.0
DEFAULT_TARGET_HEAT = 21.0

# Bande morte autour de la cible — dans cette zone on coupe la pression
# (la consigne envoyée = target sans offset). Évite que le pendule envoie
# une consigne aggressive juste après avoir atteint la cible.
TARGET_DEAD_BAND = 0.5

# === Enums ===


class ZoneState:
    """États possibles d'une zone."""

    IDLE = "idle"
    RUNNING = "running"
    WINDOW_OPEN = "window_open"
    MANUAL_OVERRIDE_TIMED = "manual_override_timed"
    MANUAL_OVERRIDE_FREE = "manual_override_free"

    ALL: ClassVar[list[str]] = [
        IDLE,
        RUNNING,
        WINDOW_OPEN,
        MANUAL_OVERRIDE_TIMED,
        MANUAL_OVERRIDE_FREE,
    ]


class ZoneMode:
    """Mode global d'une zone."""

    AUTO = "auto"
    OFF = "off"
    BOOST = "boost"

    ALL: ClassVar[list[str]] = [AUTO, OFF, BOOST]


class ProfileMode:
    """Sens d'action du profil."""

    COOL = "cool"
    HEAT = "heat"

    ALL: ClassVar[list[str]] = [COOL, HEAT]


class Power:
    """Puissance — décale la consigne vs target quand on doit pousser.
    Indépendante de la ventilation."""

    DOUX = "doux"
    NORMAL = "normal"
    AGRESSIF = "agressif"

    ALL: ClassVar[list[str]] = [DOUX, NORMAL, AGRESSIF]


class FanIntensity:
    """Intensité de ventilation envoyée à la clim. Indépendante de Power."""

    DOUX = "doux"
    NORMAL = "normal"
    FORT = "fort"

    ALL: ClassVar[list[str]] = [DOUX, NORMAL, FORT]


DEFAULT_POWER = Power.NORMAL
DEFAULT_FAN_INTENSITY = FanIntensity.NORMAL

# Offset °C appliqué à la consigne pendant la phase "pousser" (room loin de target).
POWER_OFFSETS: dict[str, float] = {
    Power.DOUX: 2.0,
    Power.NORMAL: 4.0,
    Power.AGRESSIF: 7.0,
}

# fan_mode envoyé à la clim selon l'intensité choisie.
FAN_MODES: dict[str, str] = {
    FanIntensity.DOUX: "quiet",
    FanIntensity.NORMAL: "auto",
    FanIntensity.FORT: "5",
}
