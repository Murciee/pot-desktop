[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$SkipBuild,
    [switch]$SkipFrontend,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

function Stop-PotProcesses {
    param(
        [string]$OnlyPath = $null
    )

    $procs = @(Get-Process -Name 'pot' -ErrorAction SilentlyContinue)
    if (-not [string]::IsNullOrEmpty($OnlyPath)) {
        $procs = @($procs | Where-Object {
            $_.Path -and [string]::Equals($_.Path, $OnlyPath, [System.StringComparison]::OrdinalIgnoreCase)
        })
    }

    if ($procs.Count -eq 0) {
        return
    }

    $targetIds = @($procs | ForEach-Object { $_.Id })
    foreach ($proc in $procs) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }

    $deadline = (Get-Date).AddSeconds(3)
    while ((Get-Date) -lt $deadline) {
        $remaining = @(Get-Process -Id $targetIds -ErrorAction SilentlyContinue)
        if ($remaining.Count -eq 0) {
            break
        }
        Start-Sleep -Milliseconds 100
    }

    $remaining = @(Get-Process -Id $targetIds -ErrorAction SilentlyContinue)
    if ($remaining.Count -gt 0) {
        $pids = ($remaining | ForEach-Object { $_.Id }) -join ', '
        throw "Could not stop running pot.exe (PID: $pids), likely because it is running as Administrator. Please exit pot from the system tray (or run this script in an Administrator terminal) and retry."
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$exePath = Join-Path $repoRoot 'src-tauri\target\release\pot.exe'

try {
    Push-Location $repoRoot

    if ($Check) {
        Write-Host '[check] Running JS unit tests...'
        & node --test 'tests/*.test.mjs'
        if ($LASTEXITCODE -ne 0) {
            throw "JS unit tests failed with exit code $LASTEXITCODE"
        }

        Write-Host '[check] Running Rust unit tests...'
        & cargo test --manifest-path src-tauri/Cargo.toml
        if ($LASTEXITCODE -ne 0) {
            throw "Rust unit tests failed with exit code $LASTEXITCODE"
        }
    }

    if (-not $SkipBuild) {
        if (-not $SkipFrontend) {
            Write-Host '[build] Building frontend bundle...'
            $viteCmd = Join-Path $repoRoot 'node_modules\.bin\vite.cmd'
            & $viteCmd build
            if ($LASTEXITCODE -ne 0) {
                throw "Frontend build failed with exit code $LASTEXITCODE"
            }
        }

        Stop-PotProcesses -OnlyPath $exePath

        Write-Host '[build] Building release pot.exe (custom-protocol)...'
        & cargo build --release --manifest-path src-tauri/Cargo.toml --features custom-protocol
        if ($LASTEXITCODE -ne 0) {
            throw "Cargo release build failed with exit code $LASTEXITCODE"
        }
    }

    if (-not (Test-Path $exePath)) {
        throw "Release executable not found at $exePath"
    }

    if (-not $NoLaunch) {
        Stop-PotProcesses
        Start-Process -FilePath $exePath -WorkingDirectory $repoRoot
        Write-Host "[launch] Started $exePath"
    } else {
        Write-Host "[done] Ready at $exePath"
    }
} finally {
    Pop-Location
}
