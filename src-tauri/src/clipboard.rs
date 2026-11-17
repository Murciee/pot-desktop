use crate::window::text_translate;
use std::sync::Mutex;
use tauri::{ClipboardManager, Manager};

/// 剪贴板监听允许处理的最大字符数。超过该长度的文本（整篇文档、代码库等）
/// 不再自动弹出翻译窗口，避免误触发和卡顿。
const MAX_CLIPBOARD_TEXT_LEN: usize = 5000;

pub struct ClipboardMonitorEnableWrapper(pub Mutex<String>);

pub fn start_clipboard_monitor(app_handle: tauri::AppHandle) {
    // 用独立线程轮询：之前把 std::thread::sleep 放在 async 运行时里，
    // 会长期占住一个 tokio 工作线程。
    std::thread::spawn(move || {
        let mut pre_text = String::new();
        loop {
            let enabled = {
                let state = app_handle.state::<ClipboardMonitorEnableWrapper>();
                let guard = state.0.try_lock();
                match guard {
                    Ok(v) => v.contains("true"),
                    // 锁被占用时视为保持监听，与旧行为一致
                    Err(_) => true,
                }
            };
            if !enabled {
                break;
            }

            if let Ok(Some(v)) = app_handle.clipboard_manager().read_text() {
                if v != pre_text {
                    pre_text = v.clone();
                    let trimmed = v.trim();
                    if !trimmed.is_empty() && trimmed.chars().count() <= MAX_CLIPBOARD_TEXT_LEN {
                        text_translate(v);
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}
