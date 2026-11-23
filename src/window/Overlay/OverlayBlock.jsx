import React, { useLayoutEffect, useRef, useState } from 'react';
import {
    computeBlockColors,
    computeBlockMaxFontSize,
    OVERLAY_MAX_SCALED_FONT_SIZE,
    OVERLAY_MIN_FONT_SIZE,
} from '../../utils/overlay_layout';

export const OverlayBlock = React.memo(function OverlayBlock({
    block,
    displayMode,
    contentLeft,
    contentTop,
    contentWidth,
    contentHeight,
    baseFontSize,
    fontScale,
    opacity,
    overlayTheme,
    resolvedTheme,
    locked,
    t,
    onRetryBlock,
}) {
    const ref = useRef(null);
    const [hovered, setHovered] = useState(false);

    const showError = displayMode === 'translation' && block.error;
    const pending = displayMode === 'translation' && !block.translated && !block.error;
    const text =
        displayMode === 'original'
            ? block.text
            : block.translated || (block.error ? t('overlay.block_failed') : t('overlay.translating'));

    const left = contentLeft + block.nx * contentWidth;
    const top = contentTop + block.ny * contentHeight;
    const blockWidth = Math.max(12, block.nw * contentWidth);
    const blockHeight = Math.max(12, block.nh * contentHeight);
    const vertical = Boolean(block.vertical);

    // Fit the 1.0x baseline size to the original OCR line size; explicit
    // fontScale then scales from that baseline so pressing +/- moves cleanly.
    const lineSizePx =
        Number.isFinite(block.nLineSize) && block.nLineSize > 0
            ? block.nLineSize * (vertical ? contentWidth : contentHeight)
            : null;
    const baseMaxSize = computeBlockMaxFontSize({
        blockWidth,
        blockHeight,
        vertical,
        lineSizePx,
        text: block.text,
    });
    const fitMaxSize =
        showError || pending ? Math.min(baseMaxSize, Number(baseFontSize) || 16) : baseMaxSize;

    const [baseFit, setBaseFit] = useState({ size: fitMaxSize, overflowing: false });

    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) {
            return;
        }
        const prevFont = element.style.fontSize;
        const prevOverflow = element.style.overflow;
        const prevHeight = element.style.height;
        const prevMaxHeight = element.style.maxHeight;

        element.style.overflow = 'hidden';
        element.style.height = `${blockHeight}px`;
        element.style.maxHeight = `${blockHeight}px`;

        let lo = OVERLAY_MIN_FONT_SIZE;
        let hi = Math.max(OVERLAY_MIN_FONT_SIZE, fitMaxSize);
        let best = OVERLAY_MIN_FONT_SIZE;

        const maxCandidate = Math.max(OVERLAY_MIN_FONT_SIZE, Math.floor(hi * 2) / 2);
        element.style.fontSize = `${maxCandidate}px`;
        if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) {
            best = maxCandidate;
        } else {
            for (let i = 0; i < 10 && hi - lo > 0.25; i += 1) {
                const mid = (lo + hi) / 2;
                element.style.fontSize = `${mid}px`;
                const fits =
                    element.scrollHeight <= element.clientHeight + 1 &&
                    element.scrollWidth <= element.clientWidth + 1;
                if (fits) {
                    best = mid;
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            best = Math.max(OVERLAY_MIN_FONT_SIZE, Math.floor(best * 2) / 2);
        }

        element.style.fontSize = `${best}px`;
        const overflowing =
            best <= OVERLAY_MIN_FONT_SIZE + 0.1 &&
            (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1);

        element.style.overflow = prevOverflow;
        element.style.fontSize = prevFont;
        element.style.height = prevHeight;
        element.style.maxHeight = prevMaxHeight;

        setBaseFit((prev) =>
            prev.size === best && prev.overflowing === overflowing ? prev : { size: best, overflowing }
        );
    }, [text, blockWidth, blockHeight, vertical, fitMaxSize, displayMode]);

    const displayFontSize = Math.max(
        OVERLAY_MIN_FONT_SIZE,
        Math.min(OVERLAY_MAX_SCALED_FONT_SIZE, Math.round(baseFit.size * fontScale * 2) / 2)
    );
    const expanded = fontScale > 1.01;
    const maxExpandedHeight = Math.max(blockHeight, contentTop + contentHeight - top - 4);

    const palette = computeBlockColors(block.bgColor, overlayTheme, resolvedTheme, opacity);
    const tooltip = showError
        ? [block.errorMessage, !locked ? t('overlay.retry_block_hint') : ''].filter(Boolean).join('\n')
        : displayMode === 'translation' && !locked && block.translated
          ? block.text
          : undefined;

    return (
        <div
            ref={ref}
            dir='auto'
            title={tooltip}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={
                showError && !locked && onRetryBlock
                    ? (e) => {
                          e.stopPropagation();
                          onRetryBlock(block.id);
                      }
                    : undefined
            }
            style={{
                position: 'absolute',
                left: `${left}px`,
                top: `${top}px`,
                width: `${blockWidth}px`,
                height: expanded ? 'auto' : `${blockHeight}px`,
                minHeight: `${blockHeight}px`,
                maxHeight: expanded ? `${maxExpandedHeight}px` : `${blockHeight}px`,
                zIndex: hovered && !locked ? 5 : 1,
                boxSizing: 'border-box',
                padding: vertical ? '4px 1px' : '1px 4px',
                background: palette.background,
                border: 'none',
                boxShadow: showError ? 'none' : `inset 0 0 0 1px ${palette.borderColor}`,
                outline: showError ? '1px dashed rgba(220,38,38,0.9)' : 'none',
                outlineOffset: '-1px',
                borderRadius: 4,
                color: showError ? '#dc2626' : pending ? palette.mutedColor : palette.color,
                fontStyle: pending ? 'italic' : 'normal',
                lineHeight: 1.12,
                overflow: !locked && (expanded || baseFit.overflowing) ? 'auto' : 'hidden',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                wordBreak: 'normal',
                writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
                textAlign: 'start',
                fontSize: `${displayFontSize}px`,
                userSelect: locked ? 'none' : 'text',
                cursor: showError && !locked ? 'pointer' : undefined,
            }}
        >
            {text}
        </div>
    );
});
