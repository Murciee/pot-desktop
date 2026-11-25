#[cfg(target_os = "macos")]
use std::fs;

use crate::config::get;
use crate::StringWrapper;
use crate::APP;
#[cfg(target_os = "macos")]
use dirs::cache_dir;
use log::{error, info, warn};
use tauri::Manager;
use tauri::Monitor;
use tauri::Window;
use tauri::WindowBuilder;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use window_shadows::set_shadow;

// Get daemon window instance
fn get_daemon_window() -> Window {
    let app_handle = APP.get().unwrap();
    match app_handle.get_window("daemon") {
        Some(v) => v,
        None => {
            warn!("Daemon window not found, create new daemon window!");
            WindowBuilder::new(
                app_handle,
                "daemon",
                tauri::WindowUrl::App("daemon.html".into()),
            )
            .title("Daemon")
            .additional_browser_args("--disable-web-security")
            .visible(false)
            .build()
            .unwrap()
        }
    }
}

// Get monitor where the mouse is currently located
fn get_current_monitor(x: i32, y: i32) -> Monitor {
    info!("Mouse position: {}, {}", x, y);
    let daemon_window = get_daemon_window();
    let monitors = daemon_window.available_monitors().unwrap();

    for m in monitors {
        let size = m.size();
        let position = m.position();

        if x >= position.x
            && x <= (position.x + size.width as i32)
            && y >= position.y
            && y <= (position.y + size.height as i32)
        {
            info!("Current Monitor: {:?}", m);
            return m;
        }
    }
    warn!("Current Monitor not found, using primary monitor");
    daemon_window.primary_monitor().unwrap().unwrap()
}

// Creating a window on the mouse monitor
fn build_window(label: &str, title: &str) -> (Window, bool) {
    use mouse_position::mouse_position::{Mouse, Position};

    let mouse_position = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Position { x, y },
        Mouse::Error => {
            warn!("Mouse position not found, using (0, 0) as default");
            Position { x: 0, y: 0 }
        }
    };
    let current_monitor = get_current_monitor(mouse_position.x, mouse_position.y);
    let position = current_monitor.position();

    let app_handle = APP.get().unwrap();
    match app_handle.get_window(label) {
        Some(v) => {
            info!("Window existence: {}", label);
            v.set_focus().unwrap();
            (v, true)
        }
        None => {
            info!("Window not existence, Creating new window: {}", label);
            let mut builder = tauri::WindowBuilder::new(
                app_handle,
                label,
                tauri::WindowUrl::App("index.html".into()),
            )
            .position(position.x.into(), position.y.into())
            .additional_browser_args("--disable-web-security")
            .focused(true)
            .title(title)
            .visible(false);

            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.transparent(true).decorations(false);
            }
            let window = builder.build().unwrap();

            #[cfg(target_os = "windows")]
            let use_shadow = label != "config";
            #[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
            let use_shadow = true;
            #[cfg(not(target_os = "linux"))]
            if label != "screenshot" && use_shadow {
                set_shadow(&window, true).unwrap_or_default();
            }
            let _ = window.current_monitor();
            (window, false)
        }
    }
}

fn save_config_window_geometry(window: &Window) {
    let factor = window.scale_factor().unwrap_or(1.0);
    let mut entries: Vec<(&str, serde_json::Value)> = Vec::with_capacity(4);
    if let Ok(size) = window.outer_size() {
        let size = size.to_logical::<f64>(factor);
        entries.push(("config_window_width_v2", serde_json::json!(size.width.round() as i64)));
        entries.push(("config_window_height_v2", serde_json::json!(size.height.round() as i64)));
    }
    if let Ok(position) = window.outer_position() {
        let position = position.to_logical::<f64>(factor);
        entries.push(("config_window_x", serde_json::json!(position.x.round() as i64)));
        entries.push(("config_window_y", serde_json::json!(position.y.round() as i64)));
    }
    crate::config::set_many(&entries);
}

/// Save the settings window geometry right before the title bar closes it.
#[tauri::command]
pub fn save_config_window_geometry_now() {
    if let Some(app) = APP.get() {
        if let Some(window) = app.get_window("config") {
            save_config_window_geometry(&window);
        }
    }
}

pub fn config_window() {
    let (window, exists) = build_window("config", "Config");
    info!("Config window built, exists: {}", exists);
    window
        .set_min_size(Some(tauri::LogicalSize::new(760, 400)))
        .unwrap();

    if !exists {
        let width = get("config_window_width_v2")
            .and_then(|v| v.as_i64())
            .unwrap_or(760)
            .max(760) as f64;
        let height = get("config_window_height_v2")
            .and_then(|v| v.as_i64())
            .unwrap_or(560) as f64;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .unwrap();
        info!("Config window size set: {}x{}", width, height);

        match (
            get("config_window_x").and_then(|v| v.as_i64()),
            get("config_window_y").and_then(|v| v.as_i64()),
        ) {
            (Some(x), Some(y)) => {
                let _ = window.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
            }
            _ => {
                let _ = window.center();
            }
        }

        let window_for_save = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                save_config_window_geometry(&window_for_save);
            }
        });
        info!("Config window geometry listener attached");
        let _ = window.show();
    }
}

fn translate_window() -> Window {
    use mouse_position::mouse_position::{Mouse, Position};
    // Mouse physical position
    let mouse_position = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Position { x, y },
        Mouse::Error => {
            warn!("Mouse position not found, using (0, 0) as default");
            Position { x: 0, y: 0 }
        }
    };
    let (window, exists) = build_window("translate", "Translate");
    if exists {
        return window;
    }
    window.set_skip_taskbar(true).unwrap();
    // Get Translate Window Size
    let width = get("translate_window_width")
        .and_then(|v| v.as_i64())
        .unwrap_or(350);
    let height = get("translate_window_height")
        .and_then(|v| v.as_i64())
        .unwrap_or(420);

    let monitor = window.current_monitor().unwrap().unwrap();
    let dpi = monitor.scale_factor();

    window
        .set_size(tauri::PhysicalSize::new(
            (width as f64) * dpi,
            (height as f64) * dpi,
        ))
        .unwrap();

    let position_type = match get("translate_window_position") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => "mouse".to_string(),
    };

    let (mut pos_x, mut pos_y) = match position_type.as_str() {
        "mouse" => {
            // Adjust window position
            let monitor_size = monitor.size();
            let monitor_position = monitor.position();
            let window_width = (width as f64 * dpi) as i32;
            let window_height = (height as f64 * dpi) as i32;
            let mut x = mouse_position.x;
            let mut y = mouse_position.y;

            if x + window_width > monitor_position.x + monitor_size.width as i32 {
                x -= window_width;
                if x < monitor_position.x {
                    x = monitor_position.x;
                }
            }
            if y + window_height > monitor_position.y + monitor_size.height as i32 {
                y -= window_height;
                if y < monitor_position.y {
                    y = monitor_position.y;
                }
            }
            (x, y)
        }
        _ => {
            let position_x = match get("translate_window_position_x") {
                Some(v) => v.as_i64().unwrap(),
                None => 0,
            };
            let position_y = match get("translate_window_position_y") {
                Some(v) => v.as_i64().unwrap(),
                None => 0,
            };
            (
                (position_x as f64 * dpi) as i32,
                (position_y as f64 * dpi) as i32,
            )
        }
    };

    // Keep the window fully inside the monitor it targets. Saved positions can
    // point outside the current screen, for example after switching monitors,
    // changing the resolution or reconnecting over RDP.
    let target_monitor = window
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let p = m.position();
                let s = m.size();
                pos_x >= p.x && pos_x < p.x + s.width as i32 && pos_y >= p.y && pos_y < p.y + s.height as i32
            })
        })
        .unwrap_or_else(|| monitor.clone());
    let monitor_position = target_monitor.position();
    let monitor_size = target_monitor.size();
    let window_width = (width as f64 * dpi) as i32;
    let window_height = (height as f64 * dpi) as i32;
    let max_x = monitor_position.x + monitor_size.width as i32 - window_width;
    let max_y = monitor_position.y + monitor_size.height as i32 - window_height;
    pos_x = pos_x.clamp(monitor_position.x, max_x.max(monitor_position.x));
    pos_y = pos_y.clamp(monitor_position.y, max_y.max(monitor_position.y));

    window
        .set_position(tauri::PhysicalPosition::new(pos_x, pos_y))
        .unwrap();

    window
}

pub fn selection_translate() {
    use selection::get_text;
    // Get Selected Text
    let text = get_text();
    if text.trim().is_empty() {
        info!("No selected text, skip translate window");
        return;
    }
    let app_handle = APP.get().unwrap();
    // Write into State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state.0.lock().unwrap().replace_range(.., &text);

    let window = translate_window();
    let _ = window.emit("new_text", text);
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn input_translate() {
    let app_handle = APP.get().unwrap();
    // Clear State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state
        .0
        .lock()
        .unwrap()
        .replace_range(.., "[INPUT_TRANSLATE]");
    let window = translate_window();
    let position_type = match get("translate_window_position") {
        Some(v) => v.as_str().unwrap().to_string(),
        None => "mouse".to_string(),
    };
    if position_type == "mouse" {
        window.center().unwrap();
    }

    let _ = window.emit("new_text", "[INPUT_TRANSLATE]");
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn last_translate_window() {
    let app_handle = APP.get().unwrap();
    if let Some(window) = app_handle.get_window("translate") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let state: tauri::State<StringWrapper> = app_handle.state();
    state
        .0
        .lock()
        .unwrap()
        .replace_range(.., "[LAST_TRANSLATE]");

    let window = translate_window();
    let _ = window.emit("new_text", "[LAST_TRANSLATE]");
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn text_translate(text: String) {
    if text.trim().is_empty() {
        info!("Empty text, skip translate window");
        return;
    }
    let app_handle = APP.get().unwrap();
    // Clear State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state.0.lock().unwrap().replace_range(.., &text);
    let window = translate_window();
    let _ = window.emit("new_text", text);
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn image_translate() {
    let app_handle = APP.get().unwrap();
    let state: tauri::State<StringWrapper> = app_handle.state();
    state
        .0
        .lock()
        .unwrap()
        .replace_range(.., "[IMAGE_TRANSLATE]");
    let window = translate_window();
    let _ = window.emit("new_text", "[IMAGE_TRANSLATE]");
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn recognize_window() {
    let (window, exists) = build_window("recognize", "Recognize");
    if exists {
        window.emit("new_image", "").unwrap();
        return;
    }
    let width = get("recognize_window_width")
        .and_then(|v| v.as_i64())
        .unwrap_or(800);
    let height = get("recognize_window_height")
        .and_then(|v| v.as_i64())
        .unwrap_or(400);
    let monitor = window.current_monitor().unwrap().unwrap();
    let dpi = monitor.scale_factor();
    window
        .set_size(tauri::PhysicalSize::new(
            (width as f64) * dpi,
            (height as f64) * dpi,
        ))
        .unwrap();
    window.center().unwrap();
    window.emit("new_image", "").unwrap();
}

#[cfg(not(target_os = "macos"))]
fn screenshot_window() -> Window {
    use mouse_position::mouse_position::{Mouse, Position};

    let (window, exists) = build_window("screenshot", "Screenshot");
    if exists {
        let mouse_position = match Mouse::get_mouse_position() {
            Mouse::Position { x, y } => Position { x, y },
            Mouse::Error => Position { x: 0, y: 0 },
        };
        let monitor = get_current_monitor(mouse_position.x, mouse_position.y);
        let _ = window.set_fullscreen(false);
        let _ = window.set_position(*monitor.position());
    }

    window.set_skip_taskbar(true).unwrap();
    #[cfg(target_os = "macos")]
    {
        let monitor = window.current_monitor().unwrap().unwrap();
        let size = monitor.size();
        window.set_decorations(false).unwrap();
        window.set_size(*size).unwrap();
    }

    #[cfg(not(target_os = "macos"))]
    window.set_fullscreen(true).unwrap();

    window.set_always_on_top(true).unwrap();
    window
}

pub fn ocr_recognize() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            recognize_window();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            recognize_window();
            window_.unlisten(event.id())
        });
    }
}
pub fn ocr_translate() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            image_translate();
            ();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            image_translate();
            window_.unlisten(event.id())
        });
    }
}

#[tauri::command(async)]
pub fn updater_window() {
    let (window, _exists) = build_window("updater", "Updater");
    window
        .set_min_size(Some(tauri::LogicalSize::new(600, 400)))
        .unwrap();
    window.set_size(tauri::LogicalSize::new(600, 400)).unwrap();
    window.center().unwrap();
}


#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayToolbarLayout {
    pub placement: String,
    pub offset_top: f64,
    pub offset_left: f64,
    pub content_width: f64,
    pub content_height: f64,
    pub window_width: u32,
    pub window_height: u32,
    pub dpr: f64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
    pub dpr: f64,
    pub screen_x: i32,
    pub screen_y: i32,
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub padding_left: u32,
    pub padding_top: u32,
    pub ocr_lang: String,
    pub service: String,
    pub model: String,
    pub target_lang: String,
    pub ocr_service: String,
    pub overlay_hotkey: String,
    pub overlay_refresh_hotkey: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayRectPayload {
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    dpr: f64,
    screen_x: i32,
    screen_y: i32,
    padding_left: u32,
    padding_top: u32,
}

static OVERLAY_STATE: once_cell::sync::Lazy<std::sync::Mutex<Option<OverlayState>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

static OVERLAY_TOOLBAR: once_cell::sync::Lazy<std::sync::Mutex<Option<OverlayToolbarLayout>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

/// Keep the overlay on screen when the user clicks outside it.
static OVERLAY_PINNED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Temporarily ignore outside clicks while the overlay is hidden for a refresh.
static OVERLAY_BUSY: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

static OVERLAY_USER_RESIZED_W: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static OVERLAY_USER_RESIZED_H: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
static OVERLAY_IN_SIZEMOVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
static OVERLAY_SIZEMOVE_START_W: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);

#[cfg(target_os = "windows")]
static OVERLAY_SIZEMOVE_START_H: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);

#[cfg(target_os = "windows")]
static OVERLAY_CLICK_HWND: std::sync::atomic::AtomicIsize =
    std::sync::atomic::AtomicIsize::new(0);

#[cfg(target_os = "windows")]
static OVERLAY_CLOSE_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
static OVERLAY_SESSION_ID: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[cfg(target_os = "windows")]
static OVERLAY_HOOK_THREAD_ID: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);

#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_BUTTONS_DOWN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(target_os = "windows")]
const WM_APP_CLOSE_OVERLAY: u32 = 0x8000 + 1;

#[cfg(target_os = "windows")]
fn point_outside_overlay(overlay_hwnd: isize, point: &windows::Win32::Foundation::POINT) -> bool {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    if overlay_hwnd == 0 {
        return false;
    }
    let mut bounds = RECT::default();
    unsafe {
        GetWindowRect(
            HWND(overlay_hwnd as *mut core::ffi::c_void),
            &mut bounds,
        )
        .is_ok()
            && (point.x < bounds.left
                || point.x >= bounds.right
                || point.y < bounds.top
                || point.y >= bounds.bottom)
    }
}

#[cfg(target_os = "windows")]
fn sample_overlay_mouse_buttons() -> (bool, bool) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };

    let mut buttons_are_down = false;
    let mut button_was_pressed = false;
    unsafe {
        for button in [VK_LBUTTON, VK_MBUTTON, VK_RBUTTON] {
            let state = GetAsyncKeyState(button.0 as i32);
            buttons_are_down |= state < 0;
            button_was_pressed |= state & 1 != 0;
        }
    }
    (buttons_are_down, button_was_pressed)
}

#[cfg(target_os = "windows")]
fn stop_overlay_click_watcher() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};

    OVERLAY_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let tid = OVERLAY_HOOK_THREAD_ID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn overlay_mouse_hook(
    code: i32,
    w_param: windows::Win32::Foundation::WPARAM,
    l_param: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, PostThreadMessageW, HHOOK, MSLLHOOKSTRUCT, WM_LBUTTONDOWN, WM_MBUTTONDOWN,
        WM_RBUTTONDOWN,
    };

    if code >= 0
        && l_param.0 != 0
        && matches!(
            w_param.0 as u32,
            WM_LBUTTONDOWN | WM_MBUTTONDOWN | WM_RBUTTONDOWN
        )
    {
        let overlay_hwnd = OVERLAY_CLICK_HWND.load(std::sync::atomic::Ordering::SeqCst);
        let mouse = &*(l_param.0 as *const MSLLHOOKSTRUCT);
        if point_outside_overlay(overlay_hwnd, &mouse.pt)
            && !OVERLAY_PINNED.load(std::sync::atomic::Ordering::SeqCst)
            && !OVERLAY_BUSY.load(std::sync::atomic::Ordering::SeqCst)
        {
            OVERLAY_CLOSE_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
            let tid = OVERLAY_HOOK_THREAD_ID.load(std::sync::atomic::Ordering::SeqCst);
            if tid != 0 {
                let _ = PostThreadMessageW(tid, WM_APP_CLOSE_OVERLAY, WPARAM(0), LPARAM(0));
            }
        }
    }

    CallNextHookEx(HHOOK::default(), code, w_param, l_param)
}

#[cfg(target_os = "windows")]
fn spawn_overlay_click_watcher(window: &Window) {
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, POINT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetCursorPos, GetMessageW, PeekMessageW, PostThreadMessageW,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, MSG, PM_NOREMOVE, WH_MOUSE_LL,
        WM_QUIT,
    };

    let app_handle = APP.get().unwrap().clone();
    let overlay_hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    if overlay_hwnd == 0 {
        return;
    }

    stop_overlay_click_watcher();
    let session_id = OVERLAY_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

    OVERLAY_CLICK_HWND.store(overlay_hwnd, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_CLOSE_REQUESTED.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_PINNED.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_USER_RESIZED_W.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_USER_RESIZED_H.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_IN_SIZEMOVE.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_SIZEMOVE_START_W.store(0, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_SIZEMOVE_START_H.store(0, std::sync::atomic::Ordering::SeqCst);
    *OVERLAY_TOOLBAR.lock().unwrap() = None;

    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            if OVERLAY_SESSION_ID.load(std::sync::atomic::Ordering::SeqCst) == session_id {
                let tid = OVERLAY_HOOK_THREAD_ID.swap(0, std::sync::atomic::Ordering::SeqCst);
                if tid != 0 {
                    unsafe {
                        let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
                    }
                }
            }
        }
    });

    std::thread::spawn(move || {
        let tid = unsafe { GetCurrentThreadId() };
        if OVERLAY_SESSION_ID.load(std::sync::atomic::Ordering::SeqCst) != session_id {
            return;
        }
        OVERLAY_HOOK_THREAD_ID.store(tid, std::sync::atomic::Ordering::SeqCst);

        let mut init_msg = MSG::default();
        unsafe {
            let _ = PeekMessageW(&mut init_msg, HWND::default(), 0, 0, PM_NOREMOVE);
        }

        let hook = unsafe {
            SetWindowsHookExW(WH_MOUSE_LL, Some(overlay_mouse_hook), HINSTANCE::default(), 0)
        };
        if let Err(error) = &hook {
            log::error!("[overlay] failed to install mouse hook: {}", error);
        }
        let hook = hook.ok();
        if hook.is_some() {
            let mut message = MSG::default();
            loop {
                if OVERLAY_SESSION_ID.load(std::sync::atomic::Ordering::SeqCst) != session_id {
                    break;
                }
                let ret = unsafe { GetMessageW(&mut message, HWND::default(), 0, 0) };
                if !ret.as_bool() || ret.0 == -1 {
                    break;
                }
                if OVERLAY_SESSION_ID.load(std::sync::atomic::Ordering::SeqCst) != session_id {
                    break;
                }
                if message.message == WM_APP_CLOSE_OVERLAY
                    || OVERLAY_CLOSE_REQUESTED.swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    if let Some(window) = app_handle.get_window("overlay") {
                        let _ = window.close();
                    }
                    break;
                }
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        } else {
            {
                let _guard = OVERLAY_MOUSE_STATE_LOCK.lock().unwrap();
                let (buttons_are_down, _) = sample_overlay_mouse_buttons();
                OVERLAY_MOUSE_BUTTONS_DOWN
                    .store(buttons_are_down, std::sync::atomic::Ordering::SeqCst);
            }
            loop {
                if OVERLAY_SESSION_ID.load(std::sync::atomic::Ordering::SeqCst) != session_id
                    || app_handle.get_window("overlay").is_none()
                {
                    break;
                }

                let (buttons_are_down, button_was_pressed, buttons_were_down) = {
                    let _guard = OVERLAY_MOUSE_STATE_LOCK.lock().unwrap();
                    let (buttons_are_down, button_was_pressed) = sample_overlay_mouse_buttons();
                    let buttons_were_down = OVERLAY_MOUSE_BUTTONS_DOWN.swap(
                        buttons_are_down,
                        std::sync::atomic::Ordering::SeqCst,
                    );
                    (buttons_are_down, button_was_pressed, buttons_were_down)
                };

                if !OVERLAY_PINNED.load(std::sync::atomic::Ordering::SeqCst)
                    && !OVERLAY_BUSY.load(std::sync::atomic::Ordering::SeqCst)
                    && (button_was_pressed || (buttons_are_down && !buttons_were_down))
                {
                    let mut cursor = POINT::default();
                    if unsafe { GetCursorPos(&mut cursor).is_ok() }
                        && point_outside_overlay(overlay_hwnd, &cursor)
                    {
                        if let Some(window) = app_handle.get_window("overlay") {
                            let _ = window.close();
                        }
                        break;
                    }
                }

                std::thread::sleep(std::time::Duration::from_millis(4));
            }
        }

        if let Some(hook) = hook {
            unsafe {
                let _ = UnhookWindowsHookEx(hook);
            }
        }
        if OVERLAY_SESSION_ID.load(std::sync::atomic::Ordering::SeqCst) == session_id {
            let _ = OVERLAY_HOOK_THREAD_ID.compare_exchange(
                tid,
                0,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            );
            OVERLAY_CLICK_HWND.store(0, std::sync::atomic::Ordering::SeqCst);
            OVERLAY_CLOSE_REQUESTED.store(false, std::sync::atomic::Ordering::SeqCst);
            OVERLAY_PINNED.store(false, std::sync::atomic::Ordering::SeqCst);
            OVERLAY_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
            *OVERLAY_TOOLBAR.lock().unwrap() = None;
        }
    });
}
static OVERLAY_LISTENER_ID: once_cell::sync::Lazy<
    std::sync::Mutex<Option<tauri::EventHandler>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

#[cfg(target_os = "windows")]
static OVERLAY_OPENING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
struct OverlayOpeningGuard;

#[cfg(target_os = "windows")]
impl Drop for OverlayOpeningGuard {
    fn drop(&mut self) {
        OVERLAY_OPENING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(target_os = "windows")]
fn open_overlay_screenshot() {
    let _guard = OverlayOpeningGuard;
    let app_handle = match APP.get() {
        Some(app) => app,
        None => return,
    };

    if let Some(handler) = OVERLAY_LISTENER_ID.lock().unwrap().take() {
        if let Some(window) = app_handle.get_window("screenshot") {
            window.unlisten(handler);
        }
    }

    let window = screenshot_window();
    let window_for_listener = window.clone();
    let app_handle_for_listener = app_handle.clone();
    let id = window.listen("overlay_rect", move |event| {
        if let Ok(rect) = serde_json::from_str::<OverlayRectPayload>(event.payload().unwrap_or_default()) {
            let monitor = window_for_listener.current_monitor().ok().flatten();
            let monitor_position = monitor
                .as_ref()
                .map(|m| *m.position())
                .unwrap_or(tauri::PhysicalPosition::new(rect.screen_x - rect.left as i32, rect.screen_y - rect.top as i32));

            let state = OverlayState {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                dpr: rect.dpr,
                screen_x: rect.screen_x,
                screen_y: rect.screen_y,
                monitor_x: monitor_position.x,
                monitor_y: monitor_position.y,
                padding_left: rect.padding_left,
                padding_top: rect.padding_top,
                ocr_lang: overlay_ocr_lang(),
                service: overlay_service_instance(),
                model: overlay_model(),
                target_lang: overlay_target_language(),
                ocr_service: overlay_ocr_service(),
                overlay_hotkey: overlay_hotkey_setting("hotkey_overlay_translate"),
                overlay_refresh_hotkey: overlay_hotkey_setting("hotkey_overlay_refresh"),
            };
            info!("Overlay rect: {:?}", state);
            crate::cmd::copy_screenshot_cut_to_overlay(&app_handle_for_listener);
            *OVERLAY_STATE.lock().unwrap() = Some(state.clone());
            match create_overlay_window(&state) {
                Ok(_) => info!("Overlay window created"),
                Err(e) => error!("Failed to create overlay window: {}", e),
            }
        }
        let _ = window_for_listener.unlisten(event.id());
        *OVERLAY_LISTENER_ID.lock().unwrap() = None;
    });
    *OVERLAY_LISTENER_ID.lock().unwrap() = Some(id);
}

#[cfg(target_os = "windows")]
pub fn overlay_translate() {
    if OVERLAY_BUSY.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if OVERLAY_OPENING
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return;
    }

    // Close any live overlay and wait on a worker thread before queueing
    // screenshot creation on the main event loop, avoiding WebView2 COM
    // re-entrancy deadlocks when invoked from an overlay IPC handler.
    std::thread::spawn(|| {
        let Some(app_handle) = APP.get() else {
            OVERLAY_OPENING.store(false, std::sync::atomic::Ordering::SeqCst);
            return;
        };
        close_overlay_window(app_handle, true);
        if app_handle
            .run_on_main_thread(|| open_overlay_screenshot())
            .is_err()
        {
            OVERLAY_OPENING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn overlay_translate() {}

#[cfg(target_os = "windows")]
pub fn overlay_hotkey() {
    if OVERLAY_BUSY.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app_handle = APP.get().unwrap();
    match app_handle.get_window("overlay") {
        Some(window) => {
            let _ = window.show();
            let _ = window.emit("overlay_toggle_edit", ());
        }
        None => overlay_translate(),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn overlay_hotkey() {}

#[cfg(target_os = "windows")]
pub fn overlay_refresh_hotkey() {
    if OVERLAY_BUSY.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app_handle = APP.get().unwrap();
    if let Some(window) = app_handle.get_window("overlay") {
        let _ = window.emit("overlay_refresh", ());
    }
}

#[cfg(not(target_os = "windows"))]
pub fn overlay_refresh_hotkey() {}

#[tauri::command]
pub fn set_overlay_pinned(pinned: bool) {
    OVERLAY_PINNED.store(pinned, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn set_overlay_busy(busy: bool) {
    OVERLAY_BUSY.store(busy, std::sync::atomic::Ordering::SeqCst);
}

fn resolve_synced_content_rect(
    state_w: u32,
    state_h: u32,
    outer_pos_x: i32,
    outer_pos_y: i32,
    outer_w: u32,
    outer_h: u32,
    dpr: f64,
    layout: &OverlayToolbarLayout,
    user_resized_w: bool,
    user_resized_h: bool,
) -> (i32, i32, u32, u32) {
    let extra_top_px = if layout.placement == "top" {
        (32.0 * dpr).round() as i32
    } else {
        0
    };
    let extra_left_px = (layout.offset_left * dpr).round() as i32;
    let extra_h_px = if layout.placement == "top" || layout.placement == "bottom" {
        (32.0 * dpr).round() as u32
    } else {
        0
    };
    let cw = if user_resized_w {
        outer_w
            .saturating_sub(extra_left_px.max(0) as u32)
            .max(1)
    } else {
        state_w.max(1)
    };
    let ch = if user_resized_h {
        outer_h.saturating_sub(extra_h_px).max(1)
    } else {
        state_h.max(1)
    };
    (
        outer_pos_x + extra_left_px,
        outer_pos_y + extra_top_px,
        cw,
        ch,
    )
}

fn sync_state_from_window(
    window: &Window,
    state: &mut OverlayState,
    layout: &OverlayToolbarLayout,
    user_resized_w: bool,
    user_resized_h: bool,
) {
    let outer_pos = match window.outer_position() {
        Ok(p) => p,
        Err(_) => return,
    };
    let outer_size = match window.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    let dpr = window
        .scale_factor()
        .ok()
        .filter(|v| *v > 0.0)
        .unwrap_or(if state.dpr > 0.0 { state.dpr } else { 1.0 });

    let (content_x, content_y, content_w, content_h) = resolve_synced_content_rect(
        state.width,
        state.height,
        outer_pos.x,
        outer_pos.y,
        outer_size.width,
        outer_size.height,
        dpr,
        layout,
        user_resized_w,
        user_resized_h,
    );

    let center_x = content_x + (content_w as i32) / 2;
    let center_y = content_y + (content_h as i32) / 2;
    let monitor = window
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let p = m.position();
                let s = m.size();
                center_x >= p.x
                    && center_x < p.x + s.width as i32
                    && center_y >= p.y
                    && center_y < p.y + s.height as i32
            })
        })
        .or_else(|| window.current_monitor().ok().flatten());

    if let Some(m) = monitor {
        let mp = m.position();
        state.monitor_x = mp.x;
        state.monitor_y = mp.y;
    }

    state.dpr = dpr;
    state.screen_x = content_x;
    state.screen_y = content_y;
    state.width = content_w;
    state.height = content_h;
    state.left = (content_x - state.monitor_x).max(0) as u32;
    state.top = (content_y - state.monitor_y).max(0) as u32;
}

#[tauri::command]
pub fn sync_overlay_geometry(window: Window) -> Result<OverlayState, String> {
    let toolbar = OVERLAY_TOOLBAR.lock().unwrap().clone();
    let mut guard = OVERLAY_STATE.lock().unwrap();
    let state = guard
        .as_mut()
        .ok_or_else(|| "overlay state not found".to_string())?;
    if let Some(layout) = toolbar.as_ref() {
        let resized_w = OVERLAY_USER_RESIZED_W.load(std::sync::atomic::Ordering::SeqCst);
        let resized_h = OVERLAY_USER_RESIZED_H.load(std::sync::atomic::Ordering::SeqCst);
        sync_state_from_window(&window, state, layout, resized_w, resized_h);
    }
    Ok(state.clone())
}

#[cfg(target_os = "windows")]
const OVERLAY_MIN_SIZE_SUBCLASS_ID: usize = 0x504F_5401;

#[cfg(target_os = "windows")]
unsafe extern "system" fn overlay_min_size_subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    umsg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    uidsubclass: usize,
    _dwrefdata: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::{LRESULT, RECT};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, MINMAXINFO, SWP_NOSIZE, WINDOWPOS, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE,
        WM_GETMINMAXINFO, WM_NCDESTROY, WM_WINDOWPOSCHANGING,
    };

    match umsg {
        WM_GETMINMAXINFO => {
            if lparam.0 != 0 {
                let mmi = &mut *(lparam.0 as *mut MINMAXINFO);
                mmi.ptMinTrackSize.x = 1;
                mmi.ptMinTrackSize.y = 1;
            }
            LRESULT(0)
        }
        WM_WINDOWPOSCHANGING => {
            // Bypass DefWindowProcW's SM_CXMIN/SM_CYMIN clamp on WS_CAPTION windows
            // so narrow or short overlay selections keep their exact pixel bounds.
            if lparam.0 != 0 {
                let wp = &mut *(lparam.0 as *mut WINDOWPOS);
                if (wp.flags.0 & SWP_NOSIZE.0) == 0 {
                    wp.cx = wp.cx.max(1);
                    wp.cy = wp.cy.max(1);
                }
            }
            LRESULT(0)
        }
        WM_ENTERSIZEMOVE => {
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                let w = (rect.right - rect.left).max(0) as u32;
                let h = (rect.bottom - rect.top).max(0) as u32;
                OVERLAY_SIZEMOVE_START_W.store(w, std::sync::atomic::Ordering::SeqCst);
                OVERLAY_SIZEMOVE_START_H.store(h, std::sync::atomic::Ordering::SeqCst);
            }
            OVERLAY_IN_SIZEMOVE.store(true, std::sync::atomic::Ordering::SeqCst);
            DefSubclassProc(hwnd, umsg, wparam, lparam)
        }
        WM_EXITSIZEMOVE => {
            OVERLAY_IN_SIZEMOVE.store(false, std::sync::atomic::Ordering::SeqCst);
            DefSubclassProc(hwnd, umsg, wparam, lparam)
        }
        WM_NCDESTROY => {
            OVERLAY_IN_SIZEMOVE.store(false, std::sync::atomic::Ordering::SeqCst);
            let _ = RemoveWindowSubclass(hwnd, Some(overlay_min_size_subclass_proc), uidsubclass);
            DefSubclassProc(hwnd, umsg, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, umsg, wparam, lparam),
    }
}

#[cfg(target_os = "windows")]
fn install_overlay_min_size_subclass(window: &Window) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Shell::SetWindowSubclass;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let hwnd_isize = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    if hwnd_isize == 0 {
        return;
    }

    let win_tid = unsafe {
        GetWindowThreadProcessId(HWND(hwnd_isize as *mut core::ffi::c_void), None)
    };
    let cur_tid = unsafe { GetCurrentThreadId() };
    if win_tid == cur_tid {
        unsafe {
            let _ = SetWindowSubclass(
                HWND(hwnd_isize as *mut core::ffi::c_void),
                Some(overlay_min_size_subclass_proc),
                OVERLAY_MIN_SIZE_SUBCLASS_ID,
                0,
            );
        }
    } else if let Some(app_handle) = APP.get() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
        if app_handle
            .run_on_main_thread(move || {
                unsafe {
                    let _ = SetWindowSubclass(
                        HWND(hwnd_isize as *mut core::ffi::c_void),
                        Some(overlay_min_size_subclass_proc),
                        OVERLAY_MIN_SIZE_SUBCLASS_ID,
                        0,
                    );
                }
                let _ = tx.send(());
            })
            .is_ok()
        {
            let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
        }
    }
}

#[cfg(target_os = "windows")]
fn apply_overlay_window_rect_on_thread(
    hwnd: windows::Win32::Foundation::HWND,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_EXSTYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOSENDCHANGING, SWP_NOZORDER, WS_EX_CLIENTEDGE, WS_EX_STATICEDGE,
        WS_EX_WINDOWEDGE,
    };

    let edge_mask = (WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE).0 as i32;

    unsafe {
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        let mut flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING;
        if (ex_style & edge_mask) != 0 {
            SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style & !edge_mask);
            flags |= SWP_FRAMECHANGED;
        }
        SetWindowPos(
            hwnd,
            HWND::default(),
            x,
            y,
            width.max(1) as i32,
            height.max(1) as i32,
            flags,
        )
        .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
fn set_overlay_window_rect(
    window: &Window,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let raw_hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let hwnd_isize = raw_hwnd.0 as isize;
    let hwnd = HWND(hwnd_isize as *mut core::ffi::c_void);
    let win_tid = unsafe { GetWindowThreadProcessId(hwnd, None) };
    let cur_tid = unsafe { GetCurrentThreadId() };
    if win_tid == cur_tid {
        return apply_overlay_window_rect_on_thread(hwnd, x, y, width, height);
    }

    if let Some(app_handle) = APP.get() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        app_handle
            .run_on_main_thread(move || {
                let res = apply_overlay_window_rect_on_thread(
                    HWND(hwnd_isize as *mut core::ffi::c_void),
                    x,
                    y,
                    width,
                    height,
                );
                let _ = tx.send(res);
            })
            .map_err(|e| e.to_string())?;
        return match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(res) => res,
            Err(_) => Err("Timed out waiting for main thread window rect update".to_string()),
        };
    }

    apply_overlay_window_rect_on_thread(hwnd, x, y, width, height)
}

#[cfg(not(target_os = "windows"))]
fn set_overlay_window_rect(
    window: &Window,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(width.max(1), height.max(1)))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_overlay_toolbar(
    window: Window,
    visible: bool,
) -> Result<OverlayToolbarLayout, String> {
    let mut toolbar = OVERLAY_TOOLBAR.lock().unwrap();
    let mut state_guard = OVERLAY_STATE.lock().unwrap();

    if !visible {
        if let Some(prev_layout) = toolbar.take() {
            let resized_w =
                OVERLAY_USER_RESIZED_W.swap(false, std::sync::atomic::Ordering::SeqCst);
            let resized_h =
                OVERLAY_USER_RESIZED_H.swap(false, std::sync::atomic::Ordering::SeqCst);
            if let Some(state) = state_guard.as_mut() {
                sync_state_from_window(&window, state, &prev_layout, resized_w, resized_h);
                let _ = set_overlay_window_rect(
                    &window,
                    state.screen_x,
                    state.screen_y,
                    state.width,
                    state.height,
                );
            }
        } else {
            OVERLAY_USER_RESIZED_W.store(false, std::sync::atomic::Ordering::SeqCst);
            OVERLAY_USER_RESIZED_H.store(false, std::sync::atomic::Ordering::SeqCst);
            if let Some(state) = state_guard.as_mut() {
                let _ = set_overlay_window_rect(
                    &window,
                    state.screen_x,
                    state.screen_y,
                    state.width,
                    state.height,
                );
            }
        }

        let (cw, ch, ww, wh, dpr) = state_guard
            .as_ref()
            .map(|s| {
                let d = if s.dpr > 0.0 { s.dpr } else { 1.0 };
                (s.width as f64 / d, s.height as f64 / d, s.width, s.height, d)
            })
            .unwrap_or((0.0, 0.0, 0, 0, 1.0));
        return Ok(OverlayToolbarLayout {
            placement: "none".to_string(),
            offset_top: 0.0,
            offset_left: 0.0,
            content_width: cw,
            content_height: ch,
            window_width: ww,
            window_height: wh,
            dpr,
        });
    }

    if let Some(layout) = toolbar.as_ref() {
        return Ok(layout.clone());
    }

    OVERLAY_USER_RESIZED_W.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_USER_RESIZED_H.store(false, std::sync::atomic::Ordering::SeqCst);

    let state = state_guard
        .as_mut()
        .ok_or_else(|| "overlay state not found".to_string())?;
    let dpr = window
        .scale_factor()
        .ok()
        .filter(|v| *v > 0.0)
        .unwrap_or(if state.dpr > 0.0 { state.dpr } else { 1.0 });
    state.dpr = dpr;

    let content_width = state.width as f64 / dpr;
    let content_height = state.height as f64 / dpr;
    let extra = (32.0 * dpr).round() as i32;
    let min_toolbar_px = (320.0 * dpr).round() as u32;

    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "overlay monitor not found".to_string())?;
    let monitor_position = *monitor.position();
    let monitor_size = monitor.size();

    let win_width = state.width.max(min_toolbar_px).min(monitor_size.width);
    let monitor_right = monitor_position.x + monitor_size.width as i32;
    let win_x = if state.screen_x + win_width as i32 > monitor_right {
        (monitor_right - win_width as i32).max(monitor_position.x)
    } else {
        state.screen_x.max(monitor_position.x)
    };
    let offset_left = (state.screen_x - win_x).max(0) as f64 / dpr;

    let above = state.screen_y - extra >= monitor_position.y;
    let below = state.screen_y + state.height as i32 + extra
        <= monitor_position.y + monitor_size.height as i32;

    let (layout, x, y, width, height) = if above {
        let win_h = state.height + extra as u32;
        (
            OverlayToolbarLayout {
                placement: "top".to_string(),
                offset_top: 32.0,
                offset_left,
                content_width,
                content_height,
                window_width: win_width,
                window_height: win_h,
                dpr,
            },
            win_x,
            state.screen_y - extra,
            win_width,
            win_h,
        )
    } else if below {
        let win_h = state.height + extra as u32;
        (
            OverlayToolbarLayout {
                placement: "bottom".to_string(),
                offset_top: 0.0,
                offset_left,
                content_width,
                content_height,
                window_width: win_width,
                window_height: win_h,
                dpr,
            },
            win_x,
            state.screen_y,
            win_width,
            win_h,
        )
    } else {
        (
            OverlayToolbarLayout {
                placement: "inside".to_string(),
                offset_top: 32.0,
                offset_left,
                content_width,
                content_height: (content_height - 32.0).max(1.0),
                window_width: win_width,
                window_height: state.height,
                dpr,
            },
            win_x,
            state.screen_y,
            win_width,
            state.height,
        )
    };

    set_overlay_window_rect(&window, x, y, width, height)?;
    *toolbar = Some(layout.clone());
    Ok(layout)
}

#[tauri::command]
pub fn refresh_overlay_state() -> Result<OverlayState, String> {
    let mut guard = OVERLAY_STATE.lock().unwrap();
    let state = guard
        .as_mut()
        .ok_or_else(|| "overlay state not found".to_string())?;
    state.service = overlay_service_instance();
    state.model = overlay_model();
    state.target_lang = overlay_target_language();
    state.ocr_service = overlay_ocr_service();
    state.ocr_lang = overlay_ocr_lang();
    state.overlay_hotkey = overlay_hotkey_setting("hotkey_overlay_translate");
    state.overlay_refresh_hotkey = overlay_hotkey_setting("hotkey_overlay_refresh");
    Ok(state.clone())
}

#[tauri::command(async)]
pub fn open_config_window() {
    std::thread::spawn(|| {
        if let Some(app_handle) = APP.get() {
            let _ = app_handle.run_on_main_thread(|| config_window());
        }
    });
}

#[tauri::command(async)]
pub fn restart_overlay_translate() {
    overlay_translate();
}

#[cfg(target_os = "windows")]
fn close_overlay_window(app_handle: &tauri::AppHandle, wait_until_gone: bool) {
    stop_overlay_click_watcher();
    if let Some(window) = app_handle.get_window("overlay") {
        let _ = window.close();
        if wait_until_gone {
            for _ in 0..20 {
                if app_handle.get_window("overlay").is_none() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
    OVERLAY_PINNED.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_USER_RESIZED_W.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_USER_RESIZED_H.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_IN_SIZEMOVE.store(false, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_SIZEMOVE_START_W.store(0, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_SIZEMOVE_START_H.store(0, std::sync::atomic::Ordering::SeqCst);
    *OVERLAY_TOOLBAR.lock().unwrap() = None;
}

#[cfg(target_os = "windows")]
fn create_overlay_window(state: &OverlayState) -> Result<Window, String> {
    let app_handle = APP.get().unwrap();
    close_overlay_window(app_handle, true);

    let dpr = if state.dpr > 0.0 { state.dpr } else { 1.0 };
    let logical_w = (state.width as f64 / dpr).max(1.0);
    let logical_h = (state.height as f64 / dpr).max(1.0);

    let window = tauri::WindowBuilder::new(
        app_handle,
        "overlay",
        tauri::WindowUrl::App("index.html".into()),
    )
    .title("Overlay")
    .additional_browser_args("--disable-web-security")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .resizable(true)
    .min_inner_size(1.0, 1.0)
    .inner_size(logical_w, logical_h)
    .build()
    .map_err(|e| e.to_string())?;

    install_overlay_min_size_subclass(&window);

    let window_for_resize = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Resized(size) = event {
            if OVERLAY_IN_SIZEMOVE.load(std::sync::atomic::Ordering::SeqCst) {
                let start_w = OVERLAY_SIZEMOVE_START_W.load(std::sync::atomic::Ordering::SeqCst);
                let start_h = OVERLAY_SIZEMOVE_START_H.load(std::sync::atomic::Ordering::SeqCst);
                let prev_w = OVERLAY_USER_RESIZED_W.load(std::sync::atomic::Ordering::SeqCst);
                let prev_h = OVERLAY_USER_RESIZED_H.load(std::sync::atomic::Ordering::SeqCst);
                let next_w = prev_w || (start_w > 0 && size.width != start_w);
                let next_h = prev_h || (start_h > 0 && size.height != start_h);
                if next_w != prev_w || next_h != prev_h {
                    OVERLAY_USER_RESIZED_W.store(next_w, std::sync::atomic::Ordering::SeqCst);
                    OVERLAY_USER_RESIZED_H.store(next_h, std::sync::atomic::Ordering::SeqCst);
                    let _ = window_for_resize.emit(
                        "overlay_user_resized",
                        serde_json::json!({ "width": next_w, "height": next_h }),
                    );
                }
            }
        }
    });

    window
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    set_overlay_window_rect(&window, state.screen_x, state.screen_y, state.width, state.height)?;

    #[cfg(target_os = "windows")]
    set_shadow(&window, false).unwrap_or_default();

    info!(
        "Overlay window geometry: requested ({}, {}) {}x{}, actual position {:?}, size {:?}",
        state.screen_x,
        state.screen_y,
        state.width,
        state.height,
        window.outer_position().ok(),
        window.outer_size().ok()
    );

    spawn_overlay_click_watcher(&window);

    Ok(window)
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn get_overlay_state() -> Result<OverlayState, String> {
    OVERLAY_STATE
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "overlay state not found".to_string())
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
pub fn get_overlay_state() -> Result<OverlayState, String> {
    Err("only windows".to_string())
}

fn overlay_hotkey_setting(key: &str) -> String {
    get(key)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn overlay_ocr_lang() -> String {
    get("recognize_language")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "auto".to_string())
}

fn overlay_service_instance() -> String {
    if let Some(service) = get("overlay_service_instance").and_then(|v| v.as_str().map(|s| s.to_string())) {
        if !service.is_empty() {
            return service;
        }
    }
    get("translate_service_list")
        .and_then(|v| v.as_array().and_then(|list| list.first().cloned()))
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn overlay_model() -> String {
    get("overlay_model")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn overlay_ocr_service() -> String {
    if let Some(service) = get("overlay_ocr_service").and_then(|v| v.as_str().map(|s| s.to_string())) {
        if !service.is_empty() {
            return service;
        }
    }
    get("recognize_service_list")
        .and_then(|v| v.as_array().and_then(|list| list.first().cloned()))
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "system".to_string())
}

fn overlay_target_language() -> String {
    get("overlay_target_language")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .filter(|lang| !lang.is_empty())
        .or_else(|| {
            get("translate_target_language").and_then(|v| v.as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| "zh_cn".to_string())
}

#[cfg(test)]
mod geometry_tests {
    use super::{resolve_synced_content_rect, OverlayToolbarLayout};

    #[test]
    fn resolve_synced_content_rect_preserves_narrow_bounds_unless_user_resized() {
        let layout = OverlayToolbarLayout {
            placement: "top".to_string(),
            offset_top: 32.0,
            offset_left: 0.0,
            content_width: 131.0,
            content_height: 210.0,
            window_width: 320,
            window_height: 242,
            dpr: 1.0,
        };

        // Dragged without user resize, even if outer_w/outer_h differ from window_width/height
        let rect = resolve_synced_content_rect(131, 210, 500, 300, 325, 245, 1.0, &layout, false, false);
        assert_eq!(rect, (500, 332, 131, 210));

        // Vertical-only user resize updates height while keeping narrow selection width
        let rect_v = resolve_synced_content_rect(131, 210, 500, 300, 320, 340, 1.0, &layout, false, true);
        assert_eq!(rect_v, (500, 332, 131, 308));

        // Horizontal + vertical user resize updates both axes (accounting for offset_left)
        let shifted_layout = OverlayToolbarLayout {
            offset_left: 20.0,
            ..layout.clone()
        };
        let rect_both = resolve_synced_content_rect(131, 210, 500, 300, 400, 340, 1.0, &shifted_layout, true, true);
        assert_eq!(rect_both, (520, 332, 380, 308));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{overlay_min_size_subclass_proc, OVERLAY_MIN_SIZE_SUBCLASS_ID};

    unsafe extern "system" fn test_wnd_proc(
        hwnd: windows::Win32::Foundation::HWND,
        msg: u32,
        wparam: windows::Win32::Foundation::WPARAM,
        lparam: windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        use windows::Win32::Foundation::{LRESULT, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_NCCALCSIZE};

        if msg == WM_NCCALCSIZE && wparam != WPARAM(0) {
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    #[test]
    fn overlay_subclass_allows_sub_cxmin_window_sizes() {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, POINT, RECT, WPARAM};
        use windows::Win32::UI::Shell::SetWindowSubclass;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetWindowLongW, GetWindowRect, RegisterClassExW,
            SendMessageW, SetWindowLongW, SetWindowPos, ShowWindow, GWL_EXSTYLE, MINMAXINFO,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOW,
            SW_SHOWNOACTIVATE, WNDCLASSEXW, WM_GETMINMAXINFO, WS_CAPTION, WS_CLIPCHILDREN,
            WS_CLIPSIBLINGS, WS_EX_ACCEPTFILES, WS_EX_TOPMOST, WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX,
            WS_MINIMIZEBOX, WS_SIZEBOX, WS_SYSMENU,
        };

        let class_name: Vec<u16> = "PotOverlayMinSizeTestCls\0".encode_utf16().collect();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(test_wnd_proc),
            hInstance: HINSTANCE::default(),
            lpszClassName: PCWSTR::from_raw(class_name.as_ptr()),
            ..Default::default()
        };

        unsafe {
            let _ = RegisterClassExW(&wc);
            let style = WS_CLIPSIBLINGS
                | WS_CLIPCHILDREN
                | WS_SYSMENU
                | WS_CAPTION
                | WS_SIZEBOX
                | WS_MAXIMIZEBOX
                | WS_MINIMIZEBOX;
            let ex_style = WS_EX_ACCEPTFILES | WS_EX_WINDOWEDGE | WS_EX_TOPMOST;
            let title: Vec<u16> = "Test\0".encode_utf16().collect();
            let hwnd = CreateWindowExW(
                ex_style,
                PCWSTR::from_raw(class_name.as_ptr()),
                PCWSTR::from_raw(title.as_ptr()),
                style,
                100,
                100,
                200,
                200,
                HWND::default(),
                None,
                HINSTANCE::default(),
                None,
            )
            .expect("CreateWindowExW failed");
            assert!(!hwnd.0.is_null(), "CreateWindowExW returned null HWND");

            assert!(SetWindowSubclass(
                hwnd,
                Some(overlay_min_size_subclass_proc),
                OVERLAY_MIN_SIZE_SUBCLASS_ID,
                0,
            )
            .as_bool());

            let mut mmi = MINMAXINFO {
                ptMinTrackSize: POINT { x: 136, y: 39 },
                ..Default::default()
            };
            SendMessageW(
                hwnd,
                WM_GETMINMAXINFO,
                WPARAM(0),
                LPARAM(&mut mmi as *mut MINMAXINFO as isize),
            );
            assert_eq!((mmi.ptMinTrackSize.x, mmi.ptMinTrackSize.y), (1, 1));

            SetWindowPos(hwnd, HWND::default(), 100, 100, 42, 18, SWP_NOZORDER | SWP_NOACTIVATE)
                .expect("SetWindowPos(42x18) failed");

            // Simulate tao's apply_diff re-showing and toggling WS_EX_WINDOWEDGE + SWP_FRAMECHANGED.
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = ShowWindow(hwnd, SW_SHOW);
            let cur_ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
            SetWindowLongW(hwnd, GWL_EXSTYLE, cur_ex | WS_EX_WINDOWEDGE.0 as i32);
            SetWindowPos(
                hwnd,
                HWND::default(),
                0,
                0,
                0,
                0,
                SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE,
            )
            .expect("SetWindowPos(SWP_FRAMECHANGED) failed");

            let mut rect = RECT::default();
            GetWindowRect(hwnd, &mut rect).expect("GetWindowRect failed");
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;

            let _ = DestroyWindow(hwnd);
            assert_eq!((width, height), (42, 18));
        }
    }
}
