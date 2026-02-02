#!/bin/bash
# Script bash pour nettoyer le cache Next.js et redémarrer le serveur de développement
# Usage: ./clean-dev.sh

echo "🧹 Nettoyage du cache Next.js..."

# Supprimer le dossier .next s'il existe
if [ -d ".next" ]; then
    rm -rf .next
    echo "✅ Cache supprimé"
else
    echo "ℹ️  Aucun cache à supprimer"
fi

# Tuer les processus Node.js qui pourraient bloquer le port 3000
echo "🔍 Vérification des processus Node.js..."
NODE_PROCESSES=$(pgrep -f "next dev" || true)
if [ ! -z "$NODE_PROCESSES" ]; then
    echo "⚠️  Processus Node.js trouvés. Arrêt..."
    pkill -f "next dev" || true
    sleep 1
fi

echo "🚀 Démarrage du serveur de développement..."
npm run dev
