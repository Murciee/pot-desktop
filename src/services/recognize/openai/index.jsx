import { fetch } from '@tauri-apps/api/http';

const DEFAULT_PROMPT = 'Just recognize the text in the image. Do not offer unnecessary explanations.';

function normalizePath(path) {
    let url = (path || 'https://api.openai.com').trim();
    if (!/^https?:\/\//.test(url)) {
        url = `https://${url}`;
    }
    return url.replace(/\/+$/, '');
}

function isGoogleApi(path) {
    return path.includes('generativelanguage.googleapis.com');
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

    if (isGoogleApi(path)) {
        const modelName = !model || model === 'gpt-4o' ? 'gemini-2.0-flash' : model;
        const url = `${path}/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: base64 } }],
                },
            ],
        };

        if (disableThinking) {
            body.generationConfig = { thinkingConfig: { thinkingBudget: 0 } };
        }

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: {
                type: 'Json',
                payload: body,
            },
        });

        if (!res.ok) {
            throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
        }

        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string') {
            throw JSON.stringify(res.data);
        }
        return text.trim();
    }

    const url = path.endsWith('/chat/completions') ? path : `${path}/v1/chat/completions`;

    const body = {
        model,
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'high' } },
                ],
            },
        ],
    };

    if (disableThinking) {
        // Accepted by OpenAI-compatible reasoning endpoints; providers that do
        // not know the field ignore it.
        body.reasoning_effort = 'none';
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: {
            type: 'Json',
            payload: body,
        },
    });

    if (!res.ok) {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }

    const content = readContent(res.data?.choices?.[0]);
    if (content === null) {
        throw JSON.stringify(res.data);
    }
    return content.trim();
}

export * from './Config';
export * from './info';
