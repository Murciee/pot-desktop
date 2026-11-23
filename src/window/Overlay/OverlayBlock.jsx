import React, { useLayoutEffect, useRef, useState } from 'react';
import { computeBlockColors } from '../../utils/overlay_layout';

const MIN_FONT_SIZE = 7;
const MAX_SCALED_FONT_SIZE = 36;

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

    // Fit the 1.0x baseline size to the original OCR box; explicit fontScale
    // then scales from that baseline so pressing +/- always moves the size.
    const baseMaxSize = Math.max(
        MIN_FONT_SIZE,
        Math.min((vertical ? blockWidth : blockHeight) * 0.85, Number(baseFontSize) || 16)
    );

    const [baseFit, setBaseFit] = useState({ size: baseMaxSize, overflowing: false });

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

        let lo = MIN_FONT_SIZE;
        let hi = Math.max(MIN_FONT_SIZE, baseMaxSize);
        let best = MIN_FONT_SIZE;

        element.style.fontSize = `${hi}px`;
        if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) {
            best = hi;
        } else {
            for (let i = 0; i < 6; i += 1) {
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
            best = Math.max(MIN_FONT_SIZE, Math.round(best * 2) / 2);
        }

        element.style.fontSize = `${best}px`;
        const overflowing =
            best <= MIN_FONT_SIZE + 0.1 &&
            (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1);

        element.style.overflow = prevOverflow;
        element.style.fontSize = prevFont;
        element.style.height = prevHeight;
        element.style.maxHeight = prevMaxHeight;

        setBaseFit((prev) =>
            prev.size === best && prev.overflowing === overflowing ? prev : { size: best, overflowing }
        );
    }, [text, blockWidth, blockHeight, vertical, baseMaxSize, displayMode]);

    const displayFontSize = Math.max(
        MIN_FONT_SIZE,
        Math.min(MAX_SCALED_FONT_SIZE, Math.round(baseFit.size * fontScale * 2) / 2)
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
                padding: '2px 4px',
                background: palette.background,
                border: showError ? '1px dashed rgba(220,38,38,0.9)' : palette.border,
                borderRadius: 4,
                color: showError ? '#dc2626' : pending ? palette.mutedColor : palette.color,
                fontStyle: pending ? 'italic' : 'normal',
                lineHeight: 1.15,
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
