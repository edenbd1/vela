# VELA

> **Le budget d'un agent IA n'est pas une règle. C'est un nombre dans une puce.**

ETHOnline 2026 · Deadline **dimanche 13 septembre 2026, 12:00 EDT (18:00 Paris)** · Solo
Tracks visées : **Ledger — AI Agents x Ledger** ($3 500) + **Hedera — AI & Agentic Payments** ($6 000) + 3ᵉ slot conditionnel

---

## 0 · Décisions actées

| | |
|---|---|
| Nom | **Vela** |
| Device | ⚠️ **Ledger Flex** — `target_id = 0x33300004`, build target SDK **`flex`** (pas `apex_p`). Vérifié sur device le 6 sept. : SE 1.6.1, MCU 6.9.2, onboardé, dashboard vide, `ledgerctl` OK |
| Track ancre | **Ledger fresh** (pas continuity : $3 500 vs $1 500, et Unlink n'est plus sponsor) |
| 2ᵉ slot | **Hedera — AI & Agentic Payments** |
| 3ᵉ slot | **Bazantic** si la console est accessible avant vendredi, sinon **Chainlink** |
| Repo | neuf, historique de commits réel. Le savoir-faire Lunave se réutilise, pas le code |

**Contrainte structurante :** 3 partner prizes max par soumission, mais toutes les tracks d'un même sponsor comptent pour 1 slot.

---

## 1 · La thèse

### Le problème

Quand tu donnes un budget à un agent autonome, tu le mets dans une variable. Un `.env`, une config, un `if (spent > limit)`. Donc **le budget est une suggestion** : compromets l'hôte, remplace le process, patche la ligne — le budget disparaît.

Les deux réponses actuelles sont mauvaises :
- **« l'agent demande, l'humain tape »** — inutilisable. Un agent qui fait 200 appels payants ne peut pas te réveiller 200 fois.
- **« un serveur de policy décide »** — c'est l'état de l'art (voir §2), et ça déplace le problème : maintenant il faut faire confiance à l'hôte du serveur de policy.

### L'insight

Toute la gouvernance de dépense d'agents aujourd'hui est **server-authoritative**. Vela est **device-authoritative**.

Le plafond, le compteur, l'allowlist et le kill switch vivent en **NVRAM dans un Secure Element EAL6+** (ST33K1M5). Prends le root sur la machine : tu ne peux toujours pas relever le plafond, ni forger une approbation, ni réécrire le compteur, ni dégeler un mandat.

Et la piste d'audit n'est pas sur la machine attaquable — elle est sur **HCS**, rejouable par un tiers.

### La phrase

> *« Il existe déjà de la gouvernance de dépense pour agents IA. Elle est bonne. Elle tourne dans un serveur — donc son plafond, ses clés et son journal sont sur une machine. Vela met le plafond dans un Secure Element certifié, et son journal sur un log public. Je vais lancer la même attaque contre les deux, devant vous. »*

## 1bis · Le use case — qui, quoi, pourquoi maintenant

### Le marché existe déjà, et il saigne

Ce ne sont pas des hypothèses. C'est 2026.

| Incident | Ce qui s'est passé |
|---|---|
| **Uber**, avril 2026 | Claude Code déployé à ~5 000 ingénieurs en déc. 2025. Usage doublé en février, 84 % d'usage agentique en mars. **Budget IA annuel épuisé en 4 mois.** |
| **Peter Steinberger**, mai 2026 | ~100 instances codex sur OpenClaw. 30 jours, **603 milliards de tokens, 7,6 M de requêtes, plus de 1,3 M$** |
| **Microsoft** | annulation de la plupart des licences Claude Code internes — factures de tokens ingérables à l'échelle |
| **Boucle LangChain**, nov. 2025 | 4 agents entrent en boucle infinie, tournent **11 jours**, facture **47 000 $** |
| Agent AWS | **6 531 $** de facture en scannant un réseau domestique |

Et la couche paiement arrive par-dessus : x402 a traité **165 M de transactions pour ~69 000 agents actifs** (~50 M$ cumulés — dont environ la moitié de test, il faut le dire honnêtement). Juniper projette **8 Md$ de commerce agentique en 2026**, McKinsey 3 à 5 T$ d'ici la fin de la décennie.

**Le passage critique :** hier un agent qui déraille gaspillait des *tokens*. Aujourd'hui il a un wallet. Ce qui était une facture devient un vol.

### L'arc narratif — et il est honnête

Il y a deux modes de défaillance, et ils n'appellent pas la même réponse.

**1. L'agent stupide.** Boucle infinie, retry en cascade, prompt qui part en vrille. Uber, les 47 000 $, les 1,3 M$.
→ **Un plafond logiciel corrige ça.** SpendVeto le fait très bien. **Ce n'est pas le différenciateur de Vela — c'est ce qui a créé le marché.**

**2. L'agent compromis.** Hôte rooté, process remplacé, prompt injection qui redirige le paiement.
→ **Ici tout plafond logiciel tombe**, parce qu'il vit sur la machine qu'il est censé surveiller. **C'est là que Vela est seul.**

> **Le mode 1 a créé le marché. Le mode 2 est la raison pour laquelle la réponse actuelle du marché ne suffira pas.**
> Et le mode 2 cesse d'être théorique au moment précis où les agents reçoivent un wallet : il n'y a plus des tokens à gaspiller, il y a de l'argent à voler.

### Qui

**L'opérateur d'agents qui tournent sans surveillance.** Trois cercles concentriques :

| Cercle | Douleur | Ce que Vela apporte |
|---|---|---|
| **Le builder solo** | « j'ai donné une clé à mon agent et je dors mal » | une enveloppe qu'il ne peut pas dépasser, même compromis |
| **L'agence / la plateforme** | l'agent dépense le budget d'un client ; il faut le **prouver** au client | `vela verify` : le client vérifie l'enveloppe **sans avoir à te faire confiance** |
| **L'entreprise** | EU AI Act Art. 14 — supervision humaine démontrable, capacité d'interruption | une policy logicielle est une déclaration ; une policy matérielle est une **preuve** |

### Le scénario de démo : le desk de recherche de nuit

Un agent surveille un ensemble de positions et de marchés pendant la nuit, et produit un briefing au matin. Pour travailler il doit **acheter** : de l'inférence (au token), de la donnée (à la requête).

Pourquoi ce scénario et pas un autre :

- **Le coût est variable et imprévisible.** Une nuit agitée = plus d'appels. Tu ne *peux pas* calculer le budget à l'avance — donc il te faut une **enveloppe**, pas un montant. C'est ce qui rend le plafond nécessaire plutôt que décoratif.
- **Tu dors.** L'autonomie n'est pas un confort, c'est la condition.
- **L'escalade a du sens.** Nuit exceptionnelle → l'agent demande → ton device s'allume **une fois**, pas deux cents.
- **Ça génère du trafic Hedera** — ce qui compte pour les 20 % « Success » du rubric.
- **Les gens le font déjà.**

### La primitive — la phrase à retenir

> ### « Un reçu prouve ce qu'un agent a dépensé. Vela prouve ce qu'il ne *pouvait pas* dépenser. »

C'est une primitive neuve. Aujourd'hui un agent peut prouver qu'il a payé. Il ne peut pas prouver qu'il **ne pouvait pas** surpayer.

Vela produit exactement ça : un log public, signé par le device, qui montre l'enveloppe et chaque tirage dessus. Tu peux tendre à un inconnu la preuve que ton agent était borné — sans lui donner accès à quoi que ce soit.

**Preuve de retenue.** Personne ne la produit aujourd'hui.

### Les trois couches, à ne pas confondre

| Couche | Ce que c'est | Où elle sert |
|---|---|---|
| **Scénario** | le desk de recherche de nuit | la démo vidéo, 4 min 30 |
| **Produit** | l'enveloppe de dépense de quiconque opère des agents pour quelqu'un d'autre | le Lean Canvas, le GTM |
| **Primitive** | la preuve de retenue | la phrase d'ouverture, le README |

---

## 1ter · Le pivot DeFi et le catalogue d'idées

**Décision du 5 sept. (soir) :** l'angle « plafond de dépense d'API pour agent » est trop petit. Les montants sont dérisoires, c'est un produit FinOps, et la valeur d'une limite matérielle est **proportionnelle à ce qu'il y a derrière**. On pointe le même moteur vers du capital.

**Ce qui ne change pas :** `mandate_t` en NVRAM, reserve/release, allowlist, expiration, escalade, kill switch, log HCS signé, re-vérification des bodyBytes, `vela verify`, mode software témoin, attaque contrôlée. **Tout le travail dur transfère.**

**Ce qui change :** ce que le mandat gouverne.

| Avant | Après |
|---|---|
| quel service je peux payer | **quel venue je peux toucher** (allowlist d'adresses) |
| combien par appel | **combien par trade** |
| budget d'inférence | **taille de position max** |
| — | assets autorisés, slippage max |

Tout est vérifiable **on-chip depuis les octets de la transaction seuls**. Aucun oracle requis.
Faisabilité confirmée : `app-hedera` contient `fuzzing/fuzzer_evm_payload.c` + corpus `selector.bin` / `minimal_calldata.bin` → **l'app officielle décode déjà du calldata EVM sur device.**

### 🔑 La propriété qui tue

> # « L'agent peut gagner. Il ne peut pas prendre. »

Le mandat encode : l'agent déplace des fonds **entre venues approuvés**, mais la seule adresse de sortie possible est **la tienne**. Vanne à sens unique, dans le silicium. Démontrable en 15 secondes.

### Le catalogue d'idées

#### 🥇 1. Mandats non-custodiaux — « confie ton capital, pas tes clés »
Tes fonds restent sur ton compte. Tu accordes un mandat à l'agent d'un stratège depuis ton Ledger. Il trade ton argent, sans pouvoir sortir ailleurs que chez toi, dépasser ta taille, ou toucher un venue non approuvé. Marché à deux côtés : les stratèges se battent pour des mandats, les utilisateurs ne cèdent jamais la garde.
⚠️ **Voir §2bis — l'équivalent on-chain existe déjà. La formulation doit être affinée.**

#### 🥈 2. Le prop desk d'agents
N agents de stratégie concurrents, chacun avec son enveloppe dans la puce. Ils farment sur plein de petites pools. Le meilleur reçoit plus à l'epoch suivante. **La puce est le risk manager du desk.**
Visuellement excellent (N barres d'enveloppe qui descendent) et **génère énormément de transactions Hedera** → les 20 % « Success ».
> *« La diversification est un contrôle de risque. Aujourd'hui c'est une ligne de config. Vela en fait une contrainte matérielle. »*

#### 🥉 3. Le stop-loss que rien ne peut lever
La puce refuse de signer sous un plancher de NAV. Tous les bots ont un stop-loss logiciel ; il rate (bug, désactivé, « juste cette fois »).
**Dépendance :** prix fiable on-chip → signature d'oracle vérifiée par la puce. Faisable via `plugins/oracles/chainlink-data-feeds` + `hedera-feeds.md` des skills Hedera officielles → **ferait de Chainlink un 3ᵉ slot naturel.**
**Statut : stretch goal, pas la ligne principale.**

#### 4. Trésorerie de DAO à agent borné
La DAO vote un mandat, chargé dans un device détenu par le multisig ; l'agent exécute dedans sans vote par action. Résout la latence de gouvernance.
**Statut :** bon, mais il faut une DAO à l'écran. Trop lourd pour 4 min.

#### 5. Assurance sur preuve de mandat
Un mandat matériel et vérifiable devient assurable : « j'assure ce vault parce que je peux prouver que le gérant ne peut pas dépasser 2x de levier. »
**Statut :** vision du Lean Canvas. Ne pas construire.

#### 🔥 6. Le mandat scellé — *issu de l'objection §2bis*
Tes contraintes de stratégie **sont** ton alpha. Les publier on-chain (Zodiac, ERC-7710), c'est publier ton alpha. Vela : le **hash** du mandat est public, le mandat vit dans la puce, et la conformité est prouvable.
**Un fonds peut prouver à ses LP qu'il n'a jamais franchi ses limites de risque sans révéler les limites.**
Saveur zero-knowledge sans ZK — le Secure Element est le calcul de confiance.
**Aucun smart contract ne peut servir cette catégorie.**

#### 🔥 7. Le mandat cross-chain unique
Une enveloppe, appliquée sur Hedera + Base + n'importe quoi, **parce que la puce gouverne la signature, pas un contrat**. Un mandat on-chain est par chaîne et par contrat, et deux mandats sur deux chaînes ne voient pas la dépense l'un de l'autre.
> *« Ton agent a un seul budget sur cinq chaînes, appliqué à un seul endroit. »*

#### 🔥 8. L'enveloppe unifiée : opex + capital
La même puce borne « 50 $ d'API et d'inférence » **et** « 10 000 $ de position ». Un seul nombre, deux natures de sortie.
**Structurellement impossible pour un smart contract** — aucun contrat ne peut gouverner un paiement d'API hors chaîne.

#### 9. La preuve de retenue comme réputation
Un agent accumule un historique public : N epochs, jamais de dépassement. Ça devient sa réputation → alimente le **ReputationRegistry ERC-8004, déployé sur Hedera testnet** (`0x8004B663056A597Dffe9eCcC1965A193B7388713`). Un agent prouve sa bonne conduite et obtient des mandats plus gros. Volant d'inertie.

---

## 2bis · ⚠️ L'objection sérieuse : les mandats on-chain existent déjà

**À trouver maintenant plutôt que sur scène.**

| Ce qui existe | Détail |
|---|---|
| **Zodiac Roles Modifier** (Gnosis Guild) | module de permissions on-chain pour Safe. Rôles granulaires : adresses, fonctions et **valeurs de paramètres** scopées. *« These rules are enforced by smart contracts at execution time, not by operational trust. »* Utilisé par **ENS DAO, GnosisDAO, Balancer** avec karpatkey. **Cite explicitement les agents IA.** |
| **ERC-7715 / ERC-7710** (MetaMask Delegation Toolkit) | `wallet_grantPermissions` — délégations scopées et bornées dans le temps pour session keys et wallets d'agents. ERC-7710 = le gestionnaire de délégation on-chain qui applique. **Exemple officiel : « un agent IA peut dépenser jusqu'à 10 USDC par jour pour acheter de l'ETH pendant 30 jours. »** C'est littéralement le mandat. Avec atténuation (ré-émission sous portée plus étroite). |
| **MetaMask Agent Wallet** (2026) | accès DeFi self-custody pour agents IA |

**Donc : « le mandat non-custodial pour agent IA » n'est pas un trou. C'est standardisé, et ça vient de MetaMask et Gnosis Guild.**

### Ce que le matériel ajoute vraiment — les 4 réponses honnêtes

| # | Ce qu'un mandat on-chain ne peut pas faire | Force |
|---|---|---|
| **1** | **Le mandat est public.** Une config Zodiac ou une délégation ERC-7710 est lisible on-chain. Tes limites de risque, ta liste de venues, tes plafonds — tout le monde les voit. C'est **exploitable** : front-run du rebalance, savoir exactement quand l'agent doit s'arrêter, connaître le plancher et pousser le prix dessus | 🔥🔥🔥 |
| **2** | **C'est par chaîne et par contrat.** Il faut déployer Safe + Roles sur chaque chaîne, et le mandat ne gouverne que ce que ce contrat peut faire. **Aucun contrat ne peut gouverner un paiement d'API hors chaîne** | 🔥🔥🔥 |
| **3** | **Une session key existe quelque part.** ERC-7715 génère une clé de session détenue par l'agent. Scopée, mais c'est une clé sur une machine : si elle fuit, l'attaquant obtient exactement le pouvoir délégué. Chez Vela il n'y a **aucune clé nulle part** — perte bornée contre perte nulle | 🔥🔥 |
| **4** | **Les fonds doivent vivre dans le smart account.** Tu as échangé le risque de custody de l'agent contre du risque de contrat. Chez Vela les fonds restent sur un compte simple, aucun contrat de plus dans le chemin de confiance | 🔥 |

### 🎯 La thèse affinée qui en sort

> ## Mandat privé. Preuve publique.
>
> Les mandats on-chain sont excellents — et ils sont **publics**, **par chaîne**, et **aveugles à tout ce qui se passe hors chaîne**.
> Le mandat de Vela est **privé**, **agnostique à la chaîne**, et il couvre à la fois **le capital que l'agent gère et l'argent qu'il dépense pour fonctionner**.
> Et il est **prouvable sans être révélé**.

On publie le **hash** du mandat et un log signé de chaque tirage. Un tiers vérifie « jamais dépassé » **sans apprendre les limites**.

C'est neuf, aucun smart contract ne peut le faire, et ça rejoue la force démontrée à NY (prix privacy sur Unlink).

**À écrire dans le README, section « Why not just a Safe with Zodiac Roles? »** — répondre avant qu'on demande.

---

## 2 · Le paysage concurrentiel

Recherche menée sur GitHub public le 5 septembre 2026. **Trois projets identifiés sur la track Hedera. Zéro sur la track Ledger fresh.**

### 2.1 `revanthrajeev/spendveto` — le concurrent conceptuel majeur

Apache-2.0 · créé le 21 août 2026 · **291 assertions e2e** · 14 chaînes / 7 familles de signature

> *« Spend governance for AI agents paying over x402. Payment rails move an agent's money; SpendVeto decides whether it should be allowed to move it — caps, budgets, human approvals and a kill switch, enforced before settlement. »*

**Leur `launch/ETHONLINE_2026.md` classe Hedera — AI & Agentic Payments ($6 000) comme leur cible n°1.** Ils notent que `hedera-testnet` règle déjà en live chez eux.

**Ce qu'ils ont :** `CONTROLS.md` avec **36 contrôles numérotés**, chacun mappé à l'EU AI Act Art. 12/14 et au NIST AI RMF, chacun avec son assertion de test. Moteur de policy, approbations HITL, délégation de budget à n niveaux, kill switch, ledger hash-chaîné, shadow mode, trust graph + counterparty bureau, panneau d'anomalies, dispute evidence packs, spans OpenTelemetry, serveur MCP, proxy de custody, SDK, adaptateurs LangChain / OpenAI Agents / Eliza, dashboard complet, policy packs importables.

**On ne les bat pas au nombre de features. On ne l'essaie pas.**

**Leur faille, structurelle.** Leur contrôle #2 s'appelle *« Server-authoritative enforcement »*, note de framework : *« NIST GOVERN — controls independent of the actor being governed »*. Ils sont indépendants de **l'agent**. Ils ne sont pas indépendants de **l'hôte**. Leur contrôle #9 (proxy de custody) : *« the proxy holds the keys and only signs after the full pipeline passes »*. Clés en logiciel, policy en JSON sur disque, ledger sur le même disque (hash-chaîné mais la tête de chaîne est au même endroit), kill switch = endpoint HTTP.

Leur #7 est tamper-**evident**. Le nôtre est tamper-**proof** sur la décision, et ancré hors de l'hôte.

**Incertitude à noter :** leur propre doc dit que les tracks continuity sont *« the relevant shape here »* pour un repo qui pré-existe. Ils pourraient donc viser la Hedera Continuity ($1 000) plutôt que le pot fresh. Non vérifiable.

### 2.2 `retailbox-automation/x402-work-receipts` — concurrent direct Hedera

Créé le 4 septembre 2026 (jour 1) · plan d'implémentation très carré, lanes parallèles

> *« Work orders and receipts between AI agents, paid with x402 on Hedera testnet through the Blocky402 facilitator, anchor every step on an HCS topic, verifiable from the public mirror node alone. »*

Deux organisations échangent un `mandate.v1` signé et des `receipt.v1`, paient intake + solde en x402, ancrent chaque étape sur HCS, et un verifier indépendant reconstruit `ordered → paid → delivered` depuis le mirror node public seul.

**Ils visent aussi :** Hedera Harness (PR séparée) et Bazantic.

**Leur force :** la vérifiabilité publique. Leur verifier ne fait confiance qu'au mirror node. Fixtures `golden/` + `tampered/`. Statement *« proves / does not prove »* imprimé à chaque run.

**Leur faiblesse :** aucune gouvernance. Ils prouvent qu'un paiement a eu lieu, pas qu'il était autorisé.

### 2.3 `krutftw/hedera-agentpay-guard` — troisième sur Hedera

Créé le 29 juillet 2026

> *« Signed policy receipts for Hedera x402 agent payments with HCS and Mirror Node verification »*

Même intersection : policy + x402 Hedera + HCS + vérification mirror node. Antérieur au hackathon donc probablement continuity, mais présent sur le même terrain.

### 2.4 Autres repérages

| Repo | Track visée |
|---|---|
| `craigmbrown/ethonline-sealed-bid` | Chainlink « Best Confidential Workflow » |
| `A1igator/rebalance` | Uniswap « Best Stack Contribution » |
| `rezon99/BlotChain-MEVShield` | Continuity |

### 2.5 Conclusion stratégique

**La track Hedera agentic est encombrée (3 projets connus, tous avec policy + HCS). La track Ledger fresh est vide.**

Donc : **ancrer sur Ledger, se servir de Hedera.** Et sur Hedera, ne pas concourir sur « gouvernance de dépense » (SpendVeto gagne au feature count) mais sur **l'intersection que personne n'a : enforcement matériel ET vérifiabilité publique.**

> SpendVeto a la gouvernance sans le hardware.
> work-receipts a la vérifiabilité sans la gouvernance.
> **Vela a les deux.**

---

## 3 · L'expérience contrôlée — l'idée centrale

Ne pas *affirmer* que le hardware change quelque chose. **Livrer les deux modes et faire la démonstration scientifique.**

```bash
GOVERNOR_MODE=software   # moteur de policy classique en Node — l'état de l'art
GOVERNOR_MODE=device     # la même API, compteur dans le Secure Element
```

Même API. Mêmes tests. Même agent. **Une seule variable change.**

Puis la même attaque contre les deux :

```
$ npm run attack -- --mode software
  [1/3] lecture de la policy sur disque ........ OK
  [2/3] plafond relevé 10 → 10000 HBAR ......... OK
  [3/3] paiement 500 HBAR vers l'attaquant ..... ✅ SETTLED
  → budget contourné en 1,4 s

$ npm run attack -- --mode device
  [1/3] lecture de la policy sur disque ........ rien à lire
  [2/3] tentative de relever le plafond ........ refusé — SW 0x6985
  [3/3] paiement 500 HBAR vers l'attaquant ..... ❌ REFUSED (budget_exceeded)
  → aucune signature produite
```

Un juge n'a rien à croire sur parole. Et tu n'attaques personne nommément : tu implémentes honnêtement l'état de l'art logiciel, et tu montres où il casse.

**C'est le meilleur artefact du projet. Il est non négociable.**

---

## 4 · Architecture

```
                    ┌──────────────────────────────────┐
                    │  Ledger Nano Gen5 (apex_p)       │
                    │  ┌────────────────────────────┐  │
   1 tap ──────────►│  │ app BOLOS "Vela"           │  │
   (mandat)         │  │ NVRAM: mandate_t[4]        │  │
                    │  │  budget_total / reserved   │  │
                    │  │  / spent / allowlist / TTL │  │
                    │  └────────────────────────────┘  │
                    └───────────────┬──────────────────┘
                                    │ APDU (HID, série)
                    ┌───────────────▼──────────────────┐
   secrets scellés  │  vela-host (laptop)              │
   Key Ring/LKRP ──►│  bridge + API + mode software    │
                    └───────────────┬──────────────────┘
                                    │ capability tokens (jamais la clé)
                    ┌───────────────▼──────────────────┐
                    │  agent (VPS, sans USB)           │
                    │  enrôlé via `vela ring enroll`   │
                    └───────┬──────────────────┬───────┘
                            │ x402/Blocky402   │ HCS
                    ┌───────▼───────┐  ┌───────▼───────┐
                    │ 2 endpoints   │  │ topic audit   │
                    │ d'inférence   │  │ public        │
                    │ (Hedera)      │  │               │
                    └───────────────┘  └───────┬───────┘
                                               │
                                       ┌───────▼───────┐
                                       │ vela verify   │
                                       │ mirror node   │
                                       │ SEUL          │
                                       └───────────────┘
```

### 4.1 L'app BOLOS — le cœur

Pas un signer. **Une machine à états avec mémoire persistante.**

```c
typedef struct {
    uint8_t  mandate_id;
    uint8_t  agent_id_hash[20];       // ERC-8004 / HCS-14
    uint64_t budget_total;             // tinybars
    uint64_t reserved;                 // autorisé, pas encore réglé
    uint64_t spent;                    // réglé
    uint64_t per_call_max;
    uint32_t epoch_expiry;
    uint8_t  allowed_services[4][32];  // sha256 des domaines
    uint32_t seq;                      // anti-rejeu
} mandate_t;                           // stocké en NVRAM, N_storage

// Budget disponible = budget_total - reserved - spent
```

**Cinq APDU :**

| APDU | Tap | Comportement |
|---|---|---|
| `CREATE_MANDATE` | ✅ | écran NBGL : agent, budget, services, expiration. Écrit en NVRAM |
| `AUTHORIZE_SPEND` | ❌ | **chemin chaud.** Vérifie expiration + service + `per_call_max` + `reserved+spent+amount ≤ total`, **re-sérialise et compare les bodyBytes** (§4.4bis). **Réserve** (`nvm_write`), puis signe le `TransferTransaction` Hedera en ECDSA |
| `SETTLE_CONFIRM` | ❌ | `reserved -= quoted; spent += actual`. **Libère le reliquat** |
| `ESCALATE` | ✅ | l'écran s'allume, affiche exactement la demande hors mandat |
| `REVOKE` | ✅ | kill switch. Le mandat meurt |

**Réservation, pas débit** (inspiré du problème `upto` de SpendVeto §6) : sans ça, dix autorisations ouvertes de 5 HBAR passent un plafond de 6 HBAR parce qu'aucune n'a encore réglé. La puce tient le plafond ouvert comme une pré-autorisation de carte.

**Liaison à la requête** (inspiré de leur contrôle #28) :

```
le device signe sur :
  H( mandate_id ‖ service_hash ‖ amount ‖ nonce ‖ H(canonical(request)) )
→ usage unique, TTL borné, scopé à l'agent
→ un payload échangé après autorisation est refusé
```

**Crypto : secp256k1 uniquement.** Plus de Poseidon, plus de BabyJubJub, plus de `cx_bn` cassé. Ce qui est neuf et dur, c'est l'état NVRAM et la machine à états — pas la crypto.

**Trois propriétés gratuites que personne n'a :**
1. **Pas de race condition.** L'APDU est série, une commande à la fois, l'incrément est dans la puce. SpendVeto a dû ajouter un lock par wallet (leur #16) ; ici c'est structurellement impossible.
2. **Le compteur survit à tout** — reboot, redéploiement, remplacement de l'agent, root sur l'hôte.
3. **L'audit est hors de la machine attaquable.**

**Contraintes BOLOS à respecter :**
- `nvm_write` a un coût et une endurance en écriture → batcher, ne pas réécrire octet par octet
- gérer l'app tuée en plein write
- **la NVRAM est effacée à la réinstallation de l'app** → ne jamais réinstaller entre la répétition et l'enregistrement de la vidéo
- garder `mandate_t[4]` max (taille de stockage limitée)

### 4.2 Le host

`vela-host` : bridge APDU sur HID + API HTTP pour les agents + implémentation du **mode software** derrière la même interface.

Réutiliser de Lunave : le retry d'énumération HID (~8 s sur le transitoire d'app-switch), le pattern APDU pour champs longs, la structure des écrans NBGL de review.

**Refus structurés** (inspiré de SpendVeto #12) : le status word APDU mappe vers un code machine + une correction concrète renvoyée à l'agent, pour qu'il se corrige au lieu de boucler en retry.

**Fail closed** sur timeout d'approbation. Non négociable.

### 4.3 Key Ring / LKRP — et le vrai problème à résoudre

**Faits vérifiés** (source : `LedgerHQ/agent-skills` + `ledger-live/.agents/skills/`) :

- Provisionné une fois via l'app **Ledger Sync**, device requis (`ring init`)
- Ensuite `encrypt`/`decrypt` tournent **sans device** — clés dérivées en **HKDF-SHA256** depuis la racine LKRP, **AES-256-GCM**
- Chaque invocation appelle quand même le backend LKRP pour **restaurer la trustchain** → réseau requis
- **Récupérable depuis la seed** sur n'importe quelle machine, pas de coffre externe
- Trustchain application id : Ledger Sync = 16, **wallet-cli ring = 17**
- `WALLET_PASS` fourni par le développeur dans l'environnement — **jamais par l'agent**
- ⚠️ Les commandes `ring` exigent `dangerouslyDisableSandbox` si pilotées depuis Claude Code (accès keychain OS)
- ⚠️ Jamais deux commandes device en parallèle

**Limite majeure :** *« the ring commands encrypt with a per-user Ledger Key Ring, not a sharable key »* — **pas de chiffrement multi-destinataires.** Donc impossible de donner à chaque agent sa propre clé de ring.

→ **L'archi tient et devient plus propre : le host déchiffre, les agents reçoivent des capability tokens.** Le secret ne se partage jamais. C'est exactement le bullet 1 de Ledger.

#### 🎯 `vela ring enroll` — le bullet 2 est un problème ouvert

Pour déchiffrer, une machine doit être **membre de la trustchain**. Devenir membre passe par `ring init`, **qui exige le device physique**. Un VPS n'a pas de port USB.

Le bullet #2 de Ledger — *« Bring the Key Ring to hosts with no USB port: enroll a VPS, a CI runner, or a hosted agent »* — **n'est pas une feature à câbler. C'est un problème ouvert qu'ils demandent à quelqu'un de résoudre.**

LKRP est fait pour ça (*« multiple applications or multiple instances of the same application to access a shared secret »*). La solution :

```
1. le VPS génère une paire de clés membre, localement
2. il envoie sa clé publique au laptop
3. le laptop, device branché, signe l'ajout du membre à la trustchain  → 1 tap
4. le VPS dérive désormais les clés du ring — sans avoir vu le device,
   ni la seed, ni un secret en clair
5. révocation du membre depuis le device à tout moment
```

Références : `ledger-live/docs/ledger-sync/02-trustchain-sdk.md` et `07-app-integration.md`.

**C'est le deuxième morceau dur et original du projet. Candidat à une proposition upstream.**

⚠️ Faire `ring init` et le scellement **avant** la démo. Après provisioning, plus besoin du device pour encrypt/decrypt → **zéro app-switching pendant l'enregistrement** (la friction contournée à NY disparaît par construction).

### 4.4 Hedera

**Le service payant (obligatoire pour la track) :** deux endpoints d'inférence x402 à des prix différents, **facturés au token consommé** (pas au forfait) → coche l'extra point *« pay-per-call metering rather than a flat charge »*.

**Spécifications Blocky402 vérifiées :**

| | |
|---|---|
| Facilitator | `https://api.testnet.blocky402.com` |
| Endpoints | `GET /supported` · `POST /verify` · `POST /settle` · `GET /health` |
| Network | `hedera:testnet` (CAIP-2) |
| Asset HBAR | `0.0.0`, montants en **tinybars** |
| Packages | `@x402/core`, `@x402/hedera`, `@x402/express`, `@x402/fetch` — **2.24.0** |
| SDK | `@hiero-ledger/sdk` **2.85.0 (pinné)** |
| Entry points | `@x402/hedera/exact/server` · `/exact/client` · `/exact/facilitator` |
| Mirror node | `https://testnet.mirrornode.hedera.com/api/v1/*` |
| Modèle | non-custodial : le facilitator ajoute seulement la signature **fee-payer** à un transfert déjà autorisé par l'acheteur |
| Ton resource server | n'a besoin que de `FACILITATOR_URL` — **pas** de la clé privée |

**Gotchas (coûtent une journée si on ne les connaît pas) :**

1. **Le client doit opter pour HBAR** : `setSpendControls({ allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment }] })`
2. **Format d'ID de transaction** : le facilitator renvoie `0.0.X@sec.nanos`, le mirror node veut `0.0.X-sec-nanos`. **Une seule fonction de conversion**, rien d'autre ne compare d'ids
3. **`extra.feePayer`** vient du `/supported` du facilitator — **jamais en dur**
4. **`payTo` doit être un vrai compte `0.0.x`** — le facilitator **rejette les alias**
5. Le facilitator a besoin d'un **compte ECDSA dédié et financé** — jamais le deployer ni le wallet vendeur
6. Le payeur ne paie que le prix de la ressource ; le facilitator porte les frais réseau. L'agent payeur n'a jamais à raisonner sur le gas

**Forme du code (resource server) :**

```ts
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("hedera:testnet", new ExactHederaScheme());

app.use(paymentMiddleware({
  "GET /infer": {
    accepts: {
      scheme: "exact",
      network: "hedera:testnet",
      payTo: PAY_TO,                                   // vrai 0.0.x
      price: { asset: "0.0.0", amount: PRICE_TINYBARS },
      maxTimeoutSeconds: 120,
    },
  },
}, resourceServer));
```

**Extra points Hedera, quasi gratuits une fois le socle posé :**

| Extra point | Implémentation |
|---|---|
| Audit trail vérifiable sur HCS | chaque mandat, autorisation, escalade, révocation, règlement → un topic |
| Identité on-chain ERC-8004 / HCS-14 | identité de l'agent, **controller = la clé d'autorité du Ledger** |
| Scheduled Transactions | recharge automatique du budget à chaque epoch |
| HTS + custom fee schedule | dans le chemin de règlement |
| Metering pay-per-call | facturation au token, pas au forfait |
| Agent discovery / directory | via Bazantic (§4.9) ou un registre |

### 4.4bis · 🔥 La couture de signature — le point qui rend la thèse vraie

En lisant la skill x402 officielle, un détail change tout :

```ts
new x402Client().register(network, new ExactHederaScheme(signer))
```

> *« Signer builds a native HBAR transfer: debit buyer, credit `requirements.payTo`, amount in tinybars. »*

Le schéma x402 Hedera prend un **signer injectable**. Et le flux est :

```
Buyer → GET ressource
   └─ 402 PAYMENT-REQUIRED
        → le client SIGNE un TransferTransaction        ← ★ le moment décisif
        → retry avec PAYMENT-SIGNATURE
        → le facilitator co-signe en fee payer et soumet
```

L'acheteur **signe partiellement** un `TransferTransaction` natif. Le facilitator n'ajoute que la signature *fee payer*.

#### Deux architectures possibles — une seule est honnête

**Design A (faible).** Le device signe un « jeton d'autorisation », et le host détient la clé Hedera qui signe le vrai transfert.
→ **Le host garde le pouvoir de dépenser.** Un attaquant root signe des transferts directement, sans jamais parler à la puce. **La thèse s'effondre.**

**Design B (correct).** La clé Hedera ECDSA de l'acheteur est **dérivée dans le Secure Element**, et c'est **la puce qui produit la signature partielle du `TransferTransaction`**, uniquement après que la policy on-chip est passée.
→ **L'agent n'a pas de clé. Le host n'a pas de clé. Seule la puce peut produire la signature de l'acheteur.**

**Vela implémente le Design B. C'est non négociable — c'est ce qui fait la différence entre une affirmation et un fait.**

Bonne nouvelle : les comptes Hedera acceptent **ECDSA secp256k1**, exactement la courbe que le boilerplate déclare (`CURVE_APP_LOAD_PARAMS = secp256k1`). Aucune crypto exotique. Le facilitator lui-même exige de l'ECDSA.

#### Le flux complet, corrigé

```
1. agent → GET /infer                            → 402 PAYMENT-REQUIRED
2. agent → vela-host /authorize {service, amount, request_digest}
3. host  → construit le TransferTransaction (buyer→payTo, tinybars)
           → en extrait les bodyBytes
4. host  → APDU AUTHORIZE_SPEND {bodyBytes, service_hash, request_digest}
5. PUCE  → vérifie expiration, allowlist, per_call_max, budget disponible
           → VÉRIFIE QUE LES bodyBytes CORRESPONDENT À CE QU'ELLE AUTORISE
           → reserved += amount   (nvm_write)
           → signe les bodyBytes en ECDSA        ← la signature de l'acheteur
6. host  → assemble le header PAYMENT-SIGNATURE
7. agent → retry → le facilitator co-signe en fee payer, soumet, SUCCESS
8. host  → ancre {seq, amount, remaining_after, sig_device} sur HCS
9. host  → APDU SETTLE_CONFIRM → reserved -= quoted ; spent += actual
```

#### Le point critique : l'étape 5, ligne 3

Si la puce signe des `bodyBytes` qu'elle n'a pas vérifiés, le host peut mentir : demander l'autorisation pour 1 HBAR vers un service autorisé, puis présenter des `bodyBytes` de 500 HBAR vers l'attaquant. **Toute la sécurité s'évapore.**

La puce doit donc établir elle-même que les bodyBytes correspondent à `(payee, amount)`. Deux voies :

| Voie | Principe | Effort | Verdict |
|---|---|---|---|
| **Parsing** | décoder le protobuf `TransactionBody` / `CryptoTransferTransactionBody` / `TransferList` sur la puce (varints, tags) | ~250-300 lignes de C, 1 jour | correct, c'est ce que fait app-ethereum pour l'EVM |
| **🎯 Re-sérialisation** | le host envoie les **champs structurés** ; la puce **reconstruit** les bodyBytes canoniques et compare octet à octet avec ce qu'on lui demande de signer | ~120 lignes, une demi-journée | **sérialiser est plus simple que parser.** Même garantie |

**Prendre la re-sérialisation.** Si les octets reconstruits diffèrent d'un seul bit de ceux présentés, la puce refuse. On obtient la même propriété de sécurité pour la moitié du travail, et c'est plus facile à tester (vecteurs déterministes).

C'est exactement ce que signifie « clear signing » : **le device ne signe jamais des octets qu'il n'a pas lui-même établis.**

#### Ce que ça implique pour la démo

L'acte 4 devient imparable. Tu peux dire, littéralement :

> « Je suis root sur cette machine. Il n'y a aucune clé Hedera dessus. La seule chose au monde qui peut produire la signature de l'acheteur, c'est cette puce — et elle refuse. »

### 4.4ter · 🎁 `LedgerHQ/app-hedera` — la couche de parsing existe déjà

**La trouvaille qui débloque le lundi.** Ledger maintient une app BOLOS Hedera officielle (`pushed_at` : 21 août 2026, **Apache 2.0**).

| Ce qu'elle apporte | Détail |
|---|---|
| **Cible déjà `apex_p`** | `devices = ["nanox", "nanos+", "stax", "flex", "apex_p"]` |
| **Les deux courbes** | `CURVE_APP_LOAD_PARAMS = ed25519 secp256k1` |
| **Le path Hedera** | `PATH_APP_LOAD_PARAMS = "44'/3030'"` (coin type Hedera = 3030) |
| **🔥 Protobuf on-chip via nanopb** | `proto/transaction_body.pb.c/.h`, `proto/crypto_transfer.pb.c/.h`, `proto/basic_types.pb.c/.h`, `timestamp`, `duration`, + token/contract ops — **déjà générés et compilés pour BOLOS** |
| Régénération | `make c_pb` dans l'image `ghcr.io/ledgerhq/ledger-app-builder` |
| Durci | fuzzers `proto_varlen_parser` (avec corpus de crash), `proto_full`, `hedera_format`, `staking`, `time_format` |
| Écrans | NBGL review Hedera déjà écrits |

Les `.proto` sont ceux de **Hedera Hashgraph LLC** (Apache 2.0) avec annotations nanopb. Réutilisables avec attribution (`NOTICE`) — et c'est exactement ce qu'autorise « open-source starter kits are fine » de la track fresh.

#### Ce que ça change

La question « parser ou re-sérialiser ? » de §4.4bis a une **troisième réponse, meilleure : nanopb**, exactement comme l'app officielle.

| Voie | Effort | Verdict |
|---|---|---|
| Parsing manuel | ~280 lignes C + fuzzing | ❌ inutile maintenant |
| Re-sérialisation | ~120 lignes | 🟡 plan B |
| **🎯 nanopb vendorisé depuis app-hedera** | `pb_decode()` + vérification des champs | ✅ **la voie** |

Sur la puce :

```c
// décoder ce que le host demande de signer
Hedera_TransactionBody body;
pb_decode(&stream, Hedera_TransactionBody_fields, &body);

// TransferList : montants négatifs = émetteurs, positifs = destinataires,
// somme nulle, en tinybars, 10 ajustements max
// → extraire (mon compte, -amount) et (payee, +amount)
// → payee ∈ allowlist ?  amount ≤ per_call_max ?  budget dispo ?
// → sinon : REFUS, aucune signature
```

**Le device n'accepte jamais les champs annoncés par le host. Il les lit lui-même dans les octets qu'on lui demande de signer.** C'est la définition du clear signing.

#### Le cadrage honnête à tenir face aux juges

> *« Ledger a déjà résolu la signature Hedera sur device — leur app officielle le fait. Ce que j'ajoute, c'est la seule partie qui rend l'autonomie sûre : un compteur de budget qui vit dans la puce et qui décide sans moi, dans les bornes que j'ai approuvées une fois. »*

C'est une force, pas une faiblesse : la nouveauté est **circonscrite et défendable**. Personne n'a mis de machine à états de dépense persistante dans un Secure Element.

⚠️ Vela ne peut pas simplement *utiliser* `app-hedera` : c'est une app de wallet, elle exige un tap par transaction. Le chemin sans tap sous mandat impose sa propre app. On emprunte la couche protobuf, pas l'app.

### 4.5 L'agent

Un analyste qui doit produire un rapport de risque. Pour travailler, il doit **acheter** de l'inférence et de la donnée. Il a un budget. Il **arbitre entre les deux providers** — modèle pas cher pour trier, cher pour la synthèse finale. C'est l'exemple que Hedera donne dans sa propre track.

**Détail à garder :** le budget restant est **lu depuis la puce** et injecté dans le prompt. Le LLM raisonne sur une contrainte physiquement appliquée.

**Robustesse démo** (vol à SpendVeto) : réponses LLM en cache si pas de clé API, pour que rien ne cale sur le réseau pendant l'enregistrement. Le device et Hedera restent réels — c'est le sujet.

### 4.6 Le mode software — le témoin

Voir §3. Même API, moteur de policy en Node, policy en JSON sur disque. C'est **l'état de l'art honnêtement implémenté**, et c'est le groupe témoin de l'expérience.

### 4.7 `vela verify` — la vérifiabilité publique

Inspiré directement de `x402-work-receipts`.

```bash
vela verify --topic 0.0.X [--mandate out/<id>/mandate.json]
```

Reconstruit **depuis le mirror node public SEUL** :
1. chaque paiement réglé a une autorisation device correspondante ancrée sur HCS
2. **aucun paiement n'existe sans autorisation**
3. les montants réglés correspondent aux montants autorisés
4. les ancres apparaissent dans l'ordre de consensus attendu
5. la signature de l'autorité device vérifie

Exit 0 si tout passe, 1 sinon, 2 sur erreur réseau. **Le verifier n'appelle jamais ton host.**

**Statement imprimé à chaque run** (vol direct) : *« ce que ça prouve / ce que ça ne prouve pas »*. Les limites voyagent avec l'artefact.

**Tests :** fixtures `golden/` (un vrai run) + `tampered/` (hash de reçu édité, tx id échangé, ancre manquante, mauvais payee) — chaque fixture altérée doit faire échouer **exactement** le check visé.

**C'est l'artefact qui rend la claim hardware vérifiable par un juge sans ton laptop. Aucun des trois concurrents n'a l'intersection hardware + vérifiable.**

### 4.7bis · Le compteur signé — l'ajout qui ferme la boucle

Chaque `AUTHORIZE_SPEND` ancre sur HCS un message signé **par le device** contenant l'état *après* la décision :

```
{ mandate_id, seq, amount, service_hash, remaining_after, sig_device }
```

Conséquence : `vela verify` peut reconstruire **l'historique complet du compteur depuis le log public seul**, et vérifier que :

1. `seq` est strictement monotone → aucune autorisation supprimée du log
2. `remaining_after[n] = remaining_after[n-1] - amount[n]` → l'arithmétique tient
3. `remaining_after` ne devient jamais négatif → le plafond n'a jamais été dépassé
4. chaque ligne est signée par la clé d'autorité du device

**N'importe qui peut donc auditer que le hardware n'a jamais menti — sans toucher ta machine, sans te faire confiance.**

C'est la propriété que ni SpendVeto (journal sur l'hôte) ni `x402-work-receipts` (pas de compteur) ne peuvent avoir. Coût : ce qu'on met dans le message HCS. Aucun travail supplémentaire côté puce.

### 4.8 Serveur MCP

Vol à SpendVeto (#6) : *« governance the model cannot opt out of »*. L'agent voit des tools ordinaires ; chaque appel passe silencieusement par policy → autorisation device → paiement.

Sert aussi d'angle Bazantic.

### 4.9 Bazantic (conditionnel)

**État vérifié le 5 septembre :** pas de docs publiques (`docs.bazantic.com` → 404), **zéro repo public** sur l'org GitHub `bazantic`, page `/developers` en **waitlist** (« Request Beta Access »), et **seul sponsor de l'event sans aucune ressource listée**.

Le produit : tu soumets une spec d'API → « Baz AI » génère un serveur MCP hébergé + une gateway x402/MPP à une URL custom → tu fixes un prix par appel → analytics sur le trafic non-humain + screening OFAC. **MPP = Machine Payments Protocol** (règle sur Tempo) ; x402 règle sur Base.

**Problème de rails :** ta gateway Bazantic règle sur Base/Tempo, la track Hedera exige Blocky402 sur `hedera:testnet` en tinybars. → **deux services payants, deux rôles**, à concevoir exprès :

```
agent ──paie l'inférence──► endpoints x402 sur Hedera (Blocky402)      ← track Hedera
  └────demande autorisation──► API Vela, gatewayée sur Bazantic (Base)  ← track Bazantic
```

**Track « Best Recipe » ($1 000, 3 gagnants)** — la Recipe : **« Before your agent pays, get it governed. »**
> Quand ton agent s'apprête à faire un paiement x402, appelle d'abord `vela/authorize`. Autorisation signée → procède. `escalation_required` → remonte à l'humain. Ne paie jamais sans passer par là.

**Track « Agentify a new API » ($1 000, 3 gagnants)** — il faut une API absente de Bazantic **et** non-sponsor. La bonne : **réputation de domaine / threat intel**. Avant que Vela autorise une dépense vers un service jamais vu, il vérifie la réputation du domaine. On-theme, réutilisable par n'importe quel agent payeur, et ça enrichit vraiment le produit.

**Règle de décision — vendredi 11 au plus tard :**
> Console accessible → Bazantic, ~6 h de travail, $2 000 sur 6 places.
> Toujours en waitlist → abandon immédiat, **Chainlink** à la place (Confidential Workflow $2 000 + challenge liquidation $500, ~1 jour, le CRE de Lunave est déjà connu).

**Ne rien construire pour Bazantic avant d'avoir la console sous les yeux.**

---

## 5 · Le tableau des contrôles — l'artefact qui tue

À mettre dans le README. Même langage de framework que SpendVeto, **plus une colonne qu'ils ne peuvent structurellement pas avoir**.

| # | Control | Framework expectation | **Enforced where** |
|---|---|---|---|
| 1 | Per-call cap | NIST MANAGE | 🔒 **Secure Element** |
| 2 | Epoch budget, reserved then released | NIST MANAGE | 🔒 **Secure Element** |
| 3 | Service allowlist | EU AI Act Art. 14 | 🔒 **Secure Element** |
| 4 | Mandate expiry | EU AI Act Art. 14 | 🔒 **Secure Element** |
| 5 | Human escalation above cap | EU AI Act Art. 14 | 🔒 **screen + physical tap** |
| 6 | Kill switch / revocation | EU AI Act Art. 14 | 🔒 **physical tap** |
| 7 | Request integrity (bound digest, single-use, TTL) | NIST MEASURE | 🔒 **Secure Element** |
| 8 | Verifiable audit trail | EU AI Act Art. 12 | ⛓️ **HCS, off-host** |
| 9 | Secrets never disclosed to the agent | NIST MANAGE | 🔑 **LKRP / Key Ring** |
| 10 | Enrolment of a USB-less host | — | 🔑 **trustchain, 1 tap** |
| 11 | Concurrency safety | NIST MANAGE | 🔒 **structural — serial APDU** |
| 12 | Publicly auditable counter history (monotonic seq, arithmetic, never negative) | EU AI Act Art. 12 | ⛓️ **HCS + device signature** |

**Zéro ligne ne dit « server ».** C'est tout le message dans un seul tableau.

---

## 6 · Ce qu'on prend aux concurrents

⚠️ **Les idées, pas le code.** SpendVeto est Apache-2.0 (attribution requise) et surtout on est en track **fresh** — tout doit être écrit par nous.

### De SpendVeto

| # | Ce qu'ils font | Ce qu'on en fait | Statut |
|---|---|---|---|
| 1 | `CONTROLS.md` mappé EU AI Act / NIST | Le même tableau, 11 lignes au lieu de 36, **+ colonne `Enforced where`** | ✅ intégré §5 |
| 2 | *« aucune claim qui ne soit une assertion de `npm run verify` »* + section *What not to claim* | Adopter les deux | ✅ §14 |
| 3 | Policy packs importables | 3 mandats préréglés (`cautious` / `standard` / `production`). 20 min | ✅ |
| 4 | *Blocked-spend* métrique de premier plan | **« refusé dans le silicium : X HBAR sur N tentatives »** en gros sur le dashboard | ✅ |
| 5 | Refus structurés : code machine + correction concrète | Le SW APDU mappe vers une raison exploitable. L'agent se corrige | ✅ §4.2 |
| 6 | Timeout d'approbation → **fail closed** | Tel quel, non négociable | ✅ §4.2 |
| 7 | Serveur MCP — gouvernance non-optionnelle pour le modèle | Vela expose un MCP server | ✅ §4.8 |
| 8 | **#34/#35 — gouverner le plafond, pas le prix ; tenir les plafonds ouverts contre le budget** | 🔥 `reserved` dans la NVRAM, libéré au règlement | ✅ §4.1 |
| 9 | **#28 — request integrity** : autorisation liée au digest canonique, usage unique, TTL | 🔥 essentiel, sinon trou de sécurité | ✅ §4.1 |
| 10 | **#16 — race condition** sur les caps concurrents, corrigée par un lock | 🎁 **immunisé par construction** — APDU série. Le dire | ✅ §4.1 |
| 11 | Démo 90 s sur réponses LLM en cache pour ne jamais caler | Adopter pour le LLM, garder device + Hedera réels | ✅ §4.5 |
| 12 | Idempotency key → même reçu, un seul paiement | `nonce` dans le mandat, déjà prévu | ✅ |

### De `x402-work-receipts`

| Ce qu'ils font | Ce qu'on en fait |
|---|---|
| Verifier CLI qui ne fait confiance **qu'au** mirror node public | 🔥 `vela verify` | ✅ §4.7 |
| Statement *« proves / does not prove »* imprimé à chaque run | Vol direct | ✅ §4.7 |
| Fixtures `golden/` + `tampered/`, chaque altération casse exactement un check | Discipline de test | ✅ §4.7 |
| JSON canonique RFC 8785 + enveloppes Ed25519 | Pour tout ce qui est signé | ✅ |
| Les 6 gotchas Blocky402 | Encodés d'avance | ✅ §4.4 |
| Vendorisation de `hedera-dev/hedera-skills` | Installer depuis l'upstream | ✅ §7 |

---

## 7 · Skills et plugins à installer

### Ledger — `LedgerHQ/agent-skills`

```
skills/dmk/dmk-business-logic/SKILL.md
skills/dmk/dmk-intent-vocabulary/SKILL.md
skills/dmk/ledger-dmk-implementation/SKILL.md
  + dmk-code-patterns.md · dmk-platform-patterns.md · dmk-sdk-reference.md
skills/wallet-cli/wallet-cli-usage/SKILL.md
  + references/business-logic.md
```

### Hedera — `hedera-dev/hedera-skills` (marketplace de plugins Claude Code)

Plugins disponibles :

| Plugin | Contenu utile pour Vela |
|---|---|
| **`native-services-js`** | 🔥 `x402-payments` (+ `references/facilitator.md`, `examples.md`), `hedera-consensus-service` (HCS), `hedera-token-service` (+ `custom-fees.md`) |
| **`hackathon-helper`** | 🔥 `hackathon-prd` + `validate-submission`, **avec les critères de jugement officiels** |
| `hiero-cli` | références `x402.md`, `topic.md`, `schedule.md`, `account.md`, `eip712.md` |
| `system-contracts` | HTS + **HSS (Scheduled Transactions) en Solidity** |
| `agent-kit-plugin` | tools, hooks, **policies bloquantes** |
| `oracles` | Chainlink Data Feeds sur Hedera (si 3ᵉ slot = Chainlink) |
| `dev-intelligence` | scaffolding, quality gates |
| `hedera-harness` | si on vise le rider Harness ($2 000, 2 gagnants) |

**À faire ce soir.** C'est plusieurs jours de doc condensés.

---

## 8 · Le rubric de jugement Hedera — la découverte stratégique

Extrait des skills officielles `hackathon-helper/references/judging-criteria.md`.

| Section | Poids | Ce que ça veut dire |
|---|---|---|
| **Success** — impact sur les métriques Hedera | **20 %** | volume de transactions généré |
| **Execution** | **20 %** | MVP fonctionnel, UX sans friction, stratégie long terme, GTM, décisions de design |
| Integration — qualité d'usage de Hedera | 15 % | combien de services natifs utilisés |
| **Validation** — ce que le marché en pense | **15 %** | retours réels, traction |
| Innovation | 10 % | note 5 = *« previously unseen, on Hedera, or cross-chain »* |
| Feasibility | 10 % | **demande littéralement un Lean/Business Model Canvas** |
| Pitch | 10 % | présentation |

Calcul : `Weighted = (Score/5) × (Poids/100 × 35)` ; `Final = (Σ Weighted / 35) × 100`

### ⚠️ ~45 % du score n'est pas technique

**Actions concrètes, ~2 h de travail :**

1. **Success (20 %)** — la démo de 3 min doit produire **~150 micro-paiements et ~200 messages HCS**, et **tu dis les chiffres à voix haute**. Un agent qui paie à l'appel génère bien plus de trafic qu'un projet de bons de commande.
2. **Validation (15 %)** — poster dans le Discord Hedera et le Telegram Ledger (`t.me/LedgerETHGlobal`), récolter 3-5 retours de vrais devs, **screenshoter**. Citer SpendVeto, **Catena Labs ($30M Series A, a16z crypto + Acrew, mai 2026)**, Skyfire, Payman comme preuve que la catégorie existe et est financée — **pendant que Vela est le seul avec une racine matérielle**.
3. **Feasibility (10 %)** — **une page de Lean Canvas.** Quasiment personne ne le fait. Points gratuits.
4. **Execution (20 %)** — un paragraphe de roadmap post-hackathon + GTM + les décisions de design explicitées.
5. **Innovation (10 %)** — insister sur *previously unseen* : un plafond de dépense appliqué dans un Secure Element, ça n'existe nulle part, sur Hedera ni ailleurs.

**C'est le meilleur retour sur temps de tout le hackathon.**

---

## 9 · Les critères Ledger

Source : `developers.ledger.com/ethonline`.

| Critère | Réponse de Vela |
|---|---|
| Genuine user value, pas un wrapper de chatbot | un budget d'agent qui tient face à un hôte compromis |
| **Séparation nette entre autonomie et approbation explicite** | implémentée en NVRAM : sous le plafond = silencieux, au-dessus = tap |
| Primitive Ledger concrète, pas du branding | app BOLOS custom + état NVRAM + Key Ring/LKRP + NBGL + trustchain + genuine-check |
| Démonstration pratique du pourquoi le device-backed trust compte pour l'IA | **l'expérience contrôlée §3** — prouvé, pas affirmé |
| Repo clonable ou walkthrough enregistré | ✅ |
| **Feedback DX obligatoire** | ✅ format déjà maîtrisé (11 000 caractères écrits pour Lunave) |

**Les 4 bullets de la track, tous cochés :**
1. ✅ broker de capabilities, jamais la clé → §4.3
2. ✅ Key Ring sur un hôte sans USB → **`vela ring enroll`** §4.3
3. ✅ paiements x402 sécurisés par Ledger → §4.4
4. ✅ human-in-the-loop sur l'escalade → §4.1

---

## 10 · La démo — 4 min 30

**Acte 1 · Setup (30 s)**
`ring init`, un tap, scellement de la clé opérateur Hedera. Push du ciphertext sur le VPS. Montrer que le VPS n'a rien en clair, pas de device, pas de port USB.

**Acte 2 · Le mandat (45 s)**
`agent://analyst · 10 HBAR · api.inference.x + api.data.y · expire dans 1 h`. Clear-signing plein écran sur le Gen5. Un tap. Le hash part sur HCS.

**Acte 3 · Autonomie (60 s)**
Armer l'agent. Il paie appel par appel, arbitre entre les deux providers, sort son rapport. **Aucun tap.** Le dashboard montre le compteur *on-chip* qui descend en direct, HashScan se remplit. **Dire les chiffres** (N paiements, N messages HCS).

**Acte 4 · L'expérience contrôlée (75 s)** ← *le moment qui fait gagner*

> « Maintenant je passe en mode software — l'état de l'art, ce que tout le monde fait. Et je m'attaque moi-même. »

- `npm run attack -- --mode software` → policy lue sur disque, plafond relevé, **500 HBAR partent**. En 1,4 s.
- `npm run attack -- --mode device` → **la puce refuse.** `0x6985`. Rien n'est signé.
- Puis tu **tues le process de l'agent et tu le remplaces par un malveillant** — même hôte, mêmes secrets. Il tente un service hors mandat → **refus**. Pas parce qu'un logiciel a vérifié : parce que le compteur et l'allowlist sont dans le Secure Element.
- Escalade légitime : l'agent a besoin de 3 HBAR de plus. **Le Gen5 s'allume**, affiche la demande, tu tapes. Ça passe.

**Acte 5 · Vérification indépendante + révocation (40 s)**
`vela verify --topic 0.0.X` depuis une machine vierge, qui ne touche jamais ton host → tous les checks passent, puis le statement *proves / does not prove* s'imprime.
Un tap sur le device → mandat mort, agent instantanément impuissant. HCS l'enregistre.

**Règles de tournage :** parler lentement, **se taire à chaque tap** et laisser voir l'écran, dire à voix haute « Ledger », « Key Ring », « Secure Element », « Hedera », « HCS », « Blocky402 ». Finir sur la phrase d'ancrage.

---

## 11 · Plan jour par jour

| Jour | Livrable | 🔴 = non négociable |
|---|---|---|
| **Sam 5** | Gen5 acheté (Fnac CNIT). Repo init. `ring init` via Ledger Sync. **Boilerplate `apex_p` buildé et sideloadé, hello-world APDU sur le vrai device.** Installer `hedera-dev/hedera-skills` + `LedgerHQ/agent-skills`. **Signup Bazantic** | 🔴 dérisque tout en 3 h |
| **Dim 6** | NVRAM `mandate_t` **avec `reserved` dès le départ**. `CREATE_MANDATE` + NBGL + tap. `GET_MANDATE_STATE`. Bridge HID | 🔴 |
| **Lun 7** | `AUTHORIZE_SPEND` (checks + réserve + sign, sans tap) + **request binding** + `SETTLE_CONFIRM` + `ESCALATE` + `REVOKE` + refus structurés | 🔴 le cœur |
| **Mar 8** | Hedera : 2 endpoints x402 via Blocky402, metering au token, **1 paiement réel e2e**. Les 6 gotchas sont connus → viser une demi-journée | 🔴 |
| **Mer 9** | **`GOVERNOR_MODE=software`** (le témoin) + **`vela ring enroll`** (trustchain, VPS sans USB) | 🔴 |
| **Jeu 10** | Agent en prod sur le VPS. Topic HCS complet. **`vela verify`** + statement *proves / does not prove*. ERC-8004 / HCS-14. Scheduled Tx | |
| **Ven 11** | **`npm run attack` sur les deux modes** + dashboard « refusé dans le silicium ». Fixtures golden/tampered. **Go/no-go Bazantic** | 🔴 |
| **Sam 12** | 3ᵉ slot + **feedback DX Ledger** + `CONTROLS.md` + README + schéma d'archi + **Lean Canvas 1 page + GTM** (les 45 % Hedera) | 🔴 |
| **Dim 13 matin** | Vidéo + soumission **avant 18 h Paris** | 🔴 |

---

## 12 · Risques et lignes de coupe

| Risque | Mitigation |
|---|---|
| **La puce signe des bodyBytes non vérifiés** | 🔴 **le trou fatal.** Résolu : nanopb vendorisé depuis `app-hedera`, §4.4ter |
| Le sideload sur device résiste | **le faire samedi soir**, avant tout le reste |
| `nvm_write` : endurance, app tuée en plein write | batcher les écritures, gérer l'interruption |
| **NVRAM effacée à la réinstallation** | ne pas réinstaller entre répétition et enregistrement |
| Blocky402 est du tooling neuf | 6 gotchas connus d'avance ; plan B = facilitator x402 EVM standard |
| Bazantic waitlist | décision vendredi, bascule Chainlink |
| Hedera encombré (3 concurrents) | ne pas concourir sur le feature count : hardware + vérifiabilité |
| « signer sans tap = contournement ? » | *le mandat approuvé une fois autorise exactement ça, et c'est la puce, pas le logiciel, qui garantit les bornes* |

**Ordre de sacrifice :** 3ᵉ partenaire → extras Hedera (ERC-8004, Scheduled Tx, HTS) → VPS distant → mode software.
**Jamais :** l'état NVRAM, l'expérience contrôlée, `vela verify`.

Si on tombe sur un mandat simplement signé et vérifié côté host, l'idée entière est perdue et Vela redevient un projet parmi quarante.

---

## 13 · Ce qu'on ne revendique pas

À écrire dans le README, section *What not to claim* (discipline volée à SpendVeto).

- Pas d'audit de sécurité externe. Pas de production-ready.
- Testnet uniquement (Hedera testnet). Aucun fonds réel.
- L'app BOLOS est sideloadée en dev mode, **non certifiée par Ledger**.
- Le mode software est une implémentation honnête de l'état de l'art, pas une reproduction d'un produit particulier.
- `vela verify` prouve qu'un paiement réglé avait une autorisation device ancrée. Il **ne** prouve **pas** que le service a délivré, ni que la policy était adéquate.
- Aucune claim qui ne soit pas une assertion de `npm run verify`.

---

## 14 · Checklist de soumission

- [ ] Repo public, historique de commits réel (pas de commit unique le dernier jour)
- [ ] README : archi, schéma, quickstart, `CONTROLS.md`, *What not to claim*
- [ ] Vidéo ≤ 5 min (Hedera exige ≤ 5 min ; Ledger veut un walkthrough)
- [ ] **Feedback DX Ledger** (obligatoire)
- [ ] Lean/Business Model Canvas + GTM (rubric Hedera)
- [ ] Preuve de paiement réel : lien HashScan + transfer list du mirror node
- [ ] Chiffres de trafic Hedera annoncés (N paiements, N messages HCS)
- [ ] Screenshots des retours devs (Validation 15 %)
- [ ] Username Bazantic si 3ᵉ slot = Bazantic
- [ ] Sélectionner les **3** partner prizes au moment de soumettre
- [ ] Soumettre **avant dimanche 13, 18 h Paris**

---

## 16 · Faits techniques vérifiés (5 sept. 2026)

Tout ce qui suit est sourcé de repos LedgerHQ / Hedera officiels, pas de la mémoire.

### 16.1 🟢 Sideload sur Gen5 — CONFIRMÉ

`LedgerHQ/ledgerctl` CHANGELOG : **« Support for Apex P and Apex M devices »**.
`ledgerwallet/utils.py` : `LEDGER_APEX_P = "Ledger Apex P"`.
`pyproject.toml` : *« Nano S/S+/X, Stax, Flex, Apex P and Apex M »*.

**Il existe aussi un `apex_m`** — deuxième variante Apex. Vérifier au déballage que le Gen5 correspond bien à `apex_p` (le target de Lunave). Speculos : `"apex_p": Model("Apex P", (300, 400), ...)` → **écran 300 × 400**, cohérent avec la fiche produit.

### 16.2 🟢 NVRAM — CONFIRMÉ, avec l'app de référence

Syscall : `SYSCALL void nvm_write(void *dst_adr, void *src_adr, unsigned int src_len)` — `ledger-secure-sdk/include/os_nvm.h`.

**Pattern canonique :**

```c
// globals.h
extern const internalStorage_t N_storage_real;
#define N_storage (*(volatile internalStorage_t *) PIC(&N_storage_real))

// main.c
const internalStorage_t N_storage_real;

// écriture
nvm_write((void *) &N_storage.field, (void *) &value, sizeof(value));

// effacement : src = NULL
nvm_write((void *) N_storage.records, NULL, sizeof(N_storage.records));
```

**🎯 `LedgerHQ/app-passwords` est LA référence pour Vela.** C'est une app Ledger officielle qui persiste **un tableau d'enregistrements de taille variable** en NVRAM, avec magic number, compteur et offsets — exactement la forme de `mandate_t[4]` :

```c
bool init_storage() {
    if (N_storage.magic == STORAGE_MAGIC) return false;   // déjà initialisé
    uint32_t tmp = STORAGE_MAGIC;
    nvm_write((void *) &N_storage.magic, (void *) &tmp, sizeof(uint32_t));
    tmp = 0;
    nvm_write((void *) &N_storage.metadata_count, (void *) &tmp, sizeof(...));
    ...
}
```

Autres références NVRAM : `app-ethereum` (settings booléens), `app-openpgp` (clés + compteurs), `app-monero` (état persistant).

### 16.3 ⚠️ Le gotcha `dataSize` — celui qui coûterait une journée

La région NVRAM doit être **déclarée au chargement**. Le README de `ledgerctl` calcule :

```bash
--dataSize $(( 0x$(grep _envram_data debug/app.map | ...) - 0x$(grep _nvram_data debug/app.map | ...) ))
```

Les symboles `_nvram_data` et `_envram_data` du `app.map` bornent la zone. Avec le Makefile SDK moderne c'est automatique, **mais si le stockage se comporte bizarrement, c'est là qu'il faut regarder en premier.**

### 16.4 🟢 Signature sans tap — autorisée

Les flags applicatifs (`include/appflags.h`) sont : `DERIVE_MASTER`, `GLOBAL_PIN`, `BOLOS_SETTINGS`, `LIBRARY`. **Aucun ne force une confirmation utilisateur.** Le tap est une décision de l'app, pas une contrainte de l'OS. Vela sideloadée en dev mode n'est pas soumise aux guidelines de review des apps publiées.

### 16.5 🟢 Le boilerplate cible déjà apex_p

`ledger_app.toml` : `devices = ["nanox", "nanos+", "stax", "flex", "apex_p"]`

Makefile, les lignes qui comptent pour Vela :

```makefile
ICON_APEX_P = icons/app_vela_32px_apex.png    # PNG 32px — pas un .gif
CURVE_APP_LOAD_PARAMS = secp256k1              # exactement ce qu'il faut
PATH_APP_LOAD_PARAMS = "44'/1'"                # testnet
ENABLE_BLUETOOTH = 1
#ENABLE_NFC = 1                                 # le Gen5 a les deux
```

Porting apex_p (doc officielle) : deux icônes PNG monochromes **48×48 et 32×32**, référencer la 32 dans le build, ajouter `apex_p` aux listes de devices, ajouter la couverture de test.

`app-ethereum` place `TARGET_APEX_P` dans le même filtre que `TARGET_STAX`/`TARGET_FLEX` → **famille NBGL confirmée**.

### 16.6 🟢 ERC-8004 est déployé sur Hedera Testnet

EIP-8004 « Trustless Agents » — proposé août 2025, mainnet 29 janvier 2026. Trois registres : **Identity** (identités portables basées ERC-721), **Reputation**, **Validation**. Contributeurs : MetaMask, Ethereum Foundation, Google, Coinbase.

**Adresses Hedera Testnet (chain 296)** — mêmes adresses vanity CREATE2 sur tous les testnets :

| Registre | Adresse |
|---|---|
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

HashScan : `https://hashscan.io/testnet/address/0x8004A818BFB912233c491871b3d84c89A494BD9e`
Repo : `github.com/erc-8004/erc-8004-contracts`
⚠️ Pas de ValidationRegistry listé sur Hedera testnet.

**🔥 L'angle narratif :** ERC-8004 répond à *« qui est cet agent ? »*. Vela répond à *« combien a-t-il le droit de dépenser ? »* — et **l'identité ERC-721 de l'agent est possédée par la clé d'autorité du Ledger**. L'identité on-chain de l'agent appartient au hardware. Extra point Hedera coché, et ça renforce la thèse au lieu d'être un badge collé.

**Bonus repéré :** les mêmes registres sont déployés sur **Arc Testnet**. Si le 3ᵉ slot bascule un jour vers Arc, l'identité est portable sans changement de code.

### 16.7 HCS-14 — Universal Agent ID

Standard Hashgraph Online. DID W3C, deux méthodes : **AID** (généré par registre) et **UAID** (self-sovereign). Identifiants de compte natifs chain-qualifiés (**CAIP-10**), routage embarqué dans le DID, résolution via profils (DNS TXT + découverte web).
Docs : `hol.org/docs/standards/hcs-14/`

Alternative ou complément à ERC-8004 pour l'extra point identité. **ERC-8004 est plus simple à démontrer** (adresses connues, EVM standard). Prendre ERC-8004 en premier, HCS-14 en bonus si le temps le permet.

### 16.8 wallet-cli 2.1.0

- `wallet-cli skill` — **installe la skill agent Ledger dans ton coding agent**, embarquée dans le binaire. À faire samedi soir.
- Réseaux supportés : bitcoin, ethereum, solana (pas Hedera — normal, le ring ne dépend pas du réseau)
- `ring init --unsecure-no-password` existe — **ne pas l'utiliser**, toujours un mot de passe via `WALLET_PASS`
- `genuine-check` sort immédiatement si une app currency est ouverte : **être sur le dashboard** avant de le lancer

### 16.9 Récapitulatif des risques après vérification

| Risque | Avant | Après |
|---|---|---|
| Sideload impossible sur Gen5 | 🔴 inconnu | 🟢 **supporté par ledgerctl** |
| NVRAM persistante irréalisable | 🟠 supposé | 🟢 **syscall + app de référence officielle** |
| L'OS force un tap à chaque signature | 🟠 inconnu | 🟢 **aucun flag ne l'impose** |
| Boilerplate ne cible pas apex_p | 🟠 inconnu | 🟢 **déjà dans `ledger_app.toml`** |
| ERC-8004 indisponible sur Hedera | 🟠 inconnu | 🟢 **déployé, adresses connues** |
| Région NVRAM mal dimensionnée | — | 🟡 **gotcha `dataSize`, §16.3** |
| Confusion apex_p / apex_m | — | 🟡 **vérifier au déballage** |

**Aucun risque bloquant ne subsiste sur le cœur du projet.**

---

## 17 · Speculos vs device réel — politique de test

**Contexte : les divergences rencontrées sur Lunave (ETHGlobal NY) étaient TOUTES dans `cx_bn`**, le coprocesseur bignum :

1. `cx_bn_mod_mul(r,a,a)` avec `r==a==b` (carré en place) — cassé sur le SE, toléré par Speculos
2. `cx_bn_mod_add` / `cx_bn_mod_mul` peuvent laisser le résultat dans `[modulus, 2·modulus)` au lieu de réduire

**Vela n'utilise pas `cx_bn`.** Ni BabyJubJub, ni Poseidon, ni arithmétique modulaire custom. Seulement `nvm_write`, secp256k1 via le SDK standard, de l'arithmétique `uint64` en C, et NBGL. **Cette classe de bugs est structurellement absente.**

### Le risque propre à Vela

Speculos émule `nvm_write` via `mprotect`, mais **la persistance entre deux lancements n'est pas garantie** — or c'est exactement notre thèse.

| Sur Speculos (boucle rapide) | Sur le Flex réel (obligatoire) |
|---|---|
| itération UI, écrans de review | **toute persistance NVRAM** |
| logique APDU, parsing, codes de refus | reboot / relance d'app, état conservé |
| tests de politique (plafonds, allowlist, expiration) | écriture interrompue en plein `nvm_write` |
| | effacement NVRAM à la réinstallation |
| | l'acte 4 de la démo, filmé |

### ⚠️ HID instable sur macOS

Note de Lunave : *« the macOS HID pipe is too unstable — repeated reads of the same deterministic value disagree »*. Ne pas construire de harnais qui relit en boucle sur le device physique. Boucles serrées sur Speculos, vérification ponctuelle sur le device.

### ⚠️ Ne pas créer Vela 1 / Vela 2 / Vela 3

**La NVRAM est attachée au nom de l'app.** Chaque nom = un slot de stockage séparé. Installer plusieurs variantes efface l'état à chaque itération et démontre l'inverse de ce qu'on veut prouver. Une seule app, `--delete` puis reload, avec confirmation au doigt sur le device.

---

## 18 · Le panneau de contrôle on-device — la propriété que personne n'a

**Constat.** Tous les autres contrôles de Vela sont *déclenchés par l'hôte* : il envoie un APDU, la puce répond. Ça laisse un trou. Un hôte totalement compromis ne peut pas dépenser — il n'a aucune clé — **mais il peut avaler silencieusement ton ordre de révocation** et te laisser croire qu'un agent est mort alors qu'il tourne toujours.

**Le kill switch déclenché à l'écran ferme ce trou.** Aucune coopération de l'hôte n'est requise : la liste des mandats est lue depuis la NVRAM, et la révocation s'exécute sur la puce.

> ### « Le seul contrôle qu'un hôte compromis ne peut pas intercepter. »

C'est une propriété de sécurité réelle, et elle se démontre en dix secondes : hôte rooté à l'écran, tu prends le Flex, tu tapes, l'agent est mort. Les trois concurrents ont tous un kill switch qui est un endpoint HTTP **sur la machine attaquée**.

### Ce qui est construit

```
┌─────────────────────────────────┐
│  Vela                           │
│  Spending mandates,             │
│  enforced on-chip               │
│                                 │
│  › Mandate 0  -  4.2/10 HBAR    │  BARS_LIST tactile
│  › Mandate 1  -  Free           │
│  › Mandate 2  -  Free           │
│  › Revoke all mandates          │  le bouton panique
└─────────────────────────────────┘
        ↓ tap sur une ligne
┌─────────────────────────────────┐
│  Mandate 0                      │
│  Agent      a3f2c81b...         │  INFOS_LIST
│  Budget     10 HBAR             │
│  Available  4.2 HBAR            │
│  Reserved   0.5 HBAR            │
│  Draws      27                  │
│  Services   2 allowed           │
│         ─── page 2 ───          │
│  Kill this mandate              │  INFO_BUTTON
│      [ Revoke ]                 │
└─────────────────────────────────┘
```

Composants NBGL utilisés : `BARS_LIST` (lignes tactiles), `INFOS_LIST`, `INFO_BUTTON`, `nbgl_useCaseChoice` (confirmation), `nbgl_useCaseGenericConfiguration` (page de détail navigable).

**Les listes sont reconstruites depuis la NVRAM à chaque retour à l'accueil** — ce qu'un juge lit sur le device est le compteur tel qu'il est, pas un instantané fourni par l'hôte.

### Ce que ça sert dans le jugement

- Bullet 4 Ledger : *« systems that ask for a human before anything irreversible »* — dépassé, on va plus loin
- *« products that make autonomous behavior safer instead of bypassing user intent »* — c'est exactement ça
- « Primitive Ledger concrète, pas du branding » : app native + NVRAM + NBGL interactif + Key Ring
- Et visuellement : l'app a son logo, ses écrans, ses boutons. Elle **existe** sur le device.

---

## 15 · La phrase d'ancrage

> **« L'agent propose. La puce décide. Et le log public le prouve. »**

*Document vivant — mis à jour au fil du hackathon.*
