import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api';

export let store = new Store();

// Snapshot of the in-memory store values, read once before the first render so
// useConfig can seed its state synchronously without triggering layout shift.
let configCache = new Map();
let resolvedConfigPath = '';
let saveChain = Promise.resolve();
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
    const run = async () => {
        try {
            return await fn();
        } catch (err) {
            console.error('[store] failed to persist config:', err);
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
        await invoke('save_config_store');
    });
}

export function setConfigValues(entries) {
    const pairs = Object.entries(entries ?? {});
    if (pairs.length === 0) {
        return saveChain;
    }
    for (const [key, value] of pairs) {
        clearPendingTimer(key);
        pendingSaves.delete(key);
        if (value === null || value === undefined) {
            configCache.delete(key);
        } else {
            configCache.set(key, value);
        }
    }
    return enqueueSave(async () => {
        for (const [key, value] of pairs) {
            await store.set(key, value);
        }
        await invoke('save_config_store');
    });
}

export function deleteConfigKey(key) {
    clearPendingTimer(key);
    pendingSaves.delete(key);
    configCache.delete(key);
    return enqueueSave(async () => {
        if (await store.has(key)) {
            await store.delete(key);
            await invoke('save_config_store');
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
        await invoke('save_config_store');
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
    await listen('config://reloaded', async () => {
        try {
            configCache = new Map(await store.entries());
        } catch {
            // Keep existing cache on transient error.
        }
    });
    await listen('config://flush-request', () => {
        void flushConfigSaves();
    });
}
