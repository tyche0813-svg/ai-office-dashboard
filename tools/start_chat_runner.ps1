# Starts the AI office chat runner hidden (no window). Skips if it is already running.
# Run:   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\dev\ai_office_dashboard\tools\start_chat_runner.ps1"
# Stop:  powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\dev\ai_office_dashboard\tools\start_chat_runner.ps1" -Stop
# Needs the User env var AI_OFFICE_CHAT_TOKEN (same value as the Cloudflare secret CHAT_PC_TOKEN of the 'ai-office-live' Worker).
# The value is never printed or written anywhere by this script.
param([switch]$Stop)
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root 'local\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$pidFile = Join-Path $logs 'chat_runner.pid'
$running = $null
if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($old) { $running = Get-Process -Id $old -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'python*' } }
}
if ($Stop) {
  if ($running) { Stop-Process -Id $running.Id -Force; Write-Output "Chat runner stopped (PID $($running.Id))." } else { Write-Output 'Chat runner is not running.' }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  exit 0
}
if (-not [Environment]::GetEnvironmentVariable('AI_OFFICE_CHAT_TOKEN', 'User')) {
  "$(Get-Date -Format 'MM-dd HH:mm:ss') start_chat_runner: AI_OFFICE_CHAT_TOKEN is not set - runner not started" | Out-File (Join-Path $logs 'chat_runner.log') -Append -Encoding utf8
  Write-Output 'AI_OFFICE_CHAT_TOKEN is not set. In a separate PowerShell window run:  setx AI_OFFICE_CHAT_TOKEN "<same value as the Cloudflare CHAT_PC_TOKEN secret>"  then run this script again.'
  exit 2
}
if ($running) { Write-Output 'Chat runner is already running.'; exit 0 }
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { Write-Output 'python was not found on PATH.'; exit 3 }
# A hidden process writes cp949 stdout by default and dies on the first non-cp949 character.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$p = Start-Process -FilePath $py -ArgumentList '-X', 'utf8', '-u', "`"$(Join-Path $root 'tools\chat_runner.py')`"" -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logs 'chat_runner.out.log') -RedirectStandardError (Join-Path $logs 'chat_runner.err.log') -PassThru
$p.Id | Out-File $pidFile
Write-Output "Chat runner started (PID $($p.Id)). Log: $(Join-Path $logs 'chat_runner.log')"
