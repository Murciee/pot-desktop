import test from 'node:test';
import assert from 'node:assert/strict';

import {
    clearThinkingProfileCache,
    executeWithDisableThinking,
    THINKING_VARIANTS,
} from '../src/utils/openai_thinking.js';

test('disableThinking starts with combined variant and skips thinking fields when off', async () => {
    clearThinkingProfileCache();
    const seen = [];

    await executeWithDisableThinking({
        cacheKey: 'https://example.com/v1/chat/completions::model-a',
        disableThinking: false,
        baseBody: { model: 'model-a', messages: [] },
        sendRequest: async (body) => {
            seen.push(body);
            return { ok: true, status: 200, data: {} };
        },
    });
    assert.equal(seen[0].reasoning_effort, undefined);
    assert.equal(seen[0].enable_thinking, undefined);
    assert.equal(seen[0].thinking, undefined);

    await executeWithDisableThinking({
        cacheKey: 'https://example.com/v1/chat/completions::model-a',
        disableThinking: true,
        baseBody: { model: 'model-a', messages: [] },
        sendRequest: async (body) => {
            seen.push(body);
            return { ok: true, status: 200, data: {} };
        },
    });
    assert.equal(seen[1].reasoning_effort, THINKING_VARIANTS.all.reasoning_effort);
    assert.equal(seen[1].enable_thinking, false);
    assert.deepEqual(seen[1].thinking, { type: 'disabled' });
});

test('falls back on 400 rejecting enable_thinking/thinking and caches working variant', async () => {
    clearThinkingProfileCache();
    const sent = [];

    const sendRequest = async (body) => {
        sent.push(body);
        if ('enable_thinking' in body || 'thinking' in body) {
            return {
                ok: false,
                status: 400,
                data: { error: { message: 'Unknown parameter: enable_thinking, thinking' } },
            };
        }
        return { ok: true, status: 200, data: { ok: true } };
    };

    const res1 = await executeWithDisableThinking({
        cacheKey: 'https://api.openai.com/v1/chat/completions::gpt-5',
        disableThinking: true,
        baseBody: { model: 'gpt-5', messages: [] },
        sendRequest,
    });
    assert.equal(res1.ok, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].reasoning_effort, 'none');
    assert.equal('enable_thinking' in sent[1], false);
    assert.equal('thinking' in sent[1], false);

    // Second call uses cached reasoning_none directly with only 1 request.
    const res2 = await executeWithDisableThinking({
        cacheKey: 'https://api.openai.com/v1/chat/completions::gpt-5',
        disableThinking: true,
        baseBody: { model: 'gpt-5', messages: [] },
        sendRequest,
    });
    assert.equal(res2.ok, true);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].reasoning_effort, 'none');
});

test('falls back cleanly when server rejects reasoning_effort', async () => {
    clearThinkingProfileCache();
    const sent = [];

    const sendRequest = async (body) => {
        sent.push(body);
        if ('reasoning_effort' in body) {
            return {
                ok: false,
                status: 422,
                data: { error: { message: 'Extra inputs are not permitted: reasoning_effort' } },
            };
        }
        return { ok: true, status: 200, data: { ok: true } };
    };

    const res = await executeWithDisableThinking({
        cacheKey: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions::qwen',
        disableThinking: true,
        baseBody: { model: 'qwen', messages: [] },
        sendRequest,
    });
    assert.equal(res.ok, true);
    assert.equal(sent.length, 2);
    assert.equal('reasoning_effort' in sent[1], false);
    assert.equal(sent[1].enable_thinking, false);
    assert.deepEqual(sent[1].thinking, { type: 'disabled' });
});

test('does not retry on non-400/422 errors such as 401, 429, or 500', async () => {
    for (const status of [401, 429, 500]) {
        clearThinkingProfileCache();
        let calls = 0;
        const res = await executeWithDisableThinking({
            cacheKey: `https://example.com::${status}`,
            disableThinking: true,
            baseBody: { model: 'm', messages: [] },
            sendRequest: async () => {
                calls += 1;
                return { ok: false, status, data: { error: 'fail' } };
            },
        });
        assert.equal(res.ok, false);
        assert.equal(res.status, status);
        assert.equal(calls, 1);
    }
});
