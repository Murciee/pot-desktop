use log::{error, info};

#[cfg(target_os = "windows")]
struct DcGuard(windows::Win32::Graphics::Gdi::HDC);

#[cfg(target_os = "windows")]
impl Drop for DcGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = windows::Win32::Graphics::Gdi::DeleteDC(self.0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
struct BitmapGuard(windows::Win32::Graphics::Gdi::HBITMAP);

#[cfg(target_os = "windows")]
impl Drop for BitmapGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = windows::Win32::Graphics::Gdi::DeleteObject(self.0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
struct SelectGuard {
    hdc: windows::Win32::Graphics::Gdi::HDC,
    prev: windows::Win32::Graphics::Gdi::HGDIOBJ,
}

#[cfg(target_os = "windows")]
impl Drop for SelectGuard {
    fn drop(&mut self) {
        if !self.hdc.is_invalid() && !self.prev.is_invalid() {
            unsafe {
                let _ = windows::Win32::Graphics::Gdi::SelectObject(self.hdc, self.prev);
            }
        }
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_monitor_proc(
    h_monitor: windows::Win32::Graphics::Gdi::HMONITOR,
    _: windows::Win32::Graphics::Gdi::HDC,
    _: *mut windows::Win32::Foundation::RECT,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFO, MONITORINFOEXW};

    let list = &mut *(lparam.0 as *mut Vec<MONITORINFOEXW>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(h_monitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
        list.push(info);
    }
    windows::Win32::Foundation::BOOL(1)
}

/// Capture exact physical pixels of the Windows monitor matching `(monitor_x, monitor_y)`
/// (or containing `fallback_point`), bypassing logical-vs-physical DPI double-scaling.
#[cfg(target_os = "windows")]
pub fn capture_monitor_rgba(
    monitor_x: i32,
    monitor_y: i32,
    fallback_point: Option<(i32, i32)>,
) -> Result<(image::RgbaImage, i32, i32), String> {
    use std::mem;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDCW, EnumDisplayMonitors,
        GetDIBits, GetDeviceCaps, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DESKTOPHORZRES,
        DESKTOPVERTRES, DIB_RGB_COLORS, HDC, MONITORINFOEXW, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;

    let mut monitors: Vec<MONITORINFOEXW> = Vec::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(enum_monitor_proc),
            LPARAM(&mut monitors as *mut Vec<MONITORINFOEXW> as isize),
        )
    };
    if !ok.as_bool() || monitors.is_empty() {
        return Err("Failed to enumerate monitors".to_string());
    }

    let selected = monitors
        .iter()
        .find(|m| m.monitorInfo.rcMonitor.left == monitor_x && m.monitorInfo.rcMonitor.top == monitor_y)
        .or_else(|| {
            fallback_point.and_then(|(px, py)| {
                monitors.iter().find(|m| {
                    let r = m.monitorInfo.rcMonitor;
                    px >= r.left && px < r.right && py >= r.top && py < r.bottom
                })
            })
        })
        .or_else(|| {
            monitors
                .iter()
                .find(|m| (m.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0)
        })
        .or_else(|| monitors.first())
        .ok_or_else(|| format!("Monitor at ({monitor_x}, {monitor_y}) not found"))?;

    let rc = selected.monitorInfo.rcMonitor;
    let sz_device = selected.szDevice.as_ptr();
    let screen_dc = DcGuard(unsafe {
        CreateDCW(
            PCWSTR(sz_device),
            PCWSTR(sz_device),
            PCWSTR::null(),
            None,
        )
    });
    if screen_dc.0.is_invalid() {
        return Err("CreateDCW failed for monitor".to_string());
    }

    let dev_w = unsafe { GetDeviceCaps(screen_dc.0, DESKTOPHORZRES) };
    let dev_h = unsafe { GetDeviceCaps(screen_dc.0, DESKTOPVERTRES) };
    let width = if dev_w > 0 { dev_w } else { rc.right - rc.left };
    let height = if dev_h > 0 { dev_h } else { rc.bottom - rc.top };
    if width <= 0 || height <= 0 {
        return Err("Invalid monitor dimensions".to_string());
    }

    let mem_dc = DcGuard(unsafe { CreateCompatibleDC(screen_dc.0) });
    if mem_dc.0.is_invalid() {
        return Err("CreateCompatibleDC failed".to_string());
    }
    let bitmap = BitmapGuard(unsafe { CreateCompatibleBitmap(screen_dc.0, width, height) });
    if bitmap.0.is_invalid() {
        return Err("CreateCompatibleBitmap failed".to_string());
    }
    let _select = SelectGuard {
        hdc: mem_dc.0,
        prev: unsafe { SelectObject(mem_dc.0, bitmap.0) },
    };

    unsafe {
        BitBlt(mem_dc.0, 0, 0, width, height, screen_dc.0, 0, 0, SRCCOPY)
            .map_err(|e| format!("BitBlt failed: {e}"))?;
    }

    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        ..Default::default()
    };

    let row_bytes = (width as usize) * 4;
    let mut bgra = vec![0u8; row_bytes * (height as usize)];
    let scanlines = unsafe {
        GetDIBits(
            mem_dc.0,
            bitmap.0,
            0,
            height as u32,
            Some(bgra.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    if scanlines == 0 {
        return Err("GetDIBits failed".to_string());
    }

    let mut rgba = vec![0u8; bgra.len()];
    for y in 0..(height as usize) {
        let src_row = &bgra[(height as usize - 1 - y) * row_bytes..(height as usize - y) * row_bytes];
        let dst_row = &mut rgba[y * row_bytes..(y + 1) * row_bytes];
        for (src, dst) in src_row.chunks_exact(4).zip(dst_row.chunks_exact_mut(4)) {
            dst[0] = src[2];
            dst[1] = src[1];
            dst[2] = src[0];
            dst[3] = 255;
        }
    }

    let image = image::RgbaImage::from_raw(width as u32, height as u32, rgba)
        .ok_or_else(|| "Failed to construct captured image".to_string())?;
    Ok((image, rc.left, rc.top))
}

#[tauri::command]
pub fn screenshot(x: i32, y: i32, window: tauri::Window) -> Result<(), String> {
    use crate::APP;
    use dirs::cache_dir;
    use std::fs;
    info!("Screenshot screen with position: x={}, y={}", x, y);

    let handle = APP.get().unwrap();
    let mut app_cache_dir_path = cache_dir().ok_or_else(|| {
        error!("Get Cache Dir Failed");
        "Get Cache Dir Failed".to_string()
    })?;
    app_cache_dir_path.push(&handle.config().tauri.bundle.identifier);
    if !app_cache_dir_path.exists() {
        // 创建目录
        if let Err(e) = fs::create_dir_all(&app_cache_dir_path) {
            error!("Create Cache Dir Failed: {}", e);
            return Err(e.to_string());
        }
    }
    app_cache_dir_path.push("pot_screenshot.png");

    #[cfg(target_os = "windows")]
    {
        use image::codecs::png::{CompressionType, FilterType, PngEncoder};
        use image::ImageEncoder;
        use std::io::BufWriter;

        let (rgba, _, _) = capture_monitor_rgba(x, y, None).map_err(|e| {
            error!("Screen capture failed: {}", e);
            e
        })?;
        let file = fs::File::create(&app_cache_dir_path).map_err(|e| {
            error!("Create screenshot file failed: {}", e);
            e.to_string()
        })?;
        let writer = BufWriter::new(file);
        let encoder = PngEncoder::new_with_quality(writer, CompressionType::Fast, FilterType::Sub);
        encoder
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| {
                error!("Encode screenshot failed: {}", e);
                e.to_string()
            })?;

        if window.label() == "screenshot" {
            window.show().map_err(|e| {
                error!("Failed to show screenshot window: {}", e);
                e.to_string()
            })?;
            window.set_focus().map_err(|e| {
                error!("Failed to focus screenshot window: {}", e);
                e.to_string()
            })?;
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        use screenshots::{Compression, Screen};
        let screens = Screen::all().map_err(|e| {
            error!("Failed to enumerate screens: {}", e);
            e.to_string()
        })?;
        for screen in screens {
            let info = screen.display_info;
            info!("Screen: {:?}", info);
            if info.x == x && info.y == y {
                let image = match screen.capture() {
                    Ok(v) => v,
                    Err(e) => {
                        error!("Screen capture failed: {}", e);
                        return Err(e.to_string());
                    }
                };
                let buffer = match image.to_png(Compression::Fast) {
                    Ok(v) => v,
                    Err(e) => {
                        error!("Encode screenshot failed: {}", e);
                        return Err(e.to_string());
                    }
                };
                fs::write(app_cache_dir_path, buffer).map_err(|e| {
                    error!("Write screenshot failed: {}", e);
                    e.to_string()
                })?;
                if window.label() == "screenshot" {
                    window.show().map_err(|e| {
                        error!("Failed to show screenshot window: {}", e);
                        e.to_string()
                    })?;
                    window.set_focus().map_err(|e| {
                        error!("Failed to focus screenshot window: {}", e);
                        e.to_string()
                    })?;
                }
                return Ok(());
            }
        }
        Err(format!("Monitor at ({x}, {y}) not found"))
    }
}
