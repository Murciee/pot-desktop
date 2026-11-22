import { appWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/api/clipboard';
import { invoke } from '@tauri-apps/api';
import { useTranslation } from 'react-i18next';
import { info, error as logError } from 'tauri-plugin-log-api';
import {
    MdAdd,
    MdClose,
    MdContentCopy,
    MdCopyAll,
    MdLock,
    MdOutlinePushPin,
    MdPushPin,
    MdRefresh,
    MdRemove,
    MdTextSnippet,
    MdTranslate,
} from 'react-icons/md';
import React, { useEffect, useRef, useState } from 'react';

import { translateWithService } from '../../utils/translate_text';
import { mergeLineBoxes, normalizeBlocks } from '../../utils/overlay_layout';
import { recognizeOverlay } from '../../utils/overlay_ocr';
import { getServiceName } from '../../utils/service_instance';
import { store } from '../../utils/store';
import { useConfig } from '../../hooks';

const TOOLBAR_HEIGHT = 32;
const STATUS_HEIGHT = 38;
const TRANSLATION_TIMEOUT_MS = 30_000;
const COPY_NOTICE_MS = 1500;

function cleanErrorMessage(value, maxLength = 400) {
    let text = String(value ?? '');
    if (/<html|<title/i.test(text)) {
        const title = text.match(/<title[^>]*>(.*?)<\/title>/i)?.[1];
        text = title || text.replace(/<[^>]+>/g, ' ');
    }
    return text
        .replace(/<[^>]+>/g, ' ')
        .replace(/[^\S\r\n]+/g, ' ')
        .replace(/\s*\r?\n\s*/g, '\n')
        .trim()
        .slice(0, maxLength);
}

const TOOL_STYLE = {
    background: 'rgba(255,255,255,0.12)',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: 4,
    color: '#fff',
    fontSize: 12,
    lineHeight: '20px',
    width: 22,
    height: 22,
    padding: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flex: '0 0 auto',
};

const ACTIVE_TOOL_STYLE = {
    background: 'rgba(255,255,255,0.32)',
    borderColor: 'rgba(255,255,255,0.55)',
};

function ToolButton({ title, onClick, active = false, disabled = false, children }) {
    return (
        <button
            type='button'
            style={{
                ...TOOL_STYLE,
                ...(active ? ACTIVE_TOOL_STYLE : null),
                ...(disabled ? { opacity: 0.45, cursor: 'default' } : null),
            }}
            title={title}
            aria-label={title}
            aria-pressed={active || undefined}
            onClick={onClick}
            disabled={disabled}
        >
            {children}
        </button>
    );
}

function StatusButton({ label, onClick, primary = false }) {
    return (
        <button
            type='button'
            onClick={onClick}
            style={{
                border: '1px solid rgba(255,255,255,0.25)',
                background: primary ? '#fff' : 'rgba(255,255,255,0.08)',
                color: primary ? '#111' : '#fff',
                borderRadius: 4,
                fontSize: 11,
                lineHeight: '20px',
                padding: '0 8px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flex: '0 0 auto',
            }}
        >
            {label}
        </button>
    );
}

export default function Overlay() {
    const { t } = useTranslation();
    const [overlayOpacity] = useConfig('overlay_opacity', 0.85);
    const [overlayFontScale, setOverlayFontScale] = useConfig('overlay_font_scale', 1);
    const [overlayConcurrency] = useConfig('overlay_max_concurrency', 3);
    const [translateServiceList] = useConfig('translate_service_list', []);
    const [appFontSize] = useConfig('app_font_size', 16);
    const [appFont] = useConfig('app_font', 'default');
    const [appFallbackFont] = useConfig('app_fallback_font', 'default');

    const [state, setState] = useState(null);
    const [blocks, setBlocks] = useState([]);
    const [locked, setLocked] = useState(true);
    const [pinned, setPinned] = useState(false);
    const [toolbarLayout, setToolbarLayout] = useState(null);
    const [fontScale, setFontScale] = useState(1);
    const [displayMode, setDisplayMode] = useState('translation');
    const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
    const [refreshing, setRefreshing] = useState(false);
    const [status, setStatus] = useState(null);
    const [copyNotice, setCopyNotice] = useState('');

    const blockRefs = useRef(new Map());
    const disposedRef = useRef(false);
    const refreshingRef = useRef(false);
    const runningRef = useRef(false);
    const runRef = useRef(null);
    const refreshRef = useRef(null);
    const tRef = useRef(t);
    const concurrencyRef = useRef(overlayConcurrency);
    const fontScaleRef = useRef(fontScale);
    const blocksRef = useRef([]);
    const stateRef = useRef(null);
    const statusRef = useRef(null);
    const copyNoticeTimerRef = useRef(null);

    tRef.current = t;
    concurrencyRef.current = overlayConcurrency;
    fontScaleRef.current = fontScale;
    blocksRef.current = blocks;
    stateRef.current = state;
    statusRef.current = status;

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
                    const height = overlayState ? overlayState.height / dpr : viewport.height;
                    setToolbarLayout(
                        locked
                            ? { placement: 'none', offsetTop: 0, contentHeight: height }
                            : {
                                  placement: 'inside',
                                  offsetTop: TOOLBAR_HEIGHT,
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
        return () => {
            if (copyNoticeTimerRef.current) {
                clearTimeout(copyNoticeTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        const onKeyDown = (event) => {
            // Close on Esc whenever this window owns the keyboard. In
            // click-through mode it usually does not, so the app underneath
            // keeps Esc for itself.
            if (event.key === 'Escape') {
                event.preventDefault();
                appWindow.close();
                return;
            }
            if (!locked && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
                const selected = window.getSelection?.()?.toString?.() ?? '';
                if (!selected) {
                    event.preventDefault();
                    copyText('translation');
                }
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [locked]);

    function showNotice(text) {
        if (!text) {
            return;
        }
        setCopyNotice(text);
        if (copyNoticeTimerRef.current) {
            clearTimeout(copyNoticeTimerRef.current);
        }
        copyNoticeTimerRef.current = setTimeout(() => {
            if (!disposedRef.current) {
                setCopyNotice('');
            }
        }, COPY_NOTICE_MS);
    }

    async function safeShow() {
        try {
            await appWindow.show();
        } catch (e) {
            logError(`[overlay] show failed: ${e?.toString?.() ?? String(e)}`);
        }
        // The hidden capture phase is over; outside clicks may close again.
        invoke('set_overlay_busy', { busy: false }).catch((e) => {
            logError(`[overlay] clear busy failed: ${e?.toString?.() ?? String(e)}`);
        });
    }

    async function loadLatestOverlayState() {
        // The settings window writes the config file; reload the Rust store so
        // service/model/OCR changes apply to the next retry or refresh.
        try {
            await invoke('reload_store');
        } catch (e) {
            logError(`[overlay] reload store failed: ${e?.toString?.() ?? String(e)}`);
        }
        try {
            const latest = await invoke('refresh_overlay_state');
            setState(latest);
            stateRef.current = latest;
            return latest;
        } catch (e) {
            logError(`[overlay] refresh state failed: ${e?.toString?.() ?? String(e)}`);
            return stateRef.current;
        }
    }

    async function copyText(kind) {
        const list = blocksRef.current;
        let text = '';
        if (kind === 'original') {
            text = list
                .map((block) => (block.text || '').trim())
                .filter(Boolean)
                .join('\n');
        } else if (kind === 'all') {
            text = list
                .map((block) => {
                    const original = (block.text || '').trim();
                    const translated = (block.translated || '').trim();
                    if (original && translated) {
                        return `${original}\n${translated}`;
                    }
                    return original || translated;
                })
                .filter(Boolean)
                .join('\n\n');
        } else {
            text = list
                .map((block) => (block.translated || '').trim())
                .filter(Boolean)
                .join('\n');
        }
        if (!text) {
            showNotice(tRef.current('overlay.copy_empty'));
            return;
        }
        try {
            await writeText(text);
            showNotice(tRef.current('overlay.copied'));
        } catch (e) {
            logError(`[overlay] copy failed: ${e?.toString?.() ?? String(e)}`);
            showNotice(tRef.current('overlay.copy_failed'));
        }
    }

    function adjustFont(delta) {
        const next = Math.min(2, Math.max(0.5, Number((fontScaleRef.current + delta).toFixed(2))));
        fontScaleRef.current = next;
        setFontScale(next);
        setOverlayFontScale(next);
        // useConfig debounces its write; also persist immediately so closing the
        // overlay right after pressing +/- does not lose the new size.
        Promise.resolve()
            .then(() => store.set('overlay_font_scale', next))
            .then(() => store.save())
            .catch((e) => logError(`[overlay] save font scale failed: ${e?.toString?.() ?? String(e)}`));
    }

    function togglePin() {
        const next = !pinned;
        setPinned(next);
        invoke('set_overlay_pinned', { pinned: next }).catch((e) => {
            setPinned((value) => (value === next ? !next : value));
            logError(`[overlay] set pin failed: ${e?.toString?.() ?? String(e)}`);
        });
    }

    async function retryOcr() {
        if (!stateRef.current) {
            return;
        }
        showNotice(tRef.current('overlay.recognizing'));
        const latest = await loadLatestOverlayState();
        if (!latest) {
            return;
        }
        await runRef.current?.(latest);
    }

    async function openSettings() {
        // The click watcher treats clicks in the settings window as outside
        // clicks, so pin the overlay first; otherwise the first click closes it.
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
    }

    function reselect() {
        invoke('restart_overlay_translate').catch((e) => {
            logError(`[overlay] restart selection failed: ${e?.toString?.() ?? String(e)}`);
        });
    }

    async function copyError() {
        const currentStatus = statusRef.current;
        const detail = currentStatus?.detail || currentStatus?.message || '';
        if (!detail) {
            return;
        }
        try {
            await writeText(detail);
            showNotice(tRef.current('overlay.copied'));
        } catch (e) {
            logError(`[overlay] copy error failed: ${e?.toString?.() ?? String(e)}`);
            showNotice(tRef.current('overlay.copy_failed'));
        }
    }

    function buildDiagnostic(service, result) {
        const tr = tRef.current;
        return [
            `${tr('overlay.channel')}: ${service || '-'}`,
            result.lastError ? `${tr('overlay.error_detail')}: ${result.lastError}` : '',
            ...result.errors.slice(0, 8).map((item) => `- ${String(item.text || '').slice(0, 80)}: ${item.message}`),
            tr('overlay.troubleshooting'),
        ]
            .filter(Boolean)
            .join('\n');
    }

    async function translateBlocks(targets, service, model, targetLang, totalBlocks) {
        const tr = tRef.current;
        const pending = [...targets];
        const concurrency = Math.max(1, Math.min(10, Number(concurrencyRef.current) || 3));
        const workerCount = Math.min(concurrency, pending.length);
        const targetIds = new Set(targets.map((block) => block.id));
        let failed = 0;
        let lastError = '';
        const errors = [];

        if (pending.length === 0) {
            return { failed, total: totalBlocks, lastError, errors };
        }

        setBlocks((prev) =>
            prev.map((item) =>
                targetIds.has(item.id) ? { ...item, translated: '', error: false, errorMessage: undefined } : item
            )
        );

        const worker = async () => {
            while (pending.length > 0) {
                const block = pending.shift();
                try {
                    const value = await translateWithService(service, block.text, 'auto', targetLang, 'auto', model, {
                        timeoutMs: TRANSLATION_TIMEOUT_MS,
                        timeoutMessage: tr('overlay.request_timeout', {
                            seconds: TRANSLATION_TIMEOUT_MS / 1000,
                        }),
                    });
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
                            item.id === block.id ? { ...item, translated, error: false, errorMessage: undefined } : item
                        )
                    );
                } catch (e) {
                    failed += 1;
                    const rawError = e?.toString?.() ?? String(e);
                    const errorMessage = /\b429\b/.test(rawError)
                        ? tr('overlay.rate_limited')
                        : cleanErrorMessage(rawError) || tr('overlay.block_failed');
                    lastError = errorMessage;
                    errors.push({ text: block.text, message: errorMessage });
                    logError(`[overlay] translate failed: ${rawError}`);
                    if (disposedRef.current) {
                        return;
                    }
                    setBlocks((prev) =>
                        prev.map((item) => (item.id === block.id ? { ...item, error: true, errorMessage } : item))
                    );
                }
            }
        };

        await Promise.all(Array.from({ length: workerCount }, worker));
        return { failed, total: totalBlocks, lastError, errors };
    }

    function applyTranslationStatus(result, total, service) {
        if (result.failed === 0) {
            setStatus(null);
            return;
        }
        const tr = tRef.current;
        const totalCount = Math.max(total || 0, result.failed);
        const allFailed = totalCount > 0 && result.failed >= totalCount;
        const message = allFailed
            ? tr('overlay.all_failed')
            : tr('overlay.partial_failed', {
                  failed: result.failed,
                  total: totalCount,
              });
        setStatus({
            kind: allFailed ? 'all_failed' : 'partial_failed',
            message,
            detail: buildDiagnostic(service, result),
        });
        if (allFailed) {
            setLocked(false);
        }
    }

    async function executeOverlay(overlayState) {
        const tr = tRef.current;
        setStatus(null);
        setBlocks([]);

        let boxes;
        let plainText = '';
        let hasBoxes = false;
        try {
            const recognized = await recognizeOverlay(overlayState.ocrService, overlayState.ocrLang);
            hasBoxes = Array.isArray(recognized.boxes);
            if (hasBoxes) {
                boxes = recognized.boxes;
            } else {
                plainText = String(recognized.text ?? '').trim();
            }
        } catch (e) {
            if (disposedRef.current) {
                return;
            }
            const detail = cleanErrorMessage(e?.toString?.() ?? String(e), 1200);
            logError(`[overlay] OCR failed: ${detail}`);
            await safeShow();
            setStatus({
                kind: 'ocr_failed',
                message: tr('overlay.ocr_failed') ?? '',
                detail,
            });
            setLocked(false);
            return;
        }

        if (!hasBoxes && !plainText) {
            if (disposedRef.current) {
                return;
            }
            await safeShow();
            setStatus({ kind: 'no_text', message: tr('overlay.no_text') });
            setLocked(false);
            return;
        }

        let trimmed;
        if (!hasBoxes) {
            info('[overlay] OCR returned plain text, using a single block for the selection');
            trimmed = [
                {
                    x: 0,
                    y: 0,
                    w: overlayState.width,
                    h: overlayState.height,
                    text: plainText,
                },
            ];
        } else {
            info(`[overlay] OCR returned ${boxes.length} line boxes`);
            const merged = mergeLineBoxes(boxes);
            info(`[overlay] merged into ${merged.length} text blocks`);
            if (merged.length === 0) {
                if (disposedRef.current) {
                    return;
                }
                await safeShow();
                setStatus({ kind: 'no_text', message: tr('overlay.no_text') });
                setLocked(false);
                return;
            }
            // cut_image adds padding; OCR coordinates are relative to the padded image.
            trimmed = merged.map((block) => ({
                ...block,
                x: block.x - (overlayState.paddingLeft ?? Math.round(8 * (overlayState.dpr || 1))),
                y: block.y - (overlayState.paddingTop ?? Math.round(8 * (overlayState.dpr || 1))),
            }));
        }

        const normalized = normalizeBlocks(trimmed, overlayState.width, overlayState.height, overlayState.dpr).map(
            (block) => ({ ...block, translated: '', error: false })
        );

        if (disposedRef.current) {
            return;
        }
        setBlocks(normalized);
        await safeShow();

        if (!overlayState.service) {
            setBlocks(
                normalized.map((block) => ({
                    ...block,
                    error: true,
                    errorMessage: tr('overlay.no_service'),
                }))
            );
            setStatus({ kind: 'no_service', message: tr('overlay.no_service') });
            setLocked(false);
            return;
        }

        const result = await translateBlocks(
            normalized,
            overlayState.service,
            overlayState.model,
            overlayState.targetLang,
            normalized.length
        );
        if (disposedRef.current) {
            return;
        }
        applyTranslationStatus(result, normalized.length, overlayState.service);
    }

    const runOverlay = async (overlayState) => {
        if (runningRef.current) {
            return;
        }
        runningRef.current = true;
        try {
            await executeOverlay(overlayState);
        } catch (e) {
            logError(`[overlay] run failed: ${e?.toString?.() ?? String(e)}`);
            if (!disposedRef.current) {
                const detail = cleanErrorMessage(e?.toString?.() ?? String(e), 1200);
                setStatus({ kind: 'fatal', message: detail, detail });
                await safeShow();
            }
        } finally {
            runningRef.current = false;
        }
    };
    runRef.current = runOverlay;

    async function executeRetryFailed(serviceOverride) {
        const tr = tRef.current;
        const latest = await loadLatestOverlayState();
        const baseState = latest || stateRef.current;
        if (!baseState) {
            return;
        }
        const currentState = serviceOverride ? { ...baseState, service: serviceOverride, model: '' } : baseState;
        if (serviceOverride) {
            setState(currentState);
            stateRef.current = currentState;
        }
        const targets = blocksRef.current.filter((block) => block.error || !block.translated);
        if (targets.length === 0) {
            setStatus(null);
            return;
        }
        const service = serviceOverride || currentState.service;
        if (!service) {
            setStatus({ kind: 'no_service', message: tr('overlay.no_service') });
            setLocked(false);
            return;
        }
        const model = serviceOverride ? '' : currentState.model;
        setStatus(null);
        const result = await translateBlocks(
            targets,
            service,
            model,
            currentState.targetLang,
            blocksRef.current.length
        );
        if (disposedRef.current) {
            return;
        }
        applyTranslationStatus(result, blocksRef.current.length, service);
    }

    const retryFailed = async (serviceOverride) => {
        if (runningRef.current) {
            return;
        }
        runningRef.current = true;
        try {
            await executeRetryFailed(serviceOverride);
        } catch (e) {
            logError(`[overlay] retry failed: ${e?.toString?.() ?? String(e)}`);
            if (!disposedRef.current) {
                const detail = cleanErrorMessage(e?.toString?.() ?? String(e), 1200);
                setStatus({ kind: 'fatal', message: detail, detail });
                await safeShow();
            }
        } finally {
            runningRef.current = false;
        }
    };

    async function retryAfterConfig() {
        const latest = await loadLatestOverlayState();
        if (!latest) {
            return;
        }
        if (!latest.service) {
            setStatus({ kind: 'no_service', message: tRef.current('overlay.no_service') });
            setLocked(false);
            return;
        }
        await retryFailed();
    }

    async function switchChannel() {
        if (runningRef.current) {
            return;
        }
        const tr = tRef.current;
        const latest = await loadLatestOverlayState();
        const currentState = latest || stateRef.current;
        const list = Array.isArray(translateServiceList) ? translateServiceList.filter(Boolean) : [];
        if (!currentState || list.length === 0) {
            setStatus({ kind: 'no_service', message: tr('overlay.no_service') });
            setLocked(false);
            return;
        }
        const current = currentState.service;
        const index = list.indexOf(current);
        let next = null;
        for (let step = 1; step <= list.length; step += 1) {
            const candidate = list[(Math.max(index, -1) + step) % list.length];
            if (candidate && candidate !== current) {
                next = candidate;
                break;
            }
        }
        if (!next) {
            showNotice(tr('overlay.no_other_channel'));
            return;
        }
        try {
            // Make the switch stick for later retries and future overlays.
            await Promise.resolve()
                .then(() => store.set('overlay_service_instance', next))
                .then(() => store.save());
        } catch (e) {
            logError(`[overlay] save channel failed: ${e?.toString?.() ?? String(e)}`);
        }
        const nextState = currentState ? { ...currentState, service: next, model: '' } : currentState;
        setState(nextState);
        stateRef.current = nextState;
        showNotice(tr('overlay.switching_channel', { channel: getServiceName(next) }));
        await retryFailed(next);
    }

    const refresh = async () => {
        if (refreshingRef.current) {
            return;
        }
        if (runningRef.current) {
            showNotice(tRef.current('overlay.translating'));
            return;
        }
        refreshingRef.current = true;
        setRefreshing(true);
        setStatus(null);
        try {
            await invoke('set_overlay_busy', { busy: true });
        } catch (e) {
            logError(`[overlay] set busy failed: ${e?.toString?.() ?? String(e)}`);
        }
        try {
            const latest = await loadLatestOverlayState();
            const overlayState = latest || stateRef.current;
            if (!overlayState) {
                return;
            }
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
            await safeShow();
        } catch (e) {
            if (!disposedRef.current) {
                const detail = cleanErrorMessage(e?.toString?.() ?? String(e), 1200);
                setStatus({
                    kind: 'refresh_failed',
                    message: (tRef.current('overlay.refresh_failed') ?? '') + cleanErrorMessage(detail),
                    detail,
                });
                await safeShow();
            }
        } finally {
            refreshingRef.current = false;
            if (!disposedRef.current) {
                setRefreshing(false);
            }
            invoke('set_overlay_busy', { busy: false }).catch((e) => {
                logError(`[overlay] clear busy failed: ${e?.toString?.() ?? String(e)}`);
            });
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
                    await safeShow();
                    const detail = cleanErrorMessage(e?.toString?.() ?? String(e), 1200);
                    setStatus({
                        kind: 'fatal',
                        message: detail,
                        detail,
                    });
                    setLocked(false);
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

    // Every block keeps the original OCR box, and the font shrinks until the
    // translation fits inside it, so the overlay never grows past the selection.
    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            const overlayState = stateRef.current;
            if (!overlayState || blocks.length === 0) {
                return;
            }
            const dpr = overlayState.dpr > 0 ? overlayState.dpr : 1;
            const originalWidth = overlayState.width / dpr;
            const originalHeight = overlayState.height / dpr;
            const layout = toolbarLayout || {
                placement: 'none',
                offsetTop: 0,
                contentHeight: originalHeight,
            };
            const statusHeight = status && blocks.length > 0 ? STATUS_HEIGHT : 0;
            const availableHeight = Math.max(1, layout.contentHeight - statusHeight);
            const baseSize = Math.max(6, (Number(appFontSize) || 16) * fontScale);
            const minSize = 6;

            blocks.forEach((block) => {
                const element = blockRefs.current.get(block.id);
                if (!element) {
                    return;
                }
                const blockHeight = block.nh * availableHeight;
                const blockWidth = block.nw * originalWidth;
                const vertical = blockHeight > blockWidth * 1.5;
                const maxSize = Math.max(minSize, Math.min((vertical ? blockWidth : blockHeight) * 0.72, baseSize));

                element.style.overflow = 'hidden';
                let size = maxSize;
                element.style.fontSize = `${size}px`;
                let guard = 0;
                while (
                    size > minSize &&
                    guard < 60 &&
                    (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)
                ) {
                    size = Math.max(minSize, size - 0.5);
                    element.style.fontSize = `${size}px`;
                    guard += 1;
                }
            });
        });
        return () => cancelAnimationFrame(frame);
    }, [blocks, viewport, fontScale, appFontSize, state, locked, status, displayMode, toolbarLayout]);

    const opacity = Math.min(1, Math.max(0.3, Number(overlayOpacity) || 0.85));
    const fontFamily = `"${appFont === 'default' || !appFont ? 'sans-serif' : appFont}","${
        appFallbackFont === 'default' || !appFallbackFont ? 'sans-serif' : appFallbackFont
    }"`;

    const dpr = state?.dpr > 0 ? state.dpr : 1;
    const originalWidth = state ? state.width / dpr : viewport.width;
    const originalHeight = state ? state.height / dpr : viewport.height;
    const layout = toolbarLayout || {
        placement: 'none',
        offsetTop: 0,
        contentHeight: originalHeight,
    };
    const toolbarPlacement = layout.placement;
    const toolbarAtBottom = toolbarPlacement === 'bottom';
    const toolbarVisible = !locked && toolbarPlacement !== 'none';
    const statusHeight = status && blocks.length > 0 ? STATUS_HEIGHT : 0;
    const statusBottom = toolbarAtBottom ? TOOLBAR_HEIGHT : 0;
    const contentTop = layout.offsetTop;
    const contentHeight = Math.max(1, layout.contentHeight - statusHeight);

    function renderStatusActions() {
        if (!status) {
            return null;
        }
        switch (status.kind) {
            case 'ocr_failed':
            case 'no_text':
                return [
                    <StatusButton
                        key='retry'
                        label={t('overlay.retry')}
                        onClick={retryOcr}
                        primary
                    />,
                    <StatusButton
                        key='reselect'
                        label={t('overlay.reselect')}
                        onClick={reselect}
                    />,
                    <StatusButton
                        key='close'
                        label={t('overlay.close')}
                        onClick={() => appWindow.close()}
                    />,
                ];
            case 'no_service':
                return [
                    <StatusButton
                        key='settings'
                        label={t('overlay.open_settings')}
                        onClick={openSettings}
                        primary
                    />,
                    <StatusButton
                        key='retry'
                        label={t('overlay.retry')}
                        onClick={retryAfterConfig}
                    />,
                    <StatusButton
                        key='reselect'
                        label={t('overlay.reselect')}
                        onClick={reselect}
                    />,
                    <StatusButton
                        key='close'
                        label={t('overlay.close')}
                        onClick={() => appWindow.close()}
                    />,
                ];
            case 'all_failed':
                return [
                    <StatusButton
                        key='retry'
                        label={t('overlay.retry_failed')}
                        onClick={() => retryFailed()}
                        primary
                    />,
                    <StatusButton
                        key='switch'
                        label={t('overlay.switch_channel')}
                        onClick={switchChannel}
                    />,
                    <StatusButton
                        key='copy'
                        label={t('overlay.copy_error')}
                        onClick={copyError}
                    />,
                    <StatusButton
                        key='close'
                        label={t('overlay.close')}
                        onClick={() => appWindow.close()}
                    />,
                ];
            case 'partial_failed':
                return [
                    <StatusButton
                        key='retry'
                        label={t('overlay.retry_failed')}
                        onClick={() => retryFailed()}
                        primary
                    />,
                    <StatusButton
                        key='switch'
                        label={t('overlay.switch_channel')}
                        onClick={switchChannel}
                    />,
                    <StatusButton
                        key='copy'
                        label={t('overlay.copy_error')}
                        onClick={copyError}
                    />,
                    <StatusButton
                        key='dismiss'
                        label={t('overlay.dismiss')}
                        onClick={() => setStatus(null)}
                    />,
                ];
            case 'refresh_failed':
                return [
                    <StatusButton
                        key='retry'
                        label={t('overlay.retry')}
                        onClick={() => refreshRef.current?.()}
                        primary
                    />,
                    <StatusButton
                        key='close'
                        label={t('overlay.close')}
                        onClick={() => appWindow.close()}
                    />,
                ];
            default:
                return (
                    <StatusButton
                        key='close'
                        label={t('overlay.close')}
                        onClick={() => appWindow.close()}
                    />
                );
        }
    }

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
                <div
                    className='overlay-toolbar'
                    style={{
                        position: 'absolute',
                        top: toolbarAtBottom ? 'auto' : 0,
                        bottom: toolbarAtBottom ? 0 : 'auto',
                        left: 0,
                        right: 0,
                        height: TOOLBAR_HEIGHT,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 2,
                        padding: '0 4px',
                        overflowX: 'auto',
                        overflowY: 'hidden',
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
                    onWheel={(e) => {
                        if (e.currentTarget.scrollWidth > e.currentTarget.clientWidth) {
                            e.currentTarget.scrollLeft += e.deltaY;
                        }
                    }}
                >
                    <ToolButton
                        title={t('overlay.refresh')}
                        onClick={() => refreshRef.current?.()}
                        disabled={refreshing}
                    >
                        <MdRefresh size={16} />
                    </ToolButton>
                    <ToolButton
                        title={t('overlay.font_smaller')}
                        onClick={() => adjustFont(-0.1)}
                    >
                        <MdRemove size={14} />
                    </ToolButton>
                    <ToolButton
                        title={t('overlay.font_larger')}
                        onClick={() => adjustFont(0.1)}
                    >
                        <MdAdd size={14} />
                    </ToolButton>
                    <ToolButton
                        title={t('overlay.copy_translation')}
                        onClick={() => copyText('translation')}
                    >
                        <MdContentCopy size={15} />
                    </ToolButton>
                    <ToolButton
                        title={t('overlay.copy_original')}
                        onClick={() => copyText('original')}
                    >
                        <MdTextSnippet size={15} />
                    </ToolButton>
                    <ToolButton
                        title={t('overlay.copy_all')}
                        onClick={() => copyText('all')}
                    >
                        <MdCopyAll size={15} />
                    </ToolButton>
                    <ToolButton
                        title={displayMode === 'original' ? t('overlay.show_translation') : t('overlay.show_original')}
                        onClick={() => setDisplayMode((mode) => (mode === 'original' ? 'translation' : 'original'))}
                        active={displayMode === 'original'}
                    >
                        <MdTranslate size={15} />
                    </ToolButton>
                    <ToolButton
                        title={pinned ? t('overlay.unpin') : t('overlay.pin')}
                        onClick={togglePin}
                        active={pinned}
                    >
                        {pinned ? <MdPushPin size={15} /> : <MdOutlinePushPin size={15} />}
                    </ToolButton>
                    <ToolButton
                        title={t('overlay.lock')}
                        onClick={() => setLocked(true)}
                    >
                        <MdLock size={15} />
                    </ToolButton>
                    <div
                        style={{
                            position: 'sticky',
                            right: 0,
                            display: 'flex',
                            background: 'rgba(24,24,27,0.92)',
                            paddingLeft: 2,
                        }}
                    >
                        <ToolButton
                            title={t('overlay.close')}
                            onClick={() => appWindow.close()}
                        >
                            <MdClose size={16} />
                        </ToolButton>
                    </div>
                </div>
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
            {blocks.map((block) => {
                const showError = displayMode === 'translation' && block.error;
                const pending = displayMode === 'translation' && !block.translated && !block.error;
                const text =
                    displayMode === 'original'
                        ? block.text
                        : block.translated || (block.error ? t('overlay.block_failed') : t('overlay.translating'));
                const blockWidth = block.nw * originalWidth;
                const top = contentTop + block.ny * contentHeight;
                const blockHeight = block.nh * contentHeight;
                const vertical = blockHeight > blockWidth * 1.5;
                return (
                    <div
                        key={block.id}
                        dir='auto'
                        title={showError ? block.errorMessage : undefined}
                        ref={(element) => {
                            if (element) {
                                blockRefs.current.set(block.id, element);
                            } else {
                                blockRefs.current.delete(block.id);
                            }
                        }}
                        style={{
                            position: 'absolute',
                            left: `${block.nx * originalWidth}px`,
                            top: `${top}px`,
                            width: `${blockWidth}px`,
                            height: `${blockHeight}px`,
                            boxSizing: 'border-box',
                            padding: '2px 4px',
                            background: `rgba(255,255,255,${opacity})`,
                            border: showError ? '1px dashed rgba(220,38,38,0.9)' : '1px solid rgba(0,0,0,0.15)',
                            borderRadius: 4,
                            color: showError
                                ? '#b91c1c'
                                : block.translated || displayMode === 'original'
                                  ? '#111'
                                  : '#52525b',
                            fontStyle: pending ? 'italic' : 'normal',
                            lineHeight: 1.15,
                            overflow: 'visible',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                            wordBreak: 'normal',
                            writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
                            textAlign: 'start',
                            fontSize: 16,
                            userSelect: locked ? 'none' : 'text',
                        }}
                    >
                        {text}
                    </div>
                );
            })}
            {status && blocks.length > 0 && (
                <div
                    className='overlay-toolbar'
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: statusBottom,
                        height: STATUS_HEIGHT,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '0 8px',
                        overflowX: 'auto',
                        overflowY: 'hidden',
                        background: 'rgba(24,24,27,0.92)',
                        color: '#fff',
                        fontSize: 11,
                        zIndex: 11,
                        pointerEvents: locked ? 'none' : 'auto',
                    }}
                    onWheel={(e) => {
                        if (e.currentTarget.scrollWidth > e.currentTarget.clientWidth) {
                            e.currentTarget.scrollLeft += e.deltaY;
                        }
                    }}
                >
                    <span
                        title={status.detail || status.message}
                        style={{
                            flex: '1 1 auto',
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {status.message}
                    </span>
                    {locked ? (
                        <span style={{ flex: '0 0 auto', opacity: 0.7 }}>{t('overlay.unlock_hint')}</span>
                    ) : (
                        <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>{renderStatusActions()}</div>
                    )}
                </div>
            )}
            {status && blocks.length === 0 && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 16,
                        zIndex: 12,
                        pointerEvents: 'none',
                    }}
                >
                    <div
                        style={{
                            background: 'rgba(24,24,27,0.94)',
                            color: '#fff',
                            borderRadius: 8,
                            padding: '12px 14px',
                            maxWidth: '100%',
                            maxHeight: '100%',
                            overflow: 'auto',
                            boxSizing: 'border-box',
                            fontSize: 13,
                            lineHeight: 1.5,
                            pointerEvents: locked ? 'none' : 'auto',
                            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                        }}
                    >
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('overlay.title')}</div>
                        <div style={{ wordBreak: 'break-word' }}>{status.message}</div>
                        {status.detail && (
                            <div
                                style={{
                                    marginTop: 6,
                                    maxHeight: 90,
                                    overflow: 'auto',
                                    opacity: 0.75,
                                    fontSize: 11,
                                    whiteSpace: 'pre-wrap',
                                }}
                            >
                                {status.detail}
                            </div>
                        )}
                        {!locked && (
                            <div
                                style={{
                                    display: 'flex',
                                    gap: 6,
                                    marginTop: 10,
                                    flexWrap: 'wrap',
                                }}
                            >
                                {renderStatusActions()}
                            </div>
                        )}
                        {locked && (
                            <div style={{ marginTop: 8, opacity: 0.7, fontSize: 11 }}>{t('overlay.unlock_hint')}</div>
                        )}
                    </div>
                </div>
            )}
            {copyNotice && (
                <div
                    style={{
                        position: 'absolute',
                        left: '50%',
                        bottom: statusBottom + statusHeight + 8,
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
