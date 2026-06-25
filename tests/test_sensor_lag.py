"""Tests for `detect_lagging_sensors` — pure helper that flags a sensor
when its delta vs cycle baseline is significantly off the median delta of
the other sensors in the zone (porte fermée, pièce isolée)."""

from __future__ import annotations

from custom_components.climate_manager.zone import detect_lagging_sensors


def test_no_lag_when_all_drop_similar_in_cool() -> None:
    # 3 capteurs ont tous perdu ~1°C → personne ne lag
    deltas = {"a": -1.0, "b": -1.1, "c": -0.9}
    assert detect_lagging_sensors(deltas, "cool") == []


def test_lag_when_one_did_not_drop_in_cool() -> None:
    # 2 capteurs ont perdu, 1 n'a pas bougé → ce dernier lag
    deltas = {"a": -1.0, "b": -1.2, "c": 0.0}
    assert detect_lagging_sensors(deltas, "cool") == ["c"]


def test_lag_when_one_warmed_up_in_cool() -> None:
    # 2 baissent, 1 monte (porte ouverte sur l'extérieur) → flag aussi
    deltas = {"a": -1.0, "b": -1.5, "c": 0.3}
    assert detect_lagging_sensors(deltas, "cool") == ["c"]


def test_multiple_lag_in_cool() -> None:
    deltas = {"a": -1.5, "b": -1.4, "c": -0.2, "d": 0.0}
    flagged = detect_lagging_sensors(deltas, "cool")
    assert set(flagged) == {"c", "d"}


def test_no_lag_when_all_warm_similar_in_heat() -> None:
    deltas = {"a": 1.0, "b": 1.2, "c": 0.9}
    assert detect_lagging_sensors(deltas, "heat") == []


def test_lag_when_one_did_not_warm_in_heat() -> None:
    deltas = {"a": 1.0, "b": 1.1, "c": 0.0}
    assert detect_lagging_sensors(deltas, "heat") == ["c"]


def test_threshold_respected() -> None:
    # 0.4°C d'écart à la médiane → sous le seuil 0.5, pas de flag
    deltas = {"a": -1.0, "b": -1.0, "c": -0.55}
    assert detect_lagging_sensors(deltas, "cool", threshold=0.5) == []
    # 0.6°C d'écart → flag
    deltas = {"a": -1.0, "b": -1.0, "c": -0.39}
    assert detect_lagging_sensors(deltas, "cool", threshold=0.5) == ["c"]


def test_needs_at_least_two_sensors() -> None:
    # Avec un seul capteur on ne peut rien comparer → pas de flag
    assert detect_lagging_sensors({"a": 0.0}, "cool") == []
    assert detect_lagging_sensors({}, "cool") == []


def test_unknown_direction_no_flag() -> None:
    deltas = {"a": -1.0, "b": 0.0}
    assert detect_lagging_sensors(deltas, "bogus") == []


def test_median_with_even_count() -> None:
    # 4 capteurs, médiane = moyenne des 2 du milieu
    # a=-1.5, b=-1.0, c=-0.8, d=0.0 → tri: -1.5, -1.0, -0.8, 0.0 → médiane = -0.9
    # d=0.0 est à 0.9 au-dessus de la médiane → flag
    deltas = {"a": -1.5, "b": -1.0, "c": -0.8, "d": 0.0}
    assert detect_lagging_sensors(deltas, "cool") == ["d"]
