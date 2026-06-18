# delormej_climate

Custom_component Home Assistant pour le pilotage intelligent de plusieurs climatisations (initialement 2 Daikin), avec :

- **Zones configurables** via l'UI (1 zone = 1 clim + N capteurs T° + seuils + planning + fenêtres)
- **State machine explicite** par zone (IDLE → STARTING → RUNNING → STABILIZING → COOLDOWN)
- **Algorithme à 3 régimes** : attaque / croisière / approche + stabilisation au "pendule" pour gérer l'inertie thermique
- **Gestion de l'override manuel** via le mécanisme `context` natif HA (détecte qui a touché la clim)
- **Planning par zone** via les `schedule.*` natifs HA
- **Sécurité fenêtres** : pause de la zone si une fenêtre listée est ouverte
- **Contexte présence** : maison armée → mode plus agressif autorisé
- **Carte Lovelace** dédiée pour le contrôle et la visualisation

## État du projet

En production sur HA depuis mai 2026. Architecture stabilisée à la v0.12.0 :
- Une seule phase d'ATTAQUE pendant RUNNING (la modulation est laissée à l'inverter Daikin)
- Phase STABILISATION de ~1h après atteinte de la cible
- Cascade multi-profils par zone (schedule + présence)
- Journal des cycles persistant (10 dernières sessions par zone)

## Structure

```
delormej_climate/
├── custom_components/delormej_climate/   # le composant HA (Python)
├── lovelace/                              # la carte Lovelace custom (JS/TS)
├── docs/                                  # documentation
├── tests/                                 # tests pytest
└── .beads/                                # DAG des tâches (beads)
```

## Installation via HACS (recommandé)

1. HACS → menu ⋮ → **Custom repositories**
2. Repository : `https://github.com/delormejonathan/delormej_climate`
3. Category : **Integration**
4. **Add** → tu retrouves "Delormej Climate" dans la liste HACS → **Download**
5. Redémarre HA
6. _Paramètres → Appareils & services → Ajouter une intégration → Delormej Climate_

Les futures versions remontent automatiquement comme update disponible dans HACS — 1 clic pour installer.

La carte Lovelace est embarquée dans le composant : elle est servie automatiquement à `/delormej_climate/delormej-climate-card.js` et enregistrée comme ressource Lovelace dès que l'intégration démarre.

## Migration depuis l'automation actuelle

Une fois le composant en production stable, supprimer :

- L'automation `automation.climatisation_controleur_unique` et toutes les automations climat désactivées
- Les helpers `input_number.climatisation_*`, `input_boolean.climatisation_*`, `input_datetime.climatisation_*`, `input_select.climatisation_*`

À **conserver** :

- Les capteurs agrégés `sensor.temperature_moyenne_rdc`, `_etage`, `_moyenne` (utilisés ailleurs dans HA)
