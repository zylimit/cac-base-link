#!/usr/bin/env pwsh
# # risk: high
# .cac/tests/ps1-shell.test.ps1 - End-to-end PowerShell contract & integration test suite for cac-base-link.
# Pure ASCII UTF-8 without BOM. Compatible with Windows PowerShell 5.1 and PowerShell 7+ (pwsh).
# Covers:
#   1. No-BOM, pure-ASCII, PowerShell Language.Parser AST check, and static contract for -WithCc/-NoAutoCc/-CcBase/-BundleCc & 'package' guard
#   2. Unknown flag (--dryrun), bare typo ('package'), mutually exclusive (-NoAutoCc -WithCc), duplicate target, and CON rejection (exit 2, zero mkdir)
#   3. setup.ps1 -DryRun zero-write guarantee
#   4. Tier 1: 3x repeated idempotent install onto cc-base (.claude/) + OS Junction/symlink check + doctor.mjs --json
#   5. Tier 2: empty target one-step cc-base co-installation (when ../cc-base exists)
#   6. 3-way conflict preservation (.cac-link-new) on .cac/rules/AGENTS.md + upgrade -Force recovery
#   7. Standalone physical .cac/{skills,agents} migration
#   8. Tier 3: -NoAutoCc deferred pre-.claude/ install (exit 0) + cc-bridge.mjs session-start link self-healing
#   9. setup.ps1 -Uninstall -Force detaches OS links and keeps .claude/ 100% byte-for-byte untouched

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $PSScriptRoot '..') '..'))
$SetupPs1 = Join-Path $RepoRoot 'setup.ps1'
$SelfPs1  = Join-Path (Join-Path (Join-Path $RepoRoot '.cac') 'tests') 'ps1-shell.test.ps1'
$SiblingCcBase = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $RepoRoot '..') 'cc-base'))

$PsExe = $null
try {
  $PsExe = (Get-Process -Id $PID).Path
} catch {
  $PsExe = $null
}
if (-not $PsExe) {
  $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwshCmd) {
    $PsExe = $pwshCmd.Source
  } else {
    $PsExe = 'powershell'
  }
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8NoBom([string]$FilePath, [string]$Text) {
  $parent = Split-Path -Parent $FilePath
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($FilePath, $Text, $Utf8NoBom)
}

function Invoke-PsScript([string]$ScriptPath, [string[]]$ScriptArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $stdoutLines = & $PsExe -NoProfile -File $ScriptPath @ScriptArgs 2>$null
    $rc = $LASTEXITCODE
    $stdoutText = ($stdoutLines | Out-String).Trim()
    return @{ ExitCode = $rc; Stdout = $stdoutText }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Invoke-NodeJson([string]$ScriptPath, [string[]]$NodeArgs, [string]$StdinText = '') {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($StdinText -ne '') {
      $stdoutLines = $StdinText | & node $ScriptPath @NodeArgs 2>$null
    } else {
      $stdoutLines = & node $ScriptPath @NodeArgs 2>$null
    }
    $rc = $LASTEXITCODE
    $stdoutText = ($stdoutLines | Out-String).Trim()
    return @{ ExitCode = $rc; Stdout = $stdoutText }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Seed-ClaudeBase([string]$TargetDir) {
  $ccClaude = Join-Path $SiblingCcBase '.claude'
  $ccManifest = Join-Path $ccClaude 'FRAMEWORK-MANIFEST.txt'
  if (Test-Path -LiteralPath $ccManifest) {
    $lines = [System.IO.File]::ReadAllLines($ccManifest)
    foreach ($line in $lines) {
      if (-not $line -or $line.StartsWith('#')) { continue }
      $parts = $line.Split("`t")
      if ($parts.Length -lt 2) { continue }
      $rel = $parts[0].Trim()
      $srcFile = Join-Path $ccClaude $rel
      if (Test-Path -LiteralPath $srcFile) {
        $dstFile = Join-Path (Join-Path $TargetDir '.claude') $rel
        $dstParent = Split-Path -Parent $dstFile
        if (-not (Test-Path -LiteralPath $dstParent)) {
          New-Item -ItemType Directory -Path $dstParent -Force | Out-Null
        }
        Copy-Item -LiteralPath $srcFile -Destination $dstFile -Force
      }
    }
    Copy-Item -LiteralPath $ccManifest -Destination (Join-Path $TargetDir '.claude/FRAMEWORK-MANIFEST.txt') -Force
    $ccSettings = Join-Path $ccClaude 'settings.json'
    if (Test-Path -LiteralPath $ccSettings) {
      Copy-Item -LiteralPath $ccSettings -Destination (Join-Path $TargetDir '.claude/settings.json') -Force
    }
  } else {
    Write-Utf8NoBom (Join-Path $TargetDir '.claude/CLAUDE.md') "[Role]`nSiteMaster constitution.`n"
    Write-Utf8NoBom (Join-Path $TargetDir '.claude/settings.json') "{`n  `"hooks`": {}`n}`n"
    Write-Utf8NoBom (Join-Path $TargetDir '.claude/rules/core.md') "# Core Rules`n"
    Write-Utf8NoBom (Join-Path $TargetDir '.claude/skills/dev-builder/SKILL.md') "# dev-builder`n"
    Write-Utf8NoBom (Join-Path $TargetDir '.claude/skills/dev-builder/refs/guide.md') "precious-skill-payload`n"
    Write-Utf8NoBom (Join-Path $TargetDir '.claude/agents/implementer.md') "# implementer`n"
    Write-Utf8NoBom (Join-Path $TargetDir '.claude/hooks/session-rules-banner.mjs') "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'banner-ok'}})+'\n');`n"
  }
}

function Get-TreeHashSnapshot([string]$RootDir) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $RootDir)) { return $map }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $files = Get-ChildItem -LiteralPath $RootDir -Recurse -File -Force
    foreach ($f in $files) {
      $rel = $f.FullName.Substring($RootDir.Length).TrimStart('\', '/').Replace('\', '/')
      $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
      $hashHex = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
      $map[$rel] = $hashHex
    }
  } finally {
    $sha.Dispose()
  }
  return $map
}

function Assert-SnapshotsEqual([hashtable]$Expected, [hashtable]$Actual, [string]$Label) {
  if ($Expected.Count -ne $Actual.Count) {
    throw ("Snapshot file count mismatch ($Label): expected $($Expected.Count), got $($Actual.Count)")
  }
  foreach ($k in $Expected.Keys) {
    if (-not $Actual.ContainsKey($k)) {
      throw ("Snapshot missing file ($Label): $k")
    }
    if ($Actual[$k] -ne $Expected[$k]) {
      throw ("Snapshot SHA256 mismatch ($Label): $k")
    }
  }
}

$PassCount = 0
function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw "ASSERTION FAILED: $Message"
  }
}

function Step-Pass([string]$Label) {
  $script:PassCount++
  Write-Host ("ok {0} - {1}" -f $script:PassCount, $Label)
}

# 1. PowerShell AST, No-BOM, Pure-ASCII, and Static Parameter Contract verification
$PsFiles = @(
  @{ Name = 'setup.ps1'; Path = $SetupPs1 },
  @{ Name = '.cac/tests/ps1-shell.test.ps1'; Path = $SelfPs1 }
)

$SetupAst = $null
foreach ($item in $PsFiles) {
  Assert-True (Test-Path -LiteralPath $item.Path) ("Missing PowerShell script: " + $item.Name)
  $bytes = [System.IO.File]::ReadAllBytes($item.Path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  Assert-True (-not $hasBom) ("UTF-8 BOM detected in " + $item.Name)

  for ($idx = 0; $idx -lt $bytes.Length; $idx++) {
    Assert-True ($bytes[$idx] -lt 0x80) ("Non-ASCII byte 0x{0:X2} at offset {1} in {2}" -f $bytes[$idx], $idx, $item.Name)
  }

  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($item.Path, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors -and $parseErrors.Count -gt 0) {
    throw ("PowerShell AST parse error in {0}: {1}" -f $item.Name, $parseErrors[0].Message)
  }
  if ($item.Name -eq 'setup.ps1') {
    $SetupAst = $ast
  }
}

$DeclaredParams = @($SetupAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
foreach ($reqParam in @('Command', 'Target', 'DryRun', 'Force', 'Uninstall', 'SourceCheck', 'WithCc', 'NoAutoCc', 'CcBase', 'BundleCc', 'HookForm', 'Json')) {
  Assert-True ($DeclaredParams -contains $reqParam) ("setup.ps1 ParamBlock missing parameter -$reqParam")
}

$SetupText = [System.IO.File]::ReadAllText($SetupPs1)
foreach ($reqToken in @("'package'", '--with-cc', '--no-auto-cc', '--cc-base', '--bundle-cc')) {
  Assert-True ($SetupText.Contains($reqToken)) ("setup.ps1 missing static contract token: " + $reqToken)
}
Step-Pass 'AST parse, no-BOM, pure-ASCII, and -WithCc/-NoAutoCc/-CcBase/-BundleCc/package static contract passed'

$TmpBase = Join-Path ([System.IO.Path]::GetTempPath()) ('cac-link-ps1-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))

try {
  New-Item -ItemType Directory -Path $TmpBase -Force | Out-Null

  # 2. Reject --dryrun, bare 'package' typo (F-02), mutually exclusive -NoAutoCc -WithCc, duplicate target, and CON (exit 2, zero mkdir)
  $workCwd = Join-Path $TmpBase 'cwd-guard'
  New-Item -ItemType Directory -Path $workCwd -Force | Out-Null

  Push-Location -LiteralPath $workCwd
  try {
    $rTypo = Invoke-PsScript $SetupPs1 @('--dryrun')
    $rPkg  = Invoke-PsScript $SetupPs1 @('package')
  } finally {
    Pop-Location
  }
  Assert-True ($rTypo.ExitCode -eq 2) ("Expected setup.ps1 --dryrun to exit 2, got " + $rTypo.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $workCwd '--dryrun'))) 'setup.ps1 must NOT create directory --dryrun'
  Assert-True ($rPkg.ExitCode -eq 2) ("Expected setup.ps1 package bare typo to exit 2, got " + $rPkg.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $workCwd 'package'))) 'setup.ps1 must NOT create directory package'

  $mutTarget = Join-Path $TmpBase 'mut-noauto-withcc'
  $rMut = Invoke-PsScript $SetupPs1 @('-Target', $mutTarget, '-NoAutoCc', '-WithCc')
  Assert-True ($rMut.ExitCode -eq 2) ("Expected -NoAutoCc -WithCc conflict to exit 2, got " + $rMut.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath $mutTarget)) '-NoAutoCc -WithCc must NOT create target directory'

  $dupA = Join-Path $TmpBase 'dup-a'
  $dupB = Join-Path $TmpBase 'dup-b'
  $rDup = Invoke-PsScript $SetupPs1 @($dupA, '-Target', $dupB)
  Assert-True ($rDup.ExitCode -eq 2) ("Expected duplicate target rejection exit 2, got " + $rDup.ExitCode)

  $conTarget = Join-Path $TmpBase 'CON'
  $rCon = Invoke-PsScript $SetupPs1 @($conTarget)
  Assert-True ($rCon.ExitCode -eq 2) ("Expected setup.ps1 CON path rejection exit 2, got " + $rCon.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath $conTarget)) 'setup.ps1 must NOT create reserved CON directory'
  Step-Pass 'Unknown option (--dryrun), bare package, -NoAutoCc/-WithCc conflict, duplicate target, and CON rejected with exit 2'

  # 3. setup.ps1 -DryRun leaves zero files on disk
  $dryTarget = Join-Path $TmpBase 'dry-target'
  $rDry = Invoke-PsScript $SetupPs1 @('-Target', $dryTarget, '-DryRun')
  Assert-True ($rDry.ExitCode -eq 0) ("setup.ps1 -DryRun failed with exit " + $rDry.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath $dryTarget)) 'setup.ps1 -DryRun must not create target directory'
  Step-Pass 'setup.ps1 -DryRun succeeded with zero writes'

  # 4. Tier 1: 3x repeated idempotent install onto cc-base (.claude/) + OS link check + doctor.mjs
  $projTarget = Join-Path $TmpBase 'proj-cc'
  Seed-ClaudeBase $projTarget
  $snapSkillsBefore = Get-TreeHashSnapshot (Join-Path $projTarget '.claude/skills')
  $snapAgentsBefore = Get-TreeHashSnapshot (Join-Path $projTarget '.claude/agents')

  $rInst1 = Invoke-PsScript $SetupPs1 @($projTarget, '-Json')
  Assert-True ($rInst1.ExitCode -eq 0) ("setup.ps1 install #1 failed: " + $rInst1.ExitCode)
  $j1 = $rInst1.Stdout | ConvertFrom-Json
  Assert-True ($j1.ccBase.action -eq 'present') 'Tier 1 install #1 must report ccBase.action=present'

  $rInst2 = Invoke-PsScript $SetupPs1 @($projTarget, '-Json')
  Assert-True ($rInst2.ExitCode -eq 0) ("setup.ps1 install #2 failed: " + $rInst2.ExitCode)
  $j2 = $rInst2.Stdout | ConvertFrom-Json
  Assert-True ($j2.stats.create -eq 0 -and $j2.stats.update -eq 0 -and $j2.stats.conflict -eq 0) 'Install #2 must have create=0 update=0 conflict=0'

  $rInst3 = Invoke-PsScript $SetupPs1 @('-Target', $projTarget, '-Json')
  Assert-True ($rInst3.ExitCode -eq 0) ("setup.ps1 install #3 failed: " + $rInst3.ExitCode)
  $j3 = $rInst3.Stdout | ConvertFrom-Json
  Assert-True ($j3.stats.create -eq 0 -and $j3.stats.update -eq 0 -and $j3.stats.conflict -eq 0) 'Install #3 must have create=0 update=0 conflict=0'

  $topNames = @(Get-ChildItem -LiteralPath $projTarget -Force | Select-Object -ExpandProperty Name | Sort-Object)
  Assert-True (($topNames -join ',') -eq '.cac,.claude') ("Expected only .cac and .claude at root, got: " + ($topNames -join ','))

  foreach ($ln in @('skills', 'agents')) {
    $item = Get-Item -LiteralPath (Join-Path $projTarget ".cac/$ln") -Force
    Assert-True ([bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) (".cac/$ln must be an OS ReparsePoint (Junction/symlink)")
  }

  $docScript = Join-Path $projTarget '.cac/scripts/doctor.mjs'
  $rDoc = Invoke-NodeJson $docScript @($projTarget, '--json')
  Assert-True ($rDoc.ExitCode -eq 0) ("Downstream doctor.mjs failed: " + $rDoc.Stdout)
  $docObj = $rDoc.Stdout | ConvertFrom-Json
  Assert-True ([bool]$docObj.ok) 'Downstream doctor.mjs ok must be true'
  Step-Pass 'Tier 1 3x repeated install idempotency, zero root file intrusion, OS links, and doctor.mjs passed'

  # 5. Tier 2: Empty target automatic cc-base co-installation when ../cc-base exists
  if (Test-Path -LiteralPath (Join-Path $SiblingCcBase 'setup.ps1')) {
    $autoTarget = Join-Path $TmpBase 'proj-tier2-auto'
    $rAuto = Invoke-PsScript $SetupPs1 @('-Target', $autoTarget, '-Json')
    Assert-True ($rAuto.ExitCode -eq 0) ("Tier 2 auto-install failed: " + $rAuto.ExitCode)
    $autoObj = $rAuto.Stdout | ConvertFrom-Json
    Assert-True ($autoObj.ccBase.action -eq 'auto-installed') 'Expected Tier 2 ccBase.action=auto-installed'
    Assert-True (-not [bool]$autoObj.pendingCcBase) 'Expected pendingCcBase=false after Tier 2 co-install'
    Assert-True (Test-Path -LiteralPath (Join-Path $autoTarget '.claude/CLAUDE.md')) 'Expected .claude/CLAUDE.md from Tier 2'
    Step-Pass 'Tier 2 empty target automatic cc-base co-installation passed'
  }

  # 6. 3-way conflict protection (.cac-link-new) + upgrade -Force recovery
  $agentsMd = Join-Path $projTarget '.cac/rules/AGENTS.md'
  $origAgents = [System.IO.File]::ReadAllText($agentsMd)
  Write-Utf8NoBom $agentsMd ($origAgents + "`n# Local PS1 Bridge Note`n")

  $rUpg = Invoke-PsScript $SetupPs1 @('upgrade', '-Target', $projTarget, '-Json')
  Assert-True ($rUpg.ExitCode -eq 0) ("setup.ps1 upgrade failed: " + $rUpg.ExitCode)
  Assert-True (Test-Path -LiteralPath ($agentsMd + '.cac-link-new')) 'Expected .cac/rules/AGENTS.md.cac-link-new sidecar'
  Assert-True ([System.IO.File]::ReadAllText($agentsMd).Contains('Local PS1 Bridge Note')) 'User edit in .cac/rules/AGENTS.md must be preserved'

  Remove-Item -LiteralPath ($agentsMd + '.cac-link-new') -Force
  $rUpgForce = Invoke-PsScript $SetupPs1 @('upgrade', '-Target', $projTarget, '-Force', '-Json')
  Assert-True ($rUpgForce.ExitCode -eq 0) ("setup.ps1 upgrade -Force failed: " + $rUpgForce.ExitCode)
  Assert-True (-not [System.IO.File]::ReadAllText($agentsMd).Contains('Local PS1 Bridge Note')) 'upgrade -Force must restore framework .cac/rules/AGENTS.md'
  Step-Pass '3-way conflict sidecar (.cac-link-new) and upgrade -Force recovery passed'

  # 7. Standalone physical .cac/{skills,agents} migration
  $migTarget = Join-Path $TmpBase 'proj-migrate'
  Seed-ClaudeBase $migTarget
  Write-Utf8NoBom (Join-Path $migTarget '.cac/skills/old-standalone/SKILL.md') "# standalone skill`n"
  Write-Utf8NoBom (Join-Path $migTarget '.cac/agents/old-agent.md') "# standalone agent`n"
  $rMig = Invoke-PsScript $SetupPs1 @($migTarget, '-Json')
  Assert-True ($rMig.ExitCode -eq 0) ("Standalone migration install failed: " + $rMig.ExitCode)
  $migObj = $rMig.Stdout | ConvertFrom-Json
  Assert-True ($migObj.migratedPaths.Count -ge 2) 'Expected physical .cac/skills and .cac/agents to be migrated to backup paths'
  $migSkillsItem = Get-Item -LiteralPath (Join-Path $migTarget '.cac/skills') -Force
  Assert-True ([bool]($migSkillsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) 'Migrated .cac/skills must become ReparsePoint'
  Step-Pass 'Standalone physical .cac/{skills,agents} safe backup migration passed'

  # 8. Tier 3: -NoAutoCc deferred pre-.claude/ install + cc-bridge.mjs session-start link self-healing
  $preTarget = Join-Path $TmpBase 'proj-pre-cc'
  $rPre = Invoke-PsScript $SetupPs1 @($preTarget, '-NoAutoCc', '-Json')
  Assert-True ($rPre.ExitCode -eq 0) ("Tier 3 -NoAutoCc install failed: " + $rPre.ExitCode)
  $preObj = $rPre.Stdout | ConvertFrom-Json
  Assert-True ($preObj.ccBase.action -eq 'deferred') 'Expected ccBase.action=deferred with -NoAutoCc'
  Assert-True ([bool]$preObj.pendingCcBase) 'Expected pendingCcBase=true when -NoAutoCc is passed on empty target'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $preTarget '.cac/skills'))) '.cac/skills link must not exist before .claude/'

  $bridgeScript = Join-Path $preTarget '.cac/hooks/cc-bridge.mjs'
  $evJson = ('{"cwd":"' + $preTarget.Replace('\', '\\') + '"}')
  $rSs1 = Invoke-NodeJson $bridgeScript @('session-start') $evJson
  Assert-True ($rSs1.ExitCode -eq 0) 'session-start without .claude/ must exit 0'
  $ss1Obj = $rSs1.Stdout | ConvertFrom-Json
  Assert-True ($ss1Obj.hookSpecificOutput.hookEventName -eq 'SessionStart') 'Expected single-line SessionStart JSON output'

  Seed-ClaudeBase $preTarget
  $rSs2 = Invoke-NodeJson $bridgeScript @('session-start') $evJson
  Assert-True ($rSs2.ExitCode -eq 0) 'session-start after .claude/ arrival must exit 0'
  $healedItem = Get-Item -LiteralPath (Join-Path $preTarget '.cac/skills') -Force
  Assert-True ([bool]($healedItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) 'SessionStart must self-heal .cac/skills ReparsePoint'
  Step-Pass 'Tier 3 -NoAutoCc install and SessionStart automatic link self-healing passed'

  # 9. Uninstall detaches OS links and leaves .claude/ 100% byte-for-byte untouched
  $rUn = Invoke-PsScript $SetupPs1 @('-Uninstall', '-Target', $projTarget, '-Force', '-Json')
  Assert-True ($rUn.ExitCode -eq 0) ("setup.ps1 -Uninstall -Force failed: " + $rUn.ExitCode)
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $projTarget '.cac/skills'))) '.cac/skills link must be detached on uninstall'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $projTarget '.cac/agents'))) '.cac/agents link must be detached on uninstall'

  $snapSkillsAfter = Get-TreeHashSnapshot (Join-Path $projTarget '.claude/skills')
  $snapAgentsAfter = Get-TreeHashSnapshot (Join-Path $projTarget '.claude/agents')
  Assert-SnapshotsEqual $snapSkillsBefore $snapSkillsAfter '.claude/skills after -Uninstall -Force'
  Assert-SnapshotsEqual $snapAgentsBefore $snapAgentsAfter '.claude/agents after -Uninstall -Force'
  Step-Pass 'setup.ps1 -Uninstall -Force detached OS links while preserving .claude/ byte-for-byte'

  Write-Host ("1..{0} ALL PASSED" -f $PassCount)
  exit 0
}
finally {
  if (Test-Path -LiteralPath $TmpBase) {
    Remove-Item -LiteralPath $TmpBase -Recurse -Force -ErrorAction SilentlyContinue
  }
}
