# Guide de développement - Hot Reload

## Problème résolu

Le problème de page blanche / erreur 404 après chaque modification a été corrigé en améliorant la configuration Next.js pour mieux gérer le hot-reload.

## Améliorations apportées

1. **Configuration Next.js améliorée** (`next.config.js`)
   - Ajout de `watchOptions` avec polling pour mieux détecter les changements de fichiers (utile sur Windows)
   - Configuration optimisée pour le développement

2. **Nouveaux scripts npm**
   - `npm run dev:clean` : Nettoie le cache et démarre le serveur de développement
   - `npm run clean` : Nettoie uniquement le cache `.next`

## Utilisation

### Démarrage normal
```bash
npm run dev
```

### Si vous rencontrez des problèmes (page blanche, 404)
```bash
npm run dev:clean
```

Ce script nettoie automatiquement le cache `.next` et redémarre le serveur.

### Nettoyage manuel du cache
```bash
npm run clean
```

Puis redémarrez avec `npm run dev`.

## Scripts PowerShell (Windows)

Si vous préférez utiliser un script PowerShell :

```powershell
.\clean-dev.ps1
```

Ce script :
- Nettoie le cache `.next`
- Vérifie les processus Node.js
- Redémarre le serveur de développement

## Conseils

1. **Si le hot-reload ne fonctionne toujours pas** :
   - Arrêtez le serveur (Ctrl+C)
   - Exécutez `npm run dev:clean`
   - Attendez que la compilation soit terminée avant d'ouvrir la page

2. **Si plusieurs processus Node.js tournent** :
   - Fermez tous les terminaux qui exécutent `npm run dev`
   - Vérifiez avec le Gestionnaire des tâches Windows
   - Redémarrez avec `npm run dev:clean`

3. **En cas de problème persistant** :
   - Supprimez manuellement le dossier `.next`
   - Supprimez `node_modules` et réinstallez avec `npm install`
   - Redémarrez votre ordinateur si nécessaire

## Notes techniques

- Le polling est activé à 1000ms pour mieux détecter les changements sur Windows
- Le cache est automatiquement invalidé lors des modifications
- Les fichiers sont surveillés en temps réel avec un délai d'agrégation de 300ms
