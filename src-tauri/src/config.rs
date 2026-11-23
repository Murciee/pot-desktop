use crate::{error::Error, APP};
use dirs::config_dir;
use log::{info, warn};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::{with_store, Store, StoreCollection};

const BUILTIN_RECOGNIZE_LIST: &[&str] = &[
    "baidu_ocr",
    "baidu_accurate_ocr",
    "baidu_img_ocr",
    "iflytek_ocr",
    "iflytek_intsig_ocr",
    "iflytek_latex_ocr",
    "openai_ocr",
    "qrcode",
    "simple_latex_ocr",
    "system",
    "tencent_ocr",
    "tencent_accurate_ocr",
    "tencent_img_ocr",
    "tesseract",
    "volcengine_ocr",
    "volcengine_multi_lang_ocr",
];

const BUILTIN_TRANSLATE_LIST: &[&str] = &[
    "alibaba",
    "baidu",
    "baidu_field",
    "bing",
    "bing_dict",
    "caiyun",
    "cambridge_dict",
    "chatglm",
    "deepl",
    "ecdict",
    "lingva",
    "geminipro",
    "niutrans",
    "ollama",
    "openai",
    "google",
    "tencent",
    "transmart",
    "volcengine",
    "yandex",
    "youdao",
];

const BUILTIN_TTS_LIST: &[&str] = &["lingva_tts"];
const BUILTIN_COLLECTION_LIST: &[&str] = &["anki", "eudic"];

pub fn config_path(app_handle: &AppHandle) -> PathBuf {
    app_handle
        .path_resolver()
        .app_config_dir()
        .unwrap_or_else(|| {
            config_dir()
                .unwrap()
                .join(app_handle.config().tauri.bundle.identifier.clone())
        })
        .join("config.json")
}

#[tauri::command]
pub fn get_config_path(app_handle: AppHandle) -> String {
    config_path(&app_handle).to_string_lossy().into_owned()
}

fn with_config_store<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&mut Store<Wry>) -> Result<T, tauri_plugin_store::Error>,
{
    let app = APP.get().ok_or_else(|| "App handle not initialized".to_string())?;
    let path = config_path(app);
    let collection = app.state::<StoreCollection<Wry>>();
    with_store(app.clone(), collection, path, f).map_err(|e| e.to_string())
}

pub fn init_config(app: &mut tauri::App) {
    let path = config_path(&app.handle());
    info!("Load config from: {:?}", path);
    let collection = app.state::<StoreCollection<Wry>>();
    match with_store(app.handle(), collection, &path, |_store| Ok(())) {
        Ok(_) => info!("Config loaded"),
        Err(e) => {
            warn!("Config load error: {:?}", e);
        }
    }
    let _ = check_service_available();
}

fn filter_available_services(list: Vec<String>, builtin: &[&str], plugin: &[String]) -> Vec<String> {
    list.into_iter()
        .filter(|service| {
            let name = service.split('@').next().unwrap_or("");
            if name.starts_with("plugin") {
                plugin.iter().any(|p| p == name)
            } else {
                builtin.contains(&name)
            }
        })
        .collect()
}

fn check_available(list: Vec<String>, builtin: &[&str], plugin: &[String], key: &str) {
    let origin_length = list.len();
    let new_list = filter_available_services(list, builtin, plugin);
    if new_list.len() != origin_length {
        set(key, new_list);
    }
}

pub fn check_service_available() -> Result<(), Error> {
    let plugin_recognize_list: Vec<String> = get_plugin_list("recognize").unwrap_or_default();
    let plugin_translate_list: Vec<String> = get_plugin_list("translate").unwrap_or_default();
    let plugin_tts_list: Vec<String> = get_plugin_list("tts").unwrap_or_default();
    let plugin_collection_list: Vec<String> = get_plugin_list("collection").unwrap_or_default();
    if let Some(recognize_service_list) = get("recognize_service_list") {
        let recognize_service_list: Vec<String> = serde_json::from_value(recognize_service_list)?;
        check_available(
            recognize_service_list,
            BUILTIN_RECOGNIZE_LIST,
            &plugin_recognize_list,
            "recognize_service_list",
        );
    }
    if let Some(translate_service_list) = get("translate_service_list") {
        let translate_service_list: Vec<String> = serde_json::from_value(translate_service_list)?;
        check_available(
            translate_service_list,
            BUILTIN_TRANSLATE_LIST,
            &plugin_translate_list,
            "translate_service_list",
        );
    }
    if let Some(tts_service_list) = get("tts_service_list") {
        let tts_service_list: Vec<String> = serde_json::from_value(tts_service_list)?;
        check_available(
            tts_service_list,
            BUILTIN_TTS_LIST,
            &plugin_tts_list,
            "tts_service_list",
        );
    }
    if let Some(collection_service_list) = get("collection_service_list") {
        let collection_service_list: Vec<String> = serde_json::from_value(collection_service_list)?;
        check_available(
            collection_service_list,
            BUILTIN_COLLECTION_LIST,
            &plugin_collection_list,
            "collection_service_list",
        );
    }
    Ok(())
}

pub fn get_plugin_list(plugin_type: &str) -> Option<Vec<String>> {
    let app_handle = APP.get().unwrap();
    let config_dir = dirs::config_dir()?;
    let config_dir = config_dir.join(app_handle.config().tauri.bundle.identifier.clone());
    let plugin_dir = config_dir.join("plugins");
    let plugin_dir = plugin_dir.join(plugin_type);

    // dirs in plugin_dir
    let mut plugin_list = vec![];
    if plugin_dir.exists() {
        let read_dir = std::fs::read_dir(plugin_dir).ok()?;
        for entry in read_dir {
            let entry = entry.ok()?;

            if entry.path().is_dir() {
                let name = entry.file_name().to_str()?.to_string();
                if name.starts_with("plugin") {
                    plugin_list.push(name);
                } else {
                    // Remove old plugin
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    Some(plugin_list)
}

pub fn get(key: &str) -> Option<Value> {
    match with_config_store(|store| Ok(store.get(key).cloned())) {
        Ok(value) => value,
        Err(e) => {
            warn!("Failed to read config key {}: {}", key, e);
            None
        }
    }
}

pub fn set<T: serde::ser::Serialize>(key: &str, value: T) {
    if let Err(e) = with_config_store(|store| {
        store.insert(key.to_string(), json!(value))?;
        store.save()
    }) {
        warn!("Failed to save config key {}: {}", key, e);
    }
}

pub fn set_many(entries: &[(&str, Value)]) {
    if entries.is_empty() {
        return;
    }
    if let Err(e) = with_config_store(|store| {
        for (key, value) in entries {
            store.insert((*key).to_string(), value.clone())?;
        }
        store.save()
    }) {
        warn!("Failed to save config entries: {}", e);
    }
}

pub fn reload() {
    if let Err(e) = with_config_store(|store| store.load()) {
        warn!("Failed to reload config store: {}", e);
    }
}

pub fn is_first_run() -> bool {
    match with_config_store(|store| Ok(store.is_empty())) {
        Ok(empty) => empty,
        Err(e) => {
            warn!("Failed to check if config store is empty: {}", e);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_recognize_list_includes_openai_ocr_and_system() {
        assert!(BUILTIN_RECOGNIZE_LIST.contains(&"openai_ocr"));
        assert!(BUILTIN_RECOGNIZE_LIST.contains(&"system"));
    }

    #[test]
    fn filter_available_services_preserves_openai_ocr_and_installed_plugins() {
        let services = vec![
            "openai_ocr@abc".to_string(),
            "system".to_string(),
            "plugin.com.pot-app.installed@1".to_string(),
            "plugin.com.pot-app.removed@2".to_string(),
            "unknown_service@3".to_string(),
        ];
        let plugins = vec!["plugin.com.pot-app.installed".to_string()];
        let filtered = filter_available_services(services, BUILTIN_RECOGNIZE_LIST, &plugins);
        assert_eq!(
            filtered,
            vec![
                "openai_ocr@abc".to_string(),
                "system".to_string(),
                "plugin.com.pot-app.installed@1".to_string(),
            ]
        );
    }
}
