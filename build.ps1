$ErrorActionPreference = 'Stop'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot 'RouterHost.cs'
foreach ($target in @(@('winexe', 'CodexModelRouter.exe'), @('exe', 'RouterToken.exe'))) {
    & $compiler /nologo /optimize+ /platform:anycpu ('/target:' + $target[0]) ('/out:' + (Join-Path $PSScriptRoot $target[1])) /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll $source
    if ($LASTEXITCODE -ne 0) { throw 'Native router host compilation failed.' }
}
Get-Item -LiteralPath (Join-Path $PSScriptRoot 'CodexModelRouter.exe'), (Join-Path $PSScriptRoot 'RouterToken.exe') | Select-Object Name, Length
