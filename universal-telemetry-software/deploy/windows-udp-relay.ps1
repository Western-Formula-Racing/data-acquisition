<#
.SYNOPSIS
    Windows host-side UDP relay for the base station telemetry stack.

.DESCRIPTION
    The car sends CAN telemetry as unicast UDP straight to the base station's LAN
    IP on port 5005. On Docker Desktop for Windows the container runs inside the
    WSL2 VM behind a NAT'd vEthernet adapter, and inbound *LAN* UDP from an external
    host is not reliably forwarded into a published container port. (TCP and
    localhost-originated UDP go through the Docker proxy fine; external LAN UDP is
    the broken path.)

    This relay closes that gap by running natively on Windows. It binds the real LAN
    port (0.0.0.0:5005), receives the car's datagrams on the host network stack, and
    forwards each one to the container's published UDP port on localhost
    (127.0.0.1:15005 by default). Host -> published-port forwarding is the reliable
    direction, so the telemetry reaches the container.

    The telemetry UDP path is one-directional (the base only receives; missing
    batches are pulled back over a separate outbound TCP connection), so this relay
    only needs to forward inbound datagrams.

    Pure PowerShell + .NET, so no Python (or any other runtime) is required - Windows
    PowerShell 5.1, which ships with Windows, is enough. macOS and Linux bases do not
    need this relay at all.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File windows-udp-relay.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File windows-udp-relay.ps1 -ListenPort 5005 -TargetPort 15005
#>

[CmdletBinding()]
param(
    [string] $ListenHost    = $(if ($env:RELAY_LISTEN_HOST)    { $env:RELAY_LISTEN_HOST }    else { "0.0.0.0" }),
    [int]    $ListenPort     = $(if ($env:RELAY_LISTEN_PORT)    { [int]$env:RELAY_LISTEN_PORT } else { 5005 }),
    [string] $TargetHost     = $(if ($env:RELAY_TARGET_HOST)    { $env:RELAY_TARGET_HOST }    else { "127.0.0.1" }),
    [int]    $TargetPort     = $(if ($env:RELAY_TARGET_PORT)    { [int]$env:RELAY_TARGET_PORT } else { 15005 }),
    [double] $StatsInterval  = $(if ($env:RELAY_STATS_INTERVAL) { [double]$env:RELAY_STATS_INTERVAL } else { 5 })
)

$ErrorActionPreference = "Stop"

if ($ListenPort -eq $TargetPort -and ($TargetHost -eq "127.0.0.1" -or $TargetHost -eq "localhost")) {
    Write-Host "ERROR: ListenPort and TargetPort must differ (would forward to self)."
    exit 2
}

# Receiver socket: binds the real LAN port the car sends to.
$rx = New-Object System.Net.Sockets.UdpClient
$rx.Client.SetSocketOption(
    [System.Net.Sockets.SocketOptionLevel]::Socket,
    [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
try { $rx.Client.ReceiveBufferSize = 1MB } catch { }
# 1s receive timeout so Ctrl+C is responsive between datagrams.
$rx.Client.ReceiveTimeout = 1000

try {
    $listenIP = [System.Net.IPAddress]::Parse($ListenHost)
    $rx.Client.Bind((New-Object System.Net.IPEndPoint($listenIP, $ListenPort)))
}
catch {
    Write-Host ("ERROR: Could not bind {0}:{1} ({2}). Is another process (or the Docker publish of {1}) using it?" -f $ListenHost, $ListenPort, $_.Exception.Message)
    exit 1
}

# Sender socket: forwards into the container's published port.
$tx = New-Object System.Net.Sockets.UdpClient
$tx.Connect($TargetHost, $TargetPort)

Write-Host ("UDP relay up: {0}:{1} (LAN) -> {2}:{3} (container). Ctrl+C to stop." -f $ListenHost, $ListenPort, $TargetHost, $TargetPort)

$packets = 0
$forwardedBytes = 0
$lastPackets = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$remoteEP = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)

try {
    while ($true) {
        try {
            $data = $rx.Receive([ref]$remoteEP)
        }
        catch [System.Net.Sockets.SocketException] {
            # Receive timeout (no datagram this interval) - loop so Ctrl+C works.
            $data = $null
        }

        if ($null -ne $data -and $data.Length -gt 0) {
            [void]$tx.Send($data, $data.Length)
            $packets++
            $forwardedBytes += $data.Length
        }

        if ($StatsInterval -gt 0 -and $sw.Elapsed.TotalSeconds -ge $StatsInterval) {
            $elapsed = $sw.Elapsed.TotalSeconds
            $rate = if ($elapsed -gt 0) { ($packets - $lastPackets) / $elapsed } else { 0 }
            Write-Host ("[relay] {0} packets, {1:N0} KiB total, {2:N0} pkt/s" -f $packets, ($forwardedBytes / 1024), $rate)
            $sw.Restart()
            $lastPackets = $packets
        }
    }
}
finally {
    $rx.Close()
    $tx.Close()
    Write-Host ("UDP relay stopped. Forwarded {0} packets." -f $packets)
}
