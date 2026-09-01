<#
.SYNOPSIS
  Ersetzt die alte Apps-Script-Web-App-URL durch eine neue, in allen
  Dateien im Repo-Ordner (html, ps1), unabhaengig davon, welche alte
  URL dort aktuell steht.

.USAGE
  .\update-appscript-url.ps1 -NewUrl "https://script.google.com/macros/s/DEINE_NEUE_ID/exec"
  .\update-appscript-url.ps1 -NewUrl "..." -DryRun    (nur anzeigen, nichts schreiben)


.DESCRIPTION
  Ersetzt die alte Apps-Script-Web-App-URL durch eine neue, in allen
  Dateien im Repo-Ordner (html, ps1), unabhaengig davon, welche alte
  URL dort aktuell steht.

.PARAMETER NewUrl
    Neue URL von code.cs

.PARAMETER RepoPath
    Fixer Wert

.PARAMETER DryRun
    Testlauf

.EXAMPLE
    PS> .\MeinSkript.ps1 -Name "Test"
    Beschreibung, was dieses Beispiel macht.

.EXAMPLE
    .\update-appscript-url.ps1 -NewUrl "https://script.google.com/macros/s/AKfycbyTj5QrM4I6uv67TB-_HO8rVoNd8vO7oFJysZI1FmOTFSXkKCRZxJA2f7VYN9YT10VAIQ/exec" -DryRun

.INPUTS
    Keine 

.OUTPUTS
    Keine 

.NOTES
    Autor:   Peter


.LINK
    n/a


#>

param(
    [Parameter(Mandatory=$true)]
    [string]$NewUrl,

    [string]$RepoPath = "C:\Daten WORK\Reisen\Frieda_WorldTour\Media\InteractiveMap\TravelMap",

    [switch]$DryRun
)

# --- Validierung der neuen URL ---
if ($NewUrl -notmatch '^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$') {
    Write-Host "Warnung: Die angegebene URL sieht nicht wie eine typische Apps-Script-Web-App-URL aus." -ForegroundColor Yellow
    Write-Host "Erwartetes Muster: https://script.google.com/macros/s/SCRIPT_ID/exec"
    $confirm = Read-Host "Trotzdem fortfahren? (j/n)"
    if ($confirm -ne "j") { exit 0 }
}

if (-not (Test-Path $RepoPath)) {
    Write-Host "Repo-Pfad nicht gefunden: $RepoPath" -ForegroundColor Red
    exit 1
}

# --- Muster fuer jede beliebige alte Apps-Script-Web-App-URL ---
$pattern = 'https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec'

# --- Relevante Dateitypen durchsuchen (rekursiv im Repo-Ordner) ---
$files = Get-ChildItem -Path $RepoPath -Recurse -Include *.html, *.ps1 -File -Exclude update-appscript-url.ps1

$changedCount = 0

foreach ($file in $files) {
    $content = Get-Content -Path $file.FullName -Raw

    if ($content -notmatch $pattern) {
        continue
    }

    $matches = [regex]::Matches($content, $pattern)
    $uniqueOld = $matches | ForEach-Object { $_.Value } | Select-Object -Unique

    $newContent = [regex]::Replace($content, $pattern, $NewUrl)

    if ($newContent -eq $content) {
        continue
    }

    Write-Host "$($file.Name):" -ForegroundColor Cyan
    foreach ($old in $uniqueOld) {
        Write-Host "  alt: $old"
    }
    Write-Host "  neu: $NewUrl"

    if (-not $DryRun) {
        Set-Content -Path $file.FullName -Value $newContent -Encoding utf8 -NoNewline
        Write-Host "  -> aktualisiert" -ForegroundColor Green
    } else {
        Write-Host "  -> DryRun, nicht geschrieben" -ForegroundColor Yellow
    }

    $changedCount++
}

Write-Host ""
if ($changedCount -eq 0) {
    Write-Host "Keine Datei mit einer Apps-Script-URL gefunden oder alle bereits aktuell."
} else {
    Write-Host "$changedCount Datei(en) $(if ($DryRun) { 'wuerden' } else { 'wurden' }) aktualisiert."
}
