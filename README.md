# ConsoElec

Application de bureau (**Angular 21 + Electron**) pour suivre la consommation et la production d'électricité d'une maison belge équipée de panneaux solaires :

- **Compteur intelligent** : les quatre index (soutirage et injection, heures pleines et creuses) saisis à la main ou lus par l'IA (Claude ou OpenAI) sur une **photo** du compteur ; vue détaillée des quatre sous-compteurs.
- **Statistiques** par mois, par saison et par année, avec comparaison à une maison belge type (la chaudière au mazout et le poêle à bois ne consomment pas d'électricité).
- **Installation solaire** : panneaux, onduleur (écrêtage), radiateur d'appoint sur le surplus ; si l'index de production est encodé, autoconsommation, autarcie et consommation réelle de la maison.
- **Prévisions** selon la saison : statistique belge, statistique recalée sur la maison (avec prudence quand les données sont courtes), historique réel ; fiabilité mesurée par rétro-test sur les mois passés. Scénario **voiture électrique** (avec / sans).
- **Plusieurs ordinateurs** : export JSON, puis import qui fusionne. Seuls les relevés absents sont ajoutés ; rien n'est modifié ni supprimé. Export et import CSV des relevés (Excel).
- **Compteur par le port P1** (norme belge e-MUCS) : lecteur HomeWizard Wi-Fi P1 (API v1 ou v2), Chargee, YouLess LS120 ou télégramme brut sur TCP, lu chaque minute sur le réseau local ; les index alimentent les calculs sans relevé manuel, journal compact (minutes de la dernière heure, heures du jour, un point par jour), compteur en direct et courbe du jour.
- **Onduleur** : lecture locale de la puissance, de la production du jour et de l'index total, relevés pré-remplis, rendement mesuré. SMA (WebConnect, connexion SRP ou mot de passe, avec historique quotidien), Fronius (Solar API), SolarEdge, Kostal et autres SunSpec (Modbus TCP), Huawei, Sungrow, Solis, Deye, Sofar (Modbus TCP ou clé Solarman), GoodWe (UDP), Enphase (IQ Gateway).
- **Clés dans le Trousseau macOS** (clés API Claude et OpenAI, clé de l'onduleur), lues au démarrage sans rien demander ; fichier chiffré par le système sous Windows.
- **Assistant IA** qui voit toutes les données, au choix : **Claude** (recommandé) ou **OpenAI** avec une clé API (dans le Trousseau, jamais exposée à la page), ou **Qwen 3.5**, modèle open source exécuté par l'application elle-même (node-llama-cpp, Metal), téléchargé depuis les réglages, sans clé ni envoi de données.
- Thèmes **clair / sombre / système**, interface en CSS natif, sans bibliothèque de composants.

Le mode d'emploi complet est dans **[docs/GUIDE-UTILISATEUR.md](docs/GUIDE-UTILISATEUR.md)**. Il est aussi lisible dans l'application, page *Aide*.

![Tableau de bord](docs/img/dashboard.png)

## Démarrage

Il faut Node.js 22.12 ou plus récent.

```bash
npm install
npm run dev          # Angular (http://localhost:4200) + Electron avec rechargement
npm run start:prod   # build de production puis lancement d'Electron
npm test             # tests unitaires : Vitest (Angular) puis Vitest (process principal)
```

`npm run dev:ng` lance seulement l'interface dans un navigateur. Sans Electron, les données sont alors conservées dans le `localStorage` du navigateur, et l'assistant IA ainsi que la lecture de photo sont désactivés.

Un fichier `.npmrc` local force le registre public `registry.npmjs.org`.

## Construire les installeurs

```bash
./release/build.sh       # release/consoelec-<version>-mac-arm64.dmg (macOS uniquement)
./release/build-win.sh   # release/consoelec-<version>-win-x64.exe (installeur NSIS)
```

Les scripts lancent `npm ci` si les dépendances manquent ou sont périmées, puis les tests, puis `npm run dist:mac` ou `npm run dist:win`.

- L'installeur Windows se construit depuis un Mac sans Wine. Sur Apple Silicon, il faut Rosetta 2 : `softwareupdate --install-rosetta --agree-to-license`.
- Sur un PC Windows, lancer directement `npm ci && npm run dist:win`.
- La configuration est dans [`electron-builder.yml`](electron-builder.yml) et les icônes dans [`build/`](build).

Les paquets ne sont pas signés. Sur macOS, lever la quarantaine avec `xattr -dr com.apple.quarantine /Applications/ConsoElec.app`. Sur Windows, SmartScreen demande « Exécuter quand même ».

## Vidéo de présentation

```bash
npm run video   # docs/video/consoelec-presentation.mp4 (≈ 3 min, voix off et sous-titres)
```

Playwright pilote l'interface dans Google Chrome avec des données de démo et des lectures Wi-Fi simulées (compteur P1, onduleur), un jour d'été vers 13 h. Il faut macOS (voix off par `say`) et ffmpeg (`brew install ffmpeg`) ; `ng serve` est lancé s'il ne tourne pas déjà. Le scénario (textes, gestes) est dans [`scripts/video/scenes.mjs`](scripts/video/scenes.mjs).

Le MP4 n'est pas dans le dépôt (il est ignoré par git) : la dernière version est jointe à la [release `video-2026-11`](https://github.com/warnonphilippe/consoelec/releases/tag/video-2026-11).

## Émulateurs d'onduleurs et de lecteurs P1

Pour essayer une marque qu'on n'a pas, `npm run emulate` lance sur le Mac de faux onduleurs et de faux lecteurs P1. Chacun parle le protocole de sa marque. Au démarrage, la commande affiche les réglages à saisir dans ConsoElec : marque ou type de lecteur, adresse, port, et selon le cas identifiant Modbus, numéro de série de la clé Wi-Fi, clé, mot de passe ou jeton.

```bash
npm run emulate                    # tous, sur 127.0.0.1
npm run emulate -- huawei solis    # seulement ceux-là
npm run emulate -- p1-dsmr         # un seul lecteur P1
npm run emulate -- --lan deye      # sur l'adresse IP du Mac, avec réponse à la recherche des clés Wi-Fi
npm run emulate -- --list          # liste des émulateurs
```

Ctrl+C arrête tous les émulateurs. La commande compile `scripts/emulators/` avec esbuild dans un dossier temporaire, sans rien écrire dans le dépôt. Les émulateurs HTTPS génèrent leur certificat avec `/usr/bin/openssl`.

### Onduleurs

Chaque émulateur garde toujours le même port, qu'on le lance seul ou avec les autres.

| Nom | Port | Ce qui est émulé | Réglages à saisir |
|---|---|---|---|
| `sma` | 15001 | SMA WebConnect en HTTPS, connexion SRP | clé affichée au démarrage |
| `sma-ancien` | 15002 | SMA WebConnect ancien, connexion par mot de passe | mot de passe affiché au démarrage |
| `fronius` | 15003 | Fronius Symo, Solar API (HTTP) | — |
| `fronius-gen24` | 15004 | Fronius GEN24, sans production du jour dans la réponse | — |
| `solaredge` | 15005 | SolarEdge, Modbus TCP SunSpec (entiers et facteurs d'échelle) | identifiant 1 |
| `kostal` | 15006 | Kostal Plenticore, Modbus TCP SunSpec | identifiant 71 |
| `sunspec-float` | 15007 | SunSpec en flottants (modèle 113), comme certains Fronius | identifiant 1 |
| `huawei` | 15008 | Huawei SUN2000 par SDongle, Modbus TCP, réponses retardées de 20 ms | identifiant 1 |
| `sungrow-sg` | 15009 | Sungrow SG par WiNet-S, Modbus TCP | identifiant 1 |
| `sungrow-sh` | 15010 | Sungrow SH hybride par WiNet-S, Modbus TCP | identifiant 1 |
| `solis` | 15011 | Solis par clé Solarman (protocole V5) | n° de série 2712345678 |
| `solis-modbus` | 15012 | Solis en Modbus TCP direct | identifiant 1 |
| `goodwe-et` | 15013 | GoodWe ET hybride (UDP) | identifiant 247 (0xF7) |
| `goodwe-dt` | 15014 | GoodWe DT réseau (UDP) | identifiant 127 (0x7F) |
| `deye` | 15015 | Deye SUN-G par clé Solarman | n° de série 2712345678 |
| `sofar` | 15016 | Sofar KTL-X par clé LSW-3 (Solarman) | n° de série 2712345678 |
| `enphase` | 15017 | Enphase IQ Gateway en HTTPS | jeton affiché au démarrage |

Dans ConsoElec : *Réglages › Onduleur*, choisir la marque, puis saisir l'adresse, le port et les réglages de la dernière colonne.

Tous les onduleurs partagent une journée solaire simulée à l'heure du Mac. La puissance suit une cloche entre 7 h et 20 h, avec une crête de 4 800 W et quelques passages nuageux réguliers, et elle est nulle la nuit. La production du jour et l'index total (environ 21 345 kWh) avancent en cohérence avec la puissance. Les valeurs sont déterministes : deux lectures au même instant donnent le même résultat.

### Lecteurs P1

| Nom | Port | Ce qui est émulé |
|---|---|---|
| `p1-homewizard` | 15101 | HomeWizard Wi-Fi P1, API v1 (HTTP) |
| `p1-homewizard-v2` | 15102 | HomeWizard Wi-Fi P1, API v2 (HTTPS, association par le bouton) |
| `p1-chargee` | 15103 | Chargee Sparky |
| `p1-youless` | 15104 | YouLess LS120 |
| `p1-dsmr` | 15105 | Télégramme P1 brut sur TCP, d'un compteur Fluvius e-MUCS |

Dans ConsoElec : *Réglages › Compteur*, choisir le type de lecteur, puis saisir l'adresse et le port. Pour la HomeWizard v2, cliquer sur « Associer ». L'émulateur simule l'appui sur le bouton de l'appareil à la troisième demande, puis délivre le jeton.

Le compteur simulé soustrait la production solaire (le même modèle que les onduleurs) de la consommation d'une maison : talon, repas, soirée et quelques pointes. Le surplus part en injection et le manque en soutirage. Les index avancent sur le tarif 1 (jour) ou 2 (nuit de 22 h à 7 h et week-ends). Le télégramme donne aussi la moyenne du quart d'heure en cours, qui sert au tarif capacitaire.

### Sur le réseau local (`--lan`)

Avec `--lan`, les émulateurs écoutent sur toutes les interfaces et affichent l'adresse IP du Mac. Un autre ordinateur du réseau peut alors les lire. Si un émulateur à clé Wi-Fi est lancé (Solis, Deye, Sofar ou GoodWe), le premier de la liste répond aussi à la recherche de clés Wi-Fi de ConsoElec (diffusion WIFIKIT sur le port UDP 48899). Une seule réponse est possible, et rien n'est annoncé si le port est déjà pris. La recherche Bonjour (SMA, Enphase, lecteur P1) n'est pas émulée : il faut saisir l'adresse à la main.

### Certificats épinglés

Les émulateurs HTTPS (`sma`, `sma-ancien`, `enphase`, `p1-homewizard-v2`) créent un nouveau certificat auto-signé à chaque lancement. Pour l'onduleur, ConsoElec épingle le certificat à la première connexion, donc la connexion est refusée après un redémarrage de l'émulateur. Il faut alors cliquer sur « Oublier le certificat épinglé » dans *Réglages › Onduleur*, puis tester à nouveau la connexion.

### Tests et limites

Les mêmes émulateurs ([`scripts/emulators/`](scripts/emulators)) servent aux tests de bout en bout (`electron/inverters/inverters.spec.ts`, `electron/p1-readers/p1-readers.spec.ts`). Leurs registres sont écrits d'après la documentation des fabricants, indépendamment des tables du client : ils vérifient le transport, le décodage et les échelles, pas la documentation elle-même. Seul l'onduleur SMA a été essayé sur un vrai appareil.

## Widget macOS

Le dossier [`widget/`](widget) contient un vrai widget WidgetKit, « ConsoElec Widget », qui lit l'onduleur SMA lui-même (même ConsoElec fermée) et affiche la puissance instantanée, la production du jour, la courbe de la journée et l'index total.

- **Prérequis** : Xcode 26, XcodeGen (`brew install xcodegen`), un identifiant Apple ajouté dans Xcode → Réglages → Comptes (« Personal Team » gratuite suffit).
- Copier `widget/Local.xcconfig.example` en `widget/Local.xcconfig` et y mettre son identifiant d'équipe (`DEVELOPMENT_TEAM`). Ce fichier n'est pas versionné.
- `./widget/build.sh` génère le projet Xcode depuis [`widget/project.yml`](widget/project.yml), lance les tests, construit en Release et installe `/Applications/ConsoElec Widget.app`.

Structure :
- `widget/SmaKit` : paquet Swift, port de `electron/sma-core.ts` (connexion SRP « YAP » 8192 bits, lecture des mesures, épinglage du certificat, stockage partagé). `swift run -c release smakit-check Tests/srp-vectors.json` vérifie les vecteurs et mesure la durée d'une connexion (≈ 300 ms).
- `widget/App` : petite app de réglage (adresse trouvée par Bonjour, clé WPA2-PSK rangée dans le Trousseau, test, aperçu).
- `widget/Extension` : extension WidgetKit (petit et moyen formats), rafraîchie toutes les 5 minutes environ (c'est macOS qui décide).
- `widget/Tests` : tests XCTest, dont les vecteurs SRP produits par `scripts/srp-vectors.mjs` à partir de l'implémentation TypeScript (`npm run build:main` d’abord).

### iPhone

L'app iPhone « ConsoElec » et son widget (écran d'accueil et écran verrouillé) ne sont plus dans ce dépôt : ils vivent dans le dépôt privé [`warnonphilippe/consoelec-mobile`](https://github.com/warnonphilippe/consoelec-mobile). Prérequis, signature et installation sur l'iPhone (`./build-ios.sh`) y sont décrits.

## Architecture

```
electron/                  Process principal (TypeScript → dist-electron/)
  main.ts                  fenêtre durcie, protocole app://, IPC validé, thème natif
  preload.ts               pont contextBridge → window.consoElec
  storage.ts               fichier JSON (écriture atomique + copie .bak)
  keychain.ts              Trousseau macOS par /usr/bin/security (valeur passée sur l'entrée standard, relue)
  secret-store.ts          clés de l'app en mémoire : Trousseau (macOS) ou secrets.ts, import de l'ancien coffre
  secrets.ts               repli hors macOS : fichier chiffré par safeStorage (DPAPI)
  vault.ts, vault-core.ts  ancien coffre chiffré par la clé SSH, seulement relu pour l'import unique
  sma-core.ts, inverter.ts client WebConnect de l'onduleur SMA : SRP 8192 bits (ou mot de passe), mesures, journaux, épinglage
  inverters/                autres marques : hub.ts (choix du client selon la marque), local-client.ts, modbus.ts
                           (Modbus TCP et RTU), transports.ts (clé Solarman V5, GoodWe UDP), register-maps.ts,
                           sunspec.ts, fronius.ts, enphase.ts, scan.ts (diffusion WIFIKIT, balayage du réseau)
  p1-core.ts, p1.ts         lecteur P1 : HomeWizard API v1 et v2 (association par le bouton), Chargee, YouLess,
  p1-readers/              télégramme P1 brut sur TCP (dsmr.ts : norme e-MUCS / DSMR, CRC), formats JSON
  discovery.ts             recherche Bonjour de l'onduleur SMA, de la passerelle Enphase et du lecteur P1
  ai-core.ts               API Claude : requêtes, flux SSE, lecture de photo (sortie structurée), erreurs (pur, testé)
  ai.ts                    appels réseau depuis le process principal uniquement
  openai-core.ts, openai.ts API OpenAI (Responses) : requêtes, flux SSE, appel de fonction pour la photo (pur, testé)
  local-llm.ts             modèle Qwen local (node-llama-cpp) : téléchargement, réponses en flux, une à la fois
  image.ts                 conversion d'image en JPEG (HEIC des iPhone via sips sur macOS)
  shared/ipc-contract.ts   types partagés avec l'interface
  shared/inverter-brands.ts marques d'onduleurs : protocole, réglages par défaut, conseils de mise en service
  shared/p1-readers.ts     lecteurs P1 : protocole, port, recherche, mise en service
  shared/ai-models.ts      modèles OpenAI et Qwen proposés, choix automatique du moteur
src/app/
  core/models/             modèle de données, validation et fusion des fichiers importés (merge.ts)
  core/calc/               calculs purs et testés :
    solar.ts                 hypothèses solaires : jour, météo, courbe horaire
    reference.ts             modèle horaire de la maison : consommation, production, écrêtage, radiateur, HP/HC
    house-simulator.ts       maison simulée jour par jour (vérité terrain des tests, données de démo)
    backtest.ts              fiabilité des prévisions sur les mois passés
    consumption.ts           intervalles entre relevés, anomalies, répartition journalière saisonnière
    stats.ts                 indicateurs, tableaux annuels, moyennes mensuelles, saisons
    forecast.ts              profils de prévision et projection des quatre index
    ev.ts                    effet d'une voiture électrique sur chaque registre
    analysis.ts              assemblage complet utilisé par l'interface
    meter-log.ts             journal compact des index du port P1, relevés quotidiens, courbe du jour
    csv.ts, csv-import.ts    export et import CSV des relevés
  core/ai/                 contexte envoyé à Claude (instantané des données), service de conversation
  core/services/           DataStore (signals + sauvegarde auto), stockage, thème, toasts
  shared/                  icônes SVG, enveloppe Chart.js, panneau de l'assistant, lecture des photos
  pages/                   tableau de bord, compteurs, relevés, statistiques, prévisions, maison, réglages, aide
docs/                      guide utilisateur (embarqué dans l'app) et captures d'écran
release/                   scripts de build .dmg / .exe
```

### Données

Toutes les données sont dans un seul fichier JSON :

- macOS : `~/Library/Application Support/ConsoElec/consoelec.json`
- Windows : `%APPDATA%\ConsoElec\consoelec.json`

Les secrets (clés API Claude et OpenAI, clé de l'onduleur) sont dans le Trousseau macOS (service `io.github.warnonphilippe.consoelec`) ; sous Windows, dans `secrets.bin`, chiffré par le système. Ils ne sont ni exportés ni synchronisés.

En développement, `CONSOELEC_USER_DATA=/un/dossier` isole les données. `CONSOELEC_API_URL=http://127.0.0.1:…/v1/messages` redirige les appels Claude vers un serveur de test local, et `CONSOELEC_OPENAI_API_URL=http://127.0.0.1:…/v1/responses` ceux d'OpenAI (ignorés dans l'application packagée). Les modèles Qwen téléchargés sont dans `<userData>/models`.

### Dossier des modèles partagé

Les fichiers GGUF peuvent être partagés avec les autres applications locales (ConsoElec, ConsoMazout, Assistant RAG, Plan Rando) pour ne télécharger qu'une fois un même modèle. Le dossier est choisi dans cet ordre :

1. variable d'environnement `LOCAL_MODELS_DIR` (chemin absolu, `~` accepté) ;
2. clé `modelsDir` du fichier commun `~/.config/local-models/config.json`, par exemple `{ "modelsDir": "~/models" }` ;
3. sinon le dossier propre à l'application, `<userData>/models` (comportement historique).

Le fichier commun est conseillé sur macOS : une application lancée depuis le Finder ne voit pas les variables du terminal. Dans un dossier partagé, supprimer un modèle depuis une application le supprime pour toutes.

### Lien avec ConsoMazout

ConsoElec et ConsoMazout échangent un résumé de leurs estimations par le dossier `~/.config/conso-maison` (`consoelec.json`, `consomazout.json` ; `~/.config/conso-maison-dev` pour `npm run dev`, ou la variable `CONSO_MAISON_DIR`). Chaque application publie le sien à chaque changement (jamais les données de démonstration) et lit celui de l'autre : l'assistant IA le reçoit dans son contexte et peut croiser électricité et mazout (1 L ≈ 10 kWh), et le cadre « Chauffage au mazout » (page Prévisions, plaçable sur le tableau de bord) le résume. Le format est décrit dans `src/app/core/link/household-summary.ts`, recopié à l'identique dans ConsoMazout.

Le serveur MCP `mcp/` expose ces deux résumés à Claude Desktop ou Claude Code : voir [mcp/README.md](mcp/README.md).

### Les quatre index du compteur

Un relevé contient les quatre index cumulés en kWh : soutirage heures pleines (1.8.1) et creuses (1.8.2), injection heures pleines (2.8.1) et creuses (2.8.2), plus, en option, l'index de production solaire de l'onduleur. La consommation entre deux relevés est la différence des index. Elle est répartie jour par jour au prorata d'un poids saisonnier propre à chaque registre (soutirage : consommation avec part hivernale ; injection et production : profil solaire), de sorte que les totaux mensuels restent réalistes même avec des relevés espacés. Un mois n'entre dans les moyennes que s'il est entièrement couvert.

### Données de référence

- Consommation annuelle de référence : 3 500 kWh/an pour 4 personnes sans chauffage électrique (réglable ; la VREG cite 3 305 kWh en moyenne en Flandre, les comparateurs 3 200 à 3 500 kWh pour 3 à 4 personnes).
- Production : 850 kWh/kWc/an (Bruxelles Environnement : 840 kWh/kWc, plein sud à 35°) répartis selon un profil mensuel de type PVGIS.
- Saisonnalité de la consommation : degrés-jours 15/15 normaux à Uccle (IRM).

Ce sont des ordres de grandeur, tous modifiables dans les réglages.

## Licence

Le code source est disponible sous licence [PolyForm Noncommercial 1.0.0](LICENSE) :

- ✅ télécharger, installer et utiliser l'application pour un usage personnel ou non commercial ;
- ✅ lire, modifier et partager le code à des fins non commerciales, en conservant la licence ;
- ❌ vendre l'application, ou réutiliser tout ou partie du code dans un produit ou un service commercial.

Pour un autre usage, contactez l'auteur.
