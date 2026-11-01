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
        │  scripts/sync-edt.mjs ──▶ scripts/edt-changes.mjs
        │                           (comparaison avec la version publiée)
        ▼
data/edt.json                           planning brut + journal des `changes`
        │  fetch same-origin
        ▼
index.html                              filtrage du TD, bandeau « ce qui a changé »,
                                        badges sur les cours, impression
```

1. **GitHub Actions** interroge CELCAT côté serveur (pas de CORS) et écrit le
   planning brut de tout le semestre dans `data/edt.json`. Au passage, chaque
   séance est comparée à la version déjà publiée : annulation (« prof absent »),
   nouveau cours, cours retiré, salle ou horaire modifiés sont consignés dans
   `changes`, et le commit de synchro les annonce en clair.
2. La page lit ce fichier, garde les cours de la promo et du **TD choisi**
   (TD 1 ou TD 2, mémorisé dans le navigateur ; `tdGroup` est seulement le
   défaut), **signale en clair ce qui a changé** (bandeau en haut de page,
   cloche avec le nombre de changements, badges sur les cartes concernées),
   affiche tout de suite la semaine du jour, et n'en change plus ensuite.
3. Si le fichier est indisponible, la page tente un appel direct (puis via des
   proxys publics) ; en dernier recours seulement, elle affiche l'emploi du temps
   de secours codé en dur, sans statut global à l'écran.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Tout le site : styles, données de secours et logique. La section `CORE-START … CORE-END` contient le noyau testable (parsing CELCAT, filtrage du TD choisi, fusion). |
| `edt.config.json` | **Configuration** : groupe CELCAT, TD de l'étudiant, semestre, paramètres d'appel. |
| `scripts/sync-edt.mjs` | Récupère CELCAT et écrit `data/edt.json` (uniquement si le planning a changé). `--summary` / `--summary-subject` produisent le résumé lisible des changements. |
| `scripts/edt-changes.mjs` | Compare deux versions du planning et décrit chaque changement (il réutilise le noyau de `index.html`, donc un cours est décrit exactement comme la page l'affiche). |
| `.github/workflows/edt-sync.yml` | Synchro automatique (10 min + 1×/jour) et manuelle. |
| `.github/workflows/edt-tests.yml` | Lance les tests à chaque modification. |
| `data/edt.json` | Planning brut publié (mis à jour par le workflow). |
| `tests/` | Tests du noyau, des changements (détection + affichage), de la synchro, du rendu complet (jsdom) et du mode hors-ligne. |

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

### Pourquoi le planning ne s'arrête plus fin décembre

Avant, trois endroits codaient en dur « semestre S3, du 14 septembre au
19 décembre » : la liste des semaines, l'impression et la synchro. Résultat, la
navigation butait sur la semaine du 19 décembre et janvier n'existait pas.

Maintenant :

- `edt.config.json` décrit une **liste de semestres** (`semesters`) — S3 en
  automne, S4 à partir du 4 janvier (groupe `S4MIASHS`) — et la synchro choisit
  toute seule le semestre correspondant à la date du jour ;
- `data/edt.json` publie cette liste (`semesters`) et le semestre courant ;
- la page suit `data/edt.json` : elle affiche jusqu'aux dernières semaines
  réellement publiées par l'université, même au-delà de la date de fin, et
  l'option de TD garde le numéro choisi en changeant de semestre
  (`S3MIASHS TD 2` → `S4MIASHS TD 2`) ;
- une semaine pas encore publiée est annoncée « Pas encore publié » — aucune
  vacance n'est inventée ;
- l'impression découpe autant de pages A4 que nécessaire (12 semaines par page).

Pour changer de groupe ou de semestre : modifier ce fichier, puis lancer
**Actions → « Sync emploi du temps UVSQ » → Run workflow** (case « recharger tout
le semestre » cochée). Les paramètres d'URL `?group=…&td=…` permettent de tester
sans rien modifier (`index.html?group=S3MIASHS`).

## Une seule vue, sans défilement de page

L'interface est verrouillée sur la hauteur de l'écran (`100dvh`) : la barre
d'outils, les onglets et la semaine restent toujours visibles, il n'y a plus
jamais à faire défiler la page vers le haut ou vers le bas.

- **Ordinateur** : les cinq colonnes se partagent la hauteur disponible. Les
  cours sont placés en **pourcentage** de la journée 08:00 → 19:00 (plus aucune
  hauteur fixe en pixels) : la journée entière tient dans l'écran, que la fenêtre
  fasse 600 px ou 1 400 px de haut. Deux cours qui se chevauchent s'affichent
  côte à côte au lieu de se superposer.
- **Mobile** : un seul jour à la fois, choisi par les onglets ; seule la zone du
  jour défile, jamais la page.
- **Repères horaires** resserrés automatiquement sur les écrans très bas, et
  cartes qui s'allègent (titre + horaire) pour les créneaux courts.

## Une interface de produit, pas de prototype

Feuille de style unique (les anciens blocs empilés ont été fusionnés), icônes
SVG inline partout (plus aucun emoji dans les boutons), typographie Inter,
couleurs et rayons cohérents, états hover/actif/focus discrets inspirés des
outils type Linear / Vercel :

- barre d'outils : navigation segmentée `‹ Aujourd'hui ›`, cloche de
  changements, menu `⋯` ancré sous son bouton ;
- menu : groupe de TD, thème clair/sombre, impression, réaffichage des matières ;
- dialogues d'import et de confirmation avec de vrais boutons (Annuler /
  Importer / Supprimer) ;
- le rendu papier (`@media print`) reste un tableau A4 paysage, inchangé.

## Chaque changement est signalé, clairement

Un changement, c'est tout ce qui diffère entre le planning publié par
l'université et la version précédente de `data/edt.json` :

| Changement | Détecté quand | Affiché comme |
| --- | --- | --- |
| 🚫 **Cours annulé** (professeur absent, séance supprimée) | créneau publié en catégorie `Annulation` (fond `#333333`) ou `#ff0000` | bandeau + carte rouge barrée « ANNULÉ » |
| ↩️ **Séance rétablie** | un créneau annulé redevient normal | bandeau + badge « Rétabli » |
| 🆕 **Nouveau cours** | séance absente de la version précédente | bandeau + badge « Nouveau » |
| ❌ **Cours retiré** | séance présente avant, disparue du flux CELCAT | bandeau + carte « Retiré du planning » |
| 🕘 **Horaire modifié** | l'heure de début ou de fin a changé | bandeau + badge « Horaire » et rappel de l'ancien créneau |
| 🚪 **Salle changée** | la salle a changé | bandeau + badge « Salle » et rappel de l'ancienne salle |
| ✏️ **Cours modifié** | le type a changé (TD → CM…) | bandeau + badge « Modifié » |

Comment l'information arrive à l'étudiant :

1. **Bandeau en haut de page** : « N changements au planning », suivi du résumé
   (« 1 annulation, 1 nouveau cours, 1 changement de salle… ») et de la liste
   détaillée — jour, horaire, matière, salle, et l'ancienne valeur pour les
   déplacements. Il s'ouvre tout seul tant qu'il n'a pas été marqué comme vu.
2. **Cloche dans la barre d'outils** : nombre de changements connus ; elle
   rouvre le détail après un clic sur « Vu » (le bandeau ne revient que s'il y a
   du nouveau).
3. **Badges sur les cartes** du planning, **puce 🔔 par journée** concernée, et
   mention dans l'**impression** (« NOUVEAU », « SALLE »… avec compteur en tête
   de page).
4. **Un clic sur un changement** amène à la semaine et à la carte concernées, et
   les met en évidence.
5. **Résumé du workflow et message de commit** : chaque synchro qui publie un
   planning modifié écrit « chore(edt): planning synchronisé — 2 annulations,
   1 nouveau cours » et le tableau des changements dans le résumé de l'exécution
   (onglet Actions).

Garde-fous (détaillés par `npm run test:changes`) :

- **Le site officiel fait foi** : une séance absente de edt.uvsq.fr n'est pas
  réinventée ; elle est signalée comme *retirée*, pas « à vérifier ».
- **Créneaux suspendus** : un créneau annulé *chaque semaine* (ex. le TD
  d'anglais du mardi 13:50 du TD 02) n'est pas une information : il est masqué et
  ne déclenche aucune alerte (même détection que la page, via
  `findRecurringCancellations`).
- **Pas de faux « tout est nouveau »** : une semaine jamais vue auparavant n'est
  pas comparée, sinon tout son planning paraîtrait nouveau.
- **Un seul message par changement** : le journal est dédoublonné par clé
  (type + date + heure + matière). Un changement revu plus tard redevient une
  information récente, mais n'est jamais listé deux fois.
- **Matières masquées** : maintenir une carte propose de la retirer à partir de
  cette semaine, pour tous ses créneaux et les semaines suivantes.
  **Réafficher les matières** (menu ⋯) les remet toutes. Le choix reste dans le navigateur — les changements qui la
  concernent ne sont plus signalés non plus.

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
npm install           # jsdom, uniquement pour les tests de rendu
npm test              # noyau : parsing CELCAT, filtrage du TD, annulations
npm run test:sync     # synchro (faux CELCAT) : fusion, garde-fous, journal des changements
npm run test:changes  # changements : détection, silence quand rien ne bouge, bandeau + badges (jsdom)
npm run test:render   # rendu réel de la page sur les données de data/edt.json
npm run test:offline  # mode sans réseau (repli sur l'emploi du temps de secours)
npm run test:all      # tout
```

## Dépannage

| Symptôme | Cause probable | Solution |
| --- | --- | --- |
| Le planning ne change pas | Workflow en échec ou permissions de lecture seule | Onglet **Actions** → regarder le résumé du run (l'erreur exacte y est écrite) |
| Le planning de secours s'affiche | `data/edt.json` inaccessible et CELCAT indisponible | Vérifier que le fichier est bien publié sur `main` et consulter le dernier run Actions |
| Un cours manque / en trop | Mauvais TD sélectionné, ou groupe mal configuré | Choisir TD 1 ou TD 2 dans le sélecteur de la page (le choix est mémorisé). Le défaut se règle avec `tdGroup` dans `edt.config.json` |
| Le bandeau de changements n'apparaît pas | Aucun changement dans la fenêtre affichée (3 jours en arrière → 3 semaines en avant), changement déjà marqué « ✓ Vu », ou champ `changes` encore absent de `data/edt.json` | La cloche 🔔 indique toujours combien de changements sont connus. Le champ `changes` est écrit dès la première synchro qui détecte un changement (**Actions → « Sync emploi du temps UVSQ » → Run workflow**) |
| Un changement est signalé à tort | Créneau suspendu non repéré comme récurrent, ou groupe inattendu | Regarder l'entrée correspondante dans `changes` (`data/edt.json`) ; la comparaison se règle dans `diffWeeks` (`scripts/edt-changes.mjs`) |
| L'UVSQ change d'API | L'URL ou le format CELCAT a évolué | Adapter `scripts/sync-edt.mjs` (endpoints listés dans `edt.config.json`) |

Les tests `npm test`, `npm run test:changes` et `npm run test:render` s'appuient
sur `data/edt.json` : si le format CELCAT évolue, ils échouent avant la mise en
production. `npm run test:changes` construit en plus un planning volontairement
modifié (annulation, nouveau cours, salle, horaire, cours retiré) et vérifie que
la page le signale — et qu'elle reste silencieuse quand rien ne bouge.

## Votre agenda personnel

En plus de l'emploi du temps officiel, vous pouvez importer vos propres événements
(rendez-vous, sport, démarches…) dans l'agenda :

1. Ouvrez le menu ⋮ → **Importer des événements**.
2. Collez votre agenda au format texte, une ligne par événement :
   ```
   Lundi 14/09 09:00-10:30 Réunion équipe #travail
   2026-09-15 14h00-15h30 Dentiste #santé
   Mercredi 16/09 08:00-09:00 Foot #sport
   Jeudi 17/09 11:00-12:00 Banque #perso
   ```
   Règle : **jour ou date (ISO ou JJ/MM), horaire, titre**, puis un **#tag** optionnel.
   Vous pouvez demander à votre IA d'écrire votre semaine dans ce format, puis copier-coller
   le résultat dans la boîte d'import.
3. Cliquez sur **Importer** : les événements s'ajoutent à votre agenda et s'affichent sur
   les bonnes journées. Ils sont enregistrés dans votre navigateur uniquement (localStorage),
   rien n'est envoyé sur un serveur.

Un événement personnel peut être supprimé en le maintenant du doigt (ou en le survolant sur
ordinateur) → **Supprimer**.

## Limites connues

- CELCAT ne fournit pas le **nom du professeur** dans le flux « groupe » : la page
  signale « cours annulé » avec la matière, le jour et l'horaire, et affiche le
  motif (« enseignant absent »…) quand l'université en publie un — mais elle ne
  peut pas nommer la personne absente.
- Un changement détecté reste affiché jusqu'à ce qu'il soit marqué « ✓ Vu » : le
  bandeau n'est pas une notification poussée (pas de mail ni de push).
- La fraîcheur dépend de GitHub Actions (délai de quelques minutes) et du cache
  CDN de GitHub Pages.
