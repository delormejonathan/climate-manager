"""Zone logic: state machine, decision algorithm, pilot algorithm.

A Zone is a single climate entity + its room temperature sensors + a cascade
of profiles. The state machine is intentionally minimal:

    IDLE ──(profile actif + room franchit seuil)──► RUNNING
    RUNNING ──(profil sort, fenêtre, ou utilisateur)──► IDLE / WINDOW_OPEN / OVERRIDE_*

Pendant RUNNING la clim ne s'éteint jamais : on module la consigne en mode
pendule autour de la `target` du profil actif (offset selon `power`). Daikin
gère la modulation compresseur via son inverter. Pas de phase d'attaque,
pas de stabilisation, pas de cooldown.

La Zone est pure logique — elle ne touche jamais à HA directement. Le
coordinator passe des `ZoneInputs`, récupère une liste de `Command`,
les applique.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from homeassistant.components.climate import (
    ATTR_FAN_MODE,
    ATTR_HVAC_MODE,
    ATTR_SWING_MODE,
    HVACMode,
)
from homeassistant.const import ATTR_ENTITY_ID, ATTR_TEMPERATURE

from .const import (
    BOOST_DURATION_MIN,
    BOOST_FAN_MODE,
    BOOST_OFFSET,
    CLIM_MAX_SETPOINT,
    CLIM_MIN_SETPOINT,
    DEFAULT_FAN_INTENSITY,
    DEFAULT_MODE,
    DEFAULT_OVERRIDE_DUREE_MIN,
    DEFAULT_POWER,
    DEFAULT_SEUIL_DEMARRAGE_COOL,
    DEFAULT_SEUIL_DEMARRAGE_HEAT,
    DEFAULT_SWING_MODE,
    DEFAULT_TARGET_COOL,
    DEFAULT_TARGET_HEAT,
    FAN_MODES,
    POWER_OFFSETS,
    RATE_LIMIT_SECONDS,
    SETPOINT_NOOP_DELTA,
    TARGET_CUTOFF_HOLD_SECONDS,
    TARGET_DEAD_BAND,
    ProfileMode,
    ZoneMode,
    ZoneState,
)

_LOGGER = logging.getLogger(__name__)


# === Inputs / Outputs ===


@dataclass(frozen=True)
class ZoneInputs:
    """Tout ce dont la zone a besoin pour décider l'action du tick."""

    now_ts: float
    room_temperature: float | None
    clim_internal_temperature: float | None
    clim_current_hvac_mode: str
    clim_current_setpoint: float | None
    clim_current_fan_mode: str | None
    clim_current_swing_mode: str | None
    any_window_open: bool
    supports_cool: bool = True
    supports_heat: bool = True
    supports_fan_mode: bool = True
    supports_windnice: bool = True
    clim_state_last_changed_ts: float | None = None
    active_profile: Profile | None = None


@dataclass(frozen=True)
class Command:
    """Un appel de service HA à exécuter côté coordinator."""

    domain: str
    service: str
    data: dict[str, Any]


# === Profile ===


@dataclass
class Profile:
    """Un profil = un sens (cool|heat) + un créneau d'activation + gates +
    seuils + knobs.

    Un profil est actif quand son créneau horaire et sa condition de présence
    matchent. Le coordinator prend le premier profil actif dans l'ordre de la
    cascade. Aucun profil actif → zone IDLE.
    """

    name: str
    mode: str = DEFAULT_MODE  # "cool" | "heat"
    # Créneau horaire (HH:MM, heure locale). Gère le passage à minuit quand
    # active_to <= active_from. None des deux côtés = pas de fenêtre, profil
    # toujours dans son créneau.
    active_from: str | None = None
    active_to: str | None = None
    # Condition de présence optionnelle.
    presence_entity: str | None = None
    presence_required_state: str | list[str] | None = None
    # Seuil de démarrage : on entre dans RUNNING uniquement quand room franchit
    # ce seuil dans le bon sens (cool → room >= seuil, heat → room <= seuil).
    seuil_demarrage: float = DEFAULT_SEUIL_DEMARRAGE_COOL
    # Cible à maintenir pendant RUNNING.
    target: float = DEFAULT_TARGET_COOL
    # Cible de coupure : si la pièce atteint cette T° (et la tient
    # TARGET_CUTOFF_HOLD_SECONDS), la session se termine. None = pas de coupure
    # automatique (la session tourne jusqu'à max_end_ts).
    target_cutoff: float | None = None
    power: str = DEFAULT_POWER
    fan_intensity: str = DEFAULT_FAN_INTENSITY
    # Kickstart : pendant les N premières minutes après spawn, utiliser des
    # paramètres plus agressifs que `power` / `fan_intensity`. 0 = désactivé.
    kickstart_minutes: int = 0
    kickstart_power: str | None = None  # None → utilise `power`
    kickstart_fan_intensity: str | None = None  # None → utilise `fan_intensity`

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Profile:
        def _hhmm(v: Any) -> str | None:
            if v is None or v == "":
                return None
            s = str(v).strip()
            return s or None

        mode = str(d.get("mode") or DEFAULT_MODE)
        if mode not in ProfileMode.ALL:
            mode = DEFAULT_MODE
        # Defaults dépendent du sens.
        default_seuil = (
            DEFAULT_SEUIL_DEMARRAGE_COOL if mode == ProfileMode.COOL
            else DEFAULT_SEUIL_DEMARRAGE_HEAT
        )
        default_target = (
            DEFAULT_TARGET_COOL if mode == ProfileMode.COOL
            else DEFAULT_TARGET_HEAT
        )
        cutoff_raw = d.get("target_cutoff")
        cutoff: float | None
        if cutoff_raw is None or cutoff_raw == "":
            cutoff = None
        else:
            try:
                cutoff = float(cutoff_raw)
            except (TypeError, ValueError):
                cutoff = None
        kickstart_minutes_raw = d.get("kickstart_minutes", 0)
        try:
            kickstart_minutes = int(kickstart_minutes_raw) if kickstart_minutes_raw not in (None, "") else 0
        except (TypeError, ValueError):
            kickstart_minutes = 0
        kickstart_power = d.get("kickstart_power") or None
        kickstart_fan = d.get("kickstart_fan_intensity") or None
        return cls(
            name=str(d.get("name", "Profil")),
            mode=mode,
            active_from=_hhmm(d.get("active_from")),
            active_to=_hhmm(d.get("active_to")),
            presence_entity=d.get("presence_entity") or None,
            presence_required_state=d.get("presence_required_state"),
            seuil_demarrage=float(d.get("seuil_demarrage", default_seuil)),
            target=float(d.get("target", default_target)),
            target_cutoff=cutoff,
            power=str(d.get("power", DEFAULT_POWER)),
            fan_intensity=str(d.get("fan_intensity", DEFAULT_FAN_INTENSITY)),
            kickstart_minutes=max(0, kickstart_minutes),
            kickstart_power=kickstart_power,
            kickstart_fan_intensity=kickstart_fan,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "mode": self.mode,
            "active_from": self.active_from,
            "active_to": self.active_to,
            "presence_entity": self.presence_entity,
            "presence_required_state": self.presence_required_state,
            "seuil_demarrage": self.seuil_demarrage,
            "target": self.target,
            "target_cutoff": self.target_cutoff,
            "power": self.power,
            "fan_intensity": self.fan_intensity,
            "kickstart_minutes": self.kickstart_minutes,
            "kickstart_power": self.kickstart_power,
            "kickstart_fan_intensity": self.kickstart_fan_intensity,
        }

    def time_window_contains(self, hour: int, minute: int) -> bool:
        """True quand hh:mm tombe dans [active_from, active_to). Wrap minuit si
        active_to <= active_from. Bornes manquantes ou malformées = toujours actif."""
        if not self.active_from or not self.active_to:
            return True
        try:
            fh, fm = (int(x) for x in self.active_from.split(":"))
            th, tm = (int(x) for x in self.active_to.split(":"))
        except (ValueError, AttributeError):
            return True
        now = hour * 60 + minute
        start = fh * 60 + fm
        end = th * 60 + tm
        if start == end:
            return True
        if start < end:
            return start <= now < end
        return now >= start or now < end


# === Runtime state ===


@dataclass
class ZoneRuntimeState:
    """État mutable d'une zone, persisté par le coordinator."""

    state: str = ZoneState.IDLE
    mode: str = ZoneMode.AUTO
    last_state_transition_ts: float = 0.0
    last_command_ts: float = 0.0
    last_setpoint_sent: float | None = None
    last_fan_sent: str | None = None
    last_hvac_sent: str | None = None
    override_until_ts: float | None = None
    boost_until_ts: float | None = None
    forced_direction: str | None = None  # 'cool' | 'heat' | None (force_start)
    # Profil actif au démarrage du cycle courant (pour audit).
    cycle_started_ts: float | None = None
    cycle_start_profile_name: str | None = None
    # Snapshot du compteur kWh au démarrage du cycle (None si pas de capteur).
    cycle_start_kwh: float | None = None
    # === Session params (None si pas de session active) ===
    # Tous renseignés en cohérence : soit tout None, soit tout renseigné.
    session_target: float | None = None
    session_target_cutoff: float | None = None
    session_power: str | None = None
    session_fan_intensity: str | None = None
    session_mode: str | None = None  # "cool" | "heat"
    session_max_end_ts: float | None = None
    # Kickstart actif jusqu'à ce timestamp (None = pas de kickstart en cours)
    session_kickstart_until_ts: float | None = None
    # Power/fan à appliquer une fois le kickstart terminé
    session_post_kickstart_power: str | None = None
    session_post_kickstart_fan_intensity: str | None = None
    # Quand le target_cutoff est atteint pour la première fois, on commence à
    # chronométrer. Reset si la T° remonte au-dessus du cutoff.
    session_cutoff_held_since_ts: float | None = None
    # True si la session a été démarrée manuellement (pas par la cascade).
    # Sert juste à afficher "Session manuelle" au lieu d'un nom de profil parent.
    session_manual: bool = False
    # Snapshot des températures de chaque capteur au démarrage du cycle.
    # Sert de référence pour détecter les capteurs qui ne suivent pas la
    # tendance (porte fermée). Vidé à la fin du cycle.
    cycle_baseline_temps: dict[str, float] = field(default_factory=dict)
    # Capteurs exclus du calcul de room_temperature pour le reste du cycle
    # (ils ne réagissent pas comme leurs voisins). Persiste jusqu'au prochain
    # cycle pour rester visible dans l'UI.
    flagged_sensors: list[str] = field(default_factory=list)
    # Capteurs pour lesquels une notif a déjà été émise dans le cycle courant
    # (évite le spam — un capteur flagué reste flagué jusqu'à fin de cycle).
    notified_sensors: list[str] = field(default_factory=list)
    # Historique des sessions terminées (max 20, sliding window).
    completed_sessions: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "mode": self.mode,
            "last_state_transition_ts": self.last_state_transition_ts,
            "last_command_ts": self.last_command_ts,
            "last_setpoint_sent": self.last_setpoint_sent,
            "last_fan_sent": self.last_fan_sent,
            "last_hvac_sent": self.last_hvac_sent,
            "override_until_ts": self.override_until_ts,
            "boost_until_ts": self.boost_until_ts,
            "forced_direction": self.forced_direction,
            "cycle_started_ts": self.cycle_started_ts,
            "cycle_start_profile_name": self.cycle_start_profile_name,
            "cycle_start_kwh": self.cycle_start_kwh,
            "session_target": self.session_target,
            "session_target_cutoff": self.session_target_cutoff,
            "session_power": self.session_power,
            "session_fan_intensity": self.session_fan_intensity,
            "session_mode": self.session_mode,
            "session_max_end_ts": self.session_max_end_ts,
            "session_kickstart_until_ts": self.session_kickstart_until_ts,
            "session_post_kickstart_power": self.session_post_kickstart_power,
            "session_post_kickstart_fan_intensity": self.session_post_kickstart_fan_intensity,
            "session_cutoff_held_since_ts": self.session_cutoff_held_since_ts,
            "session_manual": self.session_manual,
            "cycle_baseline_temps": dict(self.cycle_baseline_temps),
            "flagged_sensors": list(self.flagged_sensors),
            "notified_sensors": list(self.notified_sensors),
            "completed_sessions": list(self.completed_sessions),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> ZoneRuntimeState:
        if not isinstance(data, dict):
            return cls()
        state = str(data.get("state") or ZoneState.IDLE)
        if state not in ZoneState.ALL:
            state = ZoneState.IDLE
        mode = str(data.get("mode") or ZoneMode.AUTO)
        if mode not in ZoneMode.ALL:
            mode = ZoneMode.AUTO
        return cls(
            state=state,
            mode=mode,
            last_state_transition_ts=_as_float_or_zero(data.get("last_state_transition_ts")),
            last_command_ts=_as_float_or_zero(data.get("last_command_ts")),
            last_setpoint_sent=_as_optional_float(data.get("last_setpoint_sent")),
            last_fan_sent=data.get("last_fan_sent"),
            last_hvac_sent=data.get("last_hvac_sent"),
            override_until_ts=_as_optional_float(data.get("override_until_ts")),
            boost_until_ts=_as_optional_float(data.get("boost_until_ts")),
            forced_direction=data.get("forced_direction"),
            cycle_started_ts=_as_optional_float(data.get("cycle_started_ts")),
            cycle_start_profile_name=data.get("cycle_start_profile_name"),
            cycle_start_kwh=_as_optional_float(data.get("cycle_start_kwh")),
            session_target=_as_optional_float(data.get("session_target")),
            session_target_cutoff=_as_optional_float(data.get("session_target_cutoff")),
            session_power=data.get("session_power"),
            session_fan_intensity=data.get("session_fan_intensity"),
            session_mode=data.get("session_mode"),
            session_max_end_ts=_as_optional_float(data.get("session_max_end_ts")),
            session_kickstart_until_ts=_as_optional_float(
                data.get("session_kickstart_until_ts")
            ),
            session_post_kickstart_power=data.get("session_post_kickstart_power"),
            session_post_kickstart_fan_intensity=data.get(
                "session_post_kickstart_fan_intensity"
            ),
            session_cutoff_held_since_ts=_as_optional_float(
                data.get("session_cutoff_held_since_ts")
            ),
            session_manual=bool(data.get("session_manual") or False),
            cycle_baseline_temps={
                str(k): float(v)
                for k, v in (data.get("cycle_baseline_temps") or {}).items()
                if _as_optional_float(v) is not None
            },
            flagged_sensors=list(data.get("flagged_sensors") or []),
            notified_sensors=list(data.get("notified_sensors") or []),
            completed_sessions=list(data.get("completed_sessions") or []),
        )


SESSION_HISTORY_MAX = 20


def _as_optional_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_float_or_zero(value: Any) -> float:
    parsed = _as_optional_float(value)
    return parsed if parsed is not None else 0.0


def _average_temp_values(values: dict[str, float]) -> float | None:
    vals = [v for v in values.values() if isinstance(v, (int, float))]
    if not vals:
        return None
    return round(sum(vals) / len(vals), 2)


def _session_temperature_delta(
    start: float | None, current: float | None, mode: str | None
) -> float | None:
    if start is None or current is None:
        return None
    raw = current - start
    if mode == ProfileMode.COOL:
        raw = -raw
    return round(raw, 2)


# === Zone config ===


@dataclass
class ZoneConfig:
    """Static config for a zone."""

    zone_id: str
    name: str
    climate_entity: str
    temperature_sensors: list[str]
    window_sensors: list[str] = field(default_factory=list)
    # Optional energy accumulators (kWh total_increasing). Used to compute
    # per-session consumption. None → sessions are not journalised.
    consumption_sensor_cool: str | None = None
    consumption_sensor_heat: str | None = None
    override_duree_min: int = DEFAULT_OVERRIDE_DUREE_MIN
    profiles: list[Profile] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ZoneConfig:
        raw_profiles = d.get("profiles") or []
        profiles = [Profile.from_dict(p) for p in raw_profiles]
        return cls(
            zone_id=d.get("id") or str(uuid.uuid4())[:8],
            name=d["name"],
            climate_entity=d["climate_entity"],
            temperature_sensors=list(d.get("temperature_sensors", [])),
            window_sensors=list(d.get("window_sensors", [])),
            consumption_sensor_cool=d.get("consumption_sensor_cool") or None,
            consumption_sensor_heat=d.get("consumption_sensor_heat") or None,
            override_duree_min=int(d.get("override_duree_min", DEFAULT_OVERRIDE_DUREE_MIN)),
            profiles=profiles,
        )


# === Zone (core logic) ===


class Zone:
    """Machine à états pure pour une zone."""

    def __init__(self, config: ZoneConfig, state: ZoneRuntimeState | None = None) -> None:
        self.config = config
        self.state = state or ZoneRuntimeState()

    # --- entrée publique ---

    def tick(self, inp: ZoneInputs) -> list[Command]:
        """Avance la machine à états + émet les commandes.

        Modèle session :
        - RUNNING = une session active, ses paramètres sont **figés** et ne
          dépendent plus du profil de la cascade (qui peut changer librement
          sans impact).
        - La session se termine sur : max_end_ts atteinte, target_cutoff tenu
          TARGET_CUTOFF_HOLD_SECONDS, fenêtre ouverte, mode OFF, override
          utilisateur, ou annulation explicite.
        - Hors session (IDLE), la cascade peut spawner une nouvelle session si
          un profil match + room franchit son seuil.
        """
        # Garde-fou migration v0.21→v0.22 : si on est en RUNNING mais sans
        # paramètres de session (état pré-v0.22 restauré du disque), on
        # réinitialise proprement pour laisser la cascade re-spawner.
        if (
            self.state.state == ZoneState.RUNNING
            and self.state.session_target is None
        ):
            self._clear_session_fields()
            self._transition(ZoneState.IDLE, inp.now_ts)

        # Mode OFF — on s'assure que la clim est éteinte.
        if self.state.mode == ZoneMode.OFF:
            cmds = self._force_off(inp)
            return cmds

        # Boost auto-expiry (mécanique legacy, sera supplantée par les sessions)
        if self.state.boost_until_ts and inp.now_ts >= self.state.boost_until_ts:
            self.state.boost_until_ts = None

        # Hard gates (window / override) ont priorité
        gate_cmds = self._maybe_handle_hard_gates(inp)
        if gate_cmds is not None:
            return gate_cmds

        # Boost legacy
        if self.state.boost_until_ts and self.state.boost_until_ts > inp.now_ts:
            return self._pilot_boost(inp)

        # === Session active ? (state == RUNNING) ===
        if self.state.state == ZoneState.RUNNING:
            # Conditions de fin de session
            end_reason = self._check_session_end(inp)
            if end_reason is not None:
                return self._end_session(inp, end_reason)
            # Kickstart : bascule sur les paramètres réguliers une fois expiré
            self._maybe_transition_kickstart(inp)
            # Pilote avec les paramètres de la session
            return self._pilot_session(inp)

        # === IDLE — cascade peut spawner une session ===
        if inp.active_profile is None:
            # Pas de profil actif et pas de session → rien à faire
            if inp.clim_current_hvac_mode != HVACMode.OFF:
                return [self._cmd_turn_off()]
            return []

        if self._should_start_for_profile(inp.active_profile, inp):
            self._spawn_session(inp, inp.active_profile, manual=False)
            return self._pilot_session(inp)

        # IDLE sans démarrage : on s'assure que la clim est OFF
        if inp.clim_current_hvac_mode != HVACMode.OFF:
            return [self._cmd_turn_off()]
        return []

    # --- Lifecycle session ---

    def _spawn_session(self, inp: ZoneInputs, profile: Profile, *, manual: bool) -> None:
        """Crée une session héritée d'un profil (ou manuelle) et passe en RUNNING."""
        # Snapshot params du profil
        target = profile.target
        target_cutoff = profile.target_cutoff
        post_kick_power = profile.power
        post_kick_fan = profile.fan_intensity
        mode = profile.mode
        # Kickstart
        kickstart_until_ts: float | None = None
        cur_power = post_kick_power
        cur_fan = post_kick_fan
        if profile.kickstart_minutes > 0:
            kickstart_until_ts = inp.now_ts + profile.kickstart_minutes * 60
            cur_power = profile.kickstart_power or post_kick_power
            cur_fan = profile.kickstart_fan_intensity or post_kick_fan
        # Plage max : on prend la fin du créneau du profil s'il y en a une
        max_end_ts = self._default_max_end_ts(inp.now_ts, profile)

        self._transition(ZoneState.RUNNING, inp.now_ts)
        self.state.cycle_started_ts = inp.now_ts
        self.state.cycle_start_profile_name = profile.name
        self.state.session_target = target
        self.state.session_target_cutoff = target_cutoff
        self.state.session_power = cur_power
        self.state.session_fan_intensity = cur_fan
        self.state.session_mode = mode
        self.state.session_max_end_ts = max_end_ts
        self.state.session_kickstart_until_ts = kickstart_until_ts
        self.state.session_post_kickstart_power = post_kick_power
        self.state.session_post_kickstart_fan_intensity = post_kick_fan
        self.state.session_cutoff_held_since_ts = None
        self.state.session_manual = manual

    def _default_max_end_ts(self, now_ts: float, profile: Profile) -> float:
        """Calcule un max_end_ts par défaut à partir du créneau actif du profil.
        Si pas de créneau, fallback à now + 4h."""
        if not profile.active_to:
            return now_ts + 4 * 3600
        try:
            th, tm = (int(x) for x in profile.active_to.split(":"))
        except (ValueError, AttributeError):
            return now_ts + 4 * 3600
        import datetime as _dt
        now = _dt.datetime.fromtimestamp(now_ts, tz=_dt.UTC).astimezone()
        end_today = now.replace(hour=th, minute=tm, second=0, microsecond=0)
        if end_today <= now:
            end_today += _dt.timedelta(days=1)
        return end_today.timestamp()

    def _end_session(self, inp: ZoneInputs, reason: str) -> list[Command]:
        """Termine la session et passe en IDLE."""
        self._finalize_session(inp, end_reason=reason)
        if self.state.state != ZoneState.IDLE:
            self._transition(ZoneState.IDLE, inp.now_ts)
        if inp.clim_current_hvac_mode != HVACMode.OFF:
            return [self._cmd_turn_off()]
        return []

    def _check_session_end(self, inp: ZoneInputs) -> str | None:
        """Renvoie la raison de fin si la session doit se terminer ce tick."""
        # 1. max_end_ts
        if (
            self.state.session_max_end_ts is not None
            and inp.now_ts >= self.state.session_max_end_ts
        ):
            return "max_end_reached"
        # 2. target_cutoff (si défini)
        cutoff = self.state.session_target_cutoff
        if cutoff is not None and inp.room_temperature is not None:
            mode = self.state.session_mode
            met = (
                (mode == ProfileMode.COOL and inp.room_temperature <= cutoff)
                or (mode == ProfileMode.HEAT and inp.room_temperature >= cutoff)
            )
            if met:
                if self.state.session_cutoff_held_since_ts is None:
                    self.state.session_cutoff_held_since_ts = inp.now_ts
                elif (inp.now_ts - self.state.session_cutoff_held_since_ts
                      >= TARGET_CUTOFF_HOLD_SECONDS):
                    return "target_cutoff_reached"
            else:
                # T° remontée → reset du compteur
                self.state.session_cutoff_held_since_ts = None
        return None

    def _maybe_transition_kickstart(self, inp: ZoneInputs) -> None:
        """Bascule kickstart → steady quand l'horloge du kickstart expire."""
        kick_until = self.state.session_kickstart_until_ts
        if kick_until is None:
            return
        if inp.now_ts < kick_until:
            return
        # Expiré : revert aux valeurs post-kickstart
        if self.state.session_post_kickstart_power is not None:
            self.state.session_power = self.state.session_post_kickstart_power
        if self.state.session_post_kickstart_fan_intensity is not None:
            self.state.session_fan_intensity = self.state.session_post_kickstart_fan_intensity
        self.state.session_kickstart_until_ts = None

    # --- API session (appelée par le coordinator pour services manuels) ---

    def start_manual_session(
        self,
        now_ts: float,
        *,
        mode: str,
        target: float,
        max_end_ts: float,
        power: str = DEFAULT_POWER,
        fan_intensity: str = DEFAULT_FAN_INTENSITY,
        target_cutoff: float | None = None,
        parent_profile_name: str | None = None,
    ) -> None:
        """Démarre une session manuelle (peut être appelée même si IDLE sans
        profil actif)."""
        if mode not in ProfileMode.ALL:
            return
        self._transition(ZoneState.RUNNING, now_ts)
        self.state.cycle_started_ts = now_ts
        self.state.cycle_start_profile_name = parent_profile_name or "Manuelle"
        self.state.session_target = target
        self.state.session_target_cutoff = target_cutoff
        self.state.session_power = power
        self.state.session_fan_intensity = fan_intensity
        self.state.session_mode = mode
        self.state.session_max_end_ts = max_end_ts
        self.state.session_kickstart_until_ts = None
        self.state.session_post_kickstart_power = None
        self.state.session_post_kickstart_fan_intensity = None
        self.state.session_cutoff_held_since_ts = None
        self.state.session_manual = True

    def update_active_session(
        self,
        *,
        target: float | None = None,
        target_cutoff: float | None | type(...) = ...,
        power: str | None = None,
        fan_intensity: str | None = None,
        max_end_ts: float | None = None,
    ) -> bool:
        """Modifie les paramètres de la session en cours. Renvoie False si pas
        de session active. `target_cutoff=None` explicite efface le cutoff ;
        pour ne pas toucher au champ, ne pas passer l'argument."""
        if self.state.state != ZoneState.RUNNING:
            return False
        if target is not None:
            self.state.session_target = target
        if target_cutoff is not ...:
            self.state.session_target_cutoff = target_cutoff
            self.state.session_cutoff_held_since_ts = None  # reset hold counter
        if power is not None:
            self.state.session_power = power
            # User a changé power manuellement → annule la transition kickstart
            self.state.session_kickstart_until_ts = None
        if fan_intensity is not None:
            self.state.session_fan_intensity = fan_intensity
            self.state.session_kickstart_until_ts = None
        if max_end_ts is not None:
            self.state.session_max_end_ts = max_end_ts

        return True

    def extend_active_session(self, seconds: float) -> bool:
        """Idempotent : ajoute `seconds` au max_end_ts. Si pas de max_end_ts,
        prend now + seconds (mais c'est inhabituel). Renvoie False sans session."""
        if self.state.state != ZoneState.RUNNING:
            return False
        cur = self.state.session_max_end_ts or utc_now_ts()
        self.state.session_max_end_ts = cur + seconds
        return True

    def cancel_active_session(self, now_ts: float) -> list[Command]:
        """Annule la session en cours."""
        if self.state.state != ZoneState.RUNNING:
            return []
        return self._end_session(
            ZoneInputs(  # synthétique : on passe juste now_ts + hvac courant
                now_ts=now_ts,
                room_temperature=None,
                clim_internal_temperature=None,
                clim_current_hvac_mode=HVACMode.COOL,  # forcera turn_off
                clim_current_setpoint=None,
                clim_current_fan_mode=None,
                clim_current_swing_mode=None,
                any_window_open=False,
            ),
            "user_canceled",
        )

    # --- décisions ---

    def _should_start_for_profile(self, p: Profile, inp: ZoneInputs) -> bool:
        """True si on doit démarrer une session pour ce profil."""
        if inp.room_temperature is None:
            return False
        if p.mode == ProfileMode.COOL:
            return inp.supports_cool and inp.room_temperature >= p.seuil_demarrage
        if p.mode == ProfileMode.HEAT:
            return inp.supports_heat and inp.room_temperature <= p.seuil_demarrage
        return False

    # --- pilotage session ---

    def _pilot_session(self, inp: ZoneInputs) -> list[Command]:
        """Émet les commandes selon les paramètres de la session active.

        La session est self-contained : on ne lit plus du tout active_profile
        pour décider quoi envoyer à la clim — uniquement les session_* fields."""
        target = self.state.session_target
        mode = self.state.session_mode
        if target is None or mode is None or inp.room_temperature is None:
            return []

        target_mode = HVACMode.COOL if mode == ProfileMode.COOL else HVACMode.HEAT
        power = self.state.session_power or DEFAULT_POWER
        fan_intensity = self.state.session_fan_intensity or DEFAULT_FAN_INTENSITY

        cmds: list[Command] = []
        if inp.clim_current_hvac_mode != target_mode:
            cmds.append(self._cmd_set_hvac_mode(target_mode))
            self.state.last_hvac_sent = target_mode

        setpoint = self._compute_pendulum_setpoint(inp.room_temperature, target, power, mode)
        if setpoint is not None and self._setpoint_should_send(setpoint, inp):
            cmds.append(self._cmd_set_temperature(setpoint))
            self.state.last_setpoint_sent = setpoint

        if inp.supports_fan_mode:
            target_fan = FAN_MODES.get(fan_intensity, FAN_MODES[DEFAULT_FAN_INTENSITY])
            if inp.clim_current_fan_mode != target_fan:
                cmds.append(self._cmd_set_fan_mode(target_fan))
                self.state.last_fan_sent = target_fan

        if inp.supports_windnice and inp.clim_current_swing_mode != DEFAULT_SWING_MODE:
            cmds.append(self._cmd_set_swing_mode(DEFAULT_SWING_MODE))

        if cmds:
            self.state.last_command_ts = inp.now_ts
        return cmds

    def _compute_pendulum_setpoint(
        self, room: float, target: float, power: str, mode: str
    ) -> float | None:
        """Pendule pur : consigne = target ± offset(power) si room loin, target sinon."""
        offset = POWER_OFFSETS.get(power, POWER_OFFSETS[DEFAULT_POWER])
        if mode == ProfileMode.COOL:
            raw = target - offset if room > target + TARGET_DEAD_BAND else target
        else:
            raw = target + offset if room < target - TARGET_DEAD_BAND else target
        rounded = round(raw * 2) / 2
        return max(CLIM_MIN_SETPOINT, min(CLIM_MAX_SETPOINT, rounded))

    def _setpoint_should_send(self, setpoint: float, inp: ZoneInputs) -> bool:
        """Rate-limit : pas de réémission si trop proche du courant ou trop tôt."""
        if (
            inp.clim_current_setpoint is not None
            and abs(setpoint - inp.clim_current_setpoint) < SETPOINT_NOOP_DELTA
        ):
            return False
        if (
            self.state.last_command_ts
            and (inp.now_ts - self.state.last_command_ts) < RATE_LIMIT_SECONDS
            and self.state.last_setpoint_sent is not None
            and abs(setpoint - self.state.last_setpoint_sent) < SETPOINT_NOOP_DELTA
        ):
            return False
        return True

    # --- pilotage boost ---

    def _pilot_boost(self, inp: ZoneInputs) -> list[Command]:
        if inp.room_temperature is None:
            return []
        target_mode = self._desired_hvac_mode(inp)
        if target_mode is None:
            return []
        if self.state.state != ZoneState.RUNNING:
            self._transition(ZoneState.RUNNING, inp.now_ts)
            if self.state.cycle_started_ts is None:
                self.state.cycle_started_ts = inp.now_ts
                self.state.cycle_start_profile_name = (
                    inp.active_profile.name if inp.active_profile else "Boost"
                )
        cmds: list[Command] = []
        if inp.clim_current_hvac_mode != target_mode:
            cmds.append(self._cmd_set_hvac_mode(target_mode))
        setpoint = self._setpoint_for_boost(inp, target_mode)
        if setpoint is not None and self._setpoint_should_send(setpoint, inp):
            cmds.append(self._cmd_set_temperature(setpoint))
            self.state.last_setpoint_sent = setpoint
        if inp.supports_fan_mode and inp.clim_current_fan_mode != BOOST_FAN_MODE:
            cmds.append(self._cmd_set_fan_mode(BOOST_FAN_MODE))
            self.state.last_fan_sent = BOOST_FAN_MODE
        if inp.supports_windnice and inp.clim_current_swing_mode != "swing":
            cmds.append(self._cmd_set_swing_mode("swing"))
        if cmds:
            self.state.last_command_ts = inp.now_ts
        return cmds

    def _setpoint_for_boost(self, inp: ZoneInputs, target_mode: str) -> float | None:
        if inp.clim_internal_temperature is None:
            return None
        signed = BOOST_OFFSET if target_mode == HVACMode.HEAT else -BOOST_OFFSET
        raw = inp.clim_internal_temperature + signed
        rounded = round(raw * 2) / 2
        return max(CLIM_MIN_SETPOINT, min(CLIM_MAX_SETPOINT, rounded))

    def _desired_hvac_mode(self, inp: ZoneInputs) -> str | None:
        if self.state.forced_direction in (HVACMode.COOL, HVACMode.HEAT):
            return self.state.forced_direction
        if inp.active_profile is not None:
            return (
                HVACMode.COOL if inp.active_profile.mode == ProfileMode.COOL
                else HVACMode.HEAT
            )
        if inp.room_temperature is None:
            return None
        # Sans profil ni direction forcée : on devine via la temp.
        if inp.supports_cool and inp.room_temperature >= DEFAULT_SEUIL_DEMARRAGE_COOL:
            return HVACMode.COOL
        if inp.supports_heat and inp.room_temperature <= DEFAULT_SEUIL_DEMARRAGE_HEAT:
            return HVACMode.HEAT
        return None

    # --- triggers externes ---

    def set_mode(self, mode: str, now_ts: float) -> None:
        if mode not in ZoneMode.ALL:
            return
        self.state.mode = mode
        if mode == ZoneMode.BOOST:
            self.state.boost_until_ts = now_ts + BOOST_DURATION_MIN * 60
        elif mode == ZoneMode.AUTO:
            self.state.boost_until_ts = None

    def trigger_boost(self, now_ts: float, direction: str | None = None) -> None:
        self.state.boost_until_ts = now_ts + BOOST_DURATION_MIN * 60
        if direction in (HVACMode.COOL, HVACMode.HEAT):
            self.state.forced_direction = direction
            if self.state.state in (ZoneState.IDLE, ZoneState.WINDOW_OPEN):
                self._transition(ZoneState.RUNNING, now_ts)

    def force_start(self, direction: str, now_ts: float, *, supports: dict | None = None) -> None:
        if direction not in (HVACMode.COOL, HVACMode.HEAT):
            return
        if supports is not None:
            if direction == HVACMode.COOL and not supports.get("cool", True):
                return
            if direction == HVACMode.HEAT and not supports.get("heat", True):
                return
        if self.state.state not in (ZoneState.IDLE, ZoneState.WINDOW_OPEN):
            return
        self.state.forced_direction = direction
        self._transition(ZoneState.RUNNING, now_ts)
        self.state.cycle_started_ts = now_ts

    def reset_override(
        self,
        now_ts: float,
        clim_current_hvac_mode: str = "off",
        clim_state_last_changed_ts: float | None = None,
    ) -> None:
        """Sortir d'un override manuel et reprendre le pilotage auto."""
        self.state.override_until_ts = None
        if self.state.state in (ZoneState.MANUAL_OVERRIDE_TIMED, ZoneState.MANUAL_OVERRIDE_FREE):
            if self._has_suspended_session() and clim_current_hvac_mode in (HVACMode.HEAT, HVACMode.COOL):
                # Reprise explicite: on réactive la session qui était suspendue
                # par l'override, sans la re-créer ni perdre son historique.
                self._transition(ZoneState.RUNNING, now_ts)
            elif clim_current_hvac_mode in (HVACMode.HEAT, HVACMode.COOL):
                # Compat legacy: override créé hors session, on adopte l'état
                # courant pour laisser le prochain tick décider. Sans champs de
                # session, le garde-fou RUNNING→IDLE s'appliquera.
                self._transition(ZoneState.RUNNING, now_ts)
                self.state.cycle_started_ts = clim_state_last_changed_ts or now_ts
            else:
                if self._has_suspended_session():
                    self._finalize_session(
                        ZoneInputs(
                            now_ts=now_ts,
                            room_temperature=None,
                            clim_internal_temperature=None,
                            clim_current_hvac_mode=HVACMode.OFF,
                            clim_current_setpoint=None,
                            clim_current_fan_mode=None,
                            clim_current_swing_mode=None,
                            any_window_open=False,
                        ),
                        end_reason="user_canceled",
                    )
                self._transition(ZoneState.IDLE, now_ts)

    def on_external_override(self, now_ts: float, profile_active: bool) -> None:
        """Un changement d'état non tracké a été détecté sur la clim.

        Un override manuel temporaire suspend la session en cours au lieu de la
        clôturer: à l'expiration (ou via « reprendre auto »), la session reprend
        avec ses paramètres figés. Si l'utilisateur coupe vraiment la clim, on
        clôturera à la reprise/expiration comme annulation explicite.
        """
        if profile_active:
            self._transition(ZoneState.MANUAL_OVERRIDE_TIMED, now_ts)
            self.state.override_until_ts = now_ts + self.config.override_duree_min * 60
        else:
            self._transition(ZoneState.MANUAL_OVERRIDE_FREE, now_ts)
            self.state.override_until_ts = None

    def _adopt_external_climate_session(self, inp: ZoneInputs) -> None:
        """Transforme un allumage manuel externe en session manuelle.

        Cas typique: Siri/HomeKit allume la clim juste avant le début d'un
        profil. L'entrée en profil ne doit pas couper cette demande utilisateur;
        on l'adopte comme session manuelle, puis le pilotage normal de session
        prend le relais.
        """
        profile = inp.active_profile
        if profile is None:
            return
        mode = _profile_mode_from_hvac(inp.clim_current_hvac_mode) or profile.mode
        if mode not in ProfileMode.ALL:
            return
        target = inp.clim_current_setpoint if inp.clim_current_setpoint is not None else profile.target
        self.start_manual_session(
            inp.now_ts,
            mode=mode,
            target=target,
            max_end_ts=self._default_max_end_ts(inp.now_ts, profile),
            power=profile.power,
            fan_intensity=profile.fan_intensity,
            target_cutoff=profile.target_cutoff,
            parent_profile_name=profile.name,
        )

    def _has_suspended_session(self) -> bool:
        """True when a manual override is temporarily holding a session open."""
        return (
            self.state.cycle_started_ts is not None
            and self.state.session_target is not None
            and self.state.session_mode is not None
        )

    # --- hard gates ---

    def _maybe_handle_hard_gates(self, inp: ZoneInputs) -> list[Command] | None:
        # Fenêtre ouverte → fin de session immédiate
        if inp.any_window_open:
            if self.state.state == ZoneState.RUNNING:
                self._finalize_session(inp, end_reason="window_opened")
            if self.state.state != ZoneState.WINDOW_OPEN:
                self._transition(ZoneState.WINDOW_OPEN, inp.now_ts)
                if inp.clim_current_hvac_mode != HVACMode.OFF:
                    return [self._cmd_turn_off()]
            return []

        # Override manuel
        if self.state.state == ZoneState.MANUAL_OVERRIDE_TIMED:
            if (
                self.state.override_until_ts is not None
                and inp.now_ts >= self.state.override_until_ts
            ):
                self.state.override_until_ts = None
                if self._has_suspended_session() and inp.clim_current_hvac_mode in (HVACMode.HEAT, HVACMode.COOL):
                    self._transition(ZoneState.RUNNING, inp.now_ts)
                else:
                    if self._has_suspended_session():
                        self._finalize_session(inp, end_reason="user_canceled")
                    self._transition(ZoneState.IDLE, inp.now_ts)
            else:
                return []
        elif self.state.state == ZoneState.MANUAL_OVERRIDE_FREE:
            if inp.active_profile is not None:
                self.state.override_until_ts = None
                if self._has_suspended_session() and _hvac_is_active_for_session(inp.clim_current_hvac_mode):
                    self._transition(ZoneState.RUNNING, inp.now_ts)
                elif _hvac_is_active_for_session(inp.clim_current_hvac_mode):
                    self._adopt_external_climate_session(inp)
                else:
                    self._transition(ZoneState.IDLE, inp.now_ts)
            else:
                return []

        # Sortie de WINDOW_OPEN si toutes les fenêtres sont fermées
        if self.state.state == ZoneState.WINDOW_OPEN:
            self._transition(ZoneState.IDLE, inp.now_ts)

        return None

    # --- sessions ---

    def _finalize_session(self, inp: ZoneInputs, *, end_reason: str) -> None:
        """Clôt la session courante et l'append à completed_sessions.
        kWh_end / kwh_consumed sont patchés par le coordinator."""
        start_ts = self.state.cycle_started_ts
        if start_ts is None:
            self._clear_session_fields()
            return
        duration_min = round((inp.now_ts - start_ts) / 60, 1)
        start_temperature = _average_temp_values(self.state.cycle_baseline_temps)
        delta_temperature = _session_temperature_delta(
            start_temperature, inp.room_temperature, self.state.session_mode
        )
        record = {
            "start_ts": start_ts,
            "end_ts": inp.now_ts,
            "duration_min": duration_min,
            "profile_name": self.state.cycle_start_profile_name,
            "session_manual": self.state.session_manual,
            "session_target": self.state.session_target,
            "session_target_cutoff": self.state.session_target_cutoff,
            "session_power": self.state.session_power,
            "session_fan_intensity": self.state.session_fan_intensity,
            "session_mode": self.state.session_mode,
            "start_temperature": start_temperature,
            "end_temperature": inp.room_temperature,
            "delta_temperature": delta_temperature,
            "sensor_start_temperatures": dict(self.state.cycle_baseline_temps),
            "end_reason": end_reason,
            "kwh_start": self.state.cycle_start_kwh,
            "kwh_end": None,
            "kwh_consumed": None,
        }
        self.state.completed_sessions.append(record)
        if len(self.state.completed_sessions) > SESSION_HISTORY_MAX:
            self.state.completed_sessions = self.state.completed_sessions[-SESSION_HISTORY_MAX:]
        self._clear_session_fields()

    def _clear_session_fields(self) -> None:
        self.state.cycle_started_ts = None
        self.state.cycle_start_profile_name = None
        self.state.cycle_start_kwh = None
        self.state.session_target = None
        self.state.session_target_cutoff = None
        self.state.session_power = None
        self.state.session_fan_intensity = None
        self.state.session_mode = None
        self.state.session_max_end_ts = None
        self.state.session_kickstart_until_ts = None
        self.state.session_post_kickstart_power = None
        self.state.session_post_kickstart_fan_intensity = None
        self.state.session_cutoff_held_since_ts = None
        self.state.session_manual = False
        self.state.cycle_baseline_temps = {}

    # --- helpers ---

    def _force_off(self, inp: ZoneInputs) -> list[Command]:
        prev_running = self.state.state == ZoneState.RUNNING
        if self.state.state != ZoneState.IDLE:
            self._transition(ZoneState.IDLE, inp.now_ts)
        if prev_running:
            self._finalize_session(inp, end_reason="mode_off")
        if inp.clim_current_hvac_mode != HVACMode.OFF:
            return [self._cmd_turn_off()]
        return []

    def _transition(self, new_state: str, now_ts: float) -> None:
        if new_state == self.state.state:
            return
        _LOGGER.debug(
            "Zone %s: %s → %s", self.config.zone_id, self.state.state, new_state
        )
        self.state.state = new_state
        self.state.last_state_transition_ts = now_ts
        if new_state != ZoneState.RUNNING:
            self.state.forced_direction = None

    # --- command factory ---

    def _cmd_turn_off(self) -> Command:
        return Command(
            domain="climate",
            service="turn_off",
            data={ATTR_ENTITY_ID: self.config.climate_entity},
        )

    def _cmd_set_hvac_mode(self, mode: str) -> Command:
        return Command(
            domain="climate",
            service="set_hvac_mode",
            data={ATTR_ENTITY_ID: self.config.climate_entity, ATTR_HVAC_MODE: mode},
        )

    def _cmd_set_temperature(self, temp: float) -> Command:
        return Command(
            domain="climate",
            service="set_temperature",
            data={ATTR_ENTITY_ID: self.config.climate_entity, ATTR_TEMPERATURE: temp},
        )

    def _cmd_set_fan_mode(self, mode: str) -> Command:
        return Command(
            domain="climate",
            service="set_fan_mode",
            data={ATTR_ENTITY_ID: self.config.climate_entity, ATTR_FAN_MODE: mode},
        )

    def _cmd_set_swing_mode(self, mode: str) -> Command:
        return Command(
            domain="climate",
            service="set_swing_mode",
            data={ATTR_ENTITY_ID: self.config.climate_entity, ATTR_SWING_MODE: mode},
        )


def utc_now_ts() -> float:
    return time.time()


def _hvac_is_active_for_session(hvac_mode: str) -> bool:
    return hvac_mode in (HVACMode.HEAT, HVACMode.COOL, "heat_cool")


def _profile_mode_from_hvac(hvac_mode: str) -> str | None:
    if hvac_mode == HVACMode.COOL:
        return ProfileMode.COOL
    if hvac_mode == HVACMode.HEAT:
        return ProfileMode.HEAT
    return None


def detect_lagging_sensors(
    deltas: dict[str, float],
    direction: str,
    threshold: float = 0.5,
) -> list[str]:
    """Renvoie les ids de capteurs qui "ne suivent pas" la médiane des autres.

    Comparatif inter-capteurs : on calcule la médiane des deltas sur la fenêtre
    courante. Un capteur "lag" si son delta est trop loin de la médiane dans le
    sens contraire à la direction (en cool, son delta est moins négatif ; en
    heat, moins positif).

    Args:
        deltas: dict {entity_id: delta °C} (current - baseline) pour les
                capteurs non encore flagués.
        direction: "cool" | "heat".
        threshold: écart minimal à la médiane (°C) pour flag.

    Need au moins 2 capteurs pour qu'une comparaison ait du sens.
    """
    if len(deltas) < 2 or direction not in ("cool", "heat"):
        return []
    sorted_d = sorted(deltas.values())
    n = len(sorted_d)
    median = (
        sorted_d[n // 2] if n % 2
        else (sorted_d[n // 2 - 1] + sorted_d[n // 2]) / 2
    )
    lagging: list[str] = []
    for eid, d in deltas.items():
        if direction == "cool" and d - median >= threshold:
            lagging.append(eid)
        elif direction == "heat" and median - d >= threshold:
            lagging.append(eid)
    return lagging
