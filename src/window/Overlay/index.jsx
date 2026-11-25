import { appWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api';
import { useTranslation } from 'react-i18next';
import { useTheme } from 'next-themes';
import { error as logError } from 'tauri-plugin-log-api';
import { MdPushPin } from 'react-icons/md';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { store } from '../../utils/store';
import { useConfig } from '../../hooks';
import { OverlayBlock } from './OverlayBlock';
import { OverlayStatusBar } from './OverlayStatusBar';
import { OverlayToolbar } from './OverlayToolbar';
import { useOverlaySession } from './useOverlaySession';

const TOOLBAR_HEIGHT = 32;
const THEME_CYCLE = ['auto', 'light', 'dark'];
const DEFAULT_FONT_STACK =
    '"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Segoe UI",system-ui,sans-serif';

export default function Overlay() {
    const { t } = useTranslation();
    const { resolvedTheme } = useTheme();
    const [overlayOpacity] = useConfig('overlay_opacity', 0.85);
    const [overlayFontScale] = useConfig('overlay_font_scale', 1);
    const [overlayConcurrency] = useConfig('overlay_max_concurrency', 3);
    const [overlayTheme, setOverlayTheme] = useConfig('overlay_theme', 'auto');
    const [translateServiceList] = useConfig('translate_service_list', []);
    const [appFontSize] = useConfig('app_font_size', 16);
    const [appFont] = useConfig('app_font', 'default');
    const [appFallbackFont] = useConfig('app_fallback_font', 'default');

    const [locked, setLocked] = useState(true);
    const [pinned, setPinned] = useState(false);
    const [toolbarLayout, setToolbarLayout] = useState(null);
    const [fontScale, setFontScale] = useState(1);
    const [displayMode, setDisplayMode] = useState('translation');
    const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

    const fontScaleRef = useRef(fontScale);
    const localFontEditedRef = useRef(false);
    const fontSaveTimerRef = useRef(null);
    fontScaleRef.current = fontScale;

    const session = useOverlaySession({
        t,
        translateServiceList,
        overlayConcurrency,
        setLocked,
    });

    const {
        state,
        blocks,
        phase,
        refreshing,
        status,
        setStatus,
        copyNotice,
        showNotice,
        init,
        refresh,
        retryOcr,
        retryFailed,
        retryBlock,
        retryAfterConfig,
        switchChannel,
        copyText,
        copyError,
    } = session;

    const refreshRef = useRef(refresh);
    const copyTextRef = useRef(copyText);
    const showNoticeRef = useRef(showNotice);
    const stateRef = useRef(state);
    refreshRef.current = refresh;
    copyTextRef.current = copyText;
    showNoticeRef.current = showNotice;
    stateRef.current = state;

    useEffect(() => {
        if (!localFontEditedRef.current && overlayFontScale !== null) {
            const value = Number(overlayFontScale);
            if (Number.isFinite(value) && value > 0) {
                setFontScale(value);
            }
        }
    }, [overlayFontScale]);

    const flushFontScaleSave = useCallback(() => {
        if (fontSaveTimerRef.current) {
            clearTimeout(fontSaveTimerRef.current);
            fontSaveTimerRef.current = null;
            const value = fontScaleRef.current;
            Promise.resolve()
                .then(() => store.set('overlay_font_scale', value))
                .then(() => store.save())
                .catch((e) => logError(`[overlay] save font scale failed: ${e?.toString?.() ?? String(e)}`));
        }
    }, []);

    useEffect(() => {
        return () => flushFontScaleSave();
    }, [flushFontScaleSave]);

    useEffect(() => {
        document.documentElement.style.borderRadius = '0';
        const onResize = () => {
            setViewport({ width: window.innerWidth, height: window.innerHeight });
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        setViewport({ width: window.innerWidth, height: window.innerHeight });
    }, [state, toolbarLayout]);

    useEffect(() => {
        appWindow.setIgnoreCursorEvents(locked).catch(() => {});
        if (!locked) {
            appWindow.setFocus().catch(() => {});
        }
    }, [locked]);

    useEffect(() => {
        let cancelled = false;
        const updateToolbar = async () => {
            try {
                const layout = await invoke('set_overlay_toolbar', { visible: !locked });
                if (!cancelled) {
                    setToolbarLayout(layout);
                }
            } catch (e) {
                logError(`[overlay] toolbar layout failed: ${e?.toString?.() ?? String(e)}`);
                if (!cancelled) {
                    const overlayState = stateRef.current;
                    const dpr = overlayState?.dpr > 0 ? overlayState.dpr : 1;
                    const width = overlayState ? overlayState.width / dpr : window.innerWidth;
                    const height = overlayState ? overlayState.height / dpr : window.innerHeight;
                    setToolbarLayout(
                        locked
                            ? {
                                  placement: 'none',
                                  offsetTop: 0,
                                  offsetLeft: 0,
                                  contentWidth: width,
                                  contentHeight: height,
                              }
                            : {
                                  placement: 'inside',
                                  offsetTop: TOOLBAR_HEIGHT,
                                  offsetLeft: 0,
                                  contentWidth: width,
                                  contentHeight: Math.max(1, height - TOOLBAR_HEIGHT),
                              }
                    );
                }
            }
        };
        updateToolbar();
        return () => {
            cancelled = true;
        };
    }, [locked]);

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                flushFontScaleSave();
                appWindow.close();
                return;
            }
            if (!locked && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
                const selected = window.getSelection?.()?.toString?.() ?? '';
                if (!selected) {
                    event.preventDefault();
                    copyTextRef.current('translation');
                }
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [locked]);

    useEffect(() => {
        let unlistenToggle = null;
        let unlistenRefresh = null;

        void init();

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
            unlistenToggle?.();
            unlistenRefresh?.();
        };
    }, [init]);

    const adjustFont = useCallback((delta) => {
        const next = Math.min(2, Math.max(0.5, Number((fontScaleRef.current + delta).toFixed(2))));
        localFontEditedRef.current = true;
        fontScaleRef.current = next;
        setFontScale(next);
        showNoticeRef.current?.(`${Math.round(next * 100)}%`);
        if (fontSaveTimerRef.current) {
            clearTimeout(fontSaveTimerRef.current);
        }
        fontSaveTimerRef.current = setTimeout(() => {
            fontSaveTimerRef.current = null;
            Promise.resolve()
                .then(() => store.set('overlay_font_scale', next))
                .then(() => store.save())
                .catch((e) => logError(`[overlay] save font scale failed: ${e?.toString?.() ?? String(e)}`));
        }, 250);
    }, []);

    const togglePin = useCallback(() => {
        setPinned((prev) => {
            const next = !prev;
            invoke('set_overlay_pinned', { pinned: next }).catch((e) => {
                setPinned((value) => (value === next ? !next : value));
                logError(`[overlay] set pin failed: ${e?.toString?.() ?? String(e)}`);
            });
            return next;
        });
    }, []);

    const cycleTheme = useCallback(() => {
        const current = overlayTheme || 'auto';
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
        setOverlayTheme(next);
        Promise.resolve()
            .then(() => store.set('overlay_theme', next))
            .then(() => store.save())
            .catch((e) => logError(`[overlay] save theme failed: ${e?.toString?.() ?? String(e)}`));
    }, [overlayTheme, setOverlayTheme]);

    const openSettings = useCallback(async () => {
        if (!pinned) {
            setPinned(true);
            try {
                await invoke('set_overlay_pinned', { pinned: true });
            } catch (e) {
                setPinned(false);
                logError(`[overlay] set pin failed: ${e?.toString?.() ?? String(e)}`);
            }
        }
        try {
            await invoke('open_config_window');
        } catch (e) {
            logError(`[overlay] open settings failed: ${e?.toString?.() ?? String(e)}`);
        }
    }, [pinned]);

    const reselect = useCallback(() => {
        invoke('restart_overlay_translate').catch((e) => {
            logError(`[overlay] restart selection failed: ${e?.toString?.() ?? String(e)}`);
        });
    }, []);

    const opacity = Math.min(1, Math.max(0.3, Number(overlayOpacity) || 0.85));
    const primaryFont = appFont === 'default' || !appFont ? DEFAULT_FONT_STACK : `"${appFont}"`;
    const fallbackFont =
        appFallbackFont === 'default' || !appFallbackFont ? DEFAULT_FONT_STACK : `"${appFallbackFont}"`;
    const fontFamily = `${primaryFont},${fallbackFont}`;

    const dpr = state?.dpr > 0 ? state.dpr : 1;
    const baseWidth = state ? state.width / dpr : viewport.width;
    const baseHeight = state ? state.height / dpr : viewport.height;
    const layout = toolbarLayout || {
        placement: 'none',
        offsetTop: 0,
        offsetLeft: 0,
        contentWidth: baseWidth,
        contentHeight: baseHeight,
    };

    const toolbarPlacement = layout.placement;
    const toolbarAtBottom = toolbarPlacement === 'bottom';
    const toolbarVisible = !locked && toolbarPlacement !== 'none';
    const statusBottom = toolbarAtBottom ? TOOLBAR_HEIGHT : 0;

    // Derive live content dimensions from the actual viewport while preserving
    // original selection size when the toolbar temporarily widens narrow regions.
    const extraHeight = toolbarPlacement === 'top' || toolbarPlacement === 'bottom' ? TOOLBAR_HEIGHT : 0;
    const contentTop = layout.offsetTop;
    const contentLeft = layout.offsetLeft ?? 0;
    const contentWidth = !toolbarVisible
        ? Math.max(1, toolbarLayout?.contentWidth > 0 ? toolbarLayout.contentWidth : baseWidth)
        : toolbarLayout?.windowWidth &&
            (Math.abs(viewport.width - layout.windowWidth / dpr) <= 2 || viewport.width < contentLeft + 20)
          ? layout.contentWidth
          : Math.max(1, viewport.width - contentLeft);
    const contentHeight = !toolbarVisible
        ? Math.max(1, toolbarLayout?.contentHeight > 0 ? toolbarLayout.contentHeight : baseHeight)
        : Math.max(
              1,
              toolbarPlacement === 'inside'
                  ? viewport.height - TOOLBAR_HEIGHT
                  : viewport.height - extraHeight
          );
    const compactSelection = contentHeight < 28 || contentWidth < 72;

    const hasMultipleChannels = Array.isArray(translateServiceList) && translateServiceList.filter(Boolean).length > 1;
    const effectiveThemeMode = overlayTheme || 'auto';

    const readyBlockCount = blocks.filter((b) => Boolean(b.translated) || Boolean(b.error)).length;
    const isRecognizing = phase === 'recognizing' && !status;
    const isTranslating = phase === 'translating' && displayMode === 'translation' && !status;
    const showLoadingOverlay = isRecognizing || isTranslating;
    const hasVisibleBlocks = displayMode === 'original' ? blocks.length > 0 : readyBlockCount > 0;
    const loadingLabel = isRecognizing
        ? t('overlay.recognizing')
        : blocks.length > 1 && readyBlockCount > 0
          ? `${t('overlay.translating')} (${readyBlockCount}/${blocks.length})`
          : t('overlay.translating');
    const visibleBlocks =
        displayMode === 'original' ? blocks : blocks.filter((b) => Boolean(b.translated) || Boolean(b.error));

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
            {toolbarVisible && (
                <OverlayToolbar
                    t={t}
                    toolbarAtBottom={toolbarAtBottom}
                    refreshing={refreshing}
                    displayMode={displayMode}
                    overlayTheme={effectiveThemeMode}
                    pinned={pinned}
                    hasMultipleChannels={hasMultipleChannels}
                    onRefresh={() => refreshRef.current?.()}
                    onReselect={reselect}
                    onSwitchChannel={switchChannel}
                    onAdjustFont={adjustFont}
                    onCopyText={copyText}
                    onToggleDisplayMode={() =>
                        setDisplayMode((mode) => (mode === 'original' ? 'translation' : 'original'))
                    }
                    onCycleTheme={cycleTheme}
                    onTogglePin={togglePin}
                    onLock={() => {
                        flushFontScaleSave();
                        setLocked(true);
                    }}
                />
            )}
            {pinned && locked && (
                <div
                    style={{
                        position: 'absolute',
                        top: 4,
                        right: 6,
                        zIndex: 9,
                        pointerEvents: 'none',
                        background: 'rgba(24,24,27,0.75)',
                        borderRadius: 4,
                        padding: 2,
                        color: '#fff',
                        display: 'flex',
                    }}
                >
                    <MdPushPin size={12} />
                </div>
            )}
            {visibleBlocks.map((block) => (
                <OverlayBlock
                    key={block.id}
                    block={block}
                    displayMode={displayMode}
                    contentLeft={contentLeft}
                    contentTop={contentTop}
                    contentWidth={contentWidth}
                    contentHeight={contentHeight}
                    baseFontSize={appFontSize}
                    fontScale={fontScale}
                    opacity={opacity}
                    overlayTheme={effectiveThemeMode}
                    resolvedTheme={resolvedTheme}
                    targetLang={state?.targetLang}
                    ocrLang={state?.ocrLang}
                    locked={locked}
                    t={t}
                    onRetryBlock={retryBlock}
                />
            ))}
            {showLoadingOverlay && (
                <div
                    style={{
                        position: 'absolute',
                        left: `${contentLeft}px`,
                        top: `${contentTop}px`,
                        width: `${contentWidth}px`,
                        height: `${contentHeight}px`,
                        boxSizing: 'border-box',
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: hasVisibleBlocks ? 'none' : '1px dashed rgba(56,189,248,0.85)',
                        background: hasVisibleBlocks ? 'transparent' : 'rgba(24,24,27,0.22)',
                        pointerEvents: 'none',
                        zIndex: 8,
                    }}
                >
                    <span
                        style={{
                            background: 'rgba(24,24,27,0.9)',
                            color: '#fff',
                            borderRadius: compactSelection ? 4 : 6,
                            padding: compactSelection ? '1px 4px' : '4px 10px',
                            fontSize: compactSelection ? 10 : 12,
                            maxWidth: '100%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.28)',
                        }}
                    >
                        {loadingLabel}
                    </span>
                </div>
            )}
            <OverlayStatusBar
                t={t}
                status={status}
                hasBlocks={blocks.length > 0}
                locked={locked}
                statusBottom={statusBottom}
                hotkeyLabel={state?.overlayHotkey || ''}
                onRetryOcr={retryOcr}
                onReselect={reselect}
                onOpenSettings={openSettings}
                onRetryAfterConfig={retryAfterConfig}
                onRetryFailed={() => retryFailed()}
                onSwitchChannel={switchChannel}
                onCopyError={copyError}
                onDismiss={() => setStatus(null)}
                onRefresh={() => refreshRef.current?.()}
            />
            {copyNotice && (
                <div
                    style={{
                        position: 'absolute',
                        left: '50%',
                        bottom: statusBottom + (status && blocks.length > 0 ? 44 : 8),
                        transform: 'translateX(-50%)',
                        background: 'rgba(24,24,27,0.92)',
                        color: '#fff',
                        borderRadius: 6,
                        padding: '4px 10px',
                        fontSize: 12,
                        pointerEvents: 'none',
                        zIndex: 13,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {copyNotice}
                </div>
            )}
        </div>
    );
}
