# Emploi du temps L2 MIASHS — UVSQ

Page statique (GitHub Pages) qui affiche **l'emploi du temps officiel** du groupe
`S3MIASHS` de l'UVSQ, récupéré automatiquement depuis **edt.uvsq.fr** (CELCAT) —
donc toujours à la bonne date, avec les **annulations et absences de professeurs**.

## Comment ça marche

```
edt.uvsq.fr (CELCAT)
        │  POST /Home/GetCalendarData   ← impossible depuis le navigateur (CORS)
        ▼
.github/workflows/edt-sync.yml          toutes les 10 min + 1×/jour
        │  scripts/sync-edt.mjs
        ▼
data/edt.json                           planning brut (JSON) versionné
        │  fetch same-origin
        ▼
index.html                              filtrage du TD 02, annulations, affichage
```

1. **GitHub Actions** interroge CELCAT côté serveur (pas de CORS) et écrit le
   planning brut de tout le semestre dans `data/edt.json`.
2. La page lit ce fichier, garde les cours de la promo et du **TD 02**, compare
   avec l'emploi du temps de référence intégré, puis affiche la semaine du jour.
3. Si le fichier est indisponible, la page tente un appel direct (puis via des
   proxys publics) ; en dernier recours seulement, elle affiche l'emploi du temps
   de secours codé en dur, sans statut global à l'écran.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Tout le site : styles, données de secours et logique. La section `CORE-START … CORE-END` contient le noyau testable (parsing CELCAT, filtrage, fusion). |
| `edt.config.json` | **Configuration** : groupe CELCAT, TD de l'étudiant, semestre, paramètres d'appel. |
| `scripts/sync-edt.mjs` | Récupère CELCAT et écrit `data/edt.json` (uniquement si le planning a changé). |
| `.github/workflows/edt-sync.yml` | Synchro automatique (10 min + 1×/jour) et manuelle. |
| `.github/workflows/edt-tests.yml` | Lance les tests à chaque modification. |
| `data/edt.json` | Planning brut publié (mis à jour par le workflow). |
| `tests/` | Tests du noyau, du rendu complet (jsdom) et du mode hors-ligne. |

## Configuration

Tout se règle dans `edt.config.json` (la page lit ce fichier au chargement) :

```json
{
  "group": "S3MIASHS",        // identifiant CELCAT (fid0= dans l'URL)
  "tdGroup": "S3MIASHS TD 2", // TD de l'étudiant : garde la promo + ce TD
  "label": "L2 MIASHS — Semestre 3",
  "semester": { "start": "2026-09-14", "end": "2026-12-19" }
}
```

Pour changer de groupe ou de semestre : modifier ce fichier, puis lancer
**Actions → « Sync emploi du temps UVSQ » → Run workflow** (case « recharger tout
le semestre » cochée). Les paramètres d'URL `?group=…&td=…` permettent de tester
sans rien modifier (`index.html?group=S3MIASHS`).

## Détection des annulations / absences

- **Annulation officielle** : CELCAT publie un créneau dont la catégorie est
  `Annulation` (fond `#333333`). Le cours est affiché en rouge et l'information
  « annulée » reste directement sur sa carte ; aucun encart récapitulatif global
  n'est affiché.
- **Cours retiré du planning** : si un cours de l'emploi du temps de référence
  n'existe plus dans le flux officiel, il apparaît en pointillés avec le badge
  « ❓ à vérifier » (utile quand une séance disparaît sans explication).
- **Créneaux suspendus** : un créneau annulé *chaque semaine* (ex. le TD
  d'anglais du mardi 13:50 du TD 02) n'est pas une information : il est masqué
  au lieu de générer une fausse alerte.

## Mise en place (une seule fois)

1. **Settings → Actions → General → Workflow permissions** :
   sélectionner **Read and write permissions** (le workflow doit pouvoir
   committer `data/edt.json`). Sans ce réglage, la synchro s'exécute mais ne
   peut pas publier : elle l'indique dans le résumé du workflow et le site
   continue d'afficher la dernière version publiée.
2. Pages : *Deploy from a branch* → `main` / `/ (root)` (déjà en place).
3. Lancer une première fois le workflow « Sync emploi du temps UVSQ » pour
   remplir `data/edt.json`.

## Tests

```bash
npm install          # jsdom, uniquement pour les tests de rendu
npm test             # noyau : parsing CELCAT, filtrage du TD, annulations
npm run test:render  # rendu réel de la page sur les données de data/edt.json
npm run test:offline # mode sans réseau (repli sur l'emploi du temps de secours)
npm run test:all     # les trois
```

## Dépannage

| Symptôme | Cause probable | Solution |
| --- | --- | --- |
| Le planning ne change pas | Workflow en échec ou permissions de lecture seule | Onglet **Actions** → regarder le résumé du run (l'erreur exacte y est écrite) |
| Le planning de secours s'affiche | `data/edt.json` inaccessible et CELCAT indisponible | Vérifier que le fichier est bien publié sur `main` et consulter le dernier run Actions |
| Un cours manque / en trop | Groupe ou TD mal configuré | Corriger `group` / `tdGroup` dans `edt.config.json` |
| L'UVSQ change d'API | L'URL ou le format CELCAT a évolué | Adapter `scripts/sync-edt.mjs` (endpoints listés dans `edt.config.json`) |

Les tests `npm test` s'appuient sur `data/edt.json` : si le format CELCAT évolue,
ils échouent avant la mise en production.

## Limites connues

- CELCAT ne fournit pas le **nom du professeur** dans le flux « groupe » : la page
  signale l'annulation et la matière, pas la personne absente.
- La fraîcheur dépend de GitHub Actions (délai de quelques minutes) et du cache
  CDN de GitHub Pages.
