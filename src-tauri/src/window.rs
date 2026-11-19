#[cfg(target_os = "macos")]
use std::fs;

use crate::config::get;
use crate::config::set;
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
    if let Ok(size) = window.outer_size() {
        let size = size.to_logical::<f64>(factor);
        set("config_window_width", size.width.round() as i64);
        set("config_window_height", size.height.round() as i64);
    }
    if let Ok(position) = window.outer_position() {
        let position = position.to_logical::<f64>(factor);
        set("config_window_x", position.x.round() as i64);
        set("config_window_y", position.y.round() as i64);
    }
}

pub fn config_window() {
    let (window, exists) = build_window("config", "Config");
    window
        .set_min_size(Some(tauri::LogicalSize::new(800, 400)))
        .unwrap();

    if !exists {
        let width = get("config_window_width")
            .and_then(|v| v.as_i64())
            .unwrap_or(800) as f64;
        let height = get("config_window_height")
            .and_then(|v| v.as_i64())
            .unwrap_or(600) as f64;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .unwrap();

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
        let _ = window.listen("tauri://close-requested", move |_| {
            save_config_window_geometry(&window_for_save);
        });
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
    let width = match get("translate_window_width") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("translate_window_width", 350);
            350
        }
    };
    let height = match get("translate_window_height") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("translate_window_height", 420);
            420
        }
    };

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
    let width = match get("recognize_window_width") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("recognize_window_width", 800);
            800
        }
    };
    let height = match get("recognize_window_height") {
        Some(v) => v.as_i64().unwrap(),
        None => {
            set("recognize_window_height", 400);
            400
        }
    };
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
    let (window, _exists) = build_window("screenshot", "Screenshot");

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

pub static OVERLAY_DIALOG_OPEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
static OVERLAY_CLICK_HWND: std::sync::atomic::AtomicIsize =
    std::sync::atomic::AtomicIsize::new(0);

#[cfg(target_os = "windows")]
static OVERLAY_CLOSE_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_BUTTONS_DOWN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "windows")]
static OVERLAY_MOUSE_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
pub fn finish_overlay_error_dialog() {
    let _guard = OVERLAY_MOUSE_STATE_LOCK.lock().unwrap();
    let (buttons_are_down, _) = sample_overlay_mouse_buttons();
    OVERLAY_MOUSE_BUTTONS_DOWN.store(buttons_are_down, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_DIALOG_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn overlay_mouse_hook(
    code: i32,
    w_param: windows::Win32::Foundation::WPARAM,
    l_param: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, HHOOK, MSLLHOOKSTRUCT, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_RBUTTONDOWN,
    };

    if code >= 0
        && l_param.0 != 0
        && !OVERLAY_DIALOG_OPEN.load(std::sync::atomic::Ordering::SeqCst)
        && matches!(
            w_param.0 as u32,
            WM_LBUTTONDOWN | WM_MBUTTONDOWN | WM_RBUTTONDOWN
        )
    {
        let overlay_hwnd = OVERLAY_CLICK_HWND.load(std::sync::atomic::Ordering::SeqCst);
        let mouse = &*(l_param.0 as *const MSLLHOOKSTRUCT);
        if point_outside_overlay(overlay_hwnd, &mouse.pt) {
            OVERLAY_CLOSE_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    CallNextHookEx(HHOOK::default(), code, w_param, l_param)
}

#[cfg(target_os = "windows")]
fn spawn_overlay_click_watcher(window: &Window) {
    use windows::Win32::Foundation::{HINSTANCE, HWND, POINT};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetCursorPos, PeekMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, MSG, PM_REMOVE, WH_MOUSE_LL,
    };

    let app_handle = APP.get().unwrap().clone();
    let overlay_hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    if overlay_hwnd == 0 {
        return;
    }
    OVERLAY_CLICK_HWND.store(overlay_hwnd, std::sync::atomic::Ordering::SeqCst);
    OVERLAY_CLOSE_REQUESTED.store(false, std::sync::atomic::Ordering::SeqCst);

    std::thread::spawn(move || {
        let hook = unsafe {
            SetWindowsHookExW(WH_MOUSE_LL, Some(overlay_mouse_hook), HINSTANCE::default(), 0)
        };
        if let Err(error) = &hook {
            log::error!("[overlay] failed to install mouse hook: {}", error);
        }
        let hook = hook.ok();
        if hook.is_none() {
            let _guard = OVERLAY_MOUSE_STATE_LOCK.lock().unwrap();
            let (buttons_are_down, _) = sample_overlay_mouse_buttons();
            OVERLAY_MOUSE_BUTTONS_DOWN
                .store(buttons_are_down, std::sync::atomic::Ordering::SeqCst);
        }

        loop {
            if app_handle.get_window("overlay").is_none() {
                break;
            }

            if hook.is_some() {
                let mut message = MSG::default();
                unsafe {
                    while PeekMessageW(&mut message, HWND::default(), 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                if OVERLAY_CLOSE_REQUESTED.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    if let Some(window) = app_handle.get_window("overlay") {
                        let _ = window.close();
                    }
                    break;
                }
            } else {
                let (buttons_are_down, button_was_pressed, buttons_were_down, dialog_open) = {
                    let _guard = OVERLAY_MOUSE_STATE_LOCK.lock().unwrap();
                    let (buttons_are_down, button_was_pressed) = sample_overlay_mouse_buttons();
                    let buttons_were_down = OVERLAY_MOUSE_BUTTONS_DOWN.swap(
                        buttons_are_down,
                        std::sync::atomic::Ordering::SeqCst,
                    );
                    let dialog_open =
                        OVERLAY_DIALOG_OPEN.load(std::sync::atomic::Ordering::SeqCst);
                    (
                        buttons_are_down,
                        button_was_pressed,
                        buttons_were_down,
                        dialog_open,
                    )
                };

                if !dialog_open
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
            }

            std::thread::sleep(std::time::Duration::from_millis(if hook.is_some() {
                10
            } else {
                2
            }));
        }

        if let Some(hook) = hook {
            unsafe {
                let _ = UnhookWindowsHookEx(hook);
            }
        }
        OVERLAY_CLICK_HWND.store(0, std::sync::atomic::Ordering::SeqCst);
        OVERLAY_CLOSE_REQUESTED.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}
static OVERLAY_LISTENER_ID: once_cell::sync::Lazy<
    std::sync::Mutex<Option<tauri::EventHandler>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

#[cfg(target_os = "windows")]
pub fn overlay_translate() {
    let app_handle = APP.get().unwrap();

    // Remove the listener left by the previous run.
    if let Some(handler) = OVERLAY_LISTENER_ID.lock().unwrap().take() {
        if let Some(window) = app_handle.get_window("screenshot") {
            window.unlisten(handler);
        }
    }

    // Never capture our own translations.
    close_overlay_window(app_handle);

    let window = screenshot_window();
    let window_for_listener = window.clone();
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
            };
            info!("Overlay rect: {:?}", state);
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

#[cfg(not(target_os = "windows"))]
pub fn overlay_translate() {}

#[cfg(target_os = "windows")]
pub fn overlay_hotkey() {
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
    let app_handle = APP.get().unwrap();
    if let Some(window) = app_handle.get_window("overlay") {
        let _ = window.emit("overlay_refresh", ());
    }
}

#[cfg(not(target_os = "windows"))]
pub fn overlay_refresh_hotkey() {}

#[cfg(target_os = "windows")]
fn close_overlay_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_window("overlay") {
        let _ = window.close();
        for _ in 0..20 {
            if app_handle.get_window("overlay").is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

#[cfg(target_os = "windows")]
fn create_overlay_window(state: &OverlayState) -> Result<Window, String> {
    let app_handle = APP.get().unwrap();
    close_overlay_window(app_handle);

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
    .build()
    .map_err(|e| e.to_string())?;

    window
        .set_position(tauri::PhysicalPosition::new(state.screen_x, state.screen_y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(state.width, state.height))
        .map_err(|e| e.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;

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
    if let Some(lang) = get("overlay_target_language").and_then(|v| v.as_str().map(|s| s.to_string())) {
        if !lang.is_empty() {
            return lang;
        }
    }
    get("translate_target_language")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "zh_cn".to_string())
}
