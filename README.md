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

🚧 En cours de développement. Voir [`docs/architecture.md`](docs/architecture.md) pour le design et [`bd ready`](https://github.com/gastownhall/beads) pour les tâches en cours.

## Structure

```
delormej_climate/
├── custom_components/delormej_climate/   # le composant HA (Python)
├── lovelace/                              # la carte Lovelace custom (JS/TS)
├── docs/                                  # documentation
├── tests/                                 # tests pytest
└── .beads/                                # DAG des tâches (beads)
```

## Installation (à terme)

Déploiement par SSH sur l'instance HA :

```bash
scp -r custom_components/delormej_climate root@ha.delormejonathan.fr:/config/custom_components/
ha core restart   # ou redémarrage HA depuis l'UI
```

Puis ajouter l'intégration depuis _Paramètres → Appareils et services → Ajouter une intégration → Delormej Climate_.

## Migration depuis l'automation actuelle

Une fois le composant en production stable, supprimer :

- L'automation `automation.climatisation_controleur_unique` et toutes les automations climat désactivées
- Les helpers `input_number.climatisation_*`, `input_boolean.climatisation_*`, `input_datetime.climatisation_*`, `input_select.climatisation_*`

À **conserver** :

- Les capteurs agrégés `sensor.temperature_moyenne_rdc`, `_etage`, `_moyenne` (utilisés ailleurs dans HA)
