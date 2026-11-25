use crate::{error::Error, APP};
use dirs::config_dir;
use log::{info, warn};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::{with_store, Store, StoreCollection};

static CONFIG_IO_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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

pub fn app_config_dir(app_handle: &AppHandle) -> PathBuf {
    app_handle
        .path_resolver()
        .app_config_dir()
        .unwrap_or_else(|| {
            config_dir()
                .unwrap()
                .join(app_handle.config().tauri.bundle.identifier.clone())
        })
}

pub fn config_path(app_handle: &AppHandle) -> PathBuf {
    app_config_dir(app_handle).join("config.json")
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_file_name("config.json.bak")
}

fn corrupt_path(path: &Path) -> PathBuf {
    path.with_file_name("config.json.corrupt")
}

fn read_json_map(path: &Path) -> Result<HashMap<String, Value>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("Config file is empty".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn read_json_map_with_retry(path: &Path) -> Result<HashMap<String, Value>, String> {
    let mut last_err = String::new();
    for attempt in 0..5 {
        match std::fs::read(path) {
            Ok(bytes) => {
                if bytes.is_empty() {
                    last_err = "Config file is empty".to_string();
                } else {
                    match serde_json::from_slice::<HashMap<String, Value>>(&bytes) {
                        Ok(map) => return Ok(map),
                        Err(e) => last_err = e.to_string(),
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(e.to_string());
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
        if attempt < 4 {
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    Err(last_err)
}

fn atomic_write_bytes(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config.json");
    let tmp = dest.with_file_name(format!("{}.tmp.{}.{}", file_name, std::process::id(), seq));
    {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    for attempt in 0..5 {
        match std::fs::rename(&tmp, dest) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if attempt == 4 {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(e.to_string());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
    Ok(())
}

fn write_json_map_atomic(path: &Path, map: &HashMap<String, Value>) -> Result<(), String> {
    let _guard = CONFIG_IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if map.is_empty() && path.exists() {
        if let Ok(existing) = read_json_map(path) {
            if !existing.is_empty() {
                warn!(
                    "Refusing to overwrite non-empty config {:?} ({} keys) with empty map",
                    path,
                    existing.len()
                );
                return Err("Refusing to overwrite non-empty config with empty map".to_string());
            }
        }
    }
    if path.exists() {
        if let Ok(existing_bytes) = std::fs::read(path) {
            if serde_json::from_slice::<HashMap<String, Value>>(&existing_bytes)
                .map(|m| !m.is_empty())
                .unwrap_or(false)
            {
                let _ = atomic_write_bytes(&backup_path(path), &existing_bytes);
            }
        }
    }
    let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    atomic_write_bytes(path, &bytes)
}

fn ensure_config_file_healthy(path: &Path) -> Option<HashMap<String, Value>> {
    let _guard = CONFIG_IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(map) = read_json_map_with_retry(path) {
        if !map.is_empty() && !backup_path(path).exists() {
            if let Ok(bytes) = serde_json::to_vec(&map) {
                let _ = atomic_write_bytes(&backup_path(path), &bytes);
            }
        }
        return Some(map);
    }
    let bak = backup_path(path);
    if let Ok(bak_map) = read_json_map_with_retry(&bak) {
        if !bak_map.is_empty() {
            if path.exists() {
                let _ = std::fs::copy(path, corrupt_path(path));
            }
            if let Ok(bytes) = serde_json::to_vec(&bak_map) {
                if let Err(e) = atomic_write_bytes(path, &bytes) {
                    warn!("Failed to restore config from {:?}: {}", bak, e);
                } else {
                    warn!("Recovered config from {:?}", bak);
                }
            }
            return Some(bak_map);
        }
    }
    None
}

#[tauri::command]
pub fn get_config_path(app_handle: AppHandle) -> String {
    config_path(&app_handle).to_string_lossy().into_owned()
}

#[tauri::command]
pub fn save_config_store() -> Result<(), String> {
    save_now()
}

pub fn save_now() -> Result<(), String> {
    let app = APP.get().ok_or_else(|| "App handle not initialized".to_string())?;
    let path = config_path(app);
    let snapshot: HashMap<String, Value> = with_config_store(|store| {
        Ok(store
            .entries()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect())
    })?;
    write_json_map_atomic(&path, &snapshot)
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
    let recovered = ensure_config_file_healthy(&path);
    let collection = app.state::<StoreCollection<Wry>>();
    match with_store(app.handle(), collection, &path, |store| {
        if store.is_empty() {
            if let Some(map) = recovered {
                if !map.is_empty() {
                    for (k, v) in map {
                        let _ = store.insert(k, v);
                    }
                }
            }
        }
        Ok(())
    }) {
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
    let app_handle = APP.get()?;
    let plugin_dir = app_config_dir(app_handle)
        .join("plugins")
        .join(plugin_type);

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
    if let Err(e) = with_config_store(|store| store.insert(key.to_string(), json!(value))) {
        warn!("Failed to update config key {}: {}", key, e);
        return;
    }
    if let Err(e) = save_now() {
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
        Ok(())
    }) {
        warn!("Failed to update config entries: {}", e);
        return;
    }
    if let Err(e) = save_now() {
        warn!("Failed to save config entries: {}", e);
    }
}

pub fn reload() {
    let app = match APP.get() {
        Some(app) => app,
        None => return,
    };
    let path = config_path(app);
    let map = match read_json_map_with_retry(&path) {
        Ok(m) => m,
        Err(e) => {
            warn!("Failed to reload config store: {}", e);
            return;
        }
    };
    if let Err(e) = with_config_store(|store| {
        store.clear()?;
        for (key, value) in &map {
            store.insert(key.clone(), value.clone())?;
        }
        Ok(())
    }) {
        warn!("Failed to reload config store into memory: {}", e);
        return;
    }
    if !map.is_empty() {
        if let Ok(bytes) = serde_json::to_vec(&map) {
            let _guard = CONFIG_IO_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let _ = atomic_write_bytes(&backup_path(&path), &bytes);
        }
    }
    let _ = app.emit_all("config://reloaded", ());
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

    fn temp_config_dir(name: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("pot_cfg_test_{}_{}_{}", name, std::process::id(), nanos));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_creates_backup_and_preserves_data() {
        let dir = temp_config_dir("backup");
        let cfg = dir.join("config.json");

        let mut first = HashMap::new();
        first.insert("app_language".to_string(), json!("zh_cn"));
        write_json_map_atomic(&cfg, &first).unwrap();
        assert!(!backup_path(&cfg).exists());

        let mut second = HashMap::new();
        second.insert("app_language".to_string(), json!("en"));
        second.insert("transparent".to_string(), json!(false));
        write_json_map_atomic(&cfg, &second).unwrap();

        let current = read_json_map(&cfg).unwrap();
        let bak = read_json_map(&backup_path(&cfg)).unwrap();
        assert_eq!(current.get("app_language"), Some(&json!("en")));
        assert_eq!(current.get("transparent"), Some(&json!(false)));
        assert_eq!(bak.get("app_language"), Some(&json!("zh_cn")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_refuses_empty_overwrite_of_non_empty_config() {
        let dir = temp_config_dir("empty_guard");
        let cfg = dir.join("config.json");

        let mut data = HashMap::new();
        data.insert("app_language".to_string(), json!("zh_cn"));
        write_json_map_atomic(&cfg, &data).unwrap();

        let empty = HashMap::new();
        let err = write_json_map_atomic(&cfg, &empty).unwrap_err();
        assert!(err.contains("empty"));

        let still_there = read_json_map(&cfg).unwrap();
        assert_eq!(still_there.get("app_language"), Some(&json!("zh_cn")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_config_file_healthy_recovers_from_backup_when_truncated_or_corrupt() {
        let dir = temp_config_dir("recover");
        let cfg = dir.join("config.json");

        let mut data = HashMap::new();
        data.insert("app_language".to_string(), json!("zh_cn"));
        write_json_map_atomic(&cfg, &data).unwrap();

        let mut updated = data.clone();
        updated.insert("check_update".to_string(), json!(false));
        write_json_map_atomic(&cfg, &updated).unwrap();

        // Simulate abrupt truncation / corruption of config.json.
        std::fs::write(&cfg, b"{broken").unwrap();

        let recovered = ensure_config_file_healthy(&cfg).unwrap();
        assert_eq!(recovered.get("app_language"), Some(&json!("zh_cn")));

        let repaired = read_json_map(&cfg).unwrap();
        assert_eq!(repaired.get("app_language"), Some(&json!("zh_cn")));
        assert!(corrupt_path(&cfg).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
