# Merges per-language Windows MSI installers into a single multi-language MSI
# using WiX torch.exe transforms and Windows Installer embedded substorages.
# On launch, Windows Installer selects the transform matching the user's UI
# language (LCID) if present in PID_TEMPLATE, or falls back to BaseLang.

param(
    [Parameter(Mandatory = $true)]
    [string]$MsiDir,

    [Parameter(Mandatory = $true)]
    [string]$ProductName,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [string]$BaseLang,

    [Parameter(Mandatory = $true)]
    [string[]]$ExtraLangs,

    [string]$TorchPath = ""
)

$ErrorActionPreference = "Stop"

function Find-TorchExe {
    param([string]$ExplicitPath)

    if ($ExplicitPath -and (Test-Path $ExplicitPath)) {
        return $ExplicitPath
    }

    $cmd = Get-Command "torch.exe" -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    if ($env:WIX) {
        $candidate = Join-Path $env:WIX "bin\torch.exe"
        if (Test-Path $candidate) { return $candidate }
    }

    if ($env:LOCALAPPDATA) {
        $tauriDir = Join-Path $env:LOCALAPPDATA "tauri"
        if (Test-Path $tauriDir) {
            $found = Get-ChildItem -Path $tauriDir -Recurse -Filter "torch.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found) { return $found.FullName }
        }
    }

    $programFilesX86 = ${env:ProgramFiles(x86)}
    if ($programFilesX86) {
        $found = Get-ChildItem -Path $programFilesX86 -Filter "WiX Toolset*" -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "bin\torch.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($found) { return $found }
    }

    throw "torch.exe not found. Ensure WiX Toolset is installed or cached by Tauri."
}

function Get-Lcid {
    param([string]$CultureName)
    return [System.Globalization.CultureInfo]::GetCultureInfo($CultureName).LCID
}

function Release-ComObject {
    param($Obj)
    if ($null -ne $Obj) {
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($Obj) } catch {}
    }
}

$resolvedMsiDir = (Resolve-Path $MsiDir).Path
$ExtraLangs = $ExtraLangs | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$torch = Find-TorchExe -ExplicitPath $TorchPath
Write-Host "[merge-msi] Using torch.exe: $torch"

$basePattern = "${ProductName}_${Version}_*_${BaseLang}.msi"
$baseMsis = Get-ChildItem -Path $resolvedMsiDir -Filter $basePattern -File

if (-not $baseMsis -or $baseMsis.Count -eq 0) {
    throw "No base MSI matching '$basePattern' found in '$resolvedMsiDir'."
}

$baseLcid = Get-Lcid -CultureName $BaseLang

foreach ($baseMsiFile in $baseMsis) {
    $suffix = "_${BaseLang}.msi"
    $prefix = $baseMsiFile.Name.Substring(0, $baseMsiFile.Name.Length - $suffix.Length)
    $mergedMsiPath = Join-Path $resolvedMsiDir "${prefix}.msi"
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("photoboggan-msi-merge-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    try {
        Copy-Item -Path $baseMsiFile.FullName -Destination $mergedMsiPath -Force

        $lcids = [System.Collections.Generic.List[int]]::new()
        $lcids.Add($baseLcid)

        $transforms = [System.Collections.Generic.List[psobject]]::new()
        $sourceFilesToRemove = [System.Collections.Generic.List[string]]::new()
        $sourceFilesToRemove.Add($baseMsiFile.FullName)
        if (Test-Path "$($baseMsiFile.FullName).sig") {
            $sourceFilesToRemove.Add("$($baseMsiFile.FullName).sig")
        }

        foreach ($lang in $ExtraLangs) {
            if ($lang -eq $BaseLang) { continue }
            $langMsiPath = Join-Path $resolvedMsiDir "${prefix}_${lang}.msi"
            if (-not (Test-Path $langMsiPath)) {
                Write-Warning "[merge-msi] Localized MSI not found for '${lang}': $langMsiPath (skipping)"
                continue
            }

            $lcid = Get-Lcid -CultureName $lang
            $mstPath = Join-Path $tempDir "${lcid}.mst"

            Write-Host "[merge-msi] Generating transform for $lang (LCID $lcid)..."
            & $torch -p -t language $baseMsiFile.FullName $langMsiPath -out $mstPath | Out-Null
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path $mstPath)) {
                throw "torch.exe failed for language '$lang' (exit code $LASTEXITCODE)."
            }

            $lcids.Add($lcid)
            $transforms.Add([pscustomobject]@{ Lcid = $lcid; Path = $mstPath })

            $sourceFilesToRemove.Add($langMsiPath)
            if (Test-Path "${langMsiPath}.sig") {
                $sourceFilesToRemove.Add("${langMsiPath}.sig")
            }
        }

        if ($transforms.Count -eq 0) {
            Write-Warning "[merge-msi] No extra language transforms generated for ${prefix}. Keeping single-language MSI."
            continue
        }

        # Embed each .mst into _Storages named after its decimal LCID and update PID_TEMPLATE
        $installer = $null
        $db = $null
        $summary = $null
        try {
            $msiOpenDatabaseModeTransact = 1
            $msiViewModifyAssign = 7
            $pidTemplate = 7

            $installer = New-Object -ComObject WindowsInstaller.Installer
            $db = $installer.GetType().InvokeMember("OpenDatabase", "InvokeMethod", $null, $installer, ([object[]]@([string]$mergedMsiPath, [int]$msiOpenDatabaseModeTransact)))

            foreach ($t in $transforms) {
                $view = $null
                $record = $null
                try {
                    $view = $db.GetType().InvokeMember("OpenView", "InvokeMethod", $null, $db, ([object[]]@("SELECT Name, Data FROM _Storages")))
                    $view.GetType().InvokeMember("Execute", "InvokeMethod", $null, $view, $null) | Out-Null

                    $record = $installer.GetType().InvokeMember("CreateRecord", "InvokeMethod", $null, $installer, ([object[]]@(2)))
                    $record.GetType().InvokeMember("StringData", "SetProperty", $null, $record, ([object[]]@(1, "$($t.Lcid)"))) | Out-Null
                    $record.GetType().InvokeMember("SetStream", "InvokeMethod", $null, $record, ([object[]]@(2, "$($t.Path)"))) | Out-Null

                    $view.GetType().InvokeMember("Modify", "InvokeMethod", $null, $view, ([object[]]@([int]$msiViewModifyAssign, $record))) | Out-Null
                    $view.GetType().InvokeMember("Close", "InvokeMethod", $null, $view, $null) | Out-Null
                } finally {
                    Release-ComObject $record
                    Release-ComObject $view
                }
            }

            $summary = $db.GetType().InvokeMember("SummaryInformation", "GetProperty", $null, $db, ([object[]]@(20)))
            $currentTemplate = $summary.GetType().InvokeMember("Property", "GetProperty", $null, $summary, ([object[]]@([int]$pidTemplate)))
            $archPrefix = ($currentTemplate -split ";")[0]
            if (-not $archPrefix) { $archPrefix = "x64" }

            $newTemplate = "${archPrefix};" + ($lcids -join ",")
            Write-Host "[merge-msi] Setting Template Summary (PID_TEMPLATE) to '$newTemplate'"
            $summary.GetType().InvokeMember("Property", "SetProperty", $null, $summary, ([object[]]@([int]$pidTemplate, [string]$newTemplate))) | Out-Null
            $summary.GetType().InvokeMember("Persist", "InvokeMethod", $null, $summary, $null) | Out-Null

            $db.GetType().InvokeMember("Commit", "InvokeMethod", $null, $db, $null) | Out-Null
        } finally {
            Release-ComObject $summary
            Release-ComObject $db
            Release-ComObject $installer
        }

        foreach ($file in $sourceFilesToRemove) {
            Remove-Item -Path $file -Force -ErrorAction SilentlyContinue
        }

        Write-Host "[merge-msi] Created multi-language MSI: $mergedMsiPath"
    } finally {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
