[CmdletBinding()]
param(
  [string]$Version = "latest",
  [string]$InstallDir = "$env:USERPROFILE\.local\bin",
  [string]$LocalBinary = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Repo = "yasmeendawnelle-spec/Atrium"
$TargetExe = Join-Path $InstallDir "atrium.exe"
$LegacyCmd = Join-Path $InstallDir "atrium.cmd"

if ($Uninstall) {
  $removed = $false
  if (Test-Path $TargetExe) {
    Remove-Item -Force $TargetExe
    $removed = $true
  }
  if (Test-Path $LegacyCmd) {
    Remove-Item -Force $LegacyCmd
    $removed = $true
  }
  if ($removed) {
    Write-Host "Removed Atrium CLI from $InstallDir"
  } else {
    Write-Host "Atrium CLI was not found in $InstallDir"
  }
  exit 0
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$TempExe = Join-Path $InstallDir ("atrium.tmp." + $PID + ".exe")

try {
  if ($LocalBinary) {
    if (-not (Test-Path $LocalBinary)) {
      throw "Local binary not found: $LocalBinary"
    }
    Copy-Item -Force -Path (Resolve-Path $LocalBinary).Path -Destination $TempExe
  } else {
    $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    if ($osArch -ne "x64" -and $osArch -ne "amd64") {
      throw "Prebuilt Windows standalone binaries currently target x64 (detected: $osArch). Install via 'npm install -g @atrium-ai/cli' or 'npm run cli:install'."
    }
    $assetName = "atrium-win32-x64.exe"
    if ($Version -eq "latest") {
      $url = "https://github.com/$Repo/releases/latest/download/$assetName"
    } else {
      $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
      $url = "https://github.com/$Repo/releases/download/$tag/$assetName"
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "Downloading Atrium CLI ($assetName)..."
    Invoke-WebRequest -Uri $url -OutFile $TempExe -UseBasicParsing
  }

  Move-Item -Force -Path $TempExe -Destination $TargetExe
} finally {
  if (Test-Path $TempExe) {
    Remove-Item -Force $TempExe -ErrorAction SilentlyContinue
  }
}

$normTarget = $InstallDir.TrimEnd('\', '/')
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$userEntries = @($userPath -split ';' | Where-Object { $_ -and $_.Trim() })
$alreadyInUserPath = $false
foreach ($entry in $userEntries) {
  if ($entry.Trim().TrimEnd('\', '/') -ieq $normTarget) {
    $alreadyInUserPath = $true
    break
  }
}

$pathUpdated = $false
if (-not $alreadyInUserPath) {
  $nextEntries = @($userEntries + $normTarget)
  [Environment]::SetEnvironmentVariable("Path", ($nextEntries -join ';'), "User")
  $pathUpdated = $true
}

$sessionEntries = @($env:Path -split ';' | Where-Object { $_ -and $_.Trim() })
$alreadyInSession = $false
foreach ($entry in $sessionEntries) {
  if ($entry.Trim().TrimEnd('\', '/') -ieq $normTarget) {
    $alreadyInSession = $true
    break
  }
}
if (-not $alreadyInSession) {
  $env:Path = "$normTarget;$env:Path"
}

$verOut = & $TargetExe --version
Write-Host ""
Write-Host "Installed Atrium CLI ($verOut) -> $TargetExe"
if ($pathUpdated) {
  Write-Host "Added $normTarget to your User PATH (open a new terminal if another shell was already open)."
}
Write-Host 'Type "atrium" in any terminal to launch!'
