import { appWindow } from '@tauri-apps/api/window';
import React from 'react';
import {
    MdAdd,
    MdClose,
    MdContentCopy,
    MdContentCut,
    MdCopyAll,
    MdDarkMode,
    MdLightMode,
    MdLock,
    MdOutlinePushPin,
    MdPushPin,
    MdRefresh,
    MdRemove,
    MdSwapHoriz,
    MdTextSnippet,
    MdTonality,
    MdTranslate,
} from 'react-icons/md';

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

export function OverlayToolbar({
    t,
    toolbarAtBottom,
    refreshing,
    displayMode,
    overlayTheme,
    pinned,
    hasMultipleChannels,
    onRefresh,
    onReselect,
    onSwitchChannel,
    onAdjustFont,
    onCopyText,
    onToggleDisplayMode,
    onCycleTheme,
    onTogglePin,
    onLock,
}) {
    const themeLabel =
        overlayTheme === 'dark'
            ? t('overlay.theme_dark')
            : overlayTheme === 'light'
              ? t('overlay.theme_light')
              : t('overlay.theme_auto');

    return (
        <div
            className='overlay-toolbar'
            style={{
                position: 'absolute',
                top: toolbarAtBottom ? 'auto' : 0,
                bottom: toolbarAtBottom ? 0 : 'auto',
                left: 0,
                right: 0,
                height: 32,
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
            <ToolButton title={t('overlay.refresh')} onClick={onRefresh} disabled={refreshing}>
                <MdRefresh size={16} />
            </ToolButton>
            <ToolButton title={t('overlay.reselect')} onClick={onReselect}>
                <MdContentCut size={15} />
            </ToolButton>
            {hasMultipleChannels && (
                <ToolButton title={t('overlay.switch_channel')} onClick={onSwitchChannel}>
                    <MdSwapHoriz size={15} />
                </ToolButton>
            )}
            <ToolButton title={t('overlay.font_smaller')} onClick={() => onAdjustFont(-0.1)}>
                <MdRemove size={14} />
            </ToolButton>
            <ToolButton title={t('overlay.font_larger')} onClick={() => onAdjustFont(0.1)}>
                <MdAdd size={14} />
            </ToolButton>
            <ToolButton title={t('overlay.copy_translation')} onClick={() => onCopyText('translation')}>
                <MdContentCopy size={15} />
            </ToolButton>
            <ToolButton title={t('overlay.copy_original')} onClick={() => onCopyText('original')}>
                <MdTextSnippet size={15} />
            </ToolButton>
            <ToolButton title={t('overlay.copy_all')} onClick={() => onCopyText('all')}>
                <MdCopyAll size={15} />
            </ToolButton>
            <ToolButton
                title={displayMode === 'original' ? t('overlay.show_translation') : t('overlay.show_original')}
                onClick={onToggleDisplayMode}
                active={displayMode === 'original'}
            >
                <MdTranslate size={15} />
            </ToolButton>
            <ToolButton title={themeLabel} onClick={onCycleTheme} active={overlayTheme !== 'auto'}>
                {overlayTheme === 'dark' ? (
                    <MdDarkMode size={15} />
                ) : overlayTheme === 'light' ? (
                    <MdLightMode size={15} />
                ) : (
                    <MdTonality size={15} />
                )}
            </ToolButton>
            <ToolButton title={pinned ? t('overlay.unpin') : t('overlay.pin')} onClick={onTogglePin} active={pinned}>
                {pinned ? <MdPushPin size={15} /> : <MdOutlinePushPin size={15} />}
            </ToolButton>
            <ToolButton title={t('overlay.lock')} onClick={onLock}>
                <MdLock size={15} />
            </ToolButton>
            <div
                style={{
                    marginLeft: 'auto',
                    position: 'sticky',
                    right: 0,
                    display: 'flex',
                    background: 'rgba(24,24,27,0.92)',
                    paddingLeft: 2,
                }}
            >
                <ToolButton title={t('overlay.close')} onClick={() => appWindow.close()}>
                    <MdClose size={16} />
                </ToolButton>
            </div>
        </div>
    );
}
