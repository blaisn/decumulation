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
