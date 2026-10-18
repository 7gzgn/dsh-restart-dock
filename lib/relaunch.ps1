# relaunch.ps1 — dsh-restart-dock 的「停 + 拉」执行体
#
# 它由宿主半 spawn 出来（detached），因此必须活在宿主被停掉之后。
# 顺序刻意是「先确认目标 → 再等 → 再停 → 再拉」：
#   · 探测失败一律拒绝，绝不按名字猜一个进程去杀；
#   · 放下报告，让下一次启动的宿主（和界面）能说清上次到底发生了什么。
#
# 兼容 Windows PowerShell 5.1（不用 PS7 才行的高级语法）。

param(
    # 调用者（宿主）的 pid：从它往上认 DSH 应用。用 -TargetPid 时可省略。
    [int]$CallerPid = 0,
    [Parameter(Mandatory = $true)][string]$StateDir,
    # 显式指定要重启的进程（测试与排障用）；不填就按 CallerPid 祖先链探测。
    [int]$TargetPid = 0,
    [int]$DelaySeconds = 2,
    # 只探测、只出报告，不碰任何进程。用于自测与排障。
    [switch]$DryRun,
    # 内部用：标记「我是已经从宿主进程树里交接出来的副本」。
    [switch]$Handoff
)

$ErrorActionPreference = 'Stop'

# ── 两段式交接 ──────────────────────────────────────────────────────────────
# 为什么必须这样：helper 由宿主 spawn（cmd → node宿主 → Electron 主进程），
# 它自己就长在「这次要杀的那棵树」里。直接杀树 = 连自己一起杀 → 日志停在
# "stopping tree"，最后的拉起永远不执行（2026-10-18 21:27 实测）。
# 所以第一段什么都不干，先用 WMI 把自己交给一个**脱离 job 的副本**，然后退出。
# （WMI Win32_Process.Create 建的进程不属于当前 job，3081 救援通道就是这么起的。）
if (-not $Handoff -and -not $DryRun) {
    $inner = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $PSCommandPath + '"'),
        '-CallerPid', [string]$CallerPid,
        '-StateDir', ('"' + $StateDir + '"'),
        '-DelaySeconds', [string]$DelaySeconds,
        '-Handoff'
    ) -join ' '
    if ($TargetPid -gt 0) { $inner = $inner + ' -TargetPid ' + [string]$TargetPid }
    try {
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('powershell.exe ' + $inner) } -ErrorAction Stop
        if ($r.ReturnValue -eq 0) {
            try { Add-Content -LiteralPath (Join-Path $StateDir 'helper.log') -Value ('[{0}] handoff: 已交给脱离 job 的副本 pid={1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $r.ProcessId) -Encoding UTF8 } catch { }
            exit 0
        }
    } catch {
        # WMI 不可用：退化成"自己干"。可能被树带走，但至少试过。
        try { Add-Content -LiteralPath (Join-Path $StateDir 'helper.log') -Value ('[{0}] handoff 失败，改为就地执行：{1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $_.Exception.Message) -Encoding UTF8 } catch { }
    }
}

if ([string]::IsNullOrWhiteSpace($StateDir)) {
    $StateDir = Join-Path $env:USERPROFILE '.dsh\dsh-restart-dock'
}
if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
}

$logPath = Join-Path $StateDir 'helper.log'
$reportPath = Join-Path $StateDir 'last.json'

function Write-Log([string]$Message) {
    $line = '[{0}] {1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $Message
    try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch { }
}

function Write-Report($State, $Extra) {
    $payload = [ordered]@{
        ok         = ($State -eq 'relaunched')
        state      = [string]$State
        at         = (Get-Date).ToString('o')
        callerPid  = $CallerPid
        targetPid  = 0
        targetExe  = ''
        newPid     = 0
        detail     = ''
        durationMs = 0
    }
    if ($null -ne $Extra) {
        foreach ($key in $Extra.Keys) { $payload[$key] = $Extra[$key] }
    }
    try {
        $json = $payload | ConvertTo-Json -Depth 5
        Set-Content -LiteralPath $reportPath -Value $json -Encoding UTF8
    } catch { }
}

function Get-ProcInfo([int]$ProcId) {
    if ($ProcId -le 0) { return $null }
    try {
        return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction Stop
    } catch {
        return $null
    }
}

# 一个进程是不是「DSH 那一侧」的。
function Test-DshProcess($Proc) {
    if ($null -eq $Proc) { return $false }
    $cmd = ''
    try { $cmd = [string]$Proc.CommandLine } catch { }
    if ($cmd -like '*dsh-desktop-host*') { return $true }
    $exeName = ''
    try { $exeName = [System.IO.Path]::GetFileNameWithoutExtension([string]$Proc.ExecutablePath) } catch { }
    if ([string]::IsNullOrEmpty($exeName)) { return $false }
    if ($exeName -ieq 'dsh') { return $true }
    if ($exeName -ieq 'DeepSeek Harness') { return $true }
    return $false
}

# 递归收集某个进程的全部后代。
function Get-Descendants([int]$RootId) {
    $all = @(Get-CimInstance Win32_Process)
    $byParent = @{}
    foreach ($p in $all) {
        $pp = [int]$p.ParentProcessId
        if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = New-Object System.Collections.ArrayList }
        [void]$byParent[$pp].Add([int]$p.ProcessId)
    }
    $out = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push($RootId)
    while ($stack.Count -gt 0) {
        $cur = [int]$stack.Pop()
        if (-not $byParent.ContainsKey($cur)) { continue }
        foreach ($child in $byParent[$cur]) {
            [void]$out.Add($child)
            $stack.Push($child)
        }
    }
    return $out
}

function Stop-Tree([int]$RootId) {
    $desc = Get-Descendants $RootId
    $allIds = @($RootId) + @($desc)
    # 先叶子后根：倒着杀，避免父进程先死留下孤儿。
    for ($i = $desc.Count - 1; $i -ge 0; $i--) {
        try { Stop-Process -Id $desc[$i] -Force -ErrorAction SilentlyContinue } catch { }
    }
    try { Stop-Process -Id $RootId -Force -ErrorAction SilentlyContinue } catch { }

    # 复查 + 清孤儿。
    # 教训（2026-10-18 20:54）：只杀一次不够 —— 杀父进程之后，它的子进程会变成
    # 「父进程 pid 已死」的孤儿继续活着，残留的 web 宿主占着端口，新实例启动时
    # 连上去认证失败（Error: desktop welcome: Web authentication failed），
    # 于是新桌面版起一次崩一次。
    # 判据要精确：只清「父进程 pid 在本次清理名单里」的进程 ——
    # 绝不能按「父进程已死」判断，因为正常的桌面版主进程，其父进程本来就已经退了
    # （那样会把用户正在用的实例和 3081 救援通道一起误杀）。
    Start-Sleep -Milliseconds 700
    $set = @{}
    foreach ($id in $allIds) { $set[[string]$id] = $true }
    $orphanKilled = 0
    try {
        $alive = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
        foreach ($p in $alive) {
            $pp = [string]$p.ParentProcessId
            if ($set.ContainsKey($pp)) {
                try { Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue; $orphanKilled += 1 } catch { }
            }
        }
    } catch { }
    if ($orphanKilled -gt 0) { Write-Log ("清了 {0} 个孤儿进程（父进程在本次清理名单里）" -f $orphanKilled) }
    # 名单里还剩活着的（刚才强杀没成功的），再补一刀。
    $stillAlive = 0
    foreach ($id in $allIds) {
        if ($null -ne (Get-Process -Id $id -ErrorAction SilentlyContinue)) {
            $stillAlive += 1
            try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
    if ($stillAlive -gt 0) { Write-Log ("补刀：名单里还有 {0} 个没退，再强杀一遍" -f $stillAlive) }
}

function Wait-Gone([int]$ProcId, [int]$TimeoutMs) {
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
        if ($null -eq $p) { return $true }
        Start-Sleep -Milliseconds 150
    }
    return $false
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
Write-Log ("start: callerPid={0} delay={1}s stateDir={2}" -f $CallerPid, $DelaySeconds, $StateDir)

try {
    if ($TargetPid -le 0 -and $CallerPid -le 0) {
        throw '既没给 -TargetPid 也没给 -CallerPid：拒绝按名字猜一个进程去杀。'
    }

    # ---------- 1) 锁定目标 ----------
    #
    # 两条路：显式给 -TargetPid（测试/排障用），或者从调用者往上认 DSH 进程。
    # 两条路都要求「能拿到的 exe 真实存在」，否则拒绝 —— 宁可不重启，也不杀错东西。
    $target = $null
    $resolution = ''

    if ($TargetPid -gt 0) {
        $target = Get-ProcInfo $TargetPid
        if ($null -eq $target) {
            throw ("指定的目标 pid {0} 不在运行" -f $TargetPid)
        }
        $resolution = 'explicit-target'
    }
    else {
        # 找「DSH 那一侧」的进程
        $anchorId = $CallerPid
        $anchor = $null
        for ($i = 0; $i -lt 12; $i++) {
            $candidate = Get-ProcInfo $anchorId
            if ($null -eq $candidate) { break }
            if (Test-DshProcess $candidate) { $anchor = $candidate; break }
            $parentId = [int]$candidate.ParentProcessId
            if ($parentId -le 0) { break }
            $anchorId = $parentId
        }
        if ($null -eq $anchor) {
            throw ("找不到 DSH 进程（从 pid {0} 往上 12 层都没有 dsh-desktop-host / dsh 标记）" -f $CallerPid)
        }

        # 爬到「同一可执行文件的最顶层」= 用户会双击的那个应用
        $exe = [string]$anchor.ExecutablePath
        if ([string]::IsNullOrEmpty($exe)) {
            throw ("pid {0} 拿不到可执行文件路径，拒绝重启" -f $anchorId)
        }
        $top = $anchor
        for ($i = 0; $i -lt 16; $i++) {
            $parent = Get-ProcInfo ([int]$top.ParentProcessId)
            if ($null -eq $parent) { break }
            $parentExe = ''
            try { $parentExe = [string]$parent.ExecutablePath } catch { }
            if ([string]::IsNullOrEmpty($parentExe)) { break }
            if ($parentExe -ne $exe) { break }
            # Chromium 子进程有 --type=，向上不能穿到渲染/GPU 进程
            if ([string]$parent.CommandLine -like '*--type=*') { break }
            $top = $parent
        }
        $target = $top
        $resolution = 'ancestor-walk'
    }

    $targetPid = [int]$target.ProcessId
    $targetExe = [string]$target.ExecutablePath
    $targetName = [string]$target.Name
    $targetArgs = ''
    try { $targetArgs = [string]$target.CommandLine } catch { }
    if ([string]::IsNullOrEmpty($targetExe) -or -not (Test-Path -LiteralPath $targetExe)) {
        throw ("目标 {0} 的 exe 不存在：{1}" -f $targetPid, $targetExe)
    }
    # 绝不自杀
    if ($targetPid -eq $PID) { throw '目标是 helper 自己，拒绝执行' }

    Write-Log ("plan: targetPid={0} name={1} exe={2}" -f $targetPid, $targetName, $targetExe)
    Write-Report 'armed' @{
        targetPid = $targetPid
        targetExe = $targetExe
        detail    = ('已锁定目标：{0}（{1}）' -f $targetName, $targetPid)
    }

    # 拉起参数：原样复用目标进程自己的命令行（去掉可执行文件本身那一段）
    $launchArgs = ''
    if (-not [string]::IsNullOrEmpty($targetArgs)) {
        $trimmed = $targetArgs.Trim()
        if ($trimmed.StartsWith('"')) {
            $endQuote = $trimmed.IndexOf('"', 1)
            if ($endQuote -gt 0) { $launchArgs = $trimmed.Substring($endQuote + 1).Trim() }
        } else {
            $space = $trimmed.IndexOf(' ')
            if ($space -gt 0) { $launchArgs = $trimmed.Substring($space + 1).Trim() }
        }
    }

    if ($DryRun) {
        $sw.Stop()
        Write-Log ("dry-run: would relaunch {0} with args [{1}]" -f $targetExe, $launchArgs)
        Write-Report 'dry-run' @{
            targetPid  = $targetPid
            targetExe  = $targetExe
            durationMs = [int]$sw.ElapsedMilliseconds
            detail     = ('dry run：会停掉 {0}（{1}），再按原命令行拉起' -f $targetPid, $targetName)
            launchArgs = $launchArgs
        }
        exit 0
    }

    # ---------- 3) 等一会儿：让 HTTP 响应先回到界面 ----------
    if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

    # ---------- 4) 停 ----------
    Write-Log ("stopping tree of {0}" -f $targetPid)
    Stop-Tree $targetPid

    if (-not (Wait-Gone $targetPid 20000)) {
        Write-Log ("target {0} 20s 内没有退出，再强杀一轮" -f $targetPid)
        Stop-Tree $targetPid
        if (-not (Wait-Gone $targetPid 8000)) {
            throw ("进程 {0} 停不下来（可能被保护或被别的实例占着），已放弃拉起以免出现两个实例" -f $targetPid)
        }
    }
    # 给端口/锁文件留足释放时间。
    # 实测教训（2026-10-18 20:25）：只等 600ms 就拉起，Electron 的 `--remote-debugging-port`
    # 会静默绑定失败（进程照常起来、命令行参数也对，就是端口不监听），界面上完全没事，
    # 但调试通道没了。等 3 秒能稳定绑上。
    Start-Sleep -Seconds 3

    # ---------- 5) 拉 ----------
    #
    # **必须经 Explorer 打开 .lnk**：helper 自己是 cmd（detached）拉起来的，
    # 直接 Process::Start 出来的 Electron 不在交互桌面会话里 —— 实测报告就是
    # 「新进程 20008 一起来就退了」。让 Explorer 去建进程，才会落到用户的桌面上。
    $workingDir = ''
    try { $workingDir = Split-Path -Parent $targetExe } catch { }
    $procName = ''
    try { $procName = [System.IO.Path]::GetFileNameWithoutExtension($targetExe) } catch { }
    Write-Log ("relaunching via explorer: {0} {1}" -f $targetExe, $launchArgs)

    $lnkPath = Join-Path $StateDir ('launch-' + (Get-Date).ToString('HHmmss') + '.lnk')
    $lnkReady = $false
    try {
        $wsh = New-Object -ComObject WScript.Shell
        $link = $wsh.CreateShortcut($lnkPath)
        $link.TargetPath = $targetExe
        $link.Arguments = $launchArgs
        if (-not [string]::IsNullOrEmpty($workingDir)) { $link.WorkingDirectory = $workingDir }
        $link.Save()
        $lnkReady = Test-Path -LiteralPath $lnkPath
    }
    catch {
        Write-Log ("创建 .lnk 失败：" + $_.Exception.Message)
    }

    $newPid = 0
    $launchVia = ''
    if ($lnkReady) {
        # 拉起前先把「已经存在的同名进程」记下来 —— 它们可能是另一个实例
        # （比如 3081 救援通道），不能当成我们刚拉起的那个。
        # 2026-10-18 实测踩过：newPid 报成了救援通道的 6732，而真正的新进程是 6932。
        $beforeIds = @(Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
        try { Start-Process -FilePath 'explorer.exe' -ArgumentList $lnkPath } catch { Write-Log ("explorer 启动失败：" + $_.Exception.Message) }
        $deadline = (Get-Date).AddSeconds(40)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 400
            if ([string]::IsNullOrEmpty($procName)) { break }
            $fresh = @(Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $beforeIds -notcontains [int]$_.Id })
            if ($fresh.Count -gt 0) { $newPid = [int]$fresh[0].Id; break }
        }
        if ($newPid -gt 0) {
            $launchVia = 'explorer'
            Write-Log ("explorer 拉起成功：newPid={0}（拉起前已有 {1} 个同名进程，已排除）" -f $newPid, $beforeIds.Count)
        }
    }

    if ($newPid -le 0) {
        Write-Log 'explorer 没能拉起新进程，退回直接 Start-Process（可能起不来窗口）'
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $targetExe
        $psi.Arguments = $launchArgs
        if (-not [string]::IsNullOrEmpty($workingDir)) { $psi.WorkingDirectory = $workingDir }
        $psi.UseShellExecute = $true
        $started = [System.Diagnostics.Process]::Start($psi)
        Start-Sleep -Milliseconds 1500
        if ($null -ne $started) { try { $newPid = [int]$started.Id; $launchVia = 'direct' } catch { } }
    }

    if ($newPid -le 0) { throw '拉起失败：Explorer 与直接 Start 都没拿到新进程' }

    Start-Sleep -Milliseconds 1500
    $alive = Get-Process -Id $newPid -ErrorAction SilentlyContinue
    if ($null -eq $alive) { throw ("新进程 {0} 一起来就退了（看 exe / 参数的兼容性）" -f $newPid) }

    $sw.Stop()
    Write-Log ("done: newPid={0} in {1}ms" -f $newPid, $sw.ElapsedMilliseconds)
    Write-Report 'relaunched' @{
        targetPid  = $targetPid
        targetExe  = $targetExe
        newPid     = $newPid
        launchArgs = $launchArgs
        launchVia  = $launchVia
        durationMs = [int]$sw.ElapsedMilliseconds
        detail     = ('已停下 {0}，并重新拉起为 {1}（经 {2}）' -f $targetPid, $newPid, $launchVia)
    }
    exit 0
}
catch {
    $sw.Stop()
    $message = $_.Exception.Message
    Write-Log ("failed: " + $message)
    Write-Report 'failed' @{
        targetPid  = $(if ($targetPid -gt 0) { $targetPid } else { 0 })
        targetExe  = $(if ([string]::IsNullOrEmpty($targetExe)) { '' } else { $targetExe })
        launchArgs = $(if ([string]::IsNullOrEmpty($launchArgs)) { '' } else { $launchArgs })
        detail     = $message
        durationMs = [int]$sw.ElapsedMilliseconds
    }
    exit 1
}
