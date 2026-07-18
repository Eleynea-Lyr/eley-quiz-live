## Variables d'environnement (local)

Ce projet utilise des mots de passe côté client pour protéger certaines pages.

### À créer : `.env.local`

Crée un fichier `.env.local` à la racine du projet (il est déjà ignoré par Git).

```bash
NEXT_PUBLIC_SCREEN_PASSWORD=change-me
NEXT_PUBLIC_ADMIN_PASSWORD=change-me
```

### Remarques

- Les variables `NEXT_PUBLIC_*` sont **exposées au navigateur** (ce n’est pas une sécurité “serveur”).
- Après modification, **redémarre** le serveur Next.js.

### Stream Deck (télécommande Admin) — sans focus Chrome

Objectif : Studio One reste au focus ; le Stream Deck envoie des **HTTP GET** silencieux.

#### Prérequis

1. **Admin** ouvert (Chrome peut être en arrière-plan, onglet Admin vivant).
2. Bouton **Télécommande ON** dans Admin.
3. Plugin Stream Deck **Web Requests** (Marketplace Elgato) — **pas** l’action native « Website » (ouvre un onglet et vole le focus).
4. Déploiement Vercel (ou `npm run dev` + URL `http://localhost:3000` si Stream Deck et PC sont le même).

#### Configuration des touches

Dans Admin (Télécommande ON), copie les 4 URLs affichées, ou format :

```
https://TON-DOMAINE/api/remote?action=ACTION&secret=TON_SECRET
```

| Touche Stream Deck | `action` | Effet |
|---|---|---|
| Démarrer | `start` | Démarre le quiz depuis le début |
| Pause | `pause` | Pause / Reprendre (après fin de manche → 1ère Q suivante) |
| Back | `back` | Seek marqueur précédent (en pause) |
| Next | `next` | Seek marqueur suivant (en pause) |

Pour chaque touche : action **HTTP Request** / **Web Requests** → Method **GET** → colle l’URL → pas de body.

#### Dépannage

- `Télécommande OFF` → active-la dans Admin.
- `secret invalide` → recolle le secret / les URLs depuis Admin (un nouveau ON régénère le secret si besoin).
- Rien ne se passe → Admin fermé ou onglet tué ; rouvre Admin + Télécommande ON.
- Chrome passe au premier plan → tu as utilisé **Website** au lieu de **Web Requests**.
