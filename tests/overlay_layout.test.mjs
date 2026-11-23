import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeBlockColors,
    computeBlockMaxFontSize,
    formatBatchPrompt,
    isBatchFriendlyService,
    joinLineText,
    mergeLineBoxes,
    normalizeBlocks,
    OVERLAY_MAX_AUTO_FONT_SIZE,
    OVERLAY_MIN_FONT_SIZE,
    parseBatchTranslation,
    shouldSkipTranslation,
} from '../src/utils/overlay_layout.js';

test('joinLineText only unwraps English hyphenated line breaks', () => {
    assert.equal(joinLineText('inter-', 'national'), 'international');
    assert.equal(joinLineText('--max-', 'concurrency'), '--max-concurrency');
    assert.equal(joinLineText('foo-', '123'), 'foo- 123');
    assert.equal(joinLineText('你好', '世界'), '你好世界');
    assert.equal(joinLineText('Hello', 'world'), 'Hello world');
});

test('mergeLineBoxes merges paragraph lines but splits height-mismatched headings and side columns', () => {
    const blocks = mergeLineBoxes([
        // Large title spanning above two columns
        { text: 'Section Title', x: 10, y: 10, w: 300, h: 36, vertical: false, bgColor: [250, 250, 250] },
        // Left column body (smaller font, ratio > 1.55)
        { text: 'Left line one', x: 10, y: 54, w: 120, h: 16, vertical: false, bgColor: [250, 250, 250] },
        { text: 'Left line two', x: 10, y: 74, w: 120, h: 16, vertical: false, bgColor: [248, 248, 248] },
        // Right column body
        { text: 'Right line one', x: 180, y: 54, w: 120, h: 16, vertical: false, bgColor: [30, 30, 30] },
    ]);

    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].text, 'Section Title');
    assert.equal(blocks[0].lineSize, 36);
    assert.equal(blocks[0].lineCount, 1);
    assert.equal(blocks[1].text, 'Left line one Left line two');
    assert.equal(blocks[1].lineSize, 16);
    assert.equal(blocks[1].lineCount, 2);
    assert.deepEqual(blocks[1].bgColor, [249, 249, 249]);
    assert.equal(blocks[2].text, 'Right line one');
    assert.equal(blocks[2].lineSize, 16);
    assert.equal(blocks[2].lineCount, 1);
    assert.deepEqual(blocks[2].bgColor, [30, 30, 30]);
});

test('mergeLineBoxes keeps vertical lines separate and preserves vertical flag', () => {
    const blocks = mergeLineBoxes([
        { text: '縦書き一', x: 50, y: 10, w: 20, h: 120, vertical: true, bgColor: [20, 20, 20] },
        { text: '縦書き二', x: 20, y: 10, w: 20, h: 120, vertical: true, bgColor: [20, 20, 20] },
    ]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].vertical, true);
    assert.equal(blocks[0].lineSize, 20);
    assert.equal(blocks[0].lineCount, 1);
    assert.equal(blocks[1].vertical, true);
});

test('normalizeBlocks converts physical boxes to normalized ratios with orientation and color', () => {
    const normalized = normalizeBlocks(
        [
            { x: 40, y: 20, w: 200, h: 40, text: 'Hello', vertical: false, lineSize: 40, lineCount: 1, bgColor: [10, 20, 30] },
            { x: 20, y: 20, w: 40, h: 120, text: '縦書', vertical: true, lineSize: 40, lineCount: 1, bgColor: [10, 20, 30] },
            { x: 0, y: 0, w: 400, h: 200, text: 'Plain fallback', vertical: false, bgColor: null },
        ],
        400,
        200,
        2
    );
    assert.equal(normalized.length, 3);
    assert.equal(normalized[0].nx, 0.1);
    assert.equal(normalized[0].ny, 0.1);
    assert.equal(normalized[0].nw, 0.5);
    assert.equal(normalized[0].nh, 0.2);
    assert.equal(normalized[0].vertical, false);
    assert.equal(normalized[0].nLineSize, 0.2);
    assert.equal(normalized[0].lineCount, 1);
    assert.deepEqual(normalized[0].bgColor, [10, 20, 30]);

    assert.equal(normalized[1].nLineSize, 0.1);
    assert.equal(normalized[1].lineCount, 1);

    assert.equal(normalized[2].nLineSize, null);
    assert.equal(normalized[2].lineCount, null);
});

test('computeBlockMaxFontSize matches original OCR line size and falls back safely for plain text', () => {
    assert.equal(
        computeBlockMaxFontSize({ blockWidth: 320, blockHeight: 48, vertical: false, lineSizePx: 48 }),
        48
    );
    assert.equal(
        computeBlockMaxFontSize({ blockWidth: 500, blockHeight: 96, vertical: false, lineSizePx: 96 }),
        96
    );
    assert.equal(
        computeBlockMaxFontSize({ blockWidth: 260, blockHeight: 120, vertical: false, lineSizePx: 32 }),
        32
    );
    assert.equal(
        computeBlockMaxFontSize({ blockWidth: 42, blockHeight: 240, vertical: true, lineSizePx: 42 }),
        42
    );
    assert.equal(
        computeBlockMaxFontSize({ blockWidth: 300, blockHeight: 200, vertical: false, lineSizePx: null, text: 'Line 1\nLine 2' }),
        85
    );
    assert.equal(
        computeBlockMaxFontSize({ blockWidth: 1000, blockHeight: 400, vertical: false, lineSizePx: 320 }),
        OVERLAY_MAX_AUTO_FONT_SIZE
    );
    assert.equal(
        computeBlockMaxFontSize({ blockWidth: 40, blockHeight: 4, vertical: false, lineSizePx: 4 }),
        OVERLAY_MIN_FONT_SIZE
    );
});

test('shouldSkipTranslation skips non-lexical, URLs, and pure target CJK text without skipping English or mixed text', () => {
    assert.equal(shouldSkipTranslation('123.45%', 'zh_cn'), true);
    assert.equal(shouldSkipTranslation('--- / ***', 'en'), true);
    assert.equal(shouldSkipTranslation('https://example.com/docs', 'zh_cn'), true);
    assert.equal(shouldSkipTranslation('纯中文内容测试', 'zh_cn'), true);
    assert.equal(shouldSkipTranslation('使用 React 组件', 'zh_cn'), false);
    assert.equal(shouldSkipTranslation('Bonjour le monde', 'en'), false);
});

test('computeBlockColors adapts ink contrast from sampled background or explicit theme', () => {
    const darkBg = computeBlockColors([24, 24, 28], 'auto', 'light', 0.9);
    assert.equal(darkBg.isDark, true);
    assert.equal(darkBg.color, '#f4f4f5');
    assert.equal(darkBg.background, 'rgba(24,24,28,0.9)');

    const lightBg = computeBlockColors([245, 245, 245], 'auto', 'dark', 0.85);
    assert.equal(lightBg.isDark, false);
    assert.equal(lightBg.color, '#111111');

    const forcedDark = computeBlockColors([250, 250, 250], 'dark', 'light', 0.85);
    assert.equal(forcedDark.isDark, true);
    assert.equal(forcedDark.background, 'rgba(24,24,27,0.85)');

    const fallback = computeBlockColors(null, 'auto', 'dark', 0.8);
    assert.equal(fallback.isDark, true);
});

test('formatBatchPrompt and parseBatchTranslation handle multiline items and reject malformed output', () => {
    const inputs = ['Hello world', 'Line A\nLine B', 'Third block'];
    const prompt = formatBatchPrompt(inputs);
    const simulated = '[[0]] 你好世界\n[[1]] 第一行\n第二行\n[[2]] 第三块';
    assert.ok(prompt.includes('[[0]] Hello world'));
    assert.deepEqual(parseBatchTranslation(simulated, 3), ['你好世界', '第一行\n第二行', '第三块']);

    // Missing item or wrong count should return null so caller falls back safely
    assert.equal(parseBatchTranslation('[[0]] 你好\n[[2]] 第三块', 3), null);
    assert.equal(parseBatchTranslation('[[0]] ', 1), null);
    assert.equal(isBatchFriendlyService('ecdict'), false);
    assert.equal(isBatchFriendlyService('openai'), true);
});
