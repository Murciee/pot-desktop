import { BaseDirectory, readTextFile } from '@tauri-apps/api/fs';

import * as builtinServices from '../services/translate';
import { invoke_plugin } from './invoke_plugin';
import { getServiceName, whetherPluginService } from './service_instance';
import { store } from './store';

let storeReady = null;
const cache = new Map();
const pluginInfoCache = new Map();

function ensureStore() {
    if (!storeReady) {
        storeReady = store.load();
    }
    return storeReady;
}

// Dictionary services (Google, ECDict, ...) may return an object instead of
// a plain string. Flatten the useful text fields for the overlay.
function stringifyTranslation(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value && typeof value === 'object') {
        const parts = [];
        if (Array.isArray(value.sentence)) {
            for (const sentence of value.sentence) {
                if (sentence?.target) {
                    parts.push(sentence.target);
                }
            }
        }
        if (Array.isArray(value.explanations)) {
            for (const explanation of value.explanations) {
                if (Array.isArray(explanation?.explains)) {
                    parts.push(...explanation.explains.filter(Boolean));
                }
            }
        }
        if (Array.isArray(value.associations)) {
            parts.push(...value.associations.filter(Boolean));
        }
        if (parts.length > 0) {
            return parts.join('; ');
        }
    }
    return '';
}

async function getPluginInfo(serviceName) {
    if (!pluginInfoCache.has(serviceName)) {
        const infoStr = await readTextFile(`plugins/translate/${serviceName}/info.json`, {
            dir: BaseDirectory.AppConfig,
        });
        pluginInfoCache.set(serviceName, JSON.parse(infoStr));
    }
    return pluginInfoCache.get(serviceName);
}

async function doTranslate(instanceKey, text, from, to, detectLang) {
    await ensureStore();
    const serviceName = getServiceName(instanceKey);
    const config = (await store.get(instanceKey)) ?? {};

    if (whetherPluginService(instanceKey)) {
        const pluginInfo = await getPluginInfo(serviceName);
        const language = pluginInfo.language ?? {};
        const fromLang = language[from] ?? from;
        const toLang = language[to] ?? to;
        const [func, utils] = await invoke_plugin('translate', serviceName);
        const result = await func(text, fromLang, toLang, {
            config,
            detect: detectLang,
            setResult: () => {},
            utils,
        });
        return stringifyTranslation(result);
    }

    const service = builtinServices[serviceName];
    if (!service) {
        throw new Error(`Unknown translate service: ${serviceName}`);
    }
    const language = service.Language ?? {};
    const result = await service.translate(text, language[from] ?? from, language[to] ?? to, {
        config,
        detect: detectLang,
        setResult: () => {},
    });
    return stringifyTranslation(result);
}

/**
 * Translate one text block with a builtin or plugin translate service instance.
 * Results are cached in memory by instance + languages + text.
 */
export async function translateWithService(instanceKey, text, from, to, detectLang = from) {
    const key = `${instanceKey}\u0000${from}\u0000${to}\u0000${text}`;
    if (cache.has(key)) {
        return await cache.get(key);
    }

    const promise = doTranslate(instanceKey, text, from, to, detectLang);
    cache.set(key, promise);
    try {
        const result = await promise;
        cache.set(key, Promise.resolve(result));
        return result;
    } catch (e) {
        cache.delete(key);
        throw e;
    }
}

export function clearTranslateCache() {
    cache.clear();
}
