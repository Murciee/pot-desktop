import { appWindow } from '@tauri-apps/api/window';
import React from 'react';

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

export function OverlayStatusBar({
    t,
    status,
    hasBlocks,
    locked,
    statusBottom,
    hotkeyLabel,
    onRetryOcr,
    onReselect,
    onOpenSettings,
    onRetryAfterConfig,
    onRetryFailed,
    onSwitchChannel,
    onCopyError,
    onDismiss,
    onRefresh,
}) {
    if (!status) {
        return null;
    }

    const unlockHint = hotkeyLabel
        ? t('overlay.unlock_hint_with_key', { hotkey: hotkeyLabel })
        : t('overlay.unlock_hint_no_key');

    const renderActions = () => {
        switch (status.kind) {
            case 'ocr_failed':
            case 'no_text':
                return [
                    <StatusButton key='retry' label={t('overlay.retry')} onClick={onRetryOcr} primary />,
                    <StatusButton key='reselect' label={t('overlay.reselect')} onClick={onReselect} />,
                    <StatusButton key='close' label={t('overlay.close')} onClick={() => appWindow.close()} />,
                ];
            case 'no_service':
                return [
                    <StatusButton
                        key='settings'
                        label={t('overlay.open_settings')}
                        onClick={onOpenSettings}
                        primary
                    />,
                    <StatusButton key='retry' label={t('overlay.retry')} onClick={onRetryAfterConfig} />,
                    <StatusButton key='reselect' label={t('overlay.reselect')} onClick={onReselect} />,
                    <StatusButton key='close' label={t('overlay.close')} onClick={() => appWindow.close()} />,
                ];
            case 'all_failed':
                return [
                    <StatusButton key='retry' label={t('overlay.retry_failed')} onClick={onRetryFailed} primary />,
                    <StatusButton key='switch' label={t('overlay.switch_channel')} onClick={onSwitchChannel} />,
                    <StatusButton key='copy' label={t('overlay.copy_error')} onClick={onCopyError} />,
                    <StatusButton key='close' label={t('overlay.close')} onClick={() => appWindow.close()} />,
                ];
            case 'partial_failed':
                return [
                    <StatusButton key='retry' label={t('overlay.retry_failed')} onClick={onRetryFailed} primary />,
                    <StatusButton key='switch' label={t('overlay.switch_channel')} onClick={onSwitchChannel} />,
                    <StatusButton key='copy' label={t('overlay.copy_error')} onClick={onCopyError} />,
                    <StatusButton key='dismiss' label={t('overlay.dismiss')} onClick={onDismiss} />,
                ];
            case 'refresh_failed':
                return [
                    <StatusButton key='retry' label={t('overlay.retry')} onClick={onRefresh} primary />,
                    <StatusButton key='close' label={t('overlay.close')} onClick={() => appWindow.close()} />,
                ];
            default:
                return <StatusButton key='close' label={t('overlay.close')} onClick={() => appWindow.close()} />;
        }
    };

    if (hasBlocks) {
        return (
            <div
                className='overlay-toolbar'
                style={{
                    position: 'absolute',
                    left: 4,
                    right: 4,
                    bottom: statusBottom + 4,
                    height: 36,
                    borderRadius: 6,
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
                    boxShadow: '0 4px 12px rgba(0,0,0,0.28)',
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
                    <span style={{ flex: '0 0 auto', opacity: 0.7 }}>{unlockHint}</span>
                ) : (
                    <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>{renderActions()}</div>
                )}
            </div>
        );
    }

    return (
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
                        {renderActions()}
                    </div>
                )}
                {locked && <div style={{ marginTop: 8, opacity: 0.7, fontSize: 11 }}>{unlockHint}</div>}
            </div>
        </div>
    );
}
