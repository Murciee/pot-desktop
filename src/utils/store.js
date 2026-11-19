import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { watch } from 'tauri-plugin-fs-watch-api';
import { invoke } from '@tauri-apps/api';

export let store = new Store();

// Snapshot of the on-disk values, read once before the first render so that
// useConfig can seed its state synchronously. Without it every page first
// paints without its controls and then grows when the async reads resolve.
let configCache = new Map();

export function getCachedConfig(key) {
    return configCache.has(key) ? configCache.get(key) : null;
}

export async function initStore() {
    const appConfigDirPath = await appConfigDir();
    const appConfigPath = await join(appConfigDirPath, 'config.json');
    store = new Store(appConfigPath);
    // Load before any window renders: useConfig writes defaults for missing
    // keys, and doing that before the on-disk state is loaded would overwrite
    // the user's saved settings with the preset values.
    try {
        await store.load();
    } catch {
        // A missing config file is fine; defaults will be created on first write.
    }
    try {
        configCache = new Map(await store.entries());
    } catch {
        // Keep an empty cache if the store cannot be read.
    }
    const _ = await watch(appConfigPath, async () => {
        await store.load();
        try {
            configCache = new Map(await store.entries());
        } catch {
            // Ignore and keep the previous snapshot.
        }
        await invoke('reload_store');
    });
}
