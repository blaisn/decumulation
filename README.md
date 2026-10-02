# Décumulation

Plan de décaissement pour couple de retraités au Québec : moteur de calcul (TypeScript) et application Windows (Electron).

Nom du projet : `decumulation` (paquet npm, identifiant d'application `ca.local.decumulation`, clés de stockage local `decumulation.*`). Les fichiers produits par `npm run dist` portent un nom sans accent : `Decumulation-installateur-<version>.exe` et `Decumulation-portable-<version>.exe`.

**Données de l'application** : sous Windows, dans `%APPDATA%\Decumulation` (dossier fixé dans `electron/main.ts`, le même avec `npm run start` et avec une version installée ou portable). Elles comprennent le formulaire, les données de base et le choix de l'unité des montants. Pour une vraie sauvegarde, ou pour changer d'ordinateur, utilisez « Enregistrer » : le fichier JSON contient le formulaire et les données de base.

## Démarrer
Nécessite **Node.js 24** (version LTS) : `package.json` l'exige (`engines`), et la CI utilise la même.

    npm install
    npm test             # moteur de calcul et interface (fonctions pures)
    npm run start        # construit l'application et l'ouvre dans Electron
    npm run dist         # crée l'installateur et la version portable Windows dans release/
    npm run example      # compare les stratégies de retrait sur un couple fictif (console)

`npm run dist` doit être lancé sous Windows pour produire les .exe (ou déclenché sur GitHub : voir « Versionnage et intégration continue »). Si l'erreur « Cannot create symbolic link » apparaît, voir le dépannage dans [docs/PUBLICATION.md](docs/PUBLICATION.md) : il faut activer le mode développeur de Windows (installateur NSIS et version portable). Sans icône ni signature de code, Windows affichera un avertissement SmartScreen au premier lancement.

**Publier une version** (MSI, installateur, version portable, version GitHub, copie sur S3, site web statique) : voir [docs/PUBLICATION.md](docs/PUBLICATION.md).

## Versionnage et intégration continue
Première mise en place :

    git init -b main
    git add . && git commit -m "Version initiale"
    git remote add origin <url-du-depot>
    git push -u origin main

Lancez d'abord `npm install` et gardez le `package-lock.json` qu'il crée : la CI l'utilise (`npm ci`) pour des installations reproductibles.

- `.github/workflows/ci.yml` : à chaque pull request et à chaque poussée sur `main`, vérifie les types (`npm run typecheck`), lance les tests (`npm test`) et construit l'application (`npm run build`), sous Linux et sous Windows. Pour bloquer la fusion d'une PR dont la vérification échoue : Settings > Branches > règle de protection de `main` > « Require status checks », puis choisir « Vérifications (ubuntu-latest) » et « Vérifications (windows-latest) » (ces noms n'apparaissent qu'après une première exécution)
- `.github/workflows/windows-installer.yml` : construit l'installateur et la version portable sous Windows (`npm run dist`) et les conserve 30 jours dans l'onglet Actions. Se lance à la main (Actions > Installateur Windows > Run workflow) ou en poussant une étiquette comme `v0.1.0`. Sans signature de code
- `.github/pull_request_template.md` : description de PR préremplie (résumé, vérifications, changements de fiscalité ou d'hypothèses, compatibilité des données)
- `.gitattributes` : fins de ligne LF pour tous les fichiers, afin que les différences restent lisibles quand on travaille sous Windows

## Structure
- `src/engine/types.ts` : modèle de données (scénario, résultats)
- `src/engine/tax.ts` : impôt fédéral + Québec du ménage : crédits d'âge et de retraite, transfert des crédits inutilisés, fractionnement optimisé
- `src/engine/ferr.ts` : retraits minimums FERR
- `src/engine/projection.ts` : boucle année par année (revenus garantis, FERR minimum, financement selon la stratégie, décès)
- `src/engine/compare.ts` : compare et classe les stratégies de retrait
- `examples/` : exemple exécutable
- `ui/` : interface (HTML, CSS, TypeScript sans framework) : `model.ts` (formulaire vers scénario, validation, fichiers), `form.ts`, `charts.ts` (SVG), `tables.ts`, `csv.ts`, `compute.ts` + `worker.ts` (calculs hors du fil de l'interface), `main.ts` (branchement)
- `electron/` : fenêtre, boîtes de dialogue Ouvrir/Enregistrer (`main.ts`) et passerelle sécurisée (`preload.ts`)
- `scripts/build.mjs` : assemble `dist/` avec esbuild
- `src/engine/data/tax-2026.json` : table fiscale 2026 (voir `_note` pour les valeurs à valider)

## Hypothèses actuelles
- À 65 ans et plus, les retraits du REER sont traités comme des revenus de FERR (admissibles au crédit de pension et au fractionnement)
- Harmonisation RRQ à 65 ans (case à cocher par rente) : le « Montant annuel » s'applique avant 65 ans, le « Montant de la pension à 65 ans » à partir de 65 ans (`amountAt65` dans le moteur); laissé vide, il est identique au montant annuel. Les deux montants sont en dollars de l'année de départ et indexés de la même façon. La rente de survivant est calculée sur le montant que touchait le défunt à son âge au décès
- Rentes RPA admissibles au fractionnement à tout âge; RRQ et PSV ne le sont pas
- Fractionnement optimisé chaque année (0 à 50 %, pas de 1 %), tant que les deux conjoints sont en vie. Case à cocher « Appliquer le fractionnement du revenu de pension » dans les Hypothèses avancées (cochée par défaut); `assumptions.pensionSplitting` dans le moteur
- Québec : montants en raison de l'âge, pour personne vivant seule et pour revenus de retraite (1,25 x le revenu, max 3 541 $) mis en commun et réduits une seule fois selon le revenu familial net; montant personnel inutilisé transférable
- Dépenses du couple réparties entre les conjoints : le champ « Part des dépenses du couple dont il a la charge » (50 % par défaut) du premier conjoint, le second ayant le reste (affichage seulement). Cette répartition ne sert qu'à présenter la dépense visée de chacun (CSV); le ménage finance ses dépenses ensemble. Après un décès, le survivant a toute la dépense, réduite par « Dépenses du survivant »
- RRQ et PSV : les montants saisis sont ceux de **65 ans** (l'âge « normal »), en dollars de l'année de départ; l'âge de début les ajuste (`src/engine/benefits.ts`). RRQ : +0,7 % par mois après 65 ans, jusqu'à 72 ans (+58,8 %); avant 65 ans, réduction de 0,5 % à 0,6 % par mois, jusqu'à 60 ans (−30 % à −36 %). Retraite Québec précise que la réduction « augmente proportionnellement au montant de la rente » jusqu'à 0,6 % pour la rente maximale, sans publier la formule : on interpole linéairement entre 0,5 % et 0,6 % selon le rapport rente / rente maximale à 65 ans (`rrqMaxAt65` de la table fiscale, 1 507,65 $ x 12 en 2026). PSV : +0,6 % par mois de report, jusqu'à 70 ans (+36 %). Sources : Retraite Québec, « Le calcul de votre rente de retraite »; Service Canada, « Quand commencer à recevoir votre pension »; Loi sur la sécurité de la vieillesse, art. 7.1. La rente de survivant de la RRQ se calcule sur la rente ajustée du défunt. Un ancien fichier dont les montants avaient été saisis pour un âge de début autre que 65 ans doit être ressaisi
- Taux marginal : taux statutaire combiné du palier d'imposition du revenu imposable de chaque conjoint = taux fédéral x (1 − abattement du Québec) + taux du Québec. Il n'inclut ni la récupération de la PSV ni la réduction du montant en raison de l'âge, qui s'ajoutent dans certaines zones de revenu (même convention que la plupart des logiciels de planification)
- Récupération fiscale de la PSV : 15 % du revenu net au-dessus du seuil (indexé), plafonnée à la PSV reçue, déductible du revenu net; calculée après fractionnement
- Phase-out du montant personnel fédéral ignoré (revenus > 181 440 $)
- Bonification de la PSV à 75 ans : à entrer dans le montant annuel de la PSV

## Application
- **Plan** : phrase-bilan, soldes des comptes sous une ligne de vie par conjoint (début des rentes, FERR à 71 ans, décès), et d'où vient l'argent chaque année avec la ligne « dépenses visées et impôt ». La ligne est la dépense visée, pas la dépense financée : quand elle dépasse les colonnes, la zone rouge est le manque de fonds; quand les colonnes la dépassent, l'excédent est réinvesti (colonnes + manque = ligne + excédent réinvesti, chaque année). Le plan se recalcule automatiquement à chaque modification
- **Dollars constants ou courants** : le sélecteur « Montants en » (au-dessus des résultats) s'applique à tous les onglets. *Dollars de 2026* retire l'effet de l'inflation (ce que les montants permettent d'acheter aujourd'hui); *Dollars courants* montre les montants réels de chaque année. Par défaut : dollars courants; le choix est conservé. En dollars courants, l'impôt cumulé additionne des dollars de chaque année et les soldes de fin sont exprimés en dollars de la dernière année
- **Masquer le formulaire** : le bouton à gauche des onglets cache le panneau de saisie pour donner toute la largeur aux résultats (le tableau du Détail annuel n'est alors plus limité en largeur). Le choix est conservé avec les autres préférences
- **Note du Détail annuel** : le bouton « Masquer la note » (à côté de « Exporter en CSV ») cache le texte explicatif au-dessus du tableau, qui gagne alors de la hauteur. Le choix est conservé avec les autres préférences
- **Détail annuel** : tableau du ménage (revenus détaillés en rentes de régimes, RRQ et PSV; revenu imposable et taux marginal de chaque conjoint) et export CSV (une ligne par conjoint et par année). Le CSV est toujours en dollars courants et contient l'indice d'inflation (départ = 1) : diviser un montant par l'indice donne des dollars de l'année de départ. Les colonnes ajoutées après coup sont à la fin, pour ne pas déplacer les autres : « Taux marginal (%) », « Dépenses visées » (la part de ce conjoint, en dollars courants) et « Part des dépenses (%) »
- **Comparaison à la base** : plan des données de base à côté du plan actuel : verdict en une phrase, liste de ce qui change, tableau côte à côte avec écarts (impôt cumulé, PSV récupérée, dépenses non financées, soldes restants, succession, première année sans fonds) et deux courbes (actifs totaux, impôt payé par année). Avertit si les fonds s'épuisent, ou si les deux plans n'ont pas la même inflation ou année de départ (comparaison en dollars constants alors sur des bases différentes)
- **Stratégies** et **Ordre des décès** : lancent `compareStrategies`, et `compareLongevity` (ou `compareDeathOrders` avec le second mode). L'onglet Ordre des décès montre d'abord, pour chaque conjoint, les âges de décès testés et les chances d'atteindre 85, 90 et 95 ans. Les stratégies au résultat identique sont regroupées; « Appliquer » recharge la stratégie choisie dans le formulaire
- **Optimisation PSV/RRQ** : essaie toutes les combinaisons d'âges de début de la RRQ (60 à 72 ans) et de la PSV (65 à 70 ans) de chaque conjoint, calculées en parallèle dans plusieurs Web Workers (avec progression, estimation du temps et annulation), et classe les résultats : d'abord les combinaisons qui financent toutes les dépenses, par succession après impôt décroissante (les placements restants à la fin du plan), puis, si aucune ne finance tout, par manque cumulé croissant. Le tableau montre les 10 meilleures combinaisons et les choix actuels; « Appliquer » reporte la combinaison choisie dans le formulaire. Les âges déjà passés (rente commencée) ne sont pas explorés, et chaque rente peut être décochée pour réduire le nombre de combinaisons (jusqu'à 13 x 6 x 13 x 6 = 6 084)
- **Données de base** : « Enregistrer comme données de base » garde un instantané de la situation du couple. En haut du formulaire, l'application indique combien de champs ont changé depuis, les encadre en ocre et en donne la liste (« Voir les changements »). « Revenir aux données de base » annule les essais; « Définir comme données de base » remplace l'instantané Les confirmations (revenir à la base, définir la base, rétablir les valeurs d'exemple) sont des boîtes intégrées à la page (`ui/src/dialog.ts`), et non `window.confirm` : sous Electron (Windows), les boîtes bloquantes du navigateur font perdre le focus clavier à la fenêtre, et les champs de saisie ne répondent plus. Un test interdit le retour de `confirm`, `alert` et `prompt`
- **Fichiers** : « Enregistrer » écrit un scénario en JSON, avec les données de base s'il y en a; « Ouvrir » relit les deux (un fichier sans base, ancien format, ouvre sans base; les champs manquants reprennent les valeurs par défaut). Le formulaire et les données de base sont aussi conservés automatiquement entre deux ouvertures
- Les valeurs de départ sont un couple fictif : à remplacer par la situation réelle
- Sécurité : `contextIsolation`, `sandbox`, aucun accès à Node depuis la page, politique de sécurité du contenu stricte, aucune connexion réseau
- Les années de départ avant 2026 sont refusées (pas de table fiscale); après 2026, la table de 2026 est indexée à l'inflation
- Vérifié : interface complète dans Chromium sans tête (tous les onglets, saisie, erreurs, fichiers, écran étroit). Non vérifié ici : la coquille Electron elle-même (fenêtre, boîtes de dialogue, installateur), à essayer avec `npm run start`

## Stratégies de retrait (`scenario.strategy`)
- `reer-first` (défaut) : REER/FERR d'abord, puis CELI
- `celi-first` : CELI d'abord, puis REER/FERR
- `ceiling` : REER/FERR jusqu'à un revenu plafond par conjoint (en $ de départ, ou `"psv-threshold"` = seuil de récupération de la PSV), puis CELI, puis REER/FERR au-delà du plafond
- `compareStrategies(scenario, tax)` exécute une liste de stratégies (par défaut : les deux ordres simples, le seuil de la PSV et une grille de plafonds de 50 000 $ à 110 000 $) et les classe. Les montants de premier niveau sont en $ de l'année de départ; `nominal` donne les mêmes mesures en dollars courants. La « succession après impôt » = CELI + REER/FERR restant x (1 - `estateTaxRate`, défaut 45 %, hypothèse grossière à ajuster)
- `meltdown` (fonte du REER) : retire du REER/FERR jusqu'au revenu plafond même si les dépenses sont couvertes (jusqu'à `untilAge` ans, optionnel), puis verse le surplus au CELI (dans la limite des droits) et le reste au compte non enregistré
- Tout surplus net, quelle que soit la stratégie (revenus garantis ou retraits FERR minimums supérieurs aux dépenses), est réinvesti de la même façon : CELI, puis non enregistré
- Les comptes non enregistrés servent avant le CELI (sauf `celi-first`)

## Comparaison selon l'ordre et la date des décès
Deux méthodes, qui produisent la même structure de résultats (matrice stratégies x cas, meilleure stratégie par cas, classement de robustesse) :

- **Durées de vie probables** (`compareLongevity(scenario, tax, candidates?, { lifeExpectancy65: [a, b], states? })`) : les *deux* décès varient. Chaque conjoint est testé à `states` âges représentatifs de sa durée de vie probable (5 par défaut : les âges où il y a 10 %, 30 %, 50 %, 70 % et 90 % de chances qu'il soit décédé; un âge au-delà de `endAge` devient « vit jusqu'à la fin du plan »). Les combinaisons (25 avec 5 états, 9 avec 3) pèsent autant chacune, en supposant les deux durées de vie indépendantes. L'ordre des décès en découle : le plus tôt est le premier. Le classement affiche aussi la part des cas où des dépenses ne sont pas financées (`shortfallProbability`)
- **Premier décès à des âges choisis** (`compareDeathOrders`) : chaque conjoint qui décède en premier à 75, 80, 85 et 90 ans (`deathAges`), l'autre vivant jusqu'à `endAge`, plus le cas sans décès. Poids égaux, ou `weights`

Le classement de robustesse : moyenne pondérée, pire cas et **regret maximal** (écart, dans le pire cas, avec la meilleure stratégie de ce cas). Il place d'abord les stratégies sans dépenses non financées, puis celles au plus petit regret maximal. Les `deathAge` du scénario de base sont remplacés dans ces cas.

**Mortalité** (`src/engine/mortality.ts`) : modèle de Gompertz (risque de décès qui augmente d'environ 12 % par année d'âge), calé sur l'espérance de vie à 65 ans de chaque conjoint (champ du formulaire, 21 ans par défaut). Repères : Québec, 2025, 19,8 ans pour un homme et 22,1 ans pour une femme (Institut de la statistique du Québec). C'est une approximation : elle ne remplace pas une table de mortalité, elle suppose une mortalité constante dans le temps (l'espérance de vie « du moment » ignore les gains futurs de longévité : l'augmenter est une façon d'en tenir compte) et ne distingue pas les cas de santé fragile. Durée : environ 6 secondes pour 16 stratégies x 9 cas, 12 secondes x 25 cas.

## Comptes CELI et non enregistré
- `celiRoom` : droits de cotisation inutilisés au départ; s'y ajoutent chaque année le plafond (`celiAnnualLimit`, 7 000 $ indexé, arrondi à 500 $) et les retraits de l'année précédente
- Non enregistré (`nonRegistered`) : simplification — la part `nonRegTaxedShare` (50 %) du rendement est imposée chaque année comme un revenu ordinaire et reçue en argent; le reste croît sans impôt. Les retraits sont traités comme un retour de capital (gains latents jamais réalisés). Dans le classement, ces gains latents sont imposés à `nonRegTaxRate` (10 %) au dernier décès
- Au décès, le non enregistré passe au survivant comme le REER et le CELI

## Décès (`deathAge` sur un conjoint, ou les deux)
- Survient en fin d'année; le défunt est imposé normalement cette année-là
- REER/FERR et CELI passent au survivant (roulement, sans impôt)
- Rentes RPA : `survivorPct` de la rente, indexée, même si le défunt ne l'avait pas encore commencée
- RRQ : rente du survivant + 60 % de celle du défunt, plafonnée (`rrqSurvivorCap`, 17 295 $ en 2026 $); simplification (règles avant 65 ans non modélisées)
- PSV du défunt cesse; SRG non modélisé
- Dépenses du survivant : `survivorSpendingRatio` (défaut 75 %)
- Le survivant est imposé seul : pas de fractionnement, montant pour personne vivant seule (Québec)
- Non modélisé : déclaration finale détaillée du défunt, crédits inutilisés du défunt, frais de succession

## À faire (par priorité)
1. Valider les valeurs « à valider » et ajouter les années futures
2. Essayer `npm run start` et `npm run dist` sous Windows; ajouter une icône (`build.win.icon`) et, si l'application est distribuée, une signature de code
3. Optimisation fine de la fonte (plafond différent par année ou par conjoint, en fonction des paliers d'imposition)
4. Remplacer le modèle de Gompertz par une table de mortalité officielle (par sexe) si les données sont disponibles
5. Interface : impression ou export PDF du plan; comparer deux stratégies ou deux ordres de décès dans l'onglet de comparaison
