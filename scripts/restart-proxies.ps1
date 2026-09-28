# Restart the three local AI proxies (workbuddy / trae / minimax).
#
# ASCII-only on purpose: a .ps1 containing non-ASCII must carry a UTF-8 BOM or
# PowerShell 5.1 will mangle it. The Chinese explanation lives in the panel
# and the READMEs instead.
#
# What it does, per repo, in order: stop.ps1 -> start.ps1 -> wait for the port
# to accept a connection. One repo failing does not stop the other two.
#
# Note: this restarts the PROXIES only. agent-hub (the panel itself) is a
# separate process and is not touched.
#
# Restarting interrupts in-flight model requests -- they will fail and need to
# be resent. Conversation history is NOT lost; it lives in opencode's own store.

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot

$Targets = @(
  @{ Name = 'workbuddy-proxy'; Ports = @(39301, 39302) }
  @{ Name = 'trae-proxy';      Ports = @(39303, 39304) }
  @{ Name = 'minimax-proxy';   Ports = @(39305, 39306) }
)

function Test-PortOpen([int]$Port) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $Port)
    $c.Close()
    return $true
  } catch {
    return $false
  }
}

function Invoke-Script([string]$Path) {
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Path 2>&1 | Out-Null
    return $LASTEXITCODE
  } catch {
    return 1
  }
}

$failed = @()

foreach ($t in $Targets) {
  $dir = Join-Path $Root $t.Name
  if (-not (Test-Path $dir)) {
    Write-Host ("{0,-18} SKIP (folder not found: {1})" -f $t.Name, $dir)
    $failed += $t.Name
    continue
  }

  $rc = Invoke-Script (Join-Path $dir 'scripts\stop.ps1')
  if ($rc -ne 0) {
    Write-Host ("{0,-18} FAILED at stop (exit {1})" -f $t.Name, $rc)
    $failed += $t.Name
    continue
  }

  # Wait for the old process to actually release the ports. This step is NOT
  # optional: start.ps1 is idempotent and skips when a port is already open, so
  # starting too early makes it skip, and the following "wait for open" then
  # probes the DYING old process, connects, and reports success -- leaving the
  # proxy dead while the caller believes it restarted.
  $deadline = (Get-Date).AddSeconds(40)
  $closed = $false
  while ((Get-Date) -lt $deadline) {
    $stillOpen = @($t.Ports | Where-Object { Test-PortOpen $_ }).Count
    if ($stillOpen -eq 0) { $closed = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $closed) {
    Write-Host ("{0,-18} FAILED: ports still held 40s after stop (something else is bound)" -f $t.Name)
    $failed += $t.Name
    continue
  }

  $rc = Invoke-Script (Join-Path $dir 'scripts\start.ps1')
  if ($rc -ne 0) {
    Write-Host ("{0,-18} FAILED at start (exit {1})" -f $t.Name, $rc)
    $failed += $t.Name
    continue
  }

  # Wait for BOTH region ports. Checking only the first would report success
  # while the second region is still down.
  $deadline = (Get-Date).AddSeconds(40)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    $openCount = @($t.Ports | Where-Object { Test-PortOpen $_ }).Count
    if ($openCount -eq $t.Ports.Count) { $up = $true; break }
    Start-Sleep -Milliseconds 250
  }

  if ($up) {
    Write-Host ("{0,-18} restarted  {1}" -f $t.Name, (($t.Ports | ForEach-Object { ":" + $_ }) -join ' '))
  } else {
    Write-Host ("{0,-18} FAILED: not all ports listening after 40s" -f $t.Name)
    $failed += $t.Name
  }
}

Write-Host ''
if ($failed.Count -eq 0) {
  Write-Host 'All 3 proxies restarted. New code is now live.'
  Write-Host 'Note: the workbuddy signin plan is re-randomised on start; the panel may'
  Write-Host 'briefly show "pending signin 0/4" for about a minute, then recover on its own.'
} else {
  Write-Host ("{0} of {1} failed: {2}" -f $failed.Count, $Targets.Count, ($failed -join ', '))
  Write-Host 'The others were still restarted. See each proxy logs\ directory for details.'
}
