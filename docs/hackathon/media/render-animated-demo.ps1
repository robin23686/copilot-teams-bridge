param(
    [string]$OutputPath = (Join-Path $PSScriptRoot 'copilot-teams-bridge-concept.mp4'),
    [string]$WorkPath = (Join-Path $env:TEMP 'bridge-media-animated')
)

$ErrorActionPreference = 'Stop'

$dependencyRoot = Join-Path $env:TEMP 'bridge-media'
$ffmpegModule = Join-Path $dependencyRoot 'node_modules\ffmpeg-static'
if (-not (Test-Path $ffmpegModule)) {
    throw "ffmpeg-static is missing. Follow the media README regeneration steps first."
}

Push-Location $dependencyRoot
try {
    $ffmpeg = node -e "process.stdout.write(require('ffmpeg-static'))"
}
finally {
    Pop-Location
}

if (-not (Test-Path $ffmpeg)) {
    throw "Unable to resolve ffmpeg-static."
}

Remove-Item $WorkPath -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $WorkPath | Out-Null

$scenes = @(
    @{ Image = '01-hero.png'; Narration = 'Copilot Teams Bridge connects your coding session to Microsoft Teams, so your agent can reach you anywhere.' },
    @{ Image = '06-actual-extension.png'; Narration = 'Inside Visual Studio Code, each Copilot task has its own bridge session and a dedicated Teams thread.' },
    @{ Image = '02-notify.png'; Narration = 'Keep working elsewhere. Copilot posts progress and tags you only when your attention is needed.' },
    @{ Image = '03-reply-anywhere.png'; Narration = 'Reply naturally from Teams. There are no session IDs to copy and no special commands to remember.' },
    @{ Image = '04-resume.png'; Narration = 'The bridge returns your reply to the exact Copilot chat that asked, and work resumes automatically.' },
    @{ Image = '05-parallel-sessions.png'; Narration = 'One session maps to one thread, so even parallel agents stay isolated and every reply reaches the right place.' }
)

Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice.SelectVoice('Microsoft Zira Desktop')
$voice.Rate = 2
$voice.Volume = 92

try {
    for ($index = 0; $index -lt $scenes.Count; $index++) {
        $voicePath = Join-Path $WorkPath ("voice-{0:D2}.wav" -f $index)
        $voice.SetOutputToWaveFile($voicePath)
        $voice.Speak($scenes[$index].Narration)
        $voice.SetOutputToNull()
    }
}
finally {
    $voice.Dispose()
}

$sceneDuration = 6.4
$transitionDuration = 0.7
$sceneStep = $sceneDuration - $transitionDuration
$inputArguments = [System.Collections.Generic.List[string]]::new()

foreach ($scene in $scenes) {
    $inputArguments.AddRange([string[]]@(
        '-loop', '1',
        '-t', $sceneDuration.ToString([Globalization.CultureInfo]::InvariantCulture),
        '-i', (Join-Path $PSScriptRoot $scene.Image)
    ))
}

for ($index = 0; $index -lt $scenes.Count; $index++) {
    $inputArguments.AddRange([string[]]@('-i', (Join-Path $WorkPath ("voice-{0:D2}.wav" -f $index))))
}

$inputArguments.AddRange([string[]]@(
    '-f', 'lavfi', '-t', '0.42', '-i', 'sine=frequency=880:sample_rate=48000',
    '-f', 'lavfi', '-t', '0.14', '-i', 'sine=frequency=520:sample_rate=48000',
    '-f', 'lavfi', '-t', '0.34', '-i', 'sine=frequency=660:sample_rate=48000'
))

$videoFilters = @(
    "[0:v]scale=2048:1152,zoompan=z='min(zoom+0.00032,1.055)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=192:s=1920x1080:fps=30,setsar=1[v0]",
    "[1:v]scale=2048:1152,zoompan=z='min(zoom+0.00028,1.045)':x='iw/2-(iw/zoom/2)-70':y='ih/2-(ih/zoom/2)+35':d=192:s=1920x1080:fps=30,setsar=1,drawbox=x=1450:y=395:w=290:h=430:color=0x7B83EB@0.32:t=5:enable='between(t,2.0,4.8)'[v1]",
    "[2:v]scale=2048:1152,zoompan=z='min(zoom+0.00035,1.06)':x='iw/2-(iw/zoom/2)-100':y='ih/2-(ih/zoom/2)':d=192:s=1920x1080:fps=30,setsar=1,drawbox=x=1215:y=550:w=335:h=160:color=0x6264A7@0.38:t=6:enable='between(t,2.0,5.1)'[v2]",
    "[3:v]scale=2048:1152,zoompan=z='min(zoom+0.00038,1.065)':x='iw/2-(iw/zoom/2)-120':y='ih/2-(ih/zoom/2)+30':d=192:s=1920x1080:fps=30,setsar=1,drawbox=x=1325:y=635:w=250:h=100:color=0x16A34A@0.42:t=6:enable='between(t,2.2,5.2)'[v3]",
    "[4:v]scale=2048:1152,zoompan=z='min(zoom+0.00034,1.058)':x='iw/2-(iw/zoom/2)+55':y='ih/2-(ih/zoom/2)+25':d=192:s=1920x1080:fps=30,setsar=1,drawbox=x=920:y=505:w=680:h=155:color=0x16A34A@0.38:t=6:enable='between(t,1.7,4.8)'[v4]",
    "[5:v]scale=2048:1152,zoompan=z='min(zoom+0.00025,1.04)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=192:s=1920x1080:fps=30,setsar=1,drawbox=x=650:y=620:w=620:h=125:color=0x7B83EB@0.34:t=6:enable='between(t,2.0,5.0)'[v5]"
)

$xfadeTransitions = @('fade', 'slideleft', 'fadeblack', 'slideup', 'smoothleft')
$lastVideo = 'v0'
for ($index = 1; $index -lt $scenes.Count; $index++) {
    $outputLabel = "x$index"
    $offset = ($sceneStep * $index).ToString('0.###', [Globalization.CultureInfo]::InvariantCulture)
    $videoFilters += "[$lastVideo][v$index]xfade=transition=$($xfadeTransitions[$index - 1]):duration=$transitionDuration`:offset=$offset[$outputLabel]"
    $lastVideo = $outputLabel
}

$audioFilters = [System.Collections.Generic.List[string]]::new()
$audioInputs = [System.Collections.Generic.List[string]]::new()
for ($index = 0; $index -lt $scenes.Count; $index++) {
    $inputIndex = $scenes.Count + $index
    $delayMilliseconds = [int](($sceneStep * $index + 0.65) * 1000)
    $label = "n$index"
    $audioFilters.Add("[$inputIndex`:a]aresample=48000,adelay=$delayMilliseconds|$delayMilliseconds,volume=1.05[$label]")
    $audioInputs.Add("[$label]")
}

$soundInputStart = $scenes.Count * 2
$notificationDelay = [int](($sceneStep * 2 + 1.45) * 1000)
$sendDelay = [int](($sceneStep * 3 + 3.55) * 1000)
$resumeDelay = [int](($sceneStep * 4 + 1.55) * 1000)
$audioFilters.Add("[$soundInputStart`:a]afade=t=out:st=0.18:d=0.24,adelay=$notificationDelay|$notificationDelay,volume=0.16[notify]")
$audioFilters.Add("[$($soundInputStart + 1)`:a]afade=t=out:st=0.04:d=0.10,adelay=$sendDelay|$sendDelay,volume=0.12[send]")
$audioFilters.Add("[$($soundInputStart + 2)`:a]afade=t=out:st=0.12:d=0.22,adelay=$resumeDelay|$resumeDelay,volume=0.14[resume]")
$audioInputs.AddRange([string[]]@('[notify]', '[send]', '[resume]'))

$totalDuration = $sceneStep * ($scenes.Count - 1) + $sceneDuration
$audioFilters.Add(
    "$($audioInputs -join '')amix=inputs=$($audioInputs.Count):duration=longest:normalize=0," +
    "alimiter=limit=0.92,atrim=duration=$($totalDuration.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture))[audio]"
)

$filterGraph = ($videoFilters + $audioFilters) -join ';'
$arguments = [System.Collections.Generic.List[string]]::new()
$arguments.AddRange([string[]]@('-y'))
$arguments.AddRange($inputArguments)
$arguments.AddRange([string[]]@(
    '-filter_complex', $filterGraph,
    '-map', "[$lastVideo]",
    '-map', '[audio]',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-t', $totalDuration.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture),
    $OutputPath
))

& $ffmpeg $arguments
if ($LASTEXITCODE -ne 0) {
    throw "FFmpeg rendering failed with exit code $LASTEXITCODE."
}

Write-Host "Rendered animated demo: $OutputPath"
