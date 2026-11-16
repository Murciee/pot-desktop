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

            if label != "screenshot" {
                #[cfg(not(target_os = "linux"))]
                set_shadow(&window, true).unwrap_or_default();
            }
            let _ = window.current_monitor();
            (window, false)
        }
    }
}

pub fn config_window() {
    let (window, _exists) = build_window("config", "Config");
    window
        .set_min_size(Some(tauri::LogicalSize::new(800, 400)))
        .unwrap();
    window.set_size(tauri::LogicalSize::new(800, 600)).unwrap();

    window.center().unwrap();
}

fn translate_window() -> Window {
    use mouse_position::mouse_position::{Mouse, Position};
    // Mouse physical position
    let mut mouse_position = match Mouse::get_mouse_position() {
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

    match position_type.as_str() {
        "mouse" => {
            // Adjust window position
            let monitor_size = monitor.size();
            let monitor_size_width = monitor_size.width as f64;
            let monitor_size_height = monitor_size.height as f64;
            let monitor_position = monitor.position();
            let monitor_position_x = monitor_position.x as f64;
            let monitor_position_y = monitor_position.y as f64;

            if mouse_position.x as f64 + width as f64 * dpi
                > monitor_position_x + monitor_size_width
            {
                mouse_position.x -= (width as f64 * dpi) as i32;
                if (mouse_position.x as f64) < monitor_position_x {
                    mouse_position.x = monitor_position_x as i32;
                }
            }
            if mouse_position.y as f64 + height as f64 * dpi
                > monitor_position_y + monitor_size_height
            {
                mouse_position.y -= (height as f64 * dpi) as i32;
                if (mouse_position.y as f64) < monitor_position_y {
                    mouse_position.y = monitor_position_y as i32;
                }
            }

            window
                .set_position(tauri::PhysicalPosition::new(
                    mouse_position.x,
                    mouse_position.y,
                ))
                .unwrap();
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
            window
                .set_position(tauri::PhysicalPosition::new(
                    (position_x as f64) * dpi,
                    (position_y as f64) * dpi,
                ))
                .unwrap();
        }
    }

    window
}

pub fn selection_translate() {
    use selection::get_text;
    // Get Selected Text
    let text = get_text();
    if !text.trim().is_empty() {
        let app_handle = APP.get().unwrap();
        // Write into State
        let state: tauri::State<StringWrapper> = app_handle.state();
        state.0.lock().unwrap().replace_range(.., &text);
    }

    let window = translate_window();
    window.emit("new_text", text).unwrap();
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

    window.emit("new_text", "[INPUT_TRANSLATE]").unwrap();
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
}

pub fn text_translate(text: String) {
    let app_handle = APP.get().unwrap();
    // Clear State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state.0.lock().unwrap().replace_range(.., &text);
    let window = translate_window();
    window.emit("new_text", text).unwrap();
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
    window.emit("new_text", "[IMAGE_TRANSLATE]").unwrap();
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
    pub target_lang: String,
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
                target_lang: overlay_target_language(),
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
