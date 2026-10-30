#requires -Version 5.1
<#
.SYNOPSIS
  I8-3 Windows-side driver: locate THIS run's Windows Terminal window, capture
  its real OS pixels, and inject real OS keyboard / mouse / wheel input.

.DESCRIPTION
  Only ever touches the ONE visible window whose title contains the run title
  (`I8-3-<RUN_ID>`), set by `--suppressApplicationTitle` at launch. A missing,
  hidden, minimized, ambiguous or non-foreground target is a hard failure
  (`GUI_BLOCKED`), never a fallback to another window.

  Capture uses PER_MONITOR_AWARE_V2 + DWMWA_EXTENDED_FRAME_BOUNDS +
  Graphics.CopyFromScreen, i.e. physical desktop pixels of the DWM frame, and
  re-reads the frame bounds after the copy so a move/resize race is rejected
  instead of pairing a screenshot with stale bounds. This mirrors the verified
  approach in `~/project/wt-gui-lab/scripts/capture-window.ps1` (the lab that
  proved WT's real capture/scroll behavior for Image-8); it is re-stated here
  because this repository's evidence path must be self-contained.

  Pointer coordinates are CLIENT-area logical pixels of the target window; the
  driver converts them to screen coordinates with ClientToScreen so a click is
  always inside the window even if it moved. Callers must map a cell to a pixel
  from the recorded screenshot + cell geometry; the driver never guesses.

.PARAMETER Action
  capture  – write the window's physical-frame PNG (refuses to overwrite)
  text     – type Unicode text with SendInput KEYEVENTF_UNICODE
  key      – press one virtual key (named or hex)
  ctrl     – press Ctrl + one virtual key
  click    – move the pointer and press/release the left button
  wheel    – move the pointer and send wheel deltas (+up / -down, 120 per notch)
  scroll   – press one vertical ScrollBar button located through UI Automation.
             Windows Terminal 1.25.2733.0 does NOT scroll this window on
             SendInput wheel / keybd_event / SendKeys (a negative result proved
             in ~/project/wt-gui-lab); the UIA ScrollBar RepeatButton press is
             the verified positive channel, so `scroll` is what cases use.
  probe    – report the target window, DPI context and client geometry only
  close    – send WM_CLOSE to the target window (graceful, no taskkill)

.OUTPUTS
  One JSON object on stdout. `status` is `OK` or `GUI_BLOCKED`.
#>
param(
  [Parameter(Mandatory = $true)][string]$TitleFragment,
  [Parameter(Mandatory = $true)][ValidateSet('capture', 'text', 'key', 'ctrl', 'click', 'wheel', 'scroll', 'probe', 'close')][string]$Action,
  [string]$OutputPath = '',
  [string]$Text = '',
  [string]$Key = '',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Wheel = 0,
  [int]$Notches = 0,
  [ValidateSet('VerticalLargeDecrease', 'VerticalLargeIncrease', 'VerticalSmallDecrease', 'VerticalSmallIncrease')][string]$ScrollButton = 'VerticalLargeDecrease',
  [switch]$AllowNotForeground
)

$ErrorActionPreference = 'Stop'

if (-not ('I83Driver' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class I83Driver {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX {
        public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }
    public sealed class Match { public IntPtr Handle; public string Title; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public delegate bool EnumMonitorsProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprc, IntPtr data);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, uint attribute, out RECT value, uint size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW", SetLastError = true)] private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumMonitorsProc cb, IntPtr data);

    public static Match[] Find(string fragment) {
        var matches = new List<Match>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            var text = new StringBuilder(512);
            GetWindowTextW(hWnd, text, text.Capacity);
            var title = text.ToString();
            if (title.IndexOf(fragment, StringComparison.Ordinal) >= 0)
                matches.Add(new Match { Handle = hWnd, Title = title });
            return true;
        }, IntPtr.Zero);
        return matches.ToArray();
    }

    public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }
    public static uint RectSize() { return (uint)Marshal.SizeOf(typeof(RECT)); }

    /// A synthetic Alt press makes Windows treat THIS process as the most recent
    /// input owner, which lifts the SetForegroundWindow foreground lock even when
    /// another process (a KVM helper such as deskflow) currently owns the
    /// foreground window. Without it the call is silently refused and injected
    /// keys would land in that other window.
    public static void UnlockForeground() {
        var inputs = new INPUT[2];
        inputs[0].type = 1; inputs[0].u.ki.wVk = 0x12; inputs[0].u.ki.dwFlags = 0;
        inputs[1].type = 1; inputs[1].u.ki.wVk = 0x12; inputs[1].u.ki.dwFlags = 0x0002;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static bool Focus(IntPtr h) {
        IntPtr foreground = GetForegroundWindow();
        uint pid = 0;
        uint targetThread = GetWindowThreadProcessId(h, out pid);
        uint foregroundThread = GetWindowThreadProcessId(foreground, out pid);
        uint self = GetCurrentThreadId();
        if (IsIconic(h)) ShowWindow(h, 9);
        AttachThreadInput(self, targetThread, true);
        if (foregroundThread != 0) AttachThreadInput(self, foregroundThread, true);
        UnlockForeground();
        BringWindowToTop(h);
        SetForegroundWindow(h);
        SetFocus(h);
        AttachThreadInput(self, foregroundThread, false);
        AttachThreadInput(self, targetThread, false);
        return GetForegroundWindow() == h;
    }

    public static INPUT[] Unicode(string text) {
        var list = new List<INPUT>();
        foreach (char c in text) {
            var down = new INPUT(); down.type = 1; down.u.ki.wScan = (ushort)c; down.u.ki.dwFlags = 0x0004; down.u.ki.dwExtraInfo = IntPtr.Zero;
            var up = new INPUT(); up.type = 1; up.u.ki.wScan = (ushort)c; up.u.ki.dwFlags = 0x0004 | 0x0002; up.u.ki.dwExtraInfo = IntPtr.Zero;
            list.Add(down); list.Add(up);
        }
        return list.ToArray();
    }

    public static INPUT[] VirtualKey(ushort vk, bool control) {
        var list = new List<INPUT>();
        if (control) { var c = new INPUT(); c.type = 1; c.u.ki.wVk = 0x11; c.u.ki.dwFlags = 0; list.Add(c); }
        var down = new INPUT(); down.type = 1; down.u.ki.wVk = vk; down.u.ki.dwFlags = 0; list.Add(down);
        var up = new INPUT(); up.type = 1; up.u.ki.wVk = vk; up.u.ki.dwFlags = 0x0002; list.Add(up);
        if (control) { var c = new INPUT(); c.type = 1; c.u.ki.wVk = 0x11; c.u.ki.dwFlags = 0x0002; list.Add(c); }
        return list.ToArray();
    }

    public static INPUT[] Mouse(uint data, uint flags) {
        var i = new INPUT(); i.type = 0; i.u.mi.dx = 0; i.u.mi.dy = 0; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; i.u.mi.dwExtraInfo = IntPtr.Zero;
        return new INPUT[] { i };
    }

    public static MONITORINFOEX[] Monitors() {
        var monitors = new List<MONITORINFOEX>();
        EnumMonitorsProc cb = delegate(IntPtr hMonitor, IntPtr hdc, IntPtr lprc, IntPtr data) {
            var info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (!GetMonitorInfo(hMonitor, ref info)) return false;
            monitors.Add(info);
            return true;
        };
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero))
            throw new InvalidOperationException("EnumDisplayMonitors failed with Win32 error " + Marshal.GetLastWin32Error());
        GC.KeepAlive(cb);
        return monitors.ToArray();
    }
}
'@
}

<#
One explicit key-name table. `SendInput` needs a virtual-key code, and a bare
letter is a KEY NAME — `'O'` is not a hex number, so an implicit `ToInt32(...,16)`
fallback throws instead of pressing O. `HEX:..` stays available for an escape
hatch, and an unknown name is a hard failure.
#>
function Resolve-VirtualKey([string]$name) {
  $table = @{
    ESC = 0x1B; ENTER = 0x0D; TAB = 0x09; SPACE = 0x20; BACKSPACE = 0x08
    UP = 0x26; DOWN = 0x28; LEFT = 0x25; RIGHT = 0x27
    PGUP = 0x21; PGDN = 0x22; HOME = 0x24; END = 0x23
    PLUS = 0xBB; MINUS = 0xBD; NUMPAD_PLUS = 0x6B; NUMPAD_MINUS = 0x6D
  }
  foreach ($letter in [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    $table[[string]$letter] = [int][char]([string]$letter).ToUpper()
  }
  foreach ($digit in 0..9) { $table[[string]$digit] = 0x30 + $digit }
  $normalized = $name.ToUpperInvariant()
  if ($table.ContainsKey($normalized)) { return $table[$normalized] }
  if ($normalized.StartsWith('HEX:')) { return [Convert]::ToInt32($normalized.Substring(4), 16) }
  throw "unknown key name '$name' (use a letter, a digit, a named key, or HEX:1B)"
}

function Fail([string]$reason, [hashtable]$extra = @{}) {
  $payload = @{ status = 'GUI_BLOCKED'; reason = $reason; titleFragment = $TitleFragment } + $extra
  Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
  exit 3
}

# Establish PER_MONITOR_AWARE_V2 BEFORE any HWND/monitor geometry is read, then
# confirm both the process and this thread really are PMv2.
$pmv2 = [IntPtr](-4)
$setOk = [I83Driver]::SetProcessDpiAwarenessContext($pmv2)
Add-Type -AssemblyName System.Drawing

$matches = @([I83Driver]::Find($TitleFragment))
if ($matches.Count -ne 1) {
  Fail "expected exactly one visible window containing the run title; found $($matches.Count)" @{
    count = $matches.Count
    candidates = @($matches | ForEach-Object { @{ hwnd = ('0x{0:X}' -f $_.Handle.ToInt64()); title = $_.Title } })
  }
}
$target = $matches[0]
$hwnd = $target.Handle

if (-not [I83Driver]::IsWindow($hwnd)) { Fail 'the uniquely titled HWND is no longer valid' }
if (-not [I83Driver]::IsWindowVisible($hwnd)) { Fail 'the target window is not visible' }
if ([I83Driver]::IsIconic($hwnd)) { Fail 'the target window is minimized; refusing to interact with an unknown screen area' }

# Foreground is an OBSERVED fact, retried a bounded number of times. WT coalesces
# its own activation with the click that started it, so a single attempt can
# legitimately lose the race; a persistent failure is still a hard stop.
$focusAttempts = 0
if ($Action -ne 'probe' -and $Action -ne 'close') {
  while ($focusAttempts -lt 10 -and [I83Driver]::GetForegroundWindow() -ne $hwnd) {
    [I83Driver]::Focus($hwnd)
    $focusAttempts += 1
    Start-Sleep -Milliseconds 250
  }
}
$isForeground = ([I83Driver]::GetForegroundWindow() -eq $hwnd)
if (-not $isForeground -and -not $AllowNotForeground -and $Action -ne 'close' -and $Action -ne 'probe') {
  Fail 'the target window could not be brought to the foreground' @{ hwnd = ('0x{0:X}' -f $hwnd.ToInt64()); foreground = ('0x{0:X}' -f ([I83Driver]::GetForegroundWindow()).ToInt64()); attempts = $focusAttempts }
}

$client = New-Object I83Driver+RECT
[I83Driver]::GetClientRect($hwnd, [ref]$client) | Out-Null
$clientWidth = $client.Right - $client.Left
$clientHeight = $client.Bottom - $client.Top
$origin = New-Object I83Driver+POINT
[I83Driver]::ClientToScreen($hwnd, [ref]$origin) | Out-Null

$base = [ordered]@{
  hwnd = ('0x{0:X}' -f $hwnd.ToInt64())
  title = $target.Title
  action = $Action
  clientSize = @($clientWidth, $clientHeight)
  clientOriginScreen = @($origin.X, $origin.Y)
  targetWindowDpi = [I83Driver]::GetDpiForWindow($hwnd)
  dpiAwareness = 'PER_MONITOR_AWARE_V2'
  dpiApiReturn = $setOk
  foreground = $isForeground
  focusAttempts = $focusAttempts
}

switch ($Action) {
  'probe' {
    $payload = [ordered]@{ status = 'OK' } + $base
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit 0
  }
  'close' {
    # WM_CLOSE is the graceful path: the app sees a normal window close and can
    # run its own teardown instead of being killed mid-frame.
    [void][I83Driver]::PostMessageW($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    $payload = [ordered]@{ status = 'OK'; closed = $true } + $base
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit 0
  }
  'capture' {
    if ([string]::IsNullOrWhiteSpace($OutputPath)) { Fail 'capture requires -OutputPath' }
    if (Test-Path -LiteralPath $OutputPath) { Fail "refusing to overwrite an existing screenshot: $OutputPath" }

    $bounds = New-Object I83Driver+RECT
    $dwm = [I83Driver]::DwmGetWindowAttribute($hwnd, 9, [ref]$bounds, [I83Driver]::RectSize())
    if ($dwm -ne 0) { Fail ('DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) failed: HRESULT 0x{0:X8}' -f ($dwm -band 0xffffffff)) }
    $width = $bounds.Right - $bounds.Left
    $height = $bounds.Bottom - $bounds.Top
    if ($width -le 0 -or $height -le 0) { Fail "DWM returned an invalid physical frame rectangle" }

    $monitors = @([I83Driver]::Monitors())
    $intersecting = @()
    foreach ($monitor in $monitors) {
      $mb = $monitor.rcMonitor
      $left = [Math]::Max($bounds.Left, $mb.Left)
      $top = [Math]::Max($bounds.Top, $mb.Top)
      $right = [Math]::Min($bounds.Right, $mb.Right)
      $bottom = [Math]::Min($bounds.Bottom, $mb.Bottom)
      if ($right -gt $left -and $bottom -gt $top) {
        $intersecting += [pscustomobject]@{ device = $monitor.szDevice; intersection = @($left, $top, $right, $bottom) }
      }
    }
    if ($intersecting.Count -eq 0) { Fail 'the DWM frame bounds do not intersect any enumerated display' }

    $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen(
        (New-Object System.Drawing.Point($bounds.Left, $bounds.Top)),
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Size($width, $height)),
        [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally { $graphics.Dispose() }

    $after = New-Object I83Driver+RECT
    $afterDwm = [I83Driver]::DwmGetWindowAttribute($hwnd, 9, [ref]$after, [I83Driver]::RectSize())
    if ($afterDwm -ne 0 -or $bounds.Left -ne $after.Left -or $bounds.Top -ne $after.Top -or $bounds.Right -ne $after.Right -or $bounds.Bottom -ne $after.Bottom) {
      $bitmap.Dispose(); Fail 'the target frame moved or resized during capture; refusing inconsistent evidence'
    }
    if ([I83Driver]::IsIconic($hwnd) -or -not [I83Driver]::IsWindowVisible($hwnd)) {
      $bitmap.Dispose(); Fail 'the target window became minimized or hidden during capture'
    }
    # Foreground is re-checked AFTER the copy: a window that stole the foreground
    # mid-copy still leaves the target's own DWM bounds unchanged, so bounds alone
    # cannot prove the pixels belong to the target.
    $foregroundAfterCopy = ([I83Driver]::GetForegroundWindow() -eq $hwnd)
    if (-not $foregroundAfterCopy) {
      $bitmap.Dispose()
      Fail 'the target window lost the foreground during capture; refusing ambiguous pixels' @{
        foregroundAfterCopy = ('0x{0:X}' -f ([I83Driver]::GetForegroundWindow()).ToInt64())
      }
    }
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    $info = Get-Item -LiteralPath $OutputPath
    $payload = [ordered]@{
      status = 'OK'
      output = $OutputPath
      pngBytes = $info.Length
      physicalWindowBounds = @($bounds.Left, $bounds.Top, $bounds.Right, $bounds.Bottom)
      screenshotSize = @($width, $height)
      coordinateSystem = 'physical desktop pixels via DWMWA_EXTENDED_FRAME_BOUNDS and Graphics.CopyFromScreen'
      intersectingMonitors = $intersecting
    } + $base
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit 0
  }
  'text' {
    $inputs = [I83Driver]::Unicode($Text)
    $accepted = 0
    if ($inputs.Length -gt 0) { $accepted = [I83Driver]::SendInput([uint32]$inputs.Length, $inputs, [I83Driver]::InputSize()) }
    # SendInput returns how many events the SYSTEM inserted. Anything less than the
    # requested count means the input was dropped (UIPI, session isolation, ...);
    # reporting OK regardless is what made an undelivered operation look delivered.
    if ($accepted -ne $inputs.Length) {
      Fail "SendInput inserted $accepted of $($inputs.Length) events" @{ accepted = $accepted; requested = $inputs.Length }
    }
    $payload = [ordered]@{ status = 'OK'; typedLength = $Text.Length; events = $inputs.Length; accepted = $accepted; foregroundAfter = ([I83Driver]::GetForegroundWindow() -eq $hwnd) } + $base
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit 0
  }
  'key' {
    if ([string]::IsNullOrWhiteSpace($Key)) { Fail 'key requires -Key' }
    $vk = Resolve-VirtualKey $Key
    $inputs = [I83Driver]::VirtualKey([uint16]$vk, $false)
    $accepted = [I83Driver]::SendInput([uint32]$inputs.Length, $inputs, [I83Driver]::InputSize())
    if ($accepted -ne $inputs.Length) {
      Fail "SendInput inserted $accepted of $($inputs.Length) events for key '$Key'" @{ accepted = $accepted; requested = $inputs.Length }
    }
    $payload = [ordered]@{ status = 'OK'; key = $Key; virtualKey = $vk; events = $inputs.Length; foregroundAfter = ([I83Driver]::GetForegroundWindow() -eq $hwnd) } + $base
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit 0
  }
  'ctrl' {
    if ([string]::IsNullOrWhiteSpace($Key)) { Fail 'ctrl requires -Key' }
    $vk = Resolve-VirtualKey $Key
    $inputs = [I83Driver]::VirtualKey([uint16]$vk, $true)
    $accepted = [I83Driver]::SendInput([uint32]$inputs.Length, $inputs, [I83Driver]::InputSize())
    if ($accepted -ne $inputs.Length) {
      Fail "SendInput inserted $accepted of $($inputs.Length) events for key '$Key'" @{ accepted = $accepted; requested = $inputs.Length }
    }
    $payload = [ordered]@{ status = 'OK'; key = "CTRL+$Key"; virtualKey = $vk; events = $inputs.Length; foregroundAfter = ([I83Driver]::GetForegroundWindow() -eq $hwnd) } + $base
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit 0
  }
  'click' {
    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $clientWidth -or $Y -ge $clientHeight) {
      Fail "click point ($X,$Y) is outside the client area ${clientWidth}x${clientHeight}"
    }
    [void][I83Driver]::SetCursorPos($origin.X + $X, $origin.Y + $Y)
    Start-Sleep -Milliseconds 150
    $down = [I83Driver]::Mouse(0, 0x0002)
    $downAccepted = [I83Driver]::SendInput(1, $down, [I83Driver]::InputSize())
    Start-Sleep -Milliseconds 70
    $up = [I83Driver]::Mouse(0, 0x0004)
    $upAccepted = [I83Driver]::SendInput(1, $up, [I83Driver]::InputSize())
    if ($downAccepted -ne 1 -or $upAccepted -ne 1) {
      Fail 'the mouse press/release was not inserted by the system' @{ downAccepted = $downAccepted; upAccepted = $upAccepted }
    }
    $payload = [ordered]@{ status = 'OK'; pointerClient = @($X, $Y); pointerScreen = @(($origin.X + $X), ($origin.Y + $Y)); foregroundAfter = ([I83Driver]::GetForegroundWindow() -eq $hwnd) } + $base
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit 0
  }
  'scroll' {
    # UIA must be loaded AFTER the DWM/DPI work so BoundingRectangle is physical.
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $ScrollButton)
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $element = $null
    foreach ($candidate in $windows) {
      if ($candidate.Current.Name -like "*$TitleFragment*") { $element = $candidate; break }
    }
    if ($element -eq $null) { Fail 'the UIA tree does not expose the target window' }
    # Which page button is pressable is a FACT of the current scroll state, not a
    # constant: when the pane is at the newest output the "decrease" page button
    # is the live one and "increase" collapses to an infinite rectangle, and the
    # pair swaps once the user has scrolled up. A WT window can also expose a
    # collapsed duplicate with the same AutomationId, which is why every candidate
    # is tested and the chosen one is recorded instead of assumed.
    $siblingOf = @{
      VerticalLargeDecrease = 'VerticalLargeIncrease'
      VerticalLargeIncrease = 'VerticalLargeDecrease'
      VerticalSmallDecrease = 'VerticalSmallIncrease'
      VerticalSmallIncrease = 'VerticalSmallDecrease'
    }
    $siblingId = $siblingOf[$ScrollButton]

    function Get-PressableButton([string]$id) {
      $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
      $found = $null
      $foundRect = $null
      foreach ($candidate in $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
        $candidateRect = $candidate.Current.BoundingRectangle
        $finite = -not (
          [double]::IsInfinity($candidateRect.X) -or [double]::IsInfinity($candidateRect.Y) -or
          [double]::IsInfinity($candidateRect.Width) -or [double]::IsInfinity($candidateRect.Height) -or
          [double]::IsNaN($candidateRect.Width) -or [double]::IsNaN($candidateRect.Height)
        )
        if ($found -eq $null -and $finite -and $candidateRect.Width -gt 0 -and $candidateRect.Height -gt 0) {
          $found = $candidate
          $foundRect = $candidateRect
        }
      }
      return @{ element = $found; rect = $foundRect }
    }

    $primary = Get-PressableButton $ScrollButton
    $usedId = $ScrollButton
    $usedAsFallback = $false
    $button = $primary.element
    $rect = $primary.rect
    if ($button -eq $null -and $siblingId -ne $null) {
      $fallback = Get-PressableButton $siblingId
      if ($fallback.element -ne $null) {
        $button = $fallback.element
        $rect = $fallback.rect
        $usedId = $siblingId
        $usedAsFallback = $true
      }
    }
    if ($button -eq $null) {
      $siblings = @()
      $sbCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::ScrollBar)
      foreach ($bar in $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $sbCondition)) {
        foreach ($kid in $bar.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
          $kr = $kid.Current.BoundingRectangle
          $kidFinite = -not ([double]::IsInfinity($kr.Width) -or [double]::IsNaN($kr.Width))
          $siblings += @{
            id = $kid.Current.AutomationId
            width = if ($kidFinite) { [int]$kr.Width } else { 'INFINITE' }
            height = if ($kidFinite) { [int]$kr.Height } else { 'INFINITE' }
          }
        }
      }
      Fail "neither $ScrollButton nor $siblingId is pressable (nothing to page in this state)" @{ pressableButtons = $siblings }
    }
    # Derive the press point from the button's OWN physical rectangle. Reading an
    # outer-scope `$centre` here would be undefined (PowerShell function scope),
    # which silently aims the click at the screen origin.
    $centerX = [int]($rect.X + $rect.Width / 2)
    $centerY = [int]($rect.Y + $rect.Height / 2)
    if ($centerX -le 0 -or $centerY -le 0) { Fail "the $usedId button centre is not a usable screen point" }
    $presses = if ($Notches -ne 0) { [Math]::Abs($Notches) } else { 1 }
    $done = 0
    for ($index = 0; $index -lt $presses; $index += 1) {
      [void][I83Driver]::SetCursorPos($centerX, $centerY)
      Start-Sleep -Milliseconds 40
      $down = [I83Driver]::Mouse(0, 0x0002)
      $downAccepted = [I83Driver]::SendInput(1, $down, [I83Driver]::InputSize())
      $up = [I83Driver]::Mouse(0, 0x0004)
      $upAccepted = [I83Driver]::SendInput(1, $up, [I83Driver]::InputSize())
      if ($downAccepted -ne 1 -or $upAccepted -ne 1) {
        Fail 'a ScrollBar page press was not inserted by the system' @{ downAccepted = $downAccepted; upAccepted = $upAccepted; pressesDone = $done }
      }
      $done += 1
      Start-Sleep -Milliseconds 120
    }
    $payload = [ordered]@{
      status = 'OK'
      scrollButton = $usedId
      requestedButton = $ScrollButton
      usedSiblingFallback = $usedAsFallback
      presses = $done
      buttonRectPhysical = @([int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
      buttonCenterScreen = @($centerX, $centerY)
    } + $base
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit 0
  }
  'wheel' {
    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $clientWidth -or $Y -ge $clientHeight) {
      Fail "wheel point ($X,$Y) is outside the client area ${clientWidth}x${clientHeight}"
    }
    if ($Wheel -eq 0) { $Wheel = 120 * $Notches }
    if ($Wheel -eq 0) { Fail 'wheel requires -Wheel or -Notches' }
    [void][I83Driver]::SetCursorPos($origin.X + $X, $origin.Y + $Y)
    Start-Sleep -Milliseconds 150
    $notches = [Math]::Abs([int]($Wheel / 120))
    if ($notches -lt 1) { $notches = 1 }
    for ($index = 0; $index -lt $notches; $index += 1) {
      $delta = if ($Wheel -gt 0) { 120 } else { -120 }
      $inputs = [I83Driver]::Mouse([uint32]($delta -band 0xFFFF), 0x0800)
      $accepted = [I83Driver]::SendInput(1, $inputs, [I83Driver]::InputSize())
      if ($accepted -ne 1) { Fail 'a wheel event was not inserted by the system' @{ accepted = $accepted } }
      Start-Sleep -Milliseconds 60
    }
    $payload = [ordered]@{ status = 'OK'; wheelPointClient = @($X, $Y); wheelDelta = $Wheel; notches = $notches; foregroundAfter = ([I83Driver]::GetForegroundWindow() -eq $hwnd) } + $base
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit 0
  }
}
