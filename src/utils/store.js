import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { watch } from 'tauri-plugin-fs-watch-api';
import { invoke } from '@tauri-apps/api';

export let store = new Store();

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
    const _ = await watch(appConfigPath, async () => {
        await store.load();
        await invoke('reload_store');
    });
}
