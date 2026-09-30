## Résumé

<!-- En une ou deux phrases : quel problème règle cette PR, ou quelle fonction ajoute-t-elle ? -->

## Ce qui change

<!-- Les fichiers ou modules touchés, en langage simple. -->
-

## Vérification

- [ ] La CI passe (types, tests et construction, sous Linux et Windows)
- [ ] Des tests couvrent le changement, ou la PR explique pourquoi ce n'est pas nécessaire
- [ ] Si l'interface change : essayé avec `npm run start`, dans les onglets touchés et avec le sélecteur « Montants en » dans les deux positions

## Fiscalité et hypothèses

- [ ] Aucune valeur fiscale ou hypothèse de calcul modifiée
- [ ] Valeurs fiscales modifiées : source indiquée ci-dessous (ARC, Revenu Québec), et mention « à valider » retirée ou conservée dans `tax-XXXX.json`
- [ ] Nouvelle hypothèse simplificatrice : ajoutée à la section « Hypothèses actuelles » du README

<!-- Sources ou calculs de référence : -->

## Données des utilisateurs

- [ ] Le format des fichiers de scénario et du stockage local reste compatible
- [ ] Sinon : une migration est incluse et testée (voir `ui/src/storage-migration.ts` et `electron/migrate.ts`)

## Notes pour la relecture

<!-- Ce qui mérite une attention particulière, les limites connues, ce qui n'a pas pu être vérifié. -->
