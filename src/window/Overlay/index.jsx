import { appWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { info, error as logError } from 'tauri-plugin-log-api';
import { MdAdd, MdClose, MdLock, MdRefresh, MdRemove, MdSwapHoriz } from 'react-icons/md';
import React, { useEffect, useRef, useState } from 'react';

import { translateWithService } from '../../utils/translate_text';
import { mergeLineBoxes, normalizeBlocks } from '../../utils/overlay_layout';
import { recognizeWithBoxes } from '../../services/recognize/system';
import { useConfig, useToastStyle } from '../../hooks';

const TOOLBAR_HEIGHT = 32;

export default function Overlay() {
    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    const [overlayOpacity] = useConfig('overlay_opacity', 0.85);
    const [overlayFontScale] = useConfig('overlay_font_scale', 1);
    const [overlayConcurrency] = useConfig('overlay_max_concurrency', 3);
    const [appFontSize] = useConfig('app_font_size', 16);
    const [appFont] = useConfig('app_font', 'default');
    const [appFallbackFont] = useConfig('app_fallback_font', 'default');

    const [state, setState] = useState(null);
    const [blocks, setBlocks] = useState([]);
    const [locked, setLocked] = useState(true);
    const [showOriginal, setShowOriginal] = useState(false);
    const [fontScale, setFontScale] = useState(1);
    const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
    const [refreshing, setRefreshing] = useState(false);

    const blockRefs = useRef(new Map());
    const disposedRef = useRef(false);
    const refreshingRef = useRef(false);
    const runRef = useRef(null);
    const refreshRef = useRef(null);
    const tRef = useRef(t);
    const toastStyleRef = useRef(toastStyle);
    const concurrencyRef = useRef(overlayConcurrency);
    const fontScaleRef = useRef(fontScale);

    tRef.current = t;
    toastStyleRef.current = toastStyle;
    concurrencyRef.current = overlayConcurrency;
    fontScaleRef.current = fontScale;

    useEffect(() => {
        if (overlayFontScale !== null) {
            const value = Number(overlayFontScale);
            if (Number.isFinite(value) && value > 0) {
                setFontScale(value);
            }
        }
    }, [overlayFontScale]);

    useEffect(() => {
        document.documentElement.style.borderRadius = '0';
        const onResize = () => {
            setViewport({ width: window.innerWidth, height: window.innerHeight });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        appWindow.setIgnoreCursorEvents(locked).catch(() => {});
        if (!locked) {
            appWindow.setFocus().catch(() => {});
        }
    }, [locked]);

    const runOverlay = async (overlayState) => {
        const tr = tRef.current;
        const style = toastStyleRef.current;

        const showErrorAndClose = async (message) => {
            await appWindow.show();
            toast.error(message, { style, duration: 2200 });
            setTimeout(() => {
                appWindow.close();
            }, 2400);
        };

        let boxes;
        try {
            boxes = await recognizeWithBoxes(overlayState.ocrLang);
        } catch (e) {
            await showErrorAndClose(
                (tr('overlay.ocr_failed') ?? '') + (e?.toString() ?? String(e))
            );
            return;
        }
        info(`[overlay] OCR returned ${boxes.length} line boxes`);

        const merged = mergeLineBoxes(boxes);
        info(`[overlay] merged into ${merged.length} text blocks`);
        if (merged.length === 0) {
            await showErrorAndClose(tr('overlay.no_text'));
            return;
        }

        // cut_image adds padding; OCR coordinates are relative to the padded image.
        const trimmed = merged.map((block) => ({
            ...block,
            x: block.x - (overlayState.paddingLeft ?? Math.round(8 * (overlayState.dpr || 1))),
            y: block.y - (overlayState.paddingTop ?? Math.round(8 * (overlayState.dpr || 1))),
        }));
        const normalized = normalizeBlocks(
            trimmed,
            overlayState.width,
            overlayState.height,
            overlayState.dpr
        ).map((block) => ({ ...block, translated: '', error: false }));

        if (disposedRef.current) {
            return;
        }
        setBlocks(normalized);
        await appWindow.show();

        if (!overlayState.service) {
            toast.error(tr('overlay.no_service'), { style, duration: 6000 });
            return;
        }

        const pending = [...normalized];
        const concurrency = Math.max(1, Math.min(10, Number(concurrencyRef.current) || 3));
        const workerCount = Math.min(concurrency, pending.length);
        let failed = 0;
        let lastError = '';

        const worker = async () => {
            while (pending.length > 0) {
                const block = pending.shift();
                try {
                    const value = await translateWithService(
                        overlayState.service,
                        block.text,
                        'auto',
                        overlayState.targetLang,
                        'auto'
                    );
                    if (disposedRef.current) {
                        return;
                    }
                    if (typeof value !== 'string') {
                        throw new Error('Translation service returned a non-text result');
                    }
                    const translated = value.trim();
                    if (translated === '') {
                        throw new Error('Translation service returned empty text');
                    }
                    setBlocks((prev) =>
                        prev.map((item) =>
                            item.id === block.id ? { ...item, translated, error: false } : item
                        )
                    );
                } catch (e) {
                    failed += 1;
                    lastError = e?.toString?.() ?? String(e);
                    logError(`[overlay] translate failed: ${lastError}`);
                    if (disposedRef.current) {
                        return;
                    }
                    setBlocks((prev) =>
                        prev.map((item) => (item.id === block.id ? { ...item, error: true } : item))
                    );
                }
            }
        };

        await Promise.all(Array.from({ length: workerCount }, worker));

        if (!disposedRef.current) {
            if (failed === normalized.length) {
                toast.error(
                    `${tr('overlay.all_failed')} (${overlayState.service})${lastError ? `\n${lastError}` : ''}`,
                    { style, duration: 8000 }
                );
            } else if (failed > 0) {
                toast.error(`${tr('overlay.partial_failed')} (${overlayState.service})`, { style });
            }
        }
    };
    runRef.current = runOverlay;

    const refresh = async () => {
        const overlayState = state;
        if (!overlayState || refreshingRef.current) {
            return;
        }
        refreshingRef.current = true;
        setRefreshing(true);
        try {
            await appWindow.hide();
            await new Promise((resolve) => setTimeout(resolve, 130));
            await invoke('screenshot', {
                x: overlayState.monitorX,
                y: overlayState.monitorY,
            });
            const cropInfo = await invoke('cut_image', {
                left: overlayState.left,
                top: overlayState.top,
                width: overlayState.width,
                height: overlayState.height,
            });
            const refreshedState = {
                ...overlayState,
                paddingLeft: cropInfo.paddingLeft,
                paddingTop: cropInfo.paddingTop,
            };
            setState(refreshedState);
            await runRef.current(refreshedState);
        } catch (e) {
            toast.error((tRef.current('overlay.refresh_failed') ?? '') + (e?.toString() ?? String(e)), {
                style: toastStyleRef.current,
            });
            await appWindow.show();
        } finally {
            refreshingRef.current = false;
            setRefreshing(false);
        }
    };
    refreshRef.current = refresh;

    useEffect(() => {
        let unlistenToggle = null;
        let unlistenRefresh = null;

        const init = async () => {
            try {
                const overlayState = await invoke('get_overlay_state');
                if (disposedRef.current) {
                    return;
                }
                setState(overlayState);
                await runRef.current(overlayState);
            } catch (e) {
                if (!disposedRef.current) {
                    await appWindow.show();
                    toast.error(e?.toString() ?? String(e), {
                        style: toastStyleRef.current,
                        duration: 2200,
                    });
                    setTimeout(() => {
                        appWindow.close();
                    }, 2400);
                }
            }
        };
        init();

        listen('overlay_toggle_edit', () => {
            setLocked((value) => !value);
        }).then((f) => {
            unlistenToggle = f;
        });
        listen('overlay_refresh', () => {
            refreshRef.current?.();
        }).then((f) => {
            unlistenRefresh = f;
        });

        return () => {
            disposedRef.current = true;
            unlistenToggle?.();
            unlistenRefresh?.();
        };
    }, []);

    // Fit the font size of every block: start at min(block height * 0.72, base size),
    // then binary search down to the largest size that still fits (minimum 9px).
    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            const overlayState = state;
            if (!overlayState) {
                return;
            }
            const dpr = overlayState.dpr > 0 ? overlayState.dpr : 1;
            const originalWidth = overlayState.width / dpr;
            const originalHeight = overlayState.height / dpr;
            const scale =
                originalWidth > 0 && originalHeight > 0
                    ? Math.min(viewport.width / originalWidth, viewport.height / originalHeight)
                    : 1;
            const baseSize = Math.max(1, (Number(appFontSize) || 16) * fontScale * Math.max(scale, 0.01));

            blocks.forEach((block) => {
                const element = blockRefs.current.get(block.id);
                if (!element) {
                    return;
                }
                const blockHeight = block.nh * viewport.height;
                let low = 9;
                let high = Math.max(9, Math.min(blockHeight * 0.72, baseSize));
                let best = 9;
                while (high - low > 0.25) {
                    const middle = (low + high) / 2;
                    element.style.fontSize = `${middle}px`;
                    if (
                        element.scrollWidth <= element.clientWidth + 0.5 &&
                        element.scrollHeight <= element.clientHeight + 0.5
                    ) {
                        best = middle;
                        low = middle;
                    } else {
                        high = middle;
                    }
                }
                element.style.fontSize = `${best}px`;
                element.style.overflow = 'hidden';
            });
        });
        return () => cancelAnimationFrame(frame);
    }, [blocks, viewport, fontScale, showOriginal, appFontSize, state]);

    const opacity = Math.min(1, Math.max(0.3, Number(overlayOpacity) || 0.85));
    const fontFamily = `"${appFont === 'default' || !appFont ? 'sans-serif' : appFont}","${
        appFallbackFont === 'default' || !appFallbackFont ? 'sans-serif' : appFallbackFont
    }"`;

    const toolStyle = {
        background: 'rgba(255,255,255,0.12)',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: 4,
        color: '#fff',
        fontSize: 12,
        lineHeight: '20px',
        width: 26,
        height: 22,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flex: '0 0 auto',
    };

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                width: '100vw',
                height: '100vh',
                overflow: 'hidden',
                fontFamily,
                pointerEvents: locked ? 'none' : 'auto',
            }}
        >
            <Toaster />
            {!locked && (
                <div
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: TOOLBAR_HEIGHT,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '0 4px',
                        overflow: 'hidden',
                        background: 'rgba(24,24,27,0.92)',
                        zIndex: 10,
                        cursor: 'move',
                        userSelect: 'none',
                    }}
                    onMouseDown={(e) => {
                        if (e.target === e.currentTarget) {
                            appWindow.startDragging();
                        }
                    }}
                >
                    <button
                        type='button'
                        style={toolStyle}
                        title={t('overlay.refresh')}
                        aria-label={t('overlay.refresh')}
                        onClick={() => refreshRef.current?.()}
                        disabled={refreshing}
                    >
                        <MdRefresh size={16} />
                    </button>
                    <button
                        type='button'
                        style={toolStyle}
                        title={showOriginal ? t('overlay.translation') : t('overlay.original')}
                        aria-label={showOriginal ? t('overlay.translation') : t('overlay.original')}
                        onClick={() => setShowOriginal((value) => !value)}
                    >
                        <MdSwapHoriz size={16} />
                    </button>
                    <button
                        type='button'
                        style={toolStyle}
                        title={t('overlay.font_smaller')}
                        aria-label={t('overlay.font_smaller')}
                        onClick={() => setFontScale((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))}
                    >
                        <MdRemove size={14} />
                    </button>
                    <button
                        type='button'
                        style={toolStyle}
                        title={t('overlay.font_larger')}
                        aria-label={t('overlay.font_larger')}
                        onClick={() => setFontScale((value) => Math.min(2, Number((value + 0.1).toFixed(2))))}
                    >
                        <MdAdd size={14} />
                    </button>
                    <button
                        type='button'
                        style={toolStyle}
                        title={t('overlay.lock')}
                        aria-label={t('overlay.lock')}
                        onClick={() => setLocked(true)}
                    >
                        <MdLock size={15} />
                    </button>
                    <button
                        type='button'
                        style={{ ...toolStyle, marginLeft: 'auto' }}
                        title={t('overlay.close')}
                        aria-label={t('overlay.close')}
                        onClick={() => appWindow.close()}
                    >
                        <MdClose size={16} />
                    </button>
                </div>
            )}
            {blocks.map((block) => {
                const text = showOriginal ? block.text : block.translated || block.text;
                return (
                    <div
                        key={block.id}
                        ref={(element) => {
                            if (element) {
                                blockRefs.current.set(block.id, element);
                            } else {
                                blockRefs.current.delete(block.id);
                            }
                        }}
                        style={{
                            position: 'absolute',
                            left: `${block.nx * 100}%`,
                            top: `${block.ny * 100}%`,
                            width: `${block.nw * 100}%`,
                            height: `${block.nh * 100}%`,
                            boxSizing: 'border-box',
                            padding: '2px 4px',
                            background: `rgba(255,255,255,${opacity})`,
                            border: block.error
                                ? '1px dashed rgba(220,38,38,0.9)'
                                : '1px solid rgba(0,0,0,0.15)',
                            borderRadius: 4,
                            color: '#111',
                            lineHeight: 1.15,
                            overflow: 'hidden',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            fontSize: 16,
                            userSelect: locked ? 'none' : 'text',
                        }}
                    >
                        {text}
                    </div>
                );
            })}
        </div>
    );
}
