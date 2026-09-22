# agent-hub launcher.
# Starts the hub detached (via WScript.Shell COM) so the caller never waits on
# the long-lived node process. Idempotent: skips if the port is already open.
param([switch]$Foreground)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root 'logs\hub.pid'
$OutLog  = Join-Path $Root 'logs\hub.out.log'
$ErrLog  = Join-Path $Root 'logs\hub.err.log'
$Ports   = @(39310)

function Test-Port([int]$Port) {
  try {
    $t = New-Object System.Net.Sockets.TcpClient
    $t.Connect('127.0.0.1', $Port)
    $t.Close()
    return $true
  } catch { return $false }
}

function All-PortsUp([int[]]$List) {
  foreach ($p in $List) { if (-not (Test-Port $p)) { return $false } }
  return $true
}

function Owner-PidOf([int]$Port) {
  foreach ($ln in (netstat -ano)) {
    if ($ln -match 'LISTENING' -and $ln -match ":$Port\s") {
      $f = ($ln -split '\s+') | Where-Object { $_ -ne '' }
      if ($f.Count -ge 4) { return [int]$f[-1] }
    }
  }
  return 0
}

if ($Foreground) {
  node (Join-Path $Root 'src\server.ts')
  exit $LASTEXITCODE
}

if (All-PortsUp $Ports) {
  $key = (Get-Content (Join-Path $Root 'keys\hub.key') -Raw).Trim()
  Write-Host "agent-hub already running"
  Write-Host "  open: http://127.0.0.1:39310/?key=$key"
  exit 0
}

$serve = Join-Path $Root 'src\server.ts'
$cmd = 'cmd /c node "' + $serve + '" > "' + $OutLog + '" 2> "' + $ErrLog + '"'
$sh = New-Object -ComObject WScript.Shell
$sh.Run($cmd, 0, $false) | Out-Null

$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline) {
  if (All-PortsUp $Ports) { break }
  Start-Sleep -Milliseconds 400
}

if (All-PortsUp $Ports) {
  $procId = Owner-PidOf $Ports[0]
  if ($procId -gt 0) { Set-Content -Path $PidFile -Value $procId -Encoding ASCII }
  $key = (Get-Content (Join-Path $Root 'keys\hub.key') -Raw).Trim()
  Write-Host "agent-hub started (PID $procId)"
  Write-Host "  open: http://127.0.0.1:39310/?key=$key"
} else {
  Write-Host "agent-hub failed to start; check $ErrLog"
  Get-Content $ErrLog -ErrorAction SilentlyContinue
  exit 1
}
