# tmp/

Scratch directory for things that aren't part of the integration but that the
agent has touched on the user's running Home Assistant instance.

## `automation_backups/`

YAML snapshots of any HA automation **before** the agent patched or removed it.
Each file is a complete export of the automation as returned by the HA REST API
(`GET /api/config/automation/config/<id>`), so you can paste it back via
`POST` to the same path to roll back.

| File | Why it was changed |
|---|---|
| `1723110521973_*_ouvrir_le_volet_roulant.json` | Patched: added `not_from: [unavailable, unknown]` to the alarm-state trigger so a network outage no longer fires the trigger when the alarm reconnects to `disarmed`. |
| `1730136417541_*_allumer_les_lumieres.json` | Patched: same fix. |
| `1723109358457_armement_fermer_les_volets.json` | Patched: same fix on both `armed_away` and `armed_night` triggers. |

To restore one of these, run:
```bash
curl -sk -H "Authorization: Bearer $HASS_TOKEN" \
     -X POST -H "Content-Type: application/json" \
     "$HASS_SERVER/api/config/automation/config/<id>" \
     --data @1723110521973_*.json
```
