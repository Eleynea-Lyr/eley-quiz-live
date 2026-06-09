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

