import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeBlockColors,
    computeBlockMaxFontSize,
    computeOverlayContentRect,
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

test('mergeLineBoxes merges adjacent right-to-left vertical columns and keeps distant columns separate', () => {
    const blocks = mergeLineBoxes([
        {
            text: 'なんやかんやあって',
            x: 150,
            y: 10,
            w: 20,
            h: 160,
            lineSize: 18,
            vertical: true,
            bgColor: [250, 250, 250],
            fgColor: [20, 20, 20],
            fontWeight: 700,
        },
        {
            text: '梅と相互愛撫',
            x: 120,
            y: 12,
            w: 20,
            h: 120,
            lineSize: 18,
            vertical: true,
            bgColor: [250, 250, 250],
            fgColor: [20, 20, 20],
            fontWeight: 700,
        },
        // Distant column on the far left should remain separate
        {
            text: '別枠テキスト',
            x: 20,
            y: 10,
            w: 20,
            h: 120,
            lineSize: 18,
            vertical: true,
            bgColor: [20, 20, 20],
            fgColor: [240, 240, 240],
            fontWeight: 400,
        },
    ]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].vertical, true);
    assert.equal(blocks[0].text, 'なんやかんやあって梅と相互愛撫');
    assert.equal(blocks[0].lineSize, 18);
    assert.equal(blocks[0].lineCount, 2);
    assert.equal(blocks[0].fontWeight, 700);
    assert.deepEqual(blocks[0].fgColor, [20, 20, 20]);
    assert.equal(blocks[1].vertical, true);
    assert.equal(blocks[1].text, '別枠テキスト');
    assert.equal(blocks[1].lineCount, 1);
});

test('mergeLineBoxes chains isolated single-CJK character boxes into vertical columns', () => {
    const blocks = mergeLineBoxes([
        { text: '会', x: 30, y: 10, w: 22, h: 22, vertical: false },
        { text: '長', x: 30, y: 36, w: 22, h: 22, vertical: false },
    ]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].vertical, true);
    assert.equal(blocks[0].text, '会長');
    assert.equal(blocks[0].lineSize, 22);
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

test('normalizeBlocks clamps padded out-of-bounds boxes into [0, 1] and preserves sub-20px selections', () => {
    const clamped = normalizeBlocks(
        [
            { x: -12, y: -6, w: 80, h: 40, text: 'Overflow left/top' },
            { x: 160, y: 80, w: 60, h: 40, text: 'Overflow right/bottom' },
        ],
        200,
        100,
        2
    );
    assert.equal(clamped[0].nx, 0);
    assert.equal(clamped[0].ny, 0);
    assert.ok(clamped[0].nx + clamped[0].nw <= 1);
    assert.ok(clamped[0].ny + clamped[0].nh <= 1);
    assert.ok(Math.abs(clamped[0].nw - 68 / 200) < 1e-6);
    assert.ok(Math.abs(clamped[0].nh - 34 / 100) < 1e-6);

    assert.ok(clamped[1].nx >= 0 && clamped[1].ny >= 0);
    assert.ok(Math.abs(clamped[1].nx + clamped[1].nw - 1) < 1e-6);
    assert.ok(Math.abs(clamped[1].ny + clamped[1].nh - 1) < 1e-6);

    const tiny = normalizeBlocks([{ x: 0, y: 0, w: 14, h: 12, text: 'OK' }], 14, 12, 1);
    assert.equal(tiny.length, 1);
    assert.equal(tiny[0].nx, 0);
    assert.equal(tiny[0].ny, 0);
    assert.equal(tiny[0].nw, 1);
    assert.equal(tiny[0].nh, 1);
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
    const singleLineFallback = computeBlockMaxFontSize({
        blockWidth: 300,
        blockHeight: 200,
        vertical: false,
        lineSizePx: null,
        text: '这是一段没有坐标框的纯文本测试内容',
    });
    assert.ok(singleLineFallback > 25 && singleLineFallback < 60);
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

    const highContrastFg = computeBlockColors([250, 250, 250], 'auto', 'light', 0.9, [30, 40, 50]);
    assert.equal(highContrastFg.color, 'rgb(30,40,50)');

    const lowContrastFg = computeBlockColors([250, 250, 250], 'auto', 'light', 0.9, [230, 230, 230]);
    assert.equal(lowContrastFg.color, '#111111');
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

test('computeOverlayContentRect maps the reserved toolbar strip and keeps content stable while toggling', () => {
    const lockedTop = computeOverlayContentRect({
        locked: true,
        viewport: { width: 400, height: 232 },
        placement: 'top',
    });
    assert.equal(lockedTop.toolbarVisible, false);
    assert.equal(lockedTop.toolbarAtBottom, false);
    assert.equal(lockedTop.contentTop, 32);
    assert.equal(lockedTop.contentHeight, 200);
    assert.equal(lockedTop.contentWidth, 400);
    assert.equal(lockedTop.contentLeft, 0);

    // Unlocking only reveals the toolbar in the reserved strip; content is unchanged.
    const unlockedTop = computeOverlayContentRect({
        locked: false,
        viewport: { width: 400, height: 232 },
        placement: 'top',
    });
    assert.equal(unlockedTop.toolbarVisible, true);
    assert.equal(unlockedTop.contentTop, lockedTop.contentTop);
    assert.equal(unlockedTop.contentHeight, lockedTop.contentHeight);

    const bottom = computeOverlayContentRect({
        locked: false,
        viewport: { width: 400, height: 232 },
        placement: 'bottom',
    });
    assert.equal(bottom.toolbarAtBottom, true);
    assert.equal(bottom.contentTop, 0);
    assert.equal(bottom.contentHeight, 200);

    // No room above/below: the toolbar overlaps the content ("inside").
    const inside = computeOverlayContentRect({
        locked: false,
        viewport: { width: 400, height: 200 },
        placement: 'inside',
    });
    assert.equal(inside.toolbarAtBottom, false);
    assert.equal(inside.contentTop, 0);
    assert.equal(inside.contentHeight, 200);

    // A missing or zero viewport still yields a drawable rect.
    const degenerate = computeOverlayContentRect({
        locked: true,
        viewport: { width: 0, height: 0 },
        placement: 'top',
    });
    assert.equal(degenerate.contentWidth, 1);
    assert.equal(degenerate.contentHeight, 1);
});
