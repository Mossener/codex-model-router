$ErrorActionPreference = 'Stop'
$gatewayRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$settings = Get-Content -LiteralPath (Join-Path $gatewayRoot 'settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hostPath = Join-Path $gatewayRoot 'CodexModelRouter.exe'
$workerPath = [IO.Path]::GetFullPath($settings.nodePath)
$routerPath = Join-Path $gatewayRoot 'router.mjs'
if ($workerPath -ne (Join-Path $gatewayRoot 'runtime\node.exe')) { throw 'The worker must belong to this installation.' }
function Read-Health {
    try {
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$($settings.port)/health")
        $request.Proxy = $null; $request.Timeout = 1500
        $response = $request.GetResponse()
        try { $reader = New-Object IO.StreamReader($response.GetResponseStream()); try { $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() } } finally { $response.Dispose() }
    } catch { return $null }
}
$before = Read-Health
if (-not $before -or $before.instanceId -ne $settings.instanceId -or $before.version -ne 3) { throw 'The running service does not match this gateway.' }
$workerId = [int]$before.pid
$workerDetails = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $workerId) -ErrorAction Stop
if (-not $workerDetails -or $workerDetails.ExecutablePath -ne $workerPath -or -not ([string]$workerDetails.CommandLine).Contains($routerPath)) { throw 'The worker ownership check failed.' }
# Ensure the normal supervisor is present, then reload only this verified worker.
Start-Process -FilePath $hostPath -ArgumentList @('--watch','--home',('"'+$gatewayRoot+'"')) -WindowStyle Hidden
Stop-Process -Id $workerId -Force
$after = $null
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $after = Read-Health
    if ($after -and $after.instanceId -eq $settings.instanceId -and $after.pid -ne $workerId -and @($after.features) -contains 'account-switches') { break }
    Start-Sleep -Milliseconds 250
}
if (-not $after -or $after.instanceId -ne $settings.instanceId -or $after.pid -eq $workerId -or @($after.features) -notcontains 'account-switches') { throw 'The updated gateway did not become healthy.' }
@{ reloaded = $true; workerPid = $after.pid; version = $after.version; poolAccountCount = $after.poolAccountCount; features = $after.features } | ConvertTo-Json
