import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { listen } from '@tauri-apps/api/event';
import { watch } from 'tauri-plugin-fs-watch-api';
import { invoke } from '@tauri-apps/api';

export let store = new Store();

// Snapshot of the on-disk values, read once before the first render so that
// useConfig can seed its state synchronously. Without it every page first
// paints without its controls and then grows when the async reads resolve.
let configCache = new Map();
let resolvedConfigPath = '';
let saveChain = Promise.resolve();
let pendingWrites = 0;
const pendingSaves = new Map();
const pendingTimers = new Map();

export function getCachedConfig(key) {
    return configCache.has(key) ? configCache.get(key) : null;
}

function clearPendingTimer(key) {
    const timer = pendingTimers.get(key);
    if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(key);
    }
}

function enqueueSave(fn) {
    pendingWrites += 1;
    const run = async () => {
        try {
            return await fn();
        } catch (err) {
            console.error('[store] failed to persist config:', err);
        } finally {
            pendingWrites = Math.max(0, pendingWrites - 1);
        }
    };
    saveChain = saveChain.then(run, run);
    return saveChain;
}

export function setConfigValue(key, value) {
    clearPendingTimer(key);
    pendingSaves.delete(key);
    if (value === null || value === undefined) {
        configCache.delete(key);
    } else {
        configCache.set(key, value);
    }
    return enqueueSave(async () => {
        await store.set(key, value);
        await store.save();
    });
}

export function deleteConfigKey(key) {
    clearPendingTimer(key);
    pendingSaves.delete(key);
    configCache.delete(key);
    return enqueueSave(async () => {
        if (await store.has(key)) {
            await store.delete(key);
            await store.save();
        }
    });
}

export function scheduleConfigSave(key, value, delayMs = 150) {
    clearPendingTimer(key);
    if (value === null || value === undefined) {
        configCache.delete(key);
    } else {
        configCache.set(key, value);
    }
    pendingSaves.set(key, value);
    const timer = setTimeout(() => {
        pendingTimers.delete(key);
        void flushConfigSaves([key]);
    }, delayMs);
    pendingTimers.set(key, timer);
}

export function flushConfigSaves(keys) {
    const targetKeys = Array.isArray(keys) ? keys : Array.from(pendingSaves.keys());
    const batch = [];
    for (const key of targetKeys) {
        clearPendingTimer(key);
        if (pendingSaves.has(key)) {
            batch.push([key, pendingSaves.get(key)]);
            pendingSaves.delete(key);
        }
    }
    if (batch.length === 0) {
        return saveChain;
    }
    return enqueueSave(async () => {
        for (const [key, value] of batch) {
            await store.set(key, value);
        }
        await store.save();
    });
}

export async function initStore() {
    let appConfigPath = '';
    try {
        appConfigPath = await invoke('get_config_path');
    } catch {
        const appConfigDirPath = await appConfigDir();
        appConfigPath = await join(appConfigDirPath, 'config.json');
    }
    resolvedConfigPath = appConfigPath;
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
    await listen('store://change', (event) => {
        const payload = event?.payload;
        if (!payload || typeof payload.key !== 'string') {
            return;
        }
        if (payload.path && resolvedConfigPath && payload.path !== resolvedConfigPath) {
            return;
        }
        if (payload.value === null || payload.value === undefined) {
            configCache.delete(payload.key);
        } else {
            configCache.set(payload.key, payload.value);
        }
    });
    const _ = await watch(appConfigPath, async () => {
        if (pendingWrites > 0 || pendingSaves.size > 0) {
            return;
        }
        try {
            await store.load();
            configCache = new Map(await store.entries());
        } catch {
            // Ignore and keep the previous snapshot.
        }
    });
}
