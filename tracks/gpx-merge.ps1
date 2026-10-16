<#
.SYNOPSIS
    Hängt Wegpunkte, Routen und Tracks einer GPX-Datei an transafrica-2026.gpx an.

.DESCRIPTION
    Liest die angegebene GPX-Datei und fügt deren Wegpunkte (wpt), Routen (rte)
    und Tracks (trk) in transafrica-2026.gpx ein. Die Reihenfolge der Elemente
    gemäss GPX-Schema (wpt, rte, trk) bleibt dabei erhalten.

    - Zieldatei: transafrica-2026.gpx (im Ordner des Scripts, Pfad in $Ziel anpassbar)
    - Die anzuhängende Datei wird nur gelesen und bleibt unverändert.
    - Vor jedem Lauf entsteht ein Backup: transafrica-2026.gpx.bak
      (enthält nur den Stand vor dem letzten Lauf).
    - Es findet keine Duplikatprüfung statt.

.PARAMETER Datei
    Pfad zur GPX-Datei, die angehängt werden soll.

.PARAMETER EinTrack
    Hängt die Tracksegmente an den letzten Track der Zieldatei an,
    statt die Tracks als eigene Tracks zu übernehmen.

.EXAMPLE
    .\GpxAnhaengen.ps1 .\etappe-12.gpx
    Hängt etappe-12.gpx als eigenen Track an.

.EXAMPLE
    .\GpxAnhaengen.ps1 .\etappe-12.gpx -EinTrack
    Hängt die Segmente an den letzten Track an.

.NOTES
    Projekt : Transafrica 2026 / spurmacher.ch
    Version : 1.0
    Hinweis : Bei blockierter Ausführung einmalig
              Set-ExecutionPolicy -Scope Process Bypass
#>

param(
    [Parameter(Mandatory, Position = 0)][string]$Datei,
    [switch]$EinTrack
)

# Feste Zieldatei: liegt im selben Ordner wie dieses Script. Bei Bedarf Pfad anpassen.
$Ziel = Join-Path $PSScriptRoot 'transafrica-2026.gpx'

$pfad = { param($p) $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p) }
$Datei = & $pfad $Datei

if (-not (Test-Path $Ziel))  { throw "Zieldatei nicht gefunden: $Ziel" }
if (-not (Test-Path $Datei)) { throw "Datei nicht gefunden: $Datei" }
if ($Datei -eq $Ziel)        { throw "Die anzuhängende Datei darf nicht die Zieldatei selbst sein." }

$docZiel = New-Object System.Xml.XmlDocument; $docZiel.PreserveWhitespace = $false; $docZiel.Load($Ziel)
$docNeu  = New-Object System.Xml.XmlDocument; $docNeu.PreserveWhitespace = $false;  $docNeu.Load($Datei)

$rootZiel = $docZiel.DocumentElement
$rootNeu  = $docNeu.DocumentElement

if ($rootZiel.NamespaceURI -ne $rootNeu.NamespaceURI) {
    Write-Warning "Unterschiedliche GPX-Namespaces (z.B. 1.0 vs. 1.1) - Ergebnis bitte prüfen."
}

# Fügt einen Knoten vor dem ersten Element ein, das im Schema danach kommen muss
function Add-Knoten($root, $knoten, [string[]]$vorher) {
    $neu = $root.OwnerDocument.ImportNode($knoten, $true)
    $ref = $root.ChildNodes | Where-Object { $_.NodeType -eq 'Element' -and $_.LocalName -in $vorher } | Select-Object -First 1
    if ($ref) { [void]$root.InsertBefore($neu, $ref) } else { [void]$root.AppendChild($neu) }
}

$zaehler = @{ wpt = 0; rte = 0; trk = 0; trkseg = 0 }

foreach ($k in @($rootNeu.ChildNodes)) {
    if ($k.NodeType -ne 'Element') { continue }
    switch ($k.LocalName) {
        'wpt' { Add-Knoten $rootZiel $k @('rte','trk','extensions'); $zaehler.wpt++ }
        'rte' { Add-Knoten $rootZiel $k @('trk','extensions');       $zaehler.rte++ }
        'trk' {
            if ($EinTrack) {
                $letzterTrk = @($rootZiel.ChildNodes | Where-Object { $_.LocalName -eq 'trk' }) | Select-Object -Last 1
                if ($letzterTrk) {
                    foreach ($seg in @($k.ChildNodes | Where-Object { $_.LocalName -eq 'trkseg' })) {
                        [void]$letzterTrk.AppendChild($docZiel.ImportNode($seg, $true)); $zaehler.trkseg++
                    }
                    continue
                }
            }
            Add-Knoten $rootZiel $k @('extensions'); $zaehler.trk++
        }
    }
}

# Backup der Zieldatei vor dem Überschreiben
Copy-Item $Ziel "$Ziel.bak" -Force

$settings = New-Object System.Xml.XmlWriterSettings
$settings.Indent = $true
$settings.Encoding = New-Object System.Text.UTF8Encoding($false)
$writer = [System.Xml.XmlWriter]::Create($Ziel, $settings)
$docZiel.Save($writer); $writer.Close()

"Fertig: $($zaehler.wpt) Wegpunkte, $($zaehler.rte) Routen, $($zaehler.trk) Tracks, $($zaehler.trkseg) Segmente aus '$(Split-Path $Datei -Leaf)' an transafrica-2026.gpx angehängt."