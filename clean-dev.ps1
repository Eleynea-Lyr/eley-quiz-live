# Script PowerShell pour nettoyer le cache Next.js et redémarrer le serveur de développement
# Usage: .\clean-dev.ps1

Write-Host "Nettoyage du cache Next.js..." -ForegroundColor Yellow

# Supprimer le dossier .next s'il existe
if (Test-Path ".next") {
    Remove-Item -Recurse -Force ".next"
    Write-Host "Cache supprimé ✓" -ForegroundColor Green
} else {
    Write-Host "Aucun cache à supprimer" -ForegroundColor Gray
}

# Tuer les processus Node.js qui pourraient bloquer le port 3000
Write-Host "Vérification des processus Node.js..." -ForegroundColor Yellow
$nodeProcesses = Get-Process -Name "node" -ErrorAction SilentlyContinue
if ($nodeProcesses) {
    Write-Host "Processus Node.js trouvés: $($nodeProcesses.Count)" -ForegroundColor Yellow
    # Ne pas tuer automatiquement, juste informer
    Write-Host "Si vous avez des problèmes, fermez manuellement les processus Node.js" -ForegroundColor Gray
}

Write-Host "Démarrage du serveur de développement..." -ForegroundColor Yellow
npm run dev
