# Guide de développement

## Scripts npm disponibles

Définis dans `package.json` :

```bash
npm run dev     # Démarre le serveur de développement (Next.js)
npm run build   # Build de production
npm run start   # Démarre le serveur en mode production (après build)
```

## Variables d'environnement

Les pages `/admin` et `/screen` sont protégées par un mot de passe lu depuis
des variables d'environnement. Il faut un fichier `.env.local` à la racine
(voir `docs/ENV.md`) :

```bash
NEXT_PUBLIC_SCREEN_PASSWORD=ton-mot-de-passe-screen
NEXT_PUBLIC_ADMIN_PASSWORD=ton-mot-de-passe-admin
```

> Important : les variables `NEXT_PUBLIC_*` sont injectées à la **compilation**.
> Après toute modification de `.env.local`, **redémarre** le serveur (`npm run dev`).

## En cas de problème (page blanche, 404, hot-reload bloqué)

Sous Windows, un script PowerShell est fourni pour nettoyer le cache `.next`
et relancer le serveur :

```powershell
.\clean-dev.ps1
```

Ce script :
- supprime le dossier de cache `.next` s'il existe ;
- signale les éventuels processus Node.js encore actifs (sans les tuer) ;
- relance `npm run dev`.

### Nettoyage manuel équivalent

```powershell
Remove-Item -Recurse -Force .next
npm run dev
```

## Conseils

1. Attends la fin de la compilation avant d'ouvrir/recharger la page.
2. Si plusieurs serveurs tournent en parallèle, ferme les terminaux `npm run dev`
   en trop (le port 3000 doit être libre).
3. En cas de problème persistant : supprime `.next`, puis `node_modules`,
   réinstalle avec `npm install`, et relance.
