# Scrit Cribbler service starter - launched at logon via Scheduled Task "ScritCribbler-Startup"
# Starts Ollama (CPU/Vulkan mode - GTX 1050 Ti CUDA backend crashes, see notes) then the Flask backend.

$ErrorActionPreference = "Continue"
$logDir = "C:\1\scrit-cribbler-backend\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# CUDA_VISIBLE_DEVICES=-1 is set as a persistent User env var (see setup notes) so Ollama
# falls back to its Vulkan backend instead of crashing on this GPU's CUDA/PTX mismatch.
$env:CUDA_VISIBLE_DEVICES = "-1"

# --- Start Ollama serve (skip if already running) ---
$ollamaRunning = Get-NetTCPConnection -LocalPort 11434 -ErrorAction SilentlyContinue
if (-not $ollamaRunning) {
    Start-Process -FilePath "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" `
        -ArgumentList "serve" `
        -WindowStyle Hidden `
        -RedirectStandardOutput "$logDir\ollama.log" `
        -RedirectStandardError "$logDir\ollama.err.log"

    # Wait for Ollama's HTTP server to come up (up to 60s)
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Seconds 2
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 3
            $ready = $resp.StatusCode -eq 200
        } catch {
            $ready = $false
        }
    } while (-not $ready -and (Get-Date) -lt $deadline)

    # /api/tags returning 200 only means the Ollama HTTP server is up - the model
    # itself is lazy-loaded on first inference request. Hitting Ollama with a real
    # request before that lazy-load finishes crashed ollama.exe outright during
    # testing (Vulkan/GTX 1050 Ti backend, ~11-14s load time). Force the load here,
    # synchronously, before Flask is allowed to start accepting real traffic.
    if ($ready) {
        try {
            Invoke-WebRequest -Uri "http://localhost:11434/api/generate" -Method Post `
                -Body '{"model":"mistral","prompt":"Say OK.","stream":false}' `
                -ContentType "application/json" -TimeoutSec 60 -UseBasicParsing | Out-Null
        } catch {
            # If warmup fails, Flask will still work - it just eats the lazy-load
            # cost (and crash risk) on its first real request instead.
            Add-Content -Path "$logDir\startup.log" -Value "$(Get-Date): Ollama warmup failed: $_"
        }
    }
}

# --- Start backend (HTTPS on 5443 via cheroot; skip if already running) ---
$backendRunning = Get-NetTCPConnection -LocalPort 5443 -State Listen -ErrorAction SilentlyContinue
if (-not $backendRunning) {
    Start-Process -FilePath "C:\1\scrit-cribbler-backend\venv\Scripts\python.exe" `
        -ArgumentList "app.py" `
        -WorkingDirectory "C:\1\scrit-cribbler-backend" `
        -WindowStyle Hidden `
        -RedirectStandardOutput "$logDir\backend.log" `
        -RedirectStandardError "$logDir\backend.err.log"
}
