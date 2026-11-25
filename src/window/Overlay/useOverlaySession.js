import { appWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api';
import { writeText } from '@tauri-apps/api/clipboard';
import { info, error as logError } from 'tauri-plugin-log-api';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
    formatBatchPrompt,
    isBatchFriendlyService,
    mergeLineBoxes,
    normalizeBlocks,
    parseBatchTranslation,
    shouldSkipTranslation,
} from '../../utils/overlay_layout';
import { recognizeOverlay } from '../../utils/overlay_ocr';
import { getServiceName } from '../../utils/service_instance';
import { setConfigValue } from '../../utils/store';
import {
    seedTranslateCache,
    translateWithService,
} from '../../utils/translate_text';

const TRANSLATION_TIMEOUT_MS = 30_000;
const BATCH_MAX_BLOCKS = 8;
const BATCH_MAX_CHARS = 1500;
const COPY_NOTICE_MS = 1500;

export function cleanErrorMessage(value, maxLength = 400) {
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

function buildDiagnostic(tr, service, result) {
    return [
        `${tr('overlay.channel')}: ${service || '-'}`,
        result.lastError ? `${tr('overlay.error_detail')}: ${result.lastError}` : '',
        ...result.errors.slice(0, 8).map((item) => `- ${String(item.text || '').slice(0, 80)}: ${item.message}`),
        tr('overlay.troubleshooting'),
    ]
        .filter(Boolean)
        .join('\n');
}

function chunkTargetsForBatch(targets) {
    const chunks = [];
    let current = [];
    let chars = 0;

    for (const block of targets) {
        const len = String(block.text ?? '').length;
        if (current.length > 0 && (current.length >= BATCH_MAX_BLOCKS || chars + len > BATCH_MAX_CHARS)) {
            chunks.push(current);
            current = [];
            chars = 0;
        }
        current.push(block);
        chars += len;
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
}

export function useOverlaySession({ t, translateServiceList, overlayConcurrency, setLocked }) {
    const [state, setState] = useState(null);
    const [blocks, setBlocks] = useState([]);
    const [phase, setPhase] = useState('idle');
    const [refreshing, setRefreshing] = useState(false);
    const [status, setStatus] = useState(null);
    const [copyNotice, setCopyNotice] = useState('');

    const disposedRef = useRef(false);
    const runIdRef = useRef(0);
    const abortControllerRef = useRef(null);
    const busyRef = useRef(false);
    const tRef = useRef(t);
    const concurrencyRef = useRef(overlayConcurrency);
    const blocksRef = useRef([]);
    const stateRef = useRef(null);
    const statusRef = useRef(null);
    const copyNoticeTimerRef = useRef(null);

    tRef.current = t;
    concurrencyRef.current = overlayConcurrency;
    blocksRef.current = blocks;
    stateRef.current = state;
    statusRef.current = status;

    useEffect(() => {
        return () => {
            disposedRef.current = true;
            runIdRef.current += 1;
            abortControllerRef.current?.abort();
            if (copyNoticeTimerRef.current) {
                clearTimeout(copyNoticeTimerRef.current);
            }
        };
    }, []);

    const showNotice = useCallback((text) => {
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
    }, []);

    const safeShow = useCallback(async () => {
        try {
            await appWindow.show();
        } catch (e) {
            logError(`[overlay] show failed: ${e?.toString?.() ?? String(e)}`);
        }
        invoke('set_overlay_busy', { busy: false }).catch((e) => {
            logError(`[overlay] clear busy failed: ${e?.toString?.() ?? String(e)}`);
        });
    }, []);

    const loadLatestOverlayState = useCallback(async () => {
        try {
            const latest = await invoke('refresh_overlay_state');
            if (!disposedRef.current) {
                setState(latest);
            }
            stateRef.current = latest;
            return latest;
        } catch (e) {
            logError(`[overlay] refresh state failed: ${e?.toString?.() ?? String(e)}`);
            return stateRef.current;
        }
    }, []);

    const applyTranslationStatus = useCallback(
        (result, total, service) => {
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
                detail: buildDiagnostic(tr, service, result),
            });
            if (allFailed) {
                setLocked(false);
            }
        },
        [setLocked]
    );

    const translateSingleBlock = useCallback(async (block, service, model, targetLang, signal, skipCache) => {
        const tr = tRef.current;
        const value = await translateWithService(service, block.text, 'auto', targetLang, 'auto', model, {
            timeoutMs: TRANSLATION_TIMEOUT_MS,
            timeoutMessage: tr('overlay.request_timeout', {
                seconds: TRANSLATION_TIMEOUT_MS / 1000,
            }),
            signal,
            skipCache,
        });
        if (typeof value !== 'string') {
            throw new Error('Translation service returned a non-text result');
        }
        const translated = value.trim();
        if (translated === '') {
            throw new Error('Translation service returned empty text');
        }
        return translated;
    }, []);

    const translateBlocks = useCallback(
        async (targets, service, model, targetLang, totalBlocks, runId, signal, options = {}) => {
            const tr = tRef.current;
            const skipCache = Boolean(options.skipCache);
            const isStale = () => disposedRef.current || runIdRef.current !== runId || signal.aborted;

            const skippedUpdates = new Map();
            const needTranslate = [];
            for (const block of targets) {
                if (shouldSkipTranslation(block.text, targetLang)) {
                    skippedUpdates.set(block.id, block.text);
                } else {
                    needTranslate.push(block);
                }
            }

            if (targets.length > 0) {
                const targetIds = new Set(targets.map((b) => b.id));
                setBlocks((prev) =>
                    prev.map((item) => {
                        if (!targetIds.has(item.id)) {
                            return item;
                        }
                        if (skippedUpdates.has(item.id)) {
                            return {
                                ...item,
                                translated: skippedUpdates.get(item.id),
                                error: false,
                                errorMessage: undefined,
                            };
                        }
                        return { ...item, translated: '', error: false, errorMessage: undefined };
                    })
                );
            }

            if (needTranslate.length === 0) {
                return { failed: 0, total: totalBlocks, lastError: '', errors: [] };
            }

            let failed = 0;
            let lastError = '';
            const errors = [];
            const concurrency = Math.max(1, Math.min(10, Number(concurrencyRef.current) || 3));
            const serviceName = getServiceName(service);

            const translateIndividually = async (list) => {
                const pending = [...list];
                const workerCount = Math.min(concurrency, pending.length);
                const worker = async () => {
                    while (pending.length > 0) {
                        if (isStale()) {
                            return;
                        }
                        const block = pending.shift();
                        try {
                            const translated = await translateSingleBlock(
                                block,
                                service,
                                model,
                                targetLang,
                                signal,
                                skipCache
                            );
                            if (isStale()) {
                                return;
                            }
                            setBlocks((prev) =>
                                prev.map((item) =>
                                    item.id === block.id
                                        ? { ...item, translated, error: false, errorMessage: undefined }
                                        : item
                                )
                            );
                        } catch (e) {
                            if (isStale() || e?.name === 'AbortError') {
                                return;
                            }
                            failed += 1;
                            const rawError = e?.toString?.() ?? String(e);
                            const errorMessage = /\b429\b/.test(rawError)
                                ? tr('overlay.rate_limited')
                                : cleanErrorMessage(rawError) || tr('overlay.block_failed');
                            lastError = errorMessage;
                            errors.push({ text: block.text, message: errorMessage });
                            logError(`[overlay] translate failed: ${rawError}`);
                            setBlocks((prev) =>
                                prev.map((item) =>
                                    item.id === block.id ? { ...item, error: true, errorMessage } : item
                                )
                            );
                        }
                    }
                };
                await Promise.all(Array.from({ length: workerCount }, worker));
            };

            const canBatch = !skipCache && needTranslate.length >= 2 && isBatchFriendlyService(serviceName);
            if (!canBatch) {
                await translateIndividually(needTranslate);
                return { failed, total: totalBlocks, lastError, errors };
            }

            const chunks = chunkTargetsForBatch(needTranslate);
            const fallbackBlocks = [];
            const chunkQueue = [...chunks];
            const chunkWorkers = Math.min(concurrency, chunkQueue.length);

            const runChunkWorker = async () => {
                while (chunkQueue.length > 0) {
                    if (isStale()) {
                        return;
                    }
                    const chunk = chunkQueue.shift();
                    if (chunk.length === 1) {
                        fallbackBlocks.push(chunk[0]);
                        continue;
                    }
                    try {
                        const prompt = formatBatchPrompt(chunk.map((b) => b.text));
                        const raw = await translateWithService(service, prompt, 'auto', targetLang, 'auto', model, {
                            timeoutMs: TRANSLATION_TIMEOUT_MS,
                            timeoutMessage: tr('overlay.request_timeout', {
                                seconds: TRANSLATION_TIMEOUT_MS / 1000,
                            }),
                            signal,
                            skipCache: true,
                        });
                        if (isStale()) {
                            return;
                        }
                        const parsed = parseBatchTranslation(raw, chunk.length);
                        if (!parsed) {
                            fallbackBlocks.push(...chunk);
                            continue;
                        }
                        const updates = new Map();
                        for (let i = 0; i < chunk.length; i += 1) {
                            updates.set(chunk[i].id, parsed[i]);
                            void seedTranslateCache(service, chunk[i].text, 'auto', targetLang, model, parsed[i]);
                        }
                        setBlocks((prev) =>
                            prev.map((item) =>
                                updates.has(item.id)
                                    ? {
                                          ...item,
                                          translated: updates.get(item.id),
                                          error: false,
                                          errorMessage: undefined,
                                      }
                                    : item
                            )
                        );
                    } catch (e) {
                        if (isStale() || e?.name === 'AbortError') {
                            return;
                        }
                        logError(`[overlay] batch translate fallback: ${e?.toString?.() ?? String(e)}`);
                        fallbackBlocks.push(...chunk);
                    }
                }
            };

            await Promise.all(Array.from({ length: chunkWorkers }, runChunkWorker));
            if (!isStale() && fallbackBlocks.length > 0) {
                await translateIndividually(fallbackBlocks);
            }
            return { failed, total: totalBlocks, lastError, errors };
        },
        [translateSingleBlock]
    );

    const runOverlay = useCallback(
        async (overlayState) => {
            if (busyRef.current) {
                return;
            }
            busyRef.current = true;
            runIdRef.current += 1;
            const runId = runIdRef.current;
            abortControllerRef.current?.abort();
            const controller = new AbortController();
            abortControllerRef.current = controller;
            const isStale = () => disposedRef.current || runIdRef.current !== runId || controller.signal.aborted;

            const tr = tRef.current;
            setStatus(null);
            setBlocks([]);
            setPhase('recognizing');

            try {
                const padLeft = overlayState.paddingLeft ?? Math.round(8 * (overlayState.dpr || 1));
                const padTop = overlayState.paddingTop ?? Math.round(8 * (overlayState.dpr || 1));
                const ocrServiceName = getServiceName(overlayState.ocrService || 'system');
                const analysisPromise =
                    ocrServiceName !== 'system'
                        ? invoke('analyze_overlay_image', {
                              paddingLeft: padLeft,
                              paddingTop: padTop,
                              width: overlayState.width,
                              height: overlayState.height,
                          }).catch((e) => {
                              logError(`[overlay] analyze image failed: ${e?.toString?.() ?? String(e)}`);
                              return null;
                          })
                        : null;

                let boxes;
                let plainText = '';
                let hasBoxes = false;
                try {
                    const recognized = await recognizeOverlay(overlayState.ocrService, overlayState.ocrLang);
                    if (isStale()) {
                        return;
                    }
                    hasBoxes = Array.isArray(recognized.boxes);
                    if (hasBoxes) {
                        boxes = recognized.boxes;
                    } else {
                        plainText = String(recognized.text ?? '').trim();
                    }
                } catch (e) {
                    if (isStale()) {
                        return;
                    }
                    const detail = cleanErrorMessage(e?.toString?.() ?? String(e), 1200);
                    logError(`[overlay] OCR failed: ${detail}`);
                    setPhase('ready');
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
                    if (isStale()) {
                        return;
                    }
                    setPhase('ready');
                    await safeShow();
                    setStatus({ kind: 'no_text', message: tr('overlay.no_text') });
                    setLocked(false);
                    return;
                }

                let trimmed;
                if (!hasBoxes) {
                    let analysis = null;
                    if (analysisPromise) {
                        analysis = await analysisPromise;
                    } else {
                        try {
                            analysis = await invoke('analyze_overlay_image', {
                                paddingLeft: padLeft,
                                paddingTop: padTop,
                                width: overlayState.width,
                                height: overlayState.height,
                            });
                        } catch (e) {
                            logError(`[overlay] analyze image failed: ${e?.toString?.() ?? String(e)}`);
                        }
                    }
                    if (isStale()) {
                        return;
                    }
                    info(
                        analysis
                            ? `[overlay] OCR returned plain text, image analysis detected ${
                                  analysis.vertical ? 'vertical' : 'horizontal'
                              } ${analysis.lineCount} lines`
                            : '[overlay] OCR returned plain text, using a single block for the selection'
                    );
                    // A plain-text engine cannot place the individual lines, so the
                    // translation must cover the whole selected region (otherwise the
                    // overlay ends up visibly smaller than the box the user drew).
                    // The image analysis is only used to match font size, direction
                    // and colours.
                    trimmed = [
                        {
                            x: 0,
                            y: 0,
                            w: overlayState.width,
                            h: overlayState.height,
                            text: plainText,
                            vertical: Boolean(analysis?.vertical),
                            lineSize: analysis?.lineSize ?? null,
                            lineCount: analysis?.lineCount || 1,
                            bgColor: analysis?.bgColor ?? null,
                            fgColor: analysis?.fgColor ?? null,
                            fontWeight: analysis?.fontWeight || 400,
                        },
                    ];
                } else {
                    info(`[overlay] OCR returned ${boxes.length} line boxes`);
                    const merged = mergeLineBoxes(boxes);
                    info(`[overlay] merged into ${merged.length} text blocks`);
                    if (merged.length === 0) {
                        if (isStale()) {
                            return;
                        }
                        setPhase('ready');
                        await safeShow();
                        setStatus({ kind: 'no_text', message: tr('overlay.no_text') });
                        setLocked(false);
                        return;
                    }
                    trimmed = merged.map((block) => ({
                        ...block,
                        x: block.x - padLeft,
                        y: block.y - padTop,
                    }));
                }

                const normalized = normalizeBlocks(
                    trimmed,
                    overlayState.width,
                    overlayState.height,
                    overlayState.dpr
                ).map((block) => ({ ...block, translated: '', error: false }));

                if (isStale()) {
                    return;
                }
                setBlocks(normalized);
                setPhase('translating');
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
                    setPhase('ready');
                    return;
                }

                const result = await translateBlocks(
                    normalized,
                    overlayState.service,
                    overlayState.model,
                    overlayState.targetLang,
                    normalized.length,
                    runId,
                    controller.signal
                );
                if (isStale()) {
                    return;
                }
                applyTranslationStatus(result, normalized.length, overlayState.service);
                setPhase('ready');
            } catch (e) {
                logError(`[overlay] run failed: ${e?.toString?.() ?? String(e)}`);
                if (!isStale()) {
                    const detail = cleanErrorMessage(e?.toString?.() ?? String(e), 1200);
                    setStatus({ kind: 'fatal', message: detail, detail });
                    setPhase('ready');
                    await safeShow();
                }
            } finally {
                if (runIdRef.current === runId) {
                    busyRef.current = false;
                }
            }
        },
        [applyTranslationStatus, safeShow, setLocked, translateBlocks]
    );

    const retryFailed = useCallback(
        async (serviceOverride, options = {}) => {
            if (busyRef.current) {
                return;
            }
            const forceAll = Boolean(options.forceAll);
            busyRef.current = true;
            runIdRef.current += 1;
            const runId = runIdRef.current;
            abortControllerRef.current?.abort();
            const controller = new AbortController();
            abortControllerRef.current = controller;
            const isStale = () => disposedRef.current || runIdRef.current !== runId || controller.signal.aborted;

            try {
                const tr = tRef.current;
                const latest = await loadLatestOverlayState();
                const baseState = latest || stateRef.current;
                if (!baseState || isStale()) {
                    return;
                }
                const currentState = serviceOverride
                    ? { ...baseState, service: serviceOverride, model: '' }
                    : baseState;
                if (serviceOverride) {
                    setState(currentState);
                    stateRef.current = currentState;
                }
                const targets = forceAll
                    ? blocksRef.current
                    : blocksRef.current.filter((block) => block.error || !block.translated);
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
                setPhase('translating');
                const result = await translateBlocks(
                    targets,
                    service,
                    model,
                    currentState.targetLang,
                    blocksRef.current.length,
                    runId,
                    controller.signal,
                    { skipCache: true }
                );
                if (isStale()) {
                    return;
                }
                applyTranslationStatus(result, blocksRef.current.length, service);
                setPhase('ready');
            } catch (e) {
                logError(`[overlay] retry failed: ${e?.toString?.() ?? String(e)}`);
                if (!isStale()) {
                    const detail = cleanErrorMessage(e?.toString?.() ?? String(e), 1200);
                    setStatus({ kind: 'fatal', message: detail, detail });
                    setPhase('ready');
                    await safeShow();
                }
            } finally {
                if (runIdRef.current === runId) {
                    busyRef.current = false;
                }
            }
        },
        [applyTranslationStatus, loadLatestOverlayState, safeShow, setLocked, translateBlocks]
    );

    const retryBlock = useCallback(
        async (blockId) => {
            if (busyRef.current) {
                return;
            }
            const target = blocksRef.current.find((b) => b.id === blockId);
            const currentState = stateRef.current;
            if (!target || !currentState?.service) {
                return;
            }
            const tr = tRef.current;
            const runId = runIdRef.current;
            const signal = abortControllerRef.current?.signal ?? new AbortController().signal;

            setBlocks((prev) =>
                prev.map((item) =>
                    item.id === blockId ? { ...item, translated: '', error: false, errorMessage: undefined } : item
                )
            );
            setPhase('translating');

            try {
                const translated = await translateSingleBlock(
                    target,
                    currentState.service,
                    currentState.model,
                    currentState.targetLang,
                    signal,
                    true
                );
                if (disposedRef.current || runIdRef.current !== runId) {
                    return;
                }
                const nextBlocks = blocksRef.current.map((item) =>
                    item.id === blockId ? { ...item, translated, error: false, errorMessage: undefined } : item
                );
                setBlocks(nextBlocks);
                const remainingFailed = nextBlocks.filter((b) => b.error).length;
                if (remainingFailed === 0) {
                    setStatus(null);
                } else {
                    applyTranslationStatus(
                        { failed: remainingFailed, total: nextBlocks.length, lastError: '', errors: [] },
                        nextBlocks.length,
                        currentState.service
                    );
                }
            } catch (e) {
                if (disposedRef.current || runIdRef.current !== runId || e?.name === 'AbortError') {
                    return;
                }
                const rawError = e?.toString?.() ?? String(e);
                const errorMessage = /\b429\b/.test(rawError)
                    ? tr('overlay.rate_limited')
                    : cleanErrorMessage(rawError) || tr('overlay.block_failed');
                setBlocks((prev) =>
                    prev.map((item) => (item.id === blockId ? { ...item, error: true, errorMessage } : item))
                );
            } finally {
                if (!disposedRef.current && runIdRef.current === runId) {
                    setPhase('ready');
                }
            }
        },
        [applyTranslationStatus, translateSingleBlock]
    );

    const retryOcr = useCallback(async () => {
        if (!stateRef.current || busyRef.current) {
            return;
        }
        const latest = await loadLatestOverlayState();
        if (!latest || disposedRef.current) {
            return;
        }
        await runOverlay(latest);
    }, [loadLatestOverlayState, runOverlay]);

    const retryAfterConfig = useCallback(async () => {
        const latest = await loadLatestOverlayState();
        if (!latest || disposedRef.current) {
            return;
        }
        if (!latest.service) {
            setStatus({ kind: 'no_service', message: tRef.current('overlay.no_service') });
            setLocked(false);
            return;
        }
        await retryFailed();
    }, [loadLatestOverlayState, retryFailed, setLocked]);

    const switchChannel = useCallback(async () => {
        if (busyRef.current) {
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
            await setConfigValue('overlay_service_instance', next);
        } catch (e) {
            logError(`[overlay] save channel failed: ${e?.toString?.() ?? String(e)}`);
        }
        const nextState = { ...currentState, service: next, model: '' };
        setState(nextState);
        stateRef.current = nextState;
        showNotice(tr('overlay.switching_channel', { channel: getServiceName(next) }));
        const allTranslated =
            blocksRef.current.length > 0 && blocksRef.current.every((b) => !b.error && b.translated);
        await retryFailed(next, { forceAll: allTranslated });
    }, [loadLatestOverlayState, retryFailed, setLocked, showNotice, translateServiceList]);

    const refresh = useCallback(async () => {
        if (busyRef.current) {
            showNotice(tRef.current('overlay.translating'));
            return;
        }
        setRefreshing(true);
        setStatus(null);
        try {
            await invoke('set_overlay_busy', { busy: true });
        } catch (e) {
            logError(`[overlay] set busy failed: ${e?.toString?.() ?? String(e)}`);
        }
        try {
            let syncedState = null;
            try {
                syncedState = await invoke('sync_overlay_geometry');
            } catch (e) {
                logError(`[overlay] sync geometry failed: ${e?.toString?.() ?? String(e)}`);
            }
            const latest = await loadLatestOverlayState();
            const overlayState = latest || syncedState || stateRef.current;
            if (!overlayState || disposedRef.current) {
                return;
            }
            await appWindow.hide();
            await new Promise((resolve) => setTimeout(resolve, 110));
            const cropInfo = await invoke('capture_overlay_region', {
                monitorX: overlayState.monitorX,
                monitorY: overlayState.monitorY,
                left: overlayState.left,
                top: overlayState.top,
                width: overlayState.width,
                height: overlayState.height,
                scaleFactor: overlayState.dpr || 1,
            });
            const refreshedState = {
                ...overlayState,
                paddingLeft: cropInfo.paddingLeft,
                paddingTop: cropInfo.paddingTop,
            };
            if (disposedRef.current) {
                return;
            }
            setState(refreshedState);
            stateRef.current = refreshedState;
            setBlocks([]);
            setPhase('recognizing');
            await safeShow();
            await runOverlay(refreshedState);
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
            if (!disposedRef.current) {
                setRefreshing(false);
            }
            invoke('set_overlay_busy', { busy: false }).catch((e) => {
                logError(`[overlay] clear busy failed: ${e?.toString?.() ?? String(e)}`);
            });
        }
    }, [loadLatestOverlayState, runOverlay, safeShow, showNotice]);

    const copyText = useCallback(
        async (kind) => {
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
        },
        [showNotice]
    );

    const copyError = useCallback(async () => {
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
    }, [showNotice]);

    const init = useCallback(async () => {
        try {
            const overlayState = await invoke('get_overlay_state');
            if (disposedRef.current) {
                return;
            }
            setState(overlayState);
            stateRef.current = overlayState;
            setPhase('recognizing');
            await safeShow();
            await runOverlay(overlayState);
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
    }, [runOverlay, safeShow, setLocked]);

    return {
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
    };
}
