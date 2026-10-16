//! repakxtra: "Capture preview in game". Takes a picture of Marvel Rivals' Hero Profile (Overview or Cosmetics) and
//! crops it to the character, for a loadout's image. The game's window is copied from the screen (BitBlt), either
//! right away ("Capture now": the game comes to the front first) or when Ctrl+Shift+X is pressed in the game. Win32 is
//! declared by hand (no new crates); on other systems the commands say capturing works on Windows only.
//! The picture goes to the app as 8 bytes (width, height: u32 LE) then RGBA; the app encodes it and stores it.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const GAME_EXE: &str = "Marvel-Win64-Shipping.exe";
/// The loadout card's portrait ratio.
const CARD_W: f64 = 1358.0;
const CARD_H: f64 = 1920.0;
/// Where the character stands on the Hero Profile screens, as fractions of a 16:9 frame. Measured on four screenshots
/// of Black Panther (Overview: the silhouette, tall catboy ears, cosmic horns; Cosmetics: a fur collar): the character
/// spans x 0.4547..0.8146 and y 0.0705..0.966. The top stays under the tab bar (it ends at y 0.0583, x 0.483), so the
/// crop matches the generated previews' framing (render_preview.py): the head near the top with room for tall ears, cut
/// at the knees, the torso centered. Fitted on the Overview silhouette against a render of the same skin.
const CROP_TOP: f64 = 0.10;
const CROP_HEIGHT: f64 = 0.60;
const CROP_CENTER_X: f64 = 0.6228;
/// Bigger crops (4K screens) are box-filtered down to this height, which keeps the IPC small.
const MAX_HEIGHT: u32 = 1358;
/// How long a switch to the game may take (restore, focus, a stable size), then how long its frame gets to update.
const FRONT_TIMEOUT: Duration = Duration::from_secs(6);
const SETTLE: Duration = Duration::from_millis(1000);

pub const CANCELLED: &str = "cancelled";
pub const TIMEOUT: &str = "timeout";
const NOT_RUNNING: &str = "Marvel Rivals is not running. Start it and open the hero's Overview or Cosmetics screen.";
const BLACK: &str = "The picture came out black. Set the game's display mode to borderless or windowed, then try again.";

static BUSY: AtomicBool = AtomicBool::new(false);
/// The newest capture request. Every request (and every cancel) takes the next number, so whatever came before it is
/// cancelled: a worker that is not the newest stops at its next check, before registering, capturing or switching windows.
static GEN: AtomicU32 = AtomicU32::new(0);
/// The thread waiting for Ctrl+Shift+X (0: none), woken to check whether it is still the newest request.
static WAITER: AtomicU32 = AtomicU32::new(0);

/// A new request: earlier ones are cancelled and a waiting listener is woken to notice. Returns its number.
fn supersede() -> u32 {
    let my = GEN.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    wake_waiter();
    my
}

/// Ok while request `my` is still the newest, else "cancelled".
fn fresh(my: u32) -> Result<(), String> {
    if GEN.load(Ordering::SeqCst) == my { Ok(()) } else { Err(CANCELLED.into()) }
}

fn wake_waiter() {
    let t = WAITER.load(Ordering::SeqCst);
    if t != 0 {
        sys::wake(t);
    }
}

/// One capture at a time; released when dropped, on every path.
struct Busy;
impl Busy {
    /// An older listener gives way (it was cancelled by this request and is woken until it lets go); a capture already
    /// taking its picture gets about 2 s to finish. A request that is no longer the newest stops here.
    fn take(my: u32) -> Result<Busy, String> {
        for _ in 0..40 {
            fresh(my)?;
            if !BUSY.swap(true, Ordering::SeqCst) {
                let busy = Busy;
                fresh(my)?; // cancelled while it waited: dropping `busy` lets go again
                return Ok(busy);
            }
            wake_waiter(); // only ever an older request: a newer one would have failed `fresh` above
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("Another capture is still running. Try again in a moment.".into())
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// The crop (x, y, width, height) for a client area of w x h pixels: the 16:9 crop above, mapped into the largest 16:9
/// frame that fits the screen (wider screens match its height and center it, narrower ones match its width), shrunk
/// if it would not fit (keeping the card ratio) and kept inside the image. Pure.
pub fn crop_rect(w: u32, h: u32) -> (u32, u32, u32, u32) {
    if w == 0 || h == 0 {
        return (0, 0, 0, 0);
    }
    let (wf, hf) = (w as f64, h as f64);
    let s = (wf / 16.0).min(hf / 9.0);
    let (fw, fh) = (16.0 * s, 9.0 * s);
    let (ox, oy) = ((wf - fw) / 2.0, (hf - fh) / 2.0);
    let ch = ((CROP_HEIGHT * fh).min(hf).min(wf * CARD_H / CARD_W).round() as u32).clamp(1, h);
    let cw = ((ch as f64 * CARD_W / CARD_H).round() as u32).clamp(1, w);
    let x = (ox + CROP_CENTER_X * fw - cw as f64 / 2.0).round().clamp(0.0, (w - cw) as f64) as u32;
    let y = (oy + CROP_TOP * fh).round().clamp(0.0, (h - ch) as f64) as u32;
    (x, y, cw, ch)
}

/// Box filter: shrinks an RGBA image to max_h rows (each output pixel averages the pixels it covers). Pure.
fn shrink(rgba: Vec<u8>, w: u32, h: u32, max_h: u32) -> (u32, u32, Vec<u8>) {
    if h <= max_h {
        return (w, h, rgba);
    }
    let oh = max_h;
    let ow = ((w as u64 * oh as u64 + h as u64 / 2) / h as u64).max(1) as u32;
    let span = |i: u32, n: u32, total: u32| {
        let a = (i as u64 * total as u64 / n as u64) as u32;
        (a, ((i as u64 + 1) * total as u64 / n as u64).max(a as u64 + 1) as u32)
    };
    let mut out = Vec::with_capacity(ow as usize * oh as usize * 4);
    for oy in 0..oh {
        let (y0, y1) = span(oy, oh, h);
        for ox in 0..ow {
            let (x0, x1) = span(ox, ow, w);
            let mut sum = [0u32; 4];
            for y in y0..y1 {
                let row = &rgba[(y * w + x0) as usize * 4..(y * w + x1) as usize * 4];
                for p in row.chunks_exact(4) {
                    for c in 0..4 {
                        sum[c] += p[c] as u32;
                    }
                }
            }
            let n = (y1 - y0) * (x1 - x0);
            out.extend(sum.map(|s| ((s + n / 2) / n) as u8));
        }
    }
    (ow, oh, out)
}

/// Exclusive fullscreen often reads back as black: 98% of the pixels near black means there is no picture. Pure.
fn is_black(rgba: &[u8]) -> bool {
    let n = rgba.len() / 4;
    let dark = rgba.chunks_exact(4).filter(|p| p[0].max(p[1]).max(p[2]) <= 12).count();
    n == 0 || dark * 100 >= n * 98
}

/// The IPC body: width and height (u32 LE), then the RGBA pixels. Pure.
fn pack(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + rgba.len());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(rgba);
    out
}

fn game_pids() -> Vec<u32> {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    let s = System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new()));
    s.processes()
        .values()
        .filter(|p| p.name().to_string_lossy().eq_ignore_ascii_case(GAME_EXE))
        .map(|p| p.pid().as_u32())
        .collect()
}

fn game_window() -> Result<sys::Hwnd, String> {
    let pids = game_pids();
    if pids.is_empty() {
        return Err(NOT_RUNNING.into());
    }
    sys::main_window(&pids).ok_or_else(|| "Marvel Rivals has no window yet. Wait for it to finish loading, then try again.".into())
}

/// Copies the crop of the game's client area from the screen, checks it is a picture and sizes it for the app.
fn grab(hwnd: sys::Hwnd) -> Result<Vec<u8>, String> {
    let (w, h) = sys::client_size(hwnd);
    if w == 0 || h == 0 {
        return Err("The game's window is minimized. Open it, then try again.".into());
    }
    let (x, y, cw, ch) = crop_rect(w, h);
    let rgba = sys::copy_client(hwnd, x, y, cw, ch)?;
    if is_black(&rgba) {
        return Err(BLACK.into());
    }
    let (ow, oh, out) = shrink(rgba, cw, ch, MAX_HEIGHT);
    Ok(pack(ow, oh, &out))
}

/// Runs blocking capture work on its own thread (its own message queue and DPI awareness), off the async runtime.
async fn on_thread(f: impl FnOnce() -> Result<Vec<u8>, String> + Send + 'static) -> Result<Vec<u8>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        sys::per_monitor_dpi();
        let _ = tx.send(f());
    });
    rx.await.map_err(|_| "The capture stopped unexpectedly. Try again.".to_string())?
}

/// repakxtra asks to come back to the front after a capture, unless the request was cancelled meanwhile. A plain
/// SetForegroundWindow: tao's set_focus would tap Alt into the game when Windows refuses. Refused, Windows flashes the
/// taskbar button instead and the picture waits in the dialog.
fn come_back(app: &AppHandle, my: u32) {
    if fresh(my).is_err() {
        return;
    }
    #[cfg(windows)]
    if let Some(Ok(h)) = app.get_webview_window("main").map(|w| w.hwnd()) {
        sys::raise(h.0 as sys::Hwnd);
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[derive(Serialize)]
pub struct GameStatus {
    running: bool,
    width: u32,
    height: u32,
}

/// Whether Marvel Rivals runs, and its window's client size in pixels (0 when it has no window yet).
#[tauri::command]
pub async fn capture_game_status() -> GameStatus {
    let pids = game_pids();
    let (width, height) = if pids.is_empty() { (0, 0) } else { sys::main_window(&pids).map(sys::client_size).unwrap_or((0, 0)) };
    GameStatus { running: !pids.is_empty(), width, height }
}

/// Switches to the game (we are the foreground app when the button is clicked, so Windows allows it), takes the picture
/// and switches back.
#[tauri::command]
pub async fn capture_game_now(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let my = supersede(); // a listener waiting for Ctrl+Shift+X gives way
    let r = on_thread(move || {
        let _busy = Busy::take(my)?;
        let hwnd = game_window()?;
        sys::bring_to_front(hwnd)?;
        fresh(my)?;
        grab(hwnd)
    })
    .await;
    come_back(&app, my);
    r.map(tauri::ipc::Response::new)
}

/// Waits up to `seconds` for Ctrl+Shift+X (anywhere, meant for the game), then takes the picture at once and switches
/// back. Errors "cancelled" (capture_game_cancel, or Capture now took over) and "timeout" are for the app, not the user.
#[tauri::command]
pub async fn capture_game_hotkey(app: AppHandle, seconds: u32) -> Result<tauri::ipc::Response, String> {
    let my = supersede(); // numbered before its thread starts, so a cancel right after it is never lost
    let r = on_thread(move || {
        let _busy = Busy::take(my)?;
        game_window()?;
        sys::wait_for_hotkey(seconds.clamp(1, 3600), my)?;
        fresh(my)?;
        let hwnd = game_window()?;
        if sys::foreground() != hwnd {
            sys::bring_to_front(hwnd)?; // pressed while repakxtra (or another app) was in front
        }
        fresh(my)?;
        grab(hwnd)
    })
    .await;
    if !matches!(&r, Err(e) if e == CANCELLED || e == TIMEOUT) {
        come_back(&app, my);
    }
    r.map(tauri::ipc::Response::new)
}

/// Cancels every capture asked for so far: one waiting for Ctrl+Shift+X returns "cancelled", one not started yet never
/// starts.
#[tauri::command]
pub fn capture_game_cancel() {
    supersede();
}

#[cfg(windows)]
mod sys {
    use super::{fresh, CANCELLED, FRONT_TIMEOUT, SETTLE, TIMEOUT, WAITER};
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    pub type Hwnd = isize;

    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Msg {
        hwnd: isize,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt: Point,
    }
    #[repr(C)]
    #[derive(Default)]
    struct BitmapInfo {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
        colors: [u32; 1],
    }

    const GW_OWNER: u32 = 4;
    const SW_RESTORE: i32 = 9;
    const SRCCOPY: u32 = 0x00CC_0020;
    const MOD_CONTROL: u32 = 0x2;
    const MOD_SHIFT: u32 = 0x4;
    const MOD_NOREPEAT: u32 = 0x4000;
    const VK_X: u32 = 0x58;
    const WM_TIMER: u32 = 0x0113;
    const WM_HOTKEY: u32 = 0x0312;
    const WM_APP: u32 = 0x8000;
    const HOTKEY_ID: i32 = 0x5258; // "RX"
    const DPI_PER_MONITOR_AWARE_V2: isize = -4;

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(f: unsafe extern "system" fn(Hwnd, isize) -> i32, data: isize) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn GetWindow(hwnd: Hwnd, cmd: u32) -> Hwnd;
        fn GetClientRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
        fn ClientToScreen(hwnd: Hwnd, point: *mut Point) -> i32;
        fn IsIconic(hwnd: Hwnd) -> i32;
        fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn GetForegroundWindow() -> Hwnd;
        fn GetDC(hwnd: Hwnd) -> isize;
        fn ReleaseDC(hwnd: Hwnd, dc: isize) -> i32;
        fn RegisterHotKey(hwnd: Hwnd, id: i32, modifiers: u32, vk: u32) -> i32;
        fn UnregisterHotKey(hwnd: Hwnd, id: i32) -> i32;
        fn GetMessageW(msg: *mut Msg, hwnd: Hwnd, min: u32, max: u32) -> i32;
        fn PeekMessageW(msg: *mut Msg, hwnd: Hwnd, min: u32, max: u32, remove: u32) -> i32;
        fn PostThreadMessageW(thread: u32, msg: u32, wparam: usize, lparam: isize) -> i32;
        fn SetTimer(hwnd: Hwnd, id: usize, ms: u32, f: *const c_void) -> usize;
        fn KillTimer(hwnd: Hwnd, id: usize) -> i32;
        fn SetThreadDpiAwarenessContext(context: isize) -> isize;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(dc: isize) -> isize;
        fn CreateCompatibleBitmap(dc: isize, w: i32, h: i32) -> isize;
        fn SelectObject(dc: isize, obj: isize) -> isize;
        fn BitBlt(dst: isize, x: i32, y: i32, w: i32, h: i32, src: isize, sx: i32, sy: i32, rop: u32) -> i32;
        fn GetDIBits(dc: isize, bmp: isize, start: u32, lines: u32, bits: *mut c_void, info: *mut BitmapInfo, usage: u32) -> i32;
        fn DeleteObject(obj: isize) -> i32;
        fn DeleteDC(dc: isize) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
    }

    /// Rects in physical pixels on every monitor. Failing (very old Windows 10) leaves the process's own awareness.
    pub fn per_monitor_dpi() {
        unsafe { SetThreadDpiAwarenessContext(DPI_PER_MONITOR_AWARE_V2) };
    }

    pub fn client_size(hwnd: Hwnd) -> (u32, u32) {
        let mut r = Rect::default();
        if unsafe { GetClientRect(hwnd, &mut r) } == 0 {
            return (0, 0);
        }
        ((r.right - r.left).max(0) as u32, (r.bottom - r.top).max(0) as u32)
    }

    pub fn foreground() -> Hwnd {
        unsafe { GetForegroundWindow() }
    }

    struct Search<'a> {
        pids: &'a [u32],
        best: Hwnd,
        area: u64,
    }

    unsafe extern "system" fn each(hwnd: Hwnd, data: isize) -> i32 {
        let s = &mut *(data as *mut Search);
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if s.pids.contains(&pid) && IsWindowVisible(hwnd) != 0 && GetWindow(hwnd, GW_OWNER) == 0 {
            let (w, h) = client_size(hwnd);
            let area = w as u64 * h as u64;
            if s.best == 0 || area > s.area {
                (s.best, s.area) = (hwnd, area);
            }
        }
        1
    }

    /// The game's main window: visible, unowned, the largest client area among its process's windows.
    pub fn main_window(pids: &[u32]) -> Option<Hwnd> {
        let mut s = Search { pids, best: 0, area: 0 };
        unsafe { EnumWindows(each, &mut s as *mut Search as isize) };
        (s.best != 0).then_some(s.best)
    }

    /// Restores and focuses the game, waits until it really is in front with a steady size, then lets a frame draw.
    pub fn bring_to_front(hwnd: Hwnd) -> Result<(), String> {
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd);
        }
        let deadline = Instant::now() + FRONT_TIMEOUT;
        let mut size = client_size(hwnd);
        let mut steady = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(50));
            let now = client_size(hwnd);
            if now != size {
                (size, steady) = (now, Instant::now());
            }
            if foreground() == hwnd && size.0 > 0 && size.1 > 0 && steady.elapsed() >= Duration::from_millis(300) {
                break;
            }
            if Instant::now() >= deadline {
                return Err("Marvel Rivals did not come to the front. Click the game once, then press Ctrl+Shift+X there.".into());
            }
        }
        std::thread::sleep(SETTLE);
        Ok(())
    }

    /// Copies part of the window's client area (client coordinates) from the screen as RGBA.
    pub fn copy_client(hwnd: Hwnd, x: u32, y: u32, w: u32, h: u32) -> Result<Vec<u8>, String> {
        let mut origin = Point::default();
        let mut px = vec![0u8; w as usize * h as usize * 4];
        let ok = unsafe {
            ClientToScreen(hwnd, &mut origin);
            let screen = GetDC(0);
            if screen == 0 {
                return Err("Could not read the screen. Try again.".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w as i32, h as i32);
            let old = SelectObject(mem, bmp);
            let blit = BitBlt(mem, 0, 0, w as i32, h as i32, screen, origin.x + x as i32, origin.y + y as i32, SRCCOPY);
            SelectObject(mem, old); // GetDIBits needs the bitmap out of any DC
            // 32-bit top-down (negative height) BGRA
            let mut info = BitmapInfo { size: 40, width: w as i32, height: -(h as i32), planes: 1, bit_count: 32, ..Default::default() };
            let lines = GetDIBits(screen, bmp, 0, h, px.as_mut_ptr() as *mut c_void, &mut info, 0);
            DeleteObject(bmp);
            DeleteDC(mem);
            ReleaseDC(0, screen);
            blit != 0 && lines == h as i32
        };
        if !ok {
            return Err("Could not copy the game's picture from the screen. Try again.".into());
        }
        for p in px.chunks_exact_mut(4) {
            p.swap(0, 2);
            p[3] = 255;
        }
        Ok(px)
    }

    /// Registers Ctrl+Shift+X for this thread and waits on its message queue for the key or the timeout, while request
    /// `my` stays the newest (a wake only means: check again).
    pub fn wait_for_hotkey(seconds: u32, my: u32) -> Result<(), String> {
        fresh(my)?;
        unsafe {
            let mut msg = Msg::default();
            PeekMessageW(&mut msg, 0, 0, 0, 0); // creates this thread's message queue
            if RegisterHotKey(0, HOTKEY_ID, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_X) == 0 {
                return Err("Another app already uses Ctrl+Shift+X. Use Capture now instead.".into());
            }
            WAITER.store(GetCurrentThreadId(), Ordering::SeqCst);
            let timer = SetTimer(0, 0, seconds * 1000, std::ptr::null());
            // Checked after WAITER is set: a newer request either wakes this thread or is seen here
            let r = loop {
                if fresh(my).is_err() {
                    break Err(CANCELLED.to_string());
                }
                if GetMessageW(&mut msg, 0, 0, 0) <= 0 {
                    break Err(CANCELLED.to_string());
                }
                match msg.message {
                    WM_HOTKEY => break Ok(()),
                    WM_TIMER => break Err(TIMEOUT.to_string()),
                    _ => {} // WM_APP: a wake, checked at the top
                }
            };
            WAITER.store(0, Ordering::SeqCst);
            KillTimer(0, timer);
            UnregisterHotKey(0, HOTKEY_ID);
            r
        }
    }

    pub fn wake(thread: u32) {
        unsafe { PostThreadMessageW(thread, WM_APP, 0, 0) };
    }

    /// Restores and asks Windows to bring this window to the front; refused, Windows flashes its taskbar button.
    pub fn raise(hwnd: Hwnd) {
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd);
        }
    }
}

#[cfg(not(windows))]
mod sys {
    pub type Hwnd = isize;
    const ONLY: &str = "Capturing the game works on Windows only.";
    pub fn per_monitor_dpi() {}
    pub fn client_size(_: Hwnd) -> (u32, u32) {
        (0, 0)
    }
    pub fn foreground() -> Hwnd {
        0
    }
    pub fn main_window(_: &[u32]) -> Option<Hwnd> {
        None
    }
    pub fn bring_to_front(_: Hwnd) -> Result<(), String> {
        Err(ONLY.into())
    }
    pub fn copy_client(_: Hwnd, _: u32, _: u32, _: u32, _: u32) -> Result<Vec<u8>, String> {
        Err(ONLY.into())
    }
    pub fn wait_for_hotkey(_: u32, _: u32) -> Result<(), String> {
        Err(ONLY.into())
    }
    pub fn wake(_: u32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZES: [(u32, u32); 16] = [
        (1920, 1080), (2560, 1440), (2559, 1440), (1280, 720), (3840, 2160), (3440, 1440), (1920, 1200), (1366, 768),
        (5120, 1440), (1024, 768), (800, 1280), (1001, 999), (7, 3), (3, 7), (1, 1), (2, 1),
    ];

    #[test]
    fn crop_stays_inside_with_the_card_ratio() {
        for (w, h) in SIZES {
            let (x, y, cw, ch) = crop_rect(w, h);
            assert!(cw > 0 && ch > 0, "{w}x{h}: empty");
            assert!(x + cw <= w && y + ch <= h, "{w}x{h}: {:?} leaves the image", (x, y, cw, ch));
            assert!((cw as f64 - ch as f64 * CARD_W / CARD_H).abs() <= 1.0, "{w}x{h}: {cw}x{ch} is not 1358:1920");
        }
        assert_eq!(crop_rect(0, 1080), (0, 0, 0, 0));
    }

    #[test]
    fn crop_scales_linearly_on_16_9() {
        let base = crop_rect(1280, 720);
        for (w, h) in [(1920, 1080), (2560, 1440), (3840, 2160), (5120, 2880)] {
            let k = w as f64 / 1280.0;
            let r = crop_rect(w, h);
            for (a, b) in [r.0, r.1, r.2, r.3].into_iter().zip([base.0, base.1, base.2, base.3]) {
                assert!((a as f64 - b as f64 * k).abs() <= 1.0 + k, "{w}x{h}: {r:?} vs {base:?} x{k}");
            }
        }
    }

    #[test]
    fn other_shapes_center_the_16_9_frame() {
        let r = crop_rect(2560, 1440); // ultrawide: matched by height, 440 px on each side
        assert_eq!(crop_rect(3440, 1440), (r.0 + 440, r.1, r.2, r.3));
        let r = crop_rect(1920, 1080); // 16:10: matched by width, 60 px above and below
        assert_eq!(crop_rect(1920, 1200), (r.0, r.1 + 60, r.2, r.3));
    }

    #[test]
    fn crop_frames_the_character_like_the_previews() {
        // Overview silhouette: ears at y 0.133, torso centered at x 0.625, feet at y 0.966
        for (w, h) in [(2560, 1440), (1920, 1080), (2559, 1440), (1280, 720)] {
            let (x, y, cw, ch) = crop_rect(w, h);
            let (wf, hf) = (w as f64, h as f64);
            assert!((y as f64) < 0.133 * hf - 0.02 * hf, "{w}x{h}: room above the head");
            assert!(((y + ch) as f64) < 0.966 * hf - 0.1 * hf, "{w}x{h}: cut above the feet, like a render");
            assert!(((x as f64 + cw as f64 / 2.0) / wf - 0.625).abs() < 0.01, "{w}x{h}: torso centered");
            assert!((y as f64) >= 0.0583 * hf, "{w}x{h}: the tab bar shows");
        }
    }

    #[test]
    fn shrink_averages_boxes() {
        // 2x2 of [10, 20, 30, 40] per channel -> one pixel of 25
        let px: Vec<u8> = [10u8, 20, 30, 40].iter().flat_map(|&v| [v, v, v, 255]).collect();
        assert_eq!(shrink(px.clone(), 2, 2, 1), (1, 1, vec![25, 25, 25, 255]));
        assert_eq!(shrink(px.clone(), 2, 2, 2), (2, 2, px));
        let (w, h, out) = shrink(vec![7; 1436 * 2030 * 4], 1436, 2030, MAX_HEIGHT);
        assert_eq!((w, h), (961, 1358));
        assert_eq!(out.len(), 961 * 1358 * 4);
        assert!(out.iter().all(|&v| v == 7));
    }

    #[test]
    fn black_pictures_are_refused() {
        assert!(is_black(&[0, 0, 0, 255].repeat(100)));
        assert!(is_black(&[]));
        let mut px = [3, 2, 5, 255].repeat(100);
        px[..4 * 5].copy_from_slice(&[90, 60, 170, 255].repeat(5)); // 5% purple
        assert!(!is_black(&px));
    }

    #[test]
    fn a_newer_request_or_a_cancel_stops_older_ones() {
        // One test: these share the module's statics
        let first = supersede();
        assert!(fresh(first).is_ok());
        let busy = Busy::take(first).expect("the newest request gets the capture");
        let second = supersede(); // Capture now while the first listens
        assert_eq!(fresh(first), Err(CANCELLED.to_string()));
        if cfg!(windows) {
            assert_eq!(sys::wait_for_hotkey(1, first).unwrap_err(), CANCELLED, "a stale listener stops before it registers");
        }
        drop(busy);
        let third = supersede(); // the dialog closed before the second one's thread started
        assert_eq!(Busy::take(second).err().as_deref(), Some(CANCELLED), "a cancelled request never starts");
        assert!(!BUSY.load(Ordering::SeqCst), "and holds nothing");
        let busy = Busy::take(third).unwrap();
        capture_game_cancel();
        assert!(fresh(third).is_err(), "a cancel reaches a request that already holds the capture");
        drop(busy);
        assert!(!BUSY.load(Ordering::SeqCst));
    }

    #[test]
    fn body_has_the_size_header() {
        let b = pack(958, 1354, &[1, 2, 3, 4]);
        assert_eq!(&b[..8], &[0xBE, 0x03, 0, 0, 0x4A, 0x05, 0, 0]);
        assert_eq!(&b[8..], &[1, 2, 3, 4]);
    }
}
