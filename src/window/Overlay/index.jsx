import { appWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api';
import { useTranslation } from 'react-i18next';
import { useTheme } from 'next-themes';
import { error as logError } from 'tauri-plugin-log-api';
import { MdPushPin } from 'react-icons/md';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { setConfigValue, store } from '../../utils/store';
import { computeOverlayContentRect, computeOverlayViewportFromState } from '../../utils/overlay_layout';
import { useConfig } from '../../hooks';
import { OverlayBlock } from './OverlayBlock';
import { OverlayStatusBar } from './OverlayStatusBar';
import { OverlayToolbar } from './OverlayToolbar';
import { useOverlaySession } from './useOverlaySession';

const TOOLBAR_HEIGHT = 32;
const DEFAULT_FONT_STACK =
    '"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Segoe UI",system-ui,sans-serif';

export default function Overlay() {
    const { t } = useTranslation();
    const { resolvedTheme } = useTheme();
    const [overlayOpacity] = useConfig('overlay_opacity', 0.85);
    const [overlayFontScale] = useConfig('overlay_font_scale', 1);
    const [overlayConcurrency] = useConfig('overlay_max_concurrency', 3);
    const [overlayTheme] = useConfig('overlay_theme', 'auto');
    const [translateServiceList] = useConfig('translate_service_list', []);
    const [appFontSize] = useConfig('app_font_size', 16);
    const [appFont] = useConfig('app_font', 'default');
    const [appFallbackFont] = useConfig('app_fallback_font', 'default');

    const [locked, setLocked] = useState(true);
    const [pinned, setPinned] = useState(false);
    const [toolbarExpanded, setToolbarExpanded] = useState(false);
    const [enabledChannels, setEnabledChannels] = useState(null);
    const [fontScale, setFontScale] = useState(1);
    const [displayMode, setDisplayMode] = useState('translation');
    const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

    const fontScaleRef = useRef(fontScale);
    const localFontEditedRef = useRef(false);
    const fontSaveTimerRef = useRef(null);
    fontScaleRef.current = fontScale;

    const loadEnabledChannels = useCallback(async () => {
        const list = Array.isArray(translateServiceList) ? translateServiceList.filter(Boolean) : [];
        const enabled = [];
        for (const instanceKey of list) {
            let config = {};
            try {
                config = (await store.get(instanceKey)) ?? {};
            } catch (e) {
                logError(`[overlay] read service config failed: ${e?.toString?.() ?? String(e)}`);
            }
            if (config['enable'] ?? true) {
                enabled.push(instanceKey);
            }
        }
        return enabled;
    }, [translateServiceList]);

    useEffect(() => {
        let disposed = false;
        void loadEnabledChannels().then((enabled) => {
            if (!disposed) {
                setEnabledChannels(enabled);
            }
        });
        return () => {
            disposed = true;
        };
    }, [loadEnabledChannels]);

    const session = useOverlaySession({
        t,
        translateServiceList,
        enabledChannels,
        loadEnabledChannels,
        overlayConcurrency,
        setLocked,
    });

    const {
        state,
        blocks,
        phase,
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
    refreshRef.current = refresh;
    copyTextRef.current = copyText;
    showNoticeRef.current = showNotice;

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
            setConfigValue('overlay_font_scale', value).catch((e) =>
                logError(`[overlay] save font scale failed: ${e?.toString?.() ?? String(e)}`)
            );
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
    }, [state]);

    useEffect(() => {
        let cancelled = false;
        const syncLockAndToolbar = async () => {
            try {
                await appWindow.setIgnoreCursorEvents(locked);
            } catch {
                // Keep syncing the toolbar state even if cursor ignore fails.
            }
            if (cancelled) {
                return;
            }
            try {
                // The toolbar is rendered inside the existing window; this call
                // only persists drag/resize geometry when the overlay is locked.
                await invoke('set_overlay_toolbar', { visible: !locked });
            } catch (e) {
                logError(`[overlay] toolbar sync failed: ${e?.toString?.() ?? String(e)}`);
            }
            if (!cancelled) {
                try {
                    const latest = await invoke('refresh_overlay_state');
                    if (!cancelled) {
                        setState(latest);
                    }
                } catch (e) {
                    logError(`[overlay] geometry refresh failed: ${e?.toString?.() ?? String(e)}`);
                }
            }
            if (!cancelled && !locked) {
                appWindow.setFocus().catch(() => {});
            }
        };
        void syncLockAndToolbar();
        return () => {
            cancelled = true;
        };
    }, [locked]);

    useEffect(() => {
        if (!locked || !state) {
            return;
        }
        invoke('set_overlay_toolbar', { visible: false }).catch((e) => {
            logError(`[overlay] locked geometry sync failed: ${e?.toString?.() ?? String(e)}`);
        });
    }, [locked, state?.width, state?.height, state?.toolbarPlacement, phase, blocks.length, status?.kind]);

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
            setConfigValue('overlay_font_scale', next).catch((e) =>
                logError(`[overlay] save font scale failed: ${e?.toString?.() ?? String(e)}`)
            );
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

    const {
        toolbarAtBottom,
        toolbarVisible,
        contentLeft,
        contentTop,
        contentWidth,
        contentHeight,
    } = computeOverlayContentRect({
        locked,
        viewport:
            locked || toolbarExpanded
                ? computeOverlayViewportFromState(state, viewport, TOOLBAR_HEIGHT)
                : viewport,
        placement: state?.toolbarPlacement || 'inside',
        toolbarHeight: TOOLBAR_HEIGHT,
    });
    const statusBottom = toolbarAtBottom ? TOOLBAR_HEIGHT : 0;
    // Keep the loading chip out of small selections: at high DPI even a
    // 168×60 physical-pixel selection is only 84×30 CSS px and cannot
    // comfortably contain the recognition/translation label.
    const compactSelection = contentHeight < 48 || contentWidth < 144;
    const compactToolbar = contentWidth < 190 || contentHeight < TOOLBAR_HEIGHT;

    const hasMultipleChannels = Array.isArray(enabledChannels) && enabledChannels.filter(Boolean).length > 1;
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
                    compactToolbar={compactToolbar}
                    selectionWidth={
                        Number(state?.width) > 0
                            ? Number(state.width) / (Number(state.dpr) > 0 ? Number(state.dpr) : 1)
                            : contentWidth
                    }
                    onExpandedChange={setToolbarExpanded}
                    displayMode={displayMode}
                    pinned={pinned}
                    hasMultipleChannels={hasMultipleChannels}
                    onSwitchChannel={switchChannel}
                    onAdjustFont={adjustFont}
                    onToggleDisplayMode={() =>
                        setDisplayMode((mode) => (mode === 'original' ? 'translation' : 'original'))
                    }
                    onTogglePin={togglePin}
                    onLock={() => {
                        setToolbarExpanded(false);
                        flushFontScaleSave();
                        setLocked(true);
                    }}
                />
            )}
            {pinned && locked && (
                <div
                    style={{
                        position: 'absolute',
                        top: contentTop + 4,
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
                    {compactSelection ? (
                        <span
                            aria-label={loadingLabel}
                            title={loadingLabel}
                            style={{
                                width: 6,
                                height: 6,
                                flex: '0 0 6px',
                                borderRadius: '50%',
                                background: 'rgba(56,189,248,0.95)',
                                boxShadow: '0 0 6px rgba(56,189,248,0.65)',
                            }}
                        />
                    ) : (
                        <span
                            style={{
                                minWidth: 0,
                                maxWidth: 'calc(100% - 8px)',
                                boxSizing: 'border-box',
                                background: 'rgba(24,24,27,0.9)',
                                color: '#fff',
                                borderRadius: 6,
                                padding: '4px 10px',
                                fontSize: 12,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                boxShadow: '0 2px 8px rgba(0,0,0,0.28)',
                            }}
                        >
                            {loadingLabel}
                        </span>
                    )}
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
