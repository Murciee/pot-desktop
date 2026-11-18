import { BaseDirectory, readTextFile } from '@tauri-apps/api/fs';
import { invoke } from '@tauri-apps/api';

import * as builtinRecognizeServices from '../services/recognize';
import { recognizeWithBoxes } from '../services/recognize/system';
import {
    getServiceName,
    getServiceSouceType,
    ServiceSourceType,
} from './service_instance';
import { invoke_plugin } from './invoke_plugin';
import { store } from './store';

async function loadPluginLanguage(pluginName, language) {
    try {
        const info = JSON.parse(
            await readTextFile(`plugins/recognize/${pluginName}/info.json`, {
                dir: BaseDirectory.AppConfig,
            })
        );
        return info?.language?.[language] ?? info?.language?.auto;
    } catch {
        return undefined;
    }
}

/**
 * Run OCR for the overlay.
 *
 * Engines that expose text boxes keep the original layout; engines that only
 * return plain text produce one block covering the whole selection, so any
 * configured recognizer can be used.
 */
export async function recognizeOverlay(serviceInstanceKey, language) {
    const key = serviceInstanceKey || 'system';
    const serviceName = getServiceName(key);
    const sourceType = getServiceSouceType(key);

    if (sourceType !== ServiceSourceType.PLUGIN && serviceName === 'system') {
        return { boxes: await recognizeWithBoxes(language) };
    }

    const base64 = await invoke('get_base64');
    if (!base64) {
        throw new Error('Screenshot image not found');
    }
    const config = (await store.get(key)) ?? {};

    let text = '';
    if (sourceType === ServiceSourceType.PLUGIN) {
        const languageCode = await loadPluginLanguage(serviceName, language);
        const [func, utils] = await invoke_plugin('recognize', serviceName);
        text = await func(base64, languageCode, { config, utils });
    } else {
        const service = builtinRecognizeServices[serviceName];
        if (!service?.recognize) {
            throw new Error(`Recognize service not available: ${serviceName}`);
        }
        text = await service.recognize(base64, service.Language?.[language], { config });
    }

    return { text: String(text ?? '').trim() };
}
