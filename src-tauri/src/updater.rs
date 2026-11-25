use crate::config::get;
use crate::window::updater_window;
use log::{info, warn};

pub fn check_update(app_handle: tauri::AppHandle) {
    let enable = get("check_update")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if enable {
        tauri::async_runtime::spawn(async move {
            match tauri::updater::builder(app_handle).check().await {
                Ok(update) => {
                    if update.is_update_available() {
                        info!("New version available");
                        updater_window();
                    }
                }
                Err(e) => {
                    warn!("Failed to check update: {}", e);
                }
            }
        });
    }
}
