import { invoke } from '@tauri-apps/api/tauri';
import { fetch } from '@tauri-apps/api/http';

import {
    executeWithDisableThinking,
    isThinkingParamRejection,
} from '../../../utils/openai_thinking';
import { normalizeChatUrl } from '../../translate/openai/utils';

const DEFAULT_PROMPT = 'Just recognize the text in the image. Do not offer unnecessary explanations.';

function normalizePath(path) {
    let url = (path || 'https://api.openai.com').trim();
    if (!/^https?:\/\//.test(url)) {
        url = `https://${url}`;
    }
    return url.replace(/\/+$/, '');
}

function isGoogleApi(path) {
    return path.includes('generativelanguage.googleapis.com') && !/\/openai(\/|$)/.test(path);
}

function readContent(choice) {
    if (!choice) {
        return null;
    }
    const content = choice.message ? choice.message.content : choice.content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
    }
    return typeof content === 'string' ? content : null;
}

export async function recognize(base64, language, options = {}) {
    const { config } = options;

    const { model, apiKey, requestPath, customPrompt, disableThinking } = config;

    const prompt = (customPrompt || DEFAULT_PROMPT).replaceAll('$lang', language || '');
    const path = normalizePath(requestPath);

    let imageBase64 = base64;
    let mimeType = 'image/png';
    if (options.imageFile) {
        try {
            const payload = await invoke('get_ocr_image_payload', {
                imageFile: options.imageFile,
                maxDimension: 1600,
            });
            if (payload?.base64) {
                imageBase64 = payload.base64;
                mimeType = payload.mimeType || 'image/jpeg';
            }
        } catch {
            // Fall back to the PNG base64 already provided by caller.
        }
    }

    if (isGoogleApi(path)) {
        const modelName = !model || model === 'gpt-4o' ? 'gemini-2.0-flash' : model;
        const url = `${path}/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        const baseBody = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }],
                },
            ],
        };

        const postGoogle = (payload) =>
            fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: {
                    type: 'Json',
                    payload,
                },
            });

        let res = await postGoogle(
            disableThinking
                ? { ...baseBody, generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }
                : baseBody
        );

        if (!res.ok && disableThinking && isThinkingParamRejection(res.status)) {
            res = await postGoogle(baseBody);
        }

        if (!res.ok) {
            throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
        }

        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string') {
            throw JSON.stringify(res.data);
        }
        return text.trim();
    }

    const url = normalizeChatUrl(path);

    const body = {
        model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'auto' } },
                ],
            },
        ],
    };

    const result = await executeWithDisableThinking({
        cacheKey: `${url}::${model}`,
        disableThinking: Boolean(disableThinking),
        baseBody: body,
        sendRequest: async (payload) => {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: {
                    type: 'Json',
                    payload,
                },
            });
            return {
                ok: res.ok,
                status: res.status,
                data: res.data,
                response: res,
            };
        },
    });

    if (!result.ok) {
        throw `Http Request Error\nHttp Status: ${result.status}\n${JSON.stringify(result.data)}`;
    }

    const content = readContent(result.data?.choices?.[0]);
    if (content === null) {
        throw JSON.stringify(result.data);
    }
    return content.trim();
}

export * from './Config';
export * from './info';
