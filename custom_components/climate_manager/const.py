"""Constants for the Climate Manager integration."""

from __future__ import annotations

from typing import ClassVar

from homeassistant.const import Platform

DOMAIN = "climate_manager"

PLATFORMS: list[Platform] = [
    Platform.SENSOR,
    Platform.SELECT,
    Platform.BUTTON,
]

UPDATE_INTERVAL_SECONDS = 30

# === ConfigEntry data keys ===

CONF_PRESENCE_ENTITY = "presence_entity"
CONF_PRESENCE_ABSENT_STATES = "presence_absent_states"
CONF_PRESENCE_HOME_STATES = "presence_home_states"

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
CONF_ANOMALY_DELAY_MIN = "anomaly_delay_min"
CONF_ANOMALY_HEAT_GAIN_PER_HOUR = "anomaly_heat_gain_per_hour"
CONF_ANOMALY_COOL_GAIN_PER_HOUR = "anomaly_cool_gain_per_hour"
CONF_ANOMALY_NOTIFICATION_SERVICE = "anomaly_notification_service"
CONF_SEASON = "season"
CONF_PROFILE_BANKS = "profile_banks"

# === Defaults ===

DEFAULT_OVERRIDE_DUREE_MIN = 30
MIN_OVERRIDE_DUREE_MIN = 5
MAX_OVERRIDE_DUREE_MIN = 240

# Détection informative des pièces qui ne suivent pas la session. Les gains
# sont orientés (chaleur gagnée en heat, fraîcheur gagnée en cool).
DEFAULT_ANOMALY_DELAY_MIN = 60
MIN_ANOMALY_DELAY_MIN = 15
MAX_ANOMALY_DELAY_MIN = 180
DEFAULT_ANOMALY_HEAT_GAIN_PER_HOUR = 0.5
DEFAULT_ANOMALY_COOL_GAIN_PER_HOUR = 0.5

# Bornes de consigne envoyée à la clim
CLIM_MIN_SETPOINT = 18.0
CLIM_MAX_SETPOINT = 32.0

# Rate-limiting des commandes setpoint
RATE_LIMIT_SECONDS = 60
SETPOINT_NOOP_DELTA = 0.5

# Override
CONTEXT_WINDOW_SECONDS = 30
OVERRIDE_DEBOUNCE_SECONDS = 2

# Sessions
# Combien de temps la cible de coupure (target_cutoff) doit-elle être tenue
# en continu pour terminer la session.
TARGET_CUTOFF_HOLD_SECONDS = 15 * 60
# Arrêt physique si le relâchement maximal n'empêche pas une dérive franche.
SESSION_SAFETY_OVERSHOOT_C = 2.0
# Bouton "Prolonger" idempotent
EXTEND_SESSION_HOURS = 1
# Session ventilation: brassage d'air simple, sans consigne de température.
FAN_SESSION_DURATION_MIN = 45
FAN_SESSION_FAN_MODE = "4"
# Limite haute du max_end_ts d'une session (filet de sécurité côté UI)
MAX_SESSION_DURATION_HOURS = 12

# Boost
BOOST_DURATION_MIN = 15
BOOST_OFFSET = 5.0
BOOST_FAN_MODE = "4"

# Swing
DEFAULT_SWING_MODE = "windnice"
DEFAULT_HEAT_SWING_MODE = "swing"

# === Profile defaults ===

DEFAULT_MODE = "cool"
DEFAULT_SEUIL_DEMARRAGE_COOL = 27.0
DEFAULT_TARGET_COOL = 24.5
DEFAULT_SEUIL_DEMARRAGE_HEAT = 18.0
DEFAULT_TARGET_HEAT = 21.0

# Largeur de transition autour de la cible. Le froid anticipe le relâchement;
# le chauffage réduit progressivement l'effort puis relâche doucement.
TARGET_DEAD_BAND = 0.5
# En chauffage, continuer à pousser dans le dernier demi-degré, mais réduire
# progressivement l'effort à mesure que la zone approche de la cible. Une fois
# la cible atteinte, passer légèrement sous la sonde interne Daikin évite que
# son hystérésis continue à chauffer la pièce.
HEAT_APPROACH_POWER_RATIO = 0.5
HEAT_APPROACH_MIN_OFFSET_C = 0.5
HEAT_HOLD_RELEASE_OFFSET_C = 0.5

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
    FAN_ONLY = "fan_only"

    # Les profils automatiques restent cool/heat; FAN_ONLY sert aux sessions
    # manuelles de brassage d'air.
    ALL: ClassVar[list[str]] = [COOL, HEAT]
    SESSION_ALL: ClassVar[list[str]] = [COOL, HEAT, FAN_ONLY]


class ClimateSeason:
    """Banque de profils active pour une zone."""

    SUMMER = "summer"
    WINTER = "winter"

    ALL: ClassVar[list[str]] = [SUMMER, WINTER]


class Power:
    """Puissance — correction relative à la température interne Daikin.
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

# Correction °C autour du zéro relatif fourni par la sonde interne Daikin.
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
