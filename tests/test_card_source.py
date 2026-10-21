"""Regression checks for the embedded Lovelace card source."""

from __future__ import annotations

from pathlib import Path

CARD_SOURCE = (
    Path(__file__).parents[1]
    / "custom_components"
    / "climate_manager"
    / "www"
    / "climate-manager-card.js"
).read_text(encoding="utf-8")


def test_start_session_action_uses_comfort_target_for_manual_heating() -> None:
    """Absent at 18 °C must not become a manual heating session at 18 °C."""
    assert (
        'if (a === "session-start") return this._startDefaultSession();'
        in CARD_SOURCE
    )
    assert "Math.max(Number.isFinite(inheritedTarget) ? inheritedTarget : 21, 21)" in CARD_SOURCE
    start_block = CARD_SOURCE.split("_startDefaultSession() {", 1)[1].split(
        "_renderSessionSensors", 1
    )[0]
    assert "parent_profile_name" not in start_block
