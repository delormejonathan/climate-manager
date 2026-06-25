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
    power: str = DEFAULT_POWER
    fan_intensity: str = DEFAULT_FAN_INTENSITY

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
        return cls(
            name=str(d.get("name", "Profil")),
            mode=mode,
            active_from=_hhmm(d.get("active_from")),
            active_to=_hhmm(d.get("active_to")),
            presence_entity=d.get("presence_entity") or None,
            presence_required_state=d.get("presence_required_state"),
            seuil_demarrage=float(d.get("seuil_demarrage", default_seuil)),
            target=float(d.get("target", default_target)),
            power=str(d.get("power", DEFAULT_POWER)),
            fan_intensity=str(d.get("fan_intensity", DEFAULT_FAN_INTENSITY)),
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
            "power": self.power,
            "fan_intensity": self.fan_intensity,
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
        """Avance la machine à états + émet les commandes."""
        prev_state = self.state.state

        # Mode OFF — on s'assure que la clim est éteinte.
        if self.state.mode == ZoneMode.OFF:
            cmds = self._force_off(inp)
            self._finalize_cycle_if_needed(prev_state, inp)
            return cmds

        # Boost auto-expiry
        if self.state.boost_until_ts and inp.now_ts >= self.state.boost_until_ts:
            self.state.boost_until_ts = None

        # Hard gates (window / override) ont priorité
        gate_cmds = self._maybe_handle_hard_gates(inp)
        if gate_cmds is not None:
            self._finalize_cycle_if_needed(prev_state, inp)
            return gate_cmds

        # Boost : pilotage spécifique qui ignore les seuils
        if self.state.boost_until_ts and self.state.boost_until_ts > inp.now_ts:
            cmds = self._pilot_boost(inp)
            self._finalize_cycle_if_needed(prev_state, inp)
            return cmds

        # Pas de profil actif → on coupe la clim et on reste IDLE
        if inp.active_profile is None:
            return self._stop_to_idle(inp, prev_state)

        # Profil actif différent du profil au démarrage du cycle → on coupe
        # (le nouveau profil sera ré-évalué au prochain tick, partira en IDLE
        # → RUNNING avec ses propres seuils si appropriés).
        if (
            self.state.state == ZoneState.RUNNING
            and self.state.cycle_start_profile_name is not None
            and inp.active_profile.name != self.state.cycle_start_profile_name
        ):
            return self._stop_to_idle(inp, prev_state)

        # IDLE → RUNNING ?
        if self.state.state == ZoneState.IDLE:
            if self._should_start(inp):
                self._transition(ZoneState.RUNNING, inp.now_ts)
                self.state.cycle_started_ts = inp.now_ts
                self.state.cycle_start_profile_name = inp.active_profile.name

        cmds: list[Command] = []
        if self.state.state == ZoneState.RUNNING:
            cmds = self._pilot_running(inp)
        elif self.state.state == ZoneState.IDLE:
            # IDLE : on s'assure que la clim est OFF si elle ne l'est pas déjà
            if inp.clim_current_hvac_mode != HVACMode.OFF:
                cmds = [self._cmd_turn_off()]
        return cmds

    def _stop_to_idle(self, inp: ZoneInputs, prev_state: str) -> list[Command]:
        """Coupe la clim et passe en IDLE. Termine la session courante si on
        était en RUNNING."""
        was_running = self.state.state == ZoneState.RUNNING
        if self.state.state != ZoneState.IDLE:
            self._transition(ZoneState.IDLE, inp.now_ts)
        cmds: list[Command] = []
        if inp.clim_current_hvac_mode != HVACMode.OFF:
            cmds.append(self._cmd_turn_off())
        # Si on quitte un RUNNING, on finalise la session ici (avant que les
        # champs cycle_started_ts soient effacés en idle prochain).
        if was_running:
            self._finalize_session(inp, end_reason="profile_change")
        self._finalize_cycle_if_needed(prev_state, inp)
        return cmds

    # --- décisions ---

    def _should_start(self, inp: ZoneInputs) -> bool:
        """True si on doit démarrer le cycle pour le profil actif courant."""
        if inp.room_temperature is None or inp.active_profile is None:
            return False
        p = inp.active_profile
        if p.mode == ProfileMode.COOL:
            return inp.supports_cool and inp.room_temperature >= p.seuil_demarrage
        if p.mode == ProfileMode.HEAT:
            return inp.supports_heat and inp.room_temperature <= p.seuil_demarrage
        return False

    # --- pilotage RUNNING ---

    def _pilot_running(self, inp: ZoneInputs) -> list[Command]:
        """Émet les commandes pour maintenir room ≈ target.

        Pendule simple : si on est loin de target → consigne = target ± offset
        (selon power), si on est dans la bande morte → consigne = target.
        L'inverter Daikin module entre les deux automatiquement."""
        p = inp.active_profile
        if p is None or inp.room_temperature is None:
            return []

        target_mode = HVACMode.COOL if p.mode == ProfileMode.COOL else HVACMode.HEAT

        cmds: list[Command] = []
        # Allumer la clim dans le bon mode si ce n'est pas déjà le cas
        if inp.clim_current_hvac_mode != target_mode:
            cmds.append(self._cmd_set_hvac_mode(target_mode))
            self.state.last_hvac_sent = target_mode

        # Calcul de la consigne en mode pendule
        setpoint = self._compute_pendulum_setpoint(inp, p)
        if setpoint is not None and self._setpoint_should_send(setpoint, inp):
            cmds.append(self._cmd_set_temperature(setpoint))
            self.state.last_setpoint_sent = setpoint

        # Ventilation selon le profil
        if inp.supports_fan_mode:
            target_fan = FAN_MODES.get(p.fan_intensity, FAN_MODES[DEFAULT_FAN_INTENSITY])
            if inp.clim_current_fan_mode != target_fan:
                cmds.append(self._cmd_set_fan_mode(target_fan))
                self.state.last_fan_sent = target_fan

        # Swing toujours en windnice si supporté
        if inp.supports_windnice and inp.clim_current_swing_mode != DEFAULT_SWING_MODE:
            cmds.append(self._cmd_set_swing_mode(DEFAULT_SWING_MODE))

        if cmds:
            self.state.last_command_ts = inp.now_ts
        return cmds

    def _compute_pendulum_setpoint(self, inp: ZoneInputs, p: Profile) -> float | None:
        """Pendule : consigne = target ± offset(power) si room loin, target sinon."""
        room = inp.room_temperature
        if room is None:
            return None
        target = p.target
        offset = POWER_OFFSETS.get(p.power, POWER_OFFSETS[DEFAULT_POWER])

        if p.mode == ProfileMode.COOL:
            # COOL: si room > target + bande → pousser fort (consigne = target - offset)
            #       si room ≈ target → maintenir (consigne = target)
            #       si room < target - bande → laisser tranquille (consigne = target)
            if room > target + TARGET_DEAD_BAND:
                raw = target - offset
            else:
                raw = target
        else:
            # HEAT: miroir
            if room < target - TARGET_DEAD_BAND:
                raw = target + offset
            else:
                raw = target

        # Arrondi au 0.5 Daikin puis clamp
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
            if clim_current_hvac_mode in (HVACMode.HEAT, HVACMode.COOL):
                self._transition(ZoneState.RUNNING, now_ts)
                self.state.cycle_started_ts = clim_state_last_changed_ts or now_ts
            else:
                self._transition(ZoneState.IDLE, now_ts)

    def on_external_override(self, now_ts: float, profile_active: bool) -> None:
        """Un changement d'état non tracké a été détecté sur la clim."""
        if profile_active:
            self._transition(ZoneState.MANUAL_OVERRIDE_TIMED, now_ts)
            self.state.override_until_ts = now_ts + self.config.override_duree_min * 60
        else:
            self._transition(ZoneState.MANUAL_OVERRIDE_FREE, now_ts)
            self.state.override_until_ts = None

    # --- hard gates ---

    def _maybe_handle_hard_gates(self, inp: ZoneInputs) -> list[Command] | None:
        # Fenêtre ouverte
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
                self._transition(ZoneState.IDLE, inp.now_ts)
            else:
                return []
        elif self.state.state == ZoneState.MANUAL_OVERRIDE_FREE:
            # Override libre : seul un reset_override explicite en sort.
            if inp.active_profile is not None:
                # Un profil est de nouveau actif → on reprend la main.
                self.state.override_until_ts = None
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
        Le delta kWh est calculé par le coordinator qui injecte
        `_cycle_end_kwh` via une closure (cf. Coordinator)."""
        start_ts = self.state.cycle_started_ts
        if start_ts is None:
            self.state.cycle_started_ts = None
            self.state.cycle_start_profile_name = None
            self.state.cycle_start_kwh = None
            return
        duration_min = round((inp.now_ts - start_ts) / 60, 1)
        record = {
            "start_ts": start_ts,
            "end_ts": inp.now_ts,
            "duration_min": duration_min,
            "profile_name": self.state.cycle_start_profile_name,
            "end_reason": end_reason,
            "kwh_start": self.state.cycle_start_kwh,
            # kwh_end et kwh_consumed seront patchés par le coordinator
            # quand un capteur de conso est configuré.
            "kwh_end": None,
            "kwh_consumed": None,
        }
        self.state.completed_sessions.append(record)
        if len(self.state.completed_sessions) > SESSION_HISTORY_MAX:
            self.state.completed_sessions = self.state.completed_sessions[-SESSION_HISTORY_MAX:]
        self.state.cycle_started_ts = None
        self.state.cycle_start_profile_name = None
        self.state.cycle_start_kwh = None

    def _finalize_cycle_if_needed(self, prev_state: str, inp: ZoneInputs) -> None:
        """Filet de sécurité : si on est sorti de RUNNING par un chemin qui n'a
        pas appelé _finalize_session, on le fait ici."""
        if prev_state == ZoneState.RUNNING and self.state.state != ZoneState.RUNNING:
            if self.state.cycle_started_ts is not None:
                self._finalize_session(inp, end_reason=self._end_reason_from_state())

    def _end_reason_from_state(self) -> str:
        return {
            ZoneState.IDLE: "natural_end",
            ZoneState.WINDOW_OPEN: "window_opened",
            ZoneState.MANUAL_OVERRIDE_TIMED: "user_override",
            ZoneState.MANUAL_OVERRIDE_FREE: "user_override",
        }.get(self.state.state, self.state.state)

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
