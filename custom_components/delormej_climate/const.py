"""Constants for the Delormej Climate integration."""

from __future__ import annotations

from typing import ClassVar

from homeassistant.const import Platform

DOMAIN = "delormej_climate"

PLATFORMS: list[Platform] = [
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.SELECT,
    Platform.NUMBER,
    Platform.BUTTON,
]

UPDATE_INTERVAL_SECONDS = 30

# ConfigEntry.data keys
CONF_PRESENCE_ENTITY = "presence_entity"
CONF_PRESENCE_ABSENT_STATES = "presence_absent_states"

# Zone config keys
CONF_ZONES = "zones"
CONF_ZONE_ID = "id"
CONF_ZONE_NAME = "name"
CONF_CLIMATE_ENTITY = "climate_entity"
CONF_TEMPERATURE_SENSORS = "temperature_sensors"
CONF_SCHEDULE_ENTITY = "schedule_entity"
CONF_WINDOW_SENSORS = "window_sensors"
CONF_SEUIL_DEBUT_CHAUFFAGE = "seuil_debut_chauffage"
CONF_SEUIL_FIN_CHAUFFAGE = "seuil_fin_chauffage"
CONF_SEUIL_DEBUT_REFROIDISSEMENT = "seuil_debut_refroidissement"
CONF_SEUIL_FIN_REFROIDISSEMENT = "seuil_fin_refroidissement"
CONF_DUREE_STABILISATION_MIN = "duree_stabilisation_min"
CONF_DUREE_COOLDOWN_MIN = "duree_cooldown_min"
CONF_OVERRIDE_DUREE_MIN = "override_duree_min"
CONF_AGGRESSIVE_WHEN_ABSENT = "aggressive_when_absent"
CONF_AGGRESSIVITY = "aggressivity"          # legacy alias
CONF_POWER = "power"
CONF_FAN_INTENSITY = "fan_intensity"

DEFAULT_AGGRESSIVITY = "normal"
DEFAULT_POWER = "normal"
DEFAULT_FAN_INTENSITY = "normal"

# Defaults
DEFAULT_SEUIL_DEBUT_CHAUFFAGE = 19.5
DEFAULT_SEUIL_FIN_CHAUFFAGE = 21.0
DEFAULT_SEUIL_DEBUT_REFROIDISSEMENT = 26.5
DEFAULT_SEUIL_FIN_REFROIDISSEMENT = 25.0
DEFAULT_DUREE_STABILISATION_MIN = 60
DEFAULT_DUREE_COOLDOWN_MIN = 10
DEFAULT_OVERRIDE_DUREE_MIN = 30

# Hard limits
MIN_SEUIL = 5.0
MAX_SEUIL = 35.0
MIN_DUREE_MIN = 0
MAX_DUREE_MIN = 240
MIN_OVERRIDE_DUREE_MIN = 5
MAX_OVERRIDE_DUREE_MIN = 240

# Algorithme — bornes consigne envoyée à la clim
CLIM_MIN_SETPOINT = 18.0
CLIM_MAX_SETPOINT = 32.0

# Algorithme — offset par régime (delta vs T°_interne_clim)
OFFSET_ATTAQUE = 5.0
OFFSET_CROISIERE = 2.0
OFFSET_APPROCHE = 1.0
OFFSET_STABILISATION = 0.0  # pendule neutre

# Seuils d'écart pour basculer entre régimes (T° pièce vs seuil_fin)
ECART_ATTAQUE_THRESHOLD = 2.0
ECART_APPROCHE_THRESHOLD = 0.5

# Rate limiting
RATE_LIMIT_SECONDS = 60
SETPOINT_NOOP_DELTA = 0.5  # ne pas réémettre si delta < 0.5°C

# Context tracker window
CONTEXT_WINDOW_SECONDS = 30

# Override debounce — Daikin emits brief temperature flaps (X→Y→X) when its
# integration polls the unit, with both events on the same tick. Without
# debounce, the first event trips on_external_override before the second can
# resolve it. 2s is enough to coalesce the flap; UX impact on a real user
# action is invisible.
OVERRIDE_DEBOUNCE_SECONDS = 2

# Mode boost
BOOST_DURATION_MIN = 15
BOOST_OFFSET = 5.0
BOOST_FAN_MODE = "4"

# Swing toujours en mode confort
DEFAULT_SWING_MODE = "windnice"


# === State machine ===

class ZoneState:
    """Valeurs possibles de l'état d'une zone."""

    IDLE = "idle"
    STARTING = "starting"
    RUNNING = "running"
    STABILIZING = "stabilizing"
    COOLDOWN = "cooldown"
    SCHEDULE_OFF = "schedule_off"
    MANUAL_OVERRIDE_TIMED = "manual_override_timed"
    MANUAL_OVERRIDE_FREE = "manual_override_free"
    WINDOW_OPEN = "window_open"

    ALL: ClassVar[list[str]] = [
        IDLE, STARTING, RUNNING, STABILIZING, COOLDOWN,
        SCHEDULE_OFF, MANUAL_OVERRIDE_TIMED, MANUAL_OVERRIDE_FREE, WINDOW_OPEN,
    ]


class Regime:
    """Régime de pilotage actif."""

    NONE = "none"
    ATTAQUE = "attaque"
    CROISIERE = "croisiere"
    APPROCHE = "approche"
    STABILISATION = "stabilisation"
    BOOST = "boost"

    ALL: ClassVar[list[str]] = [NONE, ATTAQUE, CROISIERE, APPROCHE, STABILISATION, BOOST]


class ZoneMode:
    """Mode global d'une zone (sélecteur)."""

    AUTO = "auto"
    OFF = "off"
    BOOST = "boost"

    ALL: ClassVar[list[str]] = [AUTO, OFF, BOOST]


class Power:
    """Puissance de pilotage : contrôle uniquement le décalage de consigne envoyé
    à la clim (= à quel point on demande à la clim de turbiner). Dissociée de la
    ventilation pour permettre 'puissance agressif + ventilation douce' (chambre
    enfant qui dort)."""

    DOUX = "doux"
    NORMAL = "normal"
    AGRESSIF = "agressif"
    ALL: ClassVar[list[str]] = [DOUX, NORMAL, AGRESSIF]


class FanIntensity:
    """Intensité de ventilation : contrôle uniquement le fan_mode envoyé.
    Indépendante de la Puissance."""

    DOUX = "doux"
    NORMAL = "normal"
    FORT = "fort"
    ALL: ClassVar[list[str]] = [DOUX, NORMAL, FORT]


# Backward-compat — anciennes zones avaient une seule clé `aggressivity`.
class Aggressivity:
    DOUX = "doux"
    NORMAL = "normal"
    AGRESSIF = "agressif"
    ALL: ClassVar[list[str]] = [DOUX, NORMAL, AGRESSIF]


# Offsets °C par régime, signe appliqué au moment du pilotage selon hvac_mode.
POWER_PROFILES: dict[str, dict] = {
    "doux":     {"attaque": 3.0, "croisiere": 1.0, "approche": 0.5},
    "normal":   {"attaque": 5.0, "croisiere": 2.0, "approche": 1.0},
    "agressif": {"attaque": 7.0, "croisiere": 3.0, "approche": 1.5},
}

# fan_mode par régime. Valeurs Daikin valides : auto, quiet, 1, 2, 3, 4, 5.
FAN_PROFILES: dict[str, dict] = {
    "doux":   {"attaque": "quiet", "croisiere": "quiet", "approche": "quiet"},
    "normal": {"attaque": "auto",  "croisiere": "auto",  "approche": "quiet"},
    "fort":   {"attaque": "5",     "croisiere": "4",     "approche": "auto"},
}
