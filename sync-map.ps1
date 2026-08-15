<#
.SYNOPSIS
  TRAVELMAP - woechentlicher Sync: holt Daten aus dem Google Sheet
  (via Apps Script Endpoint) und pusht sie als data.js ins GitHub-Repo.

.NOTES
  Einmalig anpassen: $EndpointUrl und $RepoPath unten.
  Aufruf:  .\sync-map.ps1
  Testlauf ohne Push:  .\sync-map.ps1 -DryRun
#>

param(
    [switch]$DryRun
)

# ------------------------------------------------------------
# CONFIG - hier anpassen
# ------------------------------------------------------------
$EndpointUrl = "https://script.google.com/macros/s/AKfycbzN-D9RRH0Mjn-e5jIXBPLcpUGNzpL6zGINtfzgAOWuvOXMEhg6y1x15x8ngbX3ysNyfw/exec"
$RepoPath    = "C:\Daten WORK\Reisen\Frieda_WorldTour\Media\InteractiveMap\TravelMap"   # lokaler Git-Klon des Karten-Repos
$DataFile    = Join-Path $RepoPath "data.js"
$LogPath     = "C:\Daten WORK\Reisen\Frieda_WorldTour\Media\InteractiveMap\"
$LogFile     = Join-Path $LogPath "sync-log.txt"

# ------------------------------------------------------------
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

Write-Log "=== Sync gestartet ==="

# --- Vorab-Check: liegt der Git-Ordner ueberhaupt vor? ---
if (-not (Test-Path $RepoPath)) {
    Write-Log "Repo-Pfad nicht gefunden: $RepoPath" "FEHLER"
    exit 1
}

# --- 1. Daten vom Apps-Script-Endpoint holen, mit Retry bei Netzproblemen ---
$response = $null
$maxAttempts = 3
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
        Write-Log "Abruf Versuch $attempt/$maxAttempts ..."
        $response = Invoke-RestMethod -Uri $EndpointUrl -Method Get -TimeoutSec 30
        break
    } catch {
        Write-Log "Abruf fehlgeschlagen: $($_.Exception.Message)" "WARNUNG"
        if ($attempt -eq $maxAttempts) {
            Write-Log "Alle Versuche fehlgeschlagen. Sync abgebrochen, bestehende data.js bleibt unveraendert." "FEHLER"
            exit 1
        }
        Start-Sleep -Seconds (5 * $attempt)  # steigender Backoff
    }
}

# --- 2. Antwort validieren, bevor irgendwas ueberschrieben wird ---
if (-not $response.ok) {
    Write-Log "Apps Script meldet Fehler: $($response.error)" "FEHLER"
    exit 1
}

if (-not $response.points -or $response.points.Count -eq 0) {
    Write-Log "Antwort enthaelt 0 Punkte. Breche ab, um data.js nicht versehentlich zu leeren." "FEHLER"
    Write-Log "(Falls das Sheet wirklich leer sein soll: Zeile hier auskommentieren.)" "INFO"
    exit 1
}

Write-Log "Empfangen: $($response.count) gueltige Punkte, $($response.skipped) uebersprungen (fehlerhafte Zeilen im Sheet)."
if ($response.skipped -gt 0) {
    Write-Log "Hinweis: $($response.skipped) Zeile(n) im Sheet haben ungueltige/fehlende Lat-Lon oder Titel und wurden ignoriert." "WARNUNG"
}

# --- 3. data.js neu erzeugen ---
$json = $response.points | ConvertTo-Json -Depth 6 -Compress
# PowerShell-Eigenheit: ConvertTo-Json gibt bei genau 1 Element ein einzelnes
# Objekt statt ein Array zurueck ({...} statt [{...}]) - hier korrigieren,
# da die Karte immer ein Array erwartet.
if ($response.points.Count -eq 1) {
    $json = "[$json]"
}
$jsContent = @"
// Automatisch generiert von sync-map.ps1 - nicht manuell bearbeiten.
// Quelle: Google Sheet, synchronisiert am $(Get-Date -Format "yyyy-MM-dd HH:mm")
var DATA = $json;
"@

# --- 4. Nur committen, wenn sich wirklich etwas geaendert hat ---
# Vergleich nur anhand der reinen "var DATA = ..."-Zeile, nicht der ganzen Datei -
# der Zeitstempel-Kommentar oben wuerde sonst bei jedem Lauf einen Unterschied vortaeuschen.
$hasChanges = $true
if (Test-Path $DataFile) {
    $existingDataLine = (Get-Content $DataFile -Raw) -replace '(?s)^.*(var DATA = .*;)\s*$', '$1'
    $newDataLine = "var DATA = $json;"
    if ($existingDataLine.Trim() -eq $newDataLine.Trim()) {
        $hasChanges = $false
    }
}

if (-not $hasChanges) {
    Write-Log "Keine inhaltlichen Aenderungen seit letztem Sync. Kein Commit noetig."
    Write-Log "=== Sync beendet (keine Aenderung) ==="
    exit 0
}

Set-Content -Path $DataFile -Value $jsContent -Encoding utf8
Write-Log "data.js aktualisiert ($($response.count) Punkte)."

if ($DryRun) {
    Write-Log "DryRun aktiv - kein Git-Commit/Push. Datei wurde trotzdem lokal geschrieben."
    Write-Log "=== Sync beendet (DryRun) ==="
    exit 0
}

# --- 5. Git commit + push, mit Fehlerpruefung nach jedem Schritt ---
Push-Location $RepoPath
try {
    git add data.js 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git add fehlgeschlagen" }

    $commitMsg = "Datenupdate $(Get-Date -Format yyyy-MM-dd_HH-mm) - $($response.count) Punkte"
    git commit -m $commitMsg 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git commit fehlgeschlagen (evtl. nichts zu committen)" }

    git push 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git push fehlgeschlagen - Netzverbindung oder Auth pruefen" }

    Write-Log "Git push erfolgreich."
} catch {
    Write-Log "Git-Fehler: $($_.Exception.Message)" "FEHLER"
    Write-Log "data.js wurde lokal aktualisiert, aber NICHT gepusht. Beim naechsten Lauf erneut versuchen." "WARNUNG"
    Pop-Location
    exit 1
}
Pop-Location

Write-Log "=== Sync erfolgreich abgeschlossen ==="
