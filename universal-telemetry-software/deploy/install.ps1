<#
WFR Base Station - one-line installer (Windows).

Windows analog of install.sh. Docker Desktop on Windows does NOT reliably forward
inbound LAN UDP (the car's telemetry on port 5005) into a published container port,
so this installer starts the stack from docker-compose.windows-base.yml (UDP receiver
published on host 15005) AND launches the native UDP relay (windows-udp-relay.ps1),
which binds the real LAN port 5005 and forwards datagrams into the container.

Prerequisites: Git for Windows and Docker Desktop (running). The relay is pure
PowerShell, so no Python or other runtime is required.

Usage (PowerShell):
  irm https://raw.githubusercontent.com/Western-Formula-Racing/data-acquisition/main/universal-telemetry-software/deploy/install.ps1 | iex
#>

$ErrorActionPreference = "Stop"

$Repo       = "Western-Formula-Racing/data-acquisition"
$Branch     = "main"
$InstallDir = Join-Path $HOME "wfr-base-station"
$DeployRel  = "universal-telemetry-software/deploy"

function Write-Section($text) {
    Write-Host ""
    Write-Host "=======================================" -ForegroundColor Cyan
    Write-Host " $text" -ForegroundColor Cyan
    Write-Host "=======================================" -ForegroundColor Cyan
}

Write-Section "WFR Base Station - Windows Setup"

# --- Dependency checks --------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: git is not installed." -ForegroundColor Red
    Write-Host "Install Git for Windows: https://git-scm.com/download/win"
    Write-Host "Then re-run this installer."
    exit 1
}
Write-Host "OK git available"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Docker is not installed." -ForegroundColor Red
    Write-Host "Install Docker Desktop for Windows:"
    Write-Host "  https://docs.docker.com/desktop/install/windows-install/"
    Write-Host "After installing and starting Docker Desktop, re-run this installer."
    exit 1
}

try { docker info 2>&1 | Out-Null } catch { }
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Docker Desktop is not running." -ForegroundColor Red
    Write-Host "Start Docker Desktop from the Start menu, wait for it to finish starting, then re-run."
    exit 1
}
Write-Host "OK Docker Desktop running"

# --- Repo ---------------------------------------------------------------------
if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host ""
    Write-Host "-> Updating existing installation..."
    git -C $InstallDir fetch origin $Branch
    git -C $InstallDir checkout $Branch
    git -C $InstallDir pull origin $Branch
} else {
    Write-Host ""
    Write-Host "-> Cloning repository..."
    git clone --branch $Branch --depth 1 "https://github.com/$Repo.git" $InstallDir
}
Write-Host "OK Repository ready at $InstallDir"

$DeployDir   = Join-Path $InstallDir $DeployRel
$ComposeFile = Join-Path $DeployDir "docker-compose.windows-base.yml"
$EnvFile     = Join-Path $DeployDir ".env.windows"
$RelayScript = Join-Path $DeployDir "windows-udp-relay.ps1"

# --- Start the stack ----------------------------------------------------------
Write-Host ""
Write-Host "-> Pulling latest images (first run may take a few minutes)..."
docker compose --project-directory $InstallDir -f $ComposeFile pull

Write-Host ""
Write-Host "-> Starting base station stack..."
docker compose --project-directory $InstallDir -f $ComposeFile --env-file $EnvFile up -d

# --- Launch the UDP relay in its own window -----------------------------------
# The relay must run on the Windows host (not inside Docker/WSL) to receive LAN UDP.
# Start it in a new console window (Windows PowerShell, always present) so it
# survives after this installer exits.
Write-Host ""
Write-Host "-> Launching UDP relay (host 5005 -> container 15005)..."
Start-Process -FilePath "powershell" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $RelayScript) `
    -WorkingDirectory $DeployDir -WindowStyle Normal | Out-Null
Write-Host "OK Relay started in a separate window (keep it open during sessions)."

# --- Network hint -------------------------------------------------------------
Write-Section "One-time network setup required"
Write-Host ""
Write-Host "Your PC needs IP 10.71.1.20 on the ethernet adapter connected to the car radio base."
Write-Host ""
Write-Host "Via GUI:"
Write-Host "  Settings -> Network & Internet -> Ethernet -> Edit IP assignment ->"
Write-Host "  Manual -> IPv4 On -> IP 10.71.1.20 / Subnet 255.255.255.0 -> Save"
Write-Host ""
Write-Host "Via PowerShell (Run as Administrator, replace 'Ethernet' with your adapter name):"
Write-Host "  New-NetIPAddress -InterfaceAlias 'Ethernet' -IPAddress 10.71.1.20 -PrefixLength 24"
Write-Host ""
Write-Host "Verify connectivity with the car:"
Write-Host "  ping 10.71.1.10"
Write-Host ""
Write-Host "Do this before the first track session - the stack runs but won't receive"
Write-Host "telemetry until the IP is correct and the relay window is open."

# --- Success ------------------------------------------------------------------
Write-Section "Base station is running!"
Write-Host ""
Write-Host "  Pecan dashboard:  http://localhost:3000"
Write-Host "  Status page:      http://localhost:8080"
Write-Host "  Health check:     http://localhost:8080/health"
Write-Host ""
Write-Host "  The relay runs in its own window. If telemetry isn't arriving, confirm that"
Write-Host "  window is open and its 'pkt/s' counter climbs while the car streams."
Write-Host ""
Write-Host "  To stop:   docker compose -f `"$ComposeFile`" --env-file `"$EnvFile`" down"
Write-Host "             (and close the relay window)"
Write-Host "  To update: re-run this installer"
Write-Host ""
