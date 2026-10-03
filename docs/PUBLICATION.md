# Publier Décumulation

Ce document explique comment produire les fichiers d'installation pour Windows, les publier, et ce qu'on peut faire avec AWS.

## 1. Les fichiers produits

`npm run dist` (ou le workflow GitHub « Installateur Windows ») produit trois fichiers dans `release/`, plus leurs sommes de contrôle :

| Fichier | Pour qui | À savoir |
|---|---|---|
| `Decumulation-installateur-<version>.exe` | La plupart des utilisateurs | Installation pour l'utilisateur courant, sans droits d'administrateur, avec choix du dossier. Seul format compatible avec les mises à jour automatiques (non activées pour l'instant) |
| `Decumulation-<version>.msi` | Déploiement géré par une équipe informatique (GPO, Intune, SCCM) | Installation silencieuse : `msiexec /i Decumulation-<version>.msi /qn`. Les mises à jour se font en installant le MSI de la version suivante : le même `upgradeCode` (dans `package.json`) la reconnaît comme une mise à niveau. **Ne jamais changer ce code** |
| `Decumulation-portable-<version>.exe` | Essai rapide, clé USB | Aucune installation. Démarrage un peu plus lent. Les données restent dans `%APPDATA%\Decumulation`, pas à côté du fichier |
| `SHA256SUMS.txt` | Tout le monde | Permet de vérifier qu'un fichier téléchargé n'a pas été modifié : `Get-FileHash <fichier> -Algorithm SHA256` |

Pour un usage personnel ou un petit groupe, l'installateur `.exe` est le plus simple. Le MSI sert surtout si quelqu'un doit l'installer sur plusieurs postes.

## 2. Publier une version

1. Changer `version` dans `package.json`. Format obligatoire : trois nombres, par exemple `0.2.0` (le MSI refuse « 0.2.0-beta »).
2. Committer, puis créer et pousser l'étiquette :

        git commit -am "Version 0.2.0"
        git tag v0.2.0
        git push && git push origin v0.2.0

3. Le workflow vérifie que l'étiquette correspond à la version de `package.json`, lance les types et les tests, construit les trois fichiers, calcule les sommes de contrôle, puis crée une **version GitHub** avec les fichiers joints. Les versions `0.x` sont marquées « préversion ».
4. Si la copie sur S3 est configurée (section 5), les fichiers y sont copiés aussi.

Pour construire sans publier : onglet Actions > « Installateur Windows » > Run workflow. Les fichiers sont alors disponibles dans les artefacts du workflow, pendant 30 jours.

## 3. Construire à la main

Sous Windows seulement (le MSI exige l'outil WiX, qu'electron-builder télécharge), avec Node.js 24 :

    npm install
    npm run dist

Les fichiers sont dans `release/`.

### Dépannage : « Cannot create symbolic link » pendant `npm run dist`

Sous Windows, la construction s'arrête avec, répété quatre fois (reprises automatiques) :

    ERROR: Cannot create symbolic link : Le client ne dispose pas d'un privilège nécessaire. : ...\winCodeSign\...\libcrypto.dylib

**Cause.** electron-builder télécharge un outil (winCodeSign) dont l'archive contient des liens symboliques prévus pour macOS. Windows ne laisse créer des liens symboliques qu'aux administrateurs, ou quand le *mode développeur* est activé. Ce n'est pas une erreur du projet. C'est un défaut connu d'electron-builder (n° 8149), corrigé en février 2026 dans une version plus récente que celle du projet (25.x).

**Solution, dans l'ordre :**

1. Activer le **mode développeur** : Paramètres > Système > Espace développeurs > Mode développeur (ou chercher « mode développeur » dans les paramètres). Fermer puis rouvrir VS Code.
2. Supprimer l'archive partielle laissée par les essais ratés :

        # Git Bash
        rm -rf "$LOCALAPPDATA/electron-builder/Cache/winCodeSign"

        # PowerShell
        Remove-Item "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -Recurse -Force

3. Relancer `npm run dist`. L'outil est extrait une seule fois, puis gardé en cache.

**Sans mode développeur :** lancer le terminal *en tant qu'administrateur*, ou faire construire les fichiers par GitHub (Actions > Installateur Windows > Run workflow) : les machines de GitHub ont ce droit, et les fichiers se téléchargent dans les artefacts.

**Avertissements sans gravité** qui s'affichent aussi :

- `author is missed in the package.json` : ajouter `"author": "Votre nom"` dans `package.json`. C'est le nom de l'éditeur que montrent l'installateur et le MSI.
- `Manufacturer is not set for MSI` : même remède que `author is missed` ci-dessus.

### Dépannage : le MSI échoue avec « LGHT0094 … The identifier 'Icon:…Icon.exe' could not be found »

La construction s'arrête à l'étape du MSI, après ces lignes :

    default Electron icon is used  reason=application icon is not set
    building        target=MSI arch=x64 file=release\Decumulation-0.2.0.msi
    error LGHT0094 : The identifier 'Icon:DcumulationIcon.exe' could not be found.

**Cause.** Sans icône d'application, electron-builder emploie celle d'Electron pour l'installateur et la version portable, sans problème. Mais le modèle du MSI fait référence à une icône que WiX (l'outil qui assemble le MSI) ne trouve pas : c'est un problème connu d'electron-builder (tickets #5744 et #7892). Le « é » absent de l'identifiant est normal, WiX n'acceptant que des caractères ASCII. Une version antérieure de ce guide présentait l'absence d'icône comme sans gravité : c'est vrai sauf pour le MSI.

**Solution.** Le projet fournit `build/icon.ico` (electron-builder le trouve seul, sans réglage) et `build/icon.svg`, sa source modifiable. Remplacez-les par votre propre icône quand vous le voulez : un fichier `.ico` d'**au moins 256 × 256 pixels**, de préférence avec aussi 16, 32 et 48. Le dossier `build/` ne doit pas être exclu par `.gitignore`, sinon la CI n'a pas l'icône (un test le vérifie). Relancez ensuite `npm run dist`.

**Si l'erreur persiste**, ouvrez `release\__msi-x64\project.wxs`, à la ligne indiquée dans le message, et cherchez les mentions de `Icon` : elles montrent quel identifiant WiX attend et lequel est déclaré.

## 4. Avertissement SmartScreen et signature de code

Les fichiers ne sont pas signés. Au premier lancement, Windows affiche « Windows a protégé votre ordinateur » : cliquer sur « Informations complémentaires », puis « Exécuter quand même ». Un MSI non signé affiche « Éditeur inconnu ».

Pour l'éviter, il faut un **certificat de signature de code** (payant). electron-builder signe automatiquement si les variables d'environnement `CSC_LINK` (le certificat) et `CSC_KEY_PASSWORD` (son mot de passe) sont définies : les ajouter comme *secrets* du dépôt GitHub, les passer au job `windows` du workflow, et retirer la ligne `CSC_IDENTITY_AUTO_DISCOVERY: "false"`. Un certificat « EV » est reconnu tout de suite par SmartScreen; un certificat ordinaire gagne sa réputation avec le nombre de téléchargements.

## 5. AWS : ce qui est possible

### Fonction Lambda : non

Lambda exécute du code **côté serveur**, à la demande (une API, un traitement). Décumulation est un programme de bureau : tous les calculs se font sur l'ordinateur de l'utilisateur, il n'y a rien à exécuter sur un serveur. Une Lambda ne servirait qu'à des à-côtés (compter les téléchargements, produire des liens de téléchargement temporaires), et rien de tout cela n'est nécessaire ici.

### Bucket S3 : oui, pour deux usages

**A. Distribuer les installateurs.** Un bucket S3 **privé**, derrière une distribution **CloudFront** (HTTPS, adresse stable, mise en cache), donne des adresses de téléchargement stables, par exemple :

- `https://<votre-domaine>/decumulation/latest/Decumulation.msi`
- `https://<votre-domaine>/decumulation/v0.2.0/Decumulation-0.2.0.msi`

C'est facultatif : la version GitHub joue déjà ce rôle. S3 devient utile pour avoir sa propre adresse, ou si le dépôt est privé et que les utilisateurs n'ont pas de compte GitHub.

**B. Héberger l'application comme un site web.** L'interface est déjà une page statique (`dist/renderer`) : elle fonctionne sans serveur, avec son Web Worker, dans n'importe quel navigateur. (Testé avec un serveur HTTP local : le plan se calcule, la comparaison des stratégies tourne dans le worker, aucune requête ne part vers un autre site.) Il suffit de la copier dans un bucket servi par CloudFront :

    npm run build
    aws s3 sync dist/renderer s3://<bucket>/ --delete --exclude "*.map" --cache-control "no-cache"

Ce que cela change par rapport à l'application Windows :

- Les données saisies restent **dans le navigateur de chaque utilisateur** (stockage local de ce site) : rien n'est envoyé ni conservé sur AWS, et un autre navigateur ou un autre appareil ne voit pas les mêmes données. « Enregistrer » et « Ouvrir » téléchargent et téléversent des fichiers JSON.
- N'importe qui connaissant l'adresse peut utiliser l'outil. Il ne contient aucune donnée personnelle, mais si vous voulez le restreindre, il faut ajouter une protection devant CloudFront (cookies ou URL signés, Cognito, ou une fonction CloudFront qui demande un mot de passe).
- Les tables fiscales sont celles de l'application : à republier chaque année.

**C. Mises à jour automatiques (non faites).** electron-updater peut lire un dossier S3 ou une adresse HTTPS et mettre l'application à jour toute seule, mais uniquement avec l'installateur `.exe` (pas avec le MSI). Cela demande du code supplémentaire dans l'application : à faire seulement si le besoin existe.

### Mise en place (gabarits à adapter)

Remplacer `<COMPTE>` (numéro de compte AWS), `<BUCKET>`, `<ORG>/<DEPOT>`, `<ID_DISTRIBUTION>`. La région `ca-central-1` (Montréal) convient.

**1. Le bucket, privé :**

    aws s3api create-bucket --bucket <BUCKET> --region ca-central-1 --create-bucket-configuration LocationConstraint=ca-central-1
    aws s3api put-public-access-block --bucket <BUCKET> --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

**2. CloudFront**, dans la console : créer une distribution dont l'origine est ce bucket, avec un **contrôle d'accès à l'origine (OAC)**, le HTTPS obligatoire et, pour l'usage B, `index.html` comme objet racine par défaut. La console propose alors la politique de bucket à copier; elle ressemble à ceci :

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<BUCKET>/*",
      "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::<COMPTE>:distribution/<ID_DISTRIBUTION>" } }
    }
  ]
}
```

**3. Autoriser GitHub à écrire dans le bucket, sans clé d'accès** (OIDC). Créer le fournisseur d'identité une seule fois par compte :

    aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com

Puis un rôle IAM dont la **relation d'approbation** limite l'accès aux étiquettes de version de votre dépôt :

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::<COMPTE>:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<ORG>/<DEPOT>:ref:refs/tags/v*" }
      }
    }
  ]
}
```

et cette **politique de permissions** (écriture sous `decumulation/` seulement) :

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::<BUCKET>/decumulation/*"
    }
  ]
}
```

**4. Les variables du dépôt GitHub** (Settings > Secrets and variables > Actions > onglet *Variables*). Le job `publish-s3` reste inactif tant que `S3_BUCKET` n'existe pas :

| Variable | Valeur |
|---|---|
| `S3_BUCKET` | le nom du bucket |
| `AWS_REGION` | `ca-central-1` |
| `AWS_ROLE_ARN` | l'ARN du rôle créé à l'étape 3 |

## 6. Ce qui n'a pas été testé

- La construction du **MSI**, de l'installateur et de la version portable : elle exige Windows. Le premier passage du workflow `windows-installer.yml` (Run workflow) le vérifiera. Si le MSI échoue à cause du « é » de « Décumulation », mettre `productName` à `Decumulation` dans `package.json`.
- Tout ce qui touche **AWS** (bucket, CloudFront, rôle, copie par le workflow) : je n'ai pas accès à un compte AWS. Les gabarits ci-dessus suivent la documentation d'AWS, mais sont à valider sur votre compte.
- Le site web statique a été vérifié avec un serveur HTTP local, pas encore sur CloudFront.
