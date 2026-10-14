param(
    [Parameter(Mandatory)][string]$Transafrica,
    [Parameter(Mandatory)][string]$B,
    [string]$Ausgabe,
    [switch]$EinTrack   # B-Segmente an den letzten Track von Transafrica anhängen, statt B als eigenen Track zu führen
)

$pfad = { param($p) $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p) }
$Transafrica = & $pfad $Transafrica
$B = & $pfad $B
$ueberschreiben = -not $Ausgabe -or (& $pfad $Ausgabe) -eq $Transafrica
$Ausgabe = if ($Ausgabe) { & $pfad $Ausgabe } else { $Transafrica }

$docA = New-Object System.Xml.XmlDocument; $docA.PreserveWhitespace = $false; $docA.Load($Transafrica)
$docB = New-Object System.Xml.XmlDocument; $docB.PreserveWhitespace = $false; $docB.Load($B)

$rootA = $docA.DocumentElement
$rootB = $docB.DocumentElement

if ($rootA.NamespaceURI -ne $rootB.NamespaceURI) {
    Write-Warning "Unterschiedliche GPX-Namespaces (z.B. 1.0 vs. 1.1) - Ergebnis bitte prüfen."
}

# Fügt einen Knoten vor dem ersten Element ein, das im Schema danach kommen muss
function Add-Knoten($root, $knoten, [string[]]$vorher) {
    $neu = $root.OwnerDocument.ImportNode($knoten, $true)
    $ref = $root.ChildNodes | Where-Object { $_.NodeType -eq 'Element' -and $_.LocalName -in $vorher } | Select-Object -First 1
    if ($ref) { [void]$root.InsertBefore($neu, $ref) } else { [void]$root.AppendChild($neu) }
    return $neu
}

$zaehler = @{ wpt = 0; rte = 0; trk = 0; trkseg = 0 }

foreach ($k in @($rootB.ChildNodes)) {
    if ($k.NodeType -ne 'Element') { continue }
    switch ($k.LocalName) {
        'wpt' { [void](Add-Knoten $rootA $k @('rte','trk','extensions')); $zaehler.wpt++ }
        'rte' { [void](Add-Knoten $rootA $k @('trk','extensions'));       $zaehler.rte++ }
        'trk' {
            if ($EinTrack) {
                $letzterTrk = @($rootA.ChildNodes | Where-Object { $_.LocalName -eq 'trk' }) | Select-Object -Last 1
                if ($letzterTrk) {
                    foreach ($seg in @($k.ChildNodes | Where-Object { $_.LocalName -eq 'trkseg' })) {
                        [void]$letzterTrk.AppendChild($docA.ImportNode($seg, $true)); $zaehler.trkseg++
                    }
                    continue
                }
            }
            [void](Add-Knoten $rootA $k @('extensions')); $zaehler.trk++
        }
    }
}

if ($ueberschreiben) { Copy-Item $Transafrica "$Transafrica.bak" -Force }

$settings = New-Object System.Xml.XmlWriterSettings
$settings.Indent = $true
$settings.Encoding = New-Object System.Text.UTF8Encoding($false)
$writer = [System.Xml.XmlWriter]::Create($Ausgabe, $settings)
$docA.Save($writer); $writer.Close()

"Fertig: $($zaehler.wpt) Wegpunkte, $($zaehler.rte) Routen, $($zaehler.trk) Tracks, $($zaehler.trkseg) Segmente hinzugefügt -> $Ausgabe"