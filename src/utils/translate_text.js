import { BaseDirectory, readTextFile } from '@tauri-apps/api/fs';

import * as builtinServices from '../services/translate';
import { invoke_plugin } from './invoke_plugin';
import { getServiceName, whetherPluginService } from './service_instance';
import { store } from './store';

const MAX_CACHE_ENTRIES = 500;
let storeReady = null;
const cache = new Map();
const pluginInfoCache = new Map();

function ensureStore() {
    if (!storeReady) {
        storeReady = store.load();
    }
    return storeReady;
}

export async function reloadTranslateStore() {
    storeReady = store.load();
    return storeReady;
}

function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function getConfigFingerprint(config) {
    return hashString(stableStringify(config ?? {}));
}

function setBoundedCache(key, value) {
    if (cache.has(key)) {
        cache.delete(key);
    } else if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) {
            cache.delete(oldestKey);
        }
    }
    cache.set(key, value);
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

async function doTranslate(instanceKey, text, from, to, detectLang, config) {
    const serviceName = getServiceName(instanceKey);

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

async function resolveEffectiveConfig(instanceKey, model) {
    await ensureStore();
    let config = (await store.get(instanceKey)) ?? {};
    if (model && model.trim() !== '') {
        config = { ...config, model: model.trim() };
    }
    return config;
}

export async function seedTranslateCache(instanceKey, text, from, to, model, translated) {
    if (typeof translated !== 'string' || translated.trim() === '') {
        return;
    }
    const config = await resolveEffectiveConfig(instanceKey, model);
    const configHash = getConfigFingerprint(config);
    const key = `${instanceKey}\u0000${configHash}\u0000${from}\u0000${to}\u0000${text}`;
    setBoundedCache(key, Promise.resolve(translated));
}

function createAbortError() {
    const error = new Error('Translation request aborted');
    error.name = 'AbortError';
    return error;
}

/**
 * Translate one text block with a builtin or plugin translate service instance.
 * Results are cached in memory by instance + config fingerprint + languages + text.
 */
export async function translateWithService(
    instanceKey,
    text,
    from,
    to,
    detectLang = from,
    model = '',
    options = {}
) {
    const signal = options.signal;
    if (signal?.aborted) {
        throw createAbortError();
    }

    const config = await resolveEffectiveConfig(instanceKey, model);
    const configHash = getConfigFingerprint(config);
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
    const skipCache = Boolean(options.skipCache);
    const key = `${instanceKey}\u0000${configHash}\u0000${from}\u0000${to}\u0000${text}`;

    if (!skipCache && cache.has(key)) {
        return await cache.get(key);
    }

    let timeoutId;
    let abortHandler;
    const racers = [doTranslate(instanceKey, text, from, to, detectLang, config)];

    if (timeoutMs > 0) {
        racers.push(
            new Promise((_, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error(options.timeoutMessage || 'Translation request timed out')),
                    timeoutMs
                );
            })
        );
    }
    if (signal) {
        racers.push(
            new Promise((_, reject) => {
                abortHandler = () => reject(createAbortError());
                if (signal.aborted) {
                    abortHandler();
                } else {
                    signal.addEventListener('abort', abortHandler, { once: true });
                }
            })
        );
    }

    const promise = racers.length === 1 ? racers[0] : Promise.race(racers);
    if (!skipCache) {
        setBoundedCache(key, promise);
    }

    try {
        const result = await promise;
        if (!skipCache && cache.get(key) === promise) {
            if (typeof result === 'string' && result.trim() === '') {
                cache.delete(key);
            } else {
                cache.set(key, Promise.resolve(result));
            }
        }
        return result;
    } catch (e) {
        if (!skipCache && cache.get(key) === promise) {
            cache.delete(key);
        }
        throw e;
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        if (signal && abortHandler) {
            signal.removeEventListener('abort', abortHandler);
        }
    }
}

export function clearTranslateCache() {
    cache.clear();
}
