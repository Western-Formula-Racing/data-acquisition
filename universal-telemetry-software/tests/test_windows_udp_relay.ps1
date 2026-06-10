#Requires -Version 5.1
<#
.SYNOPSIS
    Functional test for deploy/windows-udp-relay.ps1.

.DESCRIPTION
    Starts the relay as a child process and verifies that a UDP datagram sent to
    its listen port is forwarded to its target port. Loopback only, so it runs
    identically under Windows PowerShell / pwsh on windows-latest and under pwsh
    on a Linux CI runner. Exits 0 on success, non-zero on failure.
#>

$ErrorActionPreference = "Stop"

$relay = Join-Path $PSScriptRoot "..\deploy\windows-udp-relay.ps1"
if (-not (Test-Path $relay)) {
    Write-Host "FAIL: relay script not found at $relay"
    exit 1
}

function Get-FreeUdpPort {
    $probe = New-Object System.Net.Sockets.UdpClient(0)
    try { return ($probe.Client.LocalEndPoint).Port }
    finally { $probe.Close() }
}

# Receiver stands in for the container's published UDP port.
$receiver = New-Object System.Net.Sockets.UdpClient
$receiver.Client.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Loopback, 0)))
$receiver.Client.ReceiveTimeout = 500
$targetPort = ($receiver.Client.LocalEndPoint).Port

$listenPort = Get-FreeUdpPort
if ($listenPort -eq $targetPort) { $listenPort = Get-FreeUdpPort }

$psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }

$proc = Start-Process -FilePath $psExe -PassThru -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $relay,
    "-ListenHost", "127.0.0.1", "-ListenPort", "$listenPort",
    "-TargetHost", "127.0.0.1", "-TargetPort", "$targetPort",
    "-StatsInterval", "0"
)

$exitCode = 1
try {
    Start-Sleep -Milliseconds 1500
    if ($proc.HasExited) {
        Write-Host "FAIL: relay process exited early (code $($proc.ExitCode))"
        exit 1
    }

    $sender = New-Object System.Net.Sockets.UdpClient
    $sender.Connect("127.0.0.1", $listenPort)
    $payload = [System.Text.Encoding]::ASCII.GetBytes("CAN-RELAY-CI-TEST")
    $expected = [Convert]::ToBase64String($payload)

    $remoteEP = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
    for ($i = 0; $i -lt 25; $i++) {
        [void]$sender.Send($payload, $payload.Length)
        try {
            $data = $receiver.Receive([ref]$remoteEP)
        }
        catch [System.Net.Sockets.SocketException] {
            $data = $null
        }
        if ($null -ne $data -and [Convert]::ToBase64String($data) -eq $expected) {
            Write-Host "PASS: relay forwarded datagram ${listenPort} -> ${targetPort}"
            $exitCode = 0
            break
        }
        Start-Sleep -Milliseconds 100
    }
    $sender.Close()

    if ($exitCode -ne 0) {
        Write-Host "FAIL: relay did not forward the datagram to the target port"
    }
}
finally {
    if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    $receiver.Close()
}

exit $exitCode
