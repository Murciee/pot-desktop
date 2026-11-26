import { appWindow, currentMonitor, LogicalSize } from '@tauri-apps/api/window';
import React from 'react';
import {
    MdAdd,
    MdClose,
    MdExpandLess,
    MdLock,
    MdMoreHoriz,
    MdOutlinePushPin,
    MdPushPin,
    MdRemove,
    MdSwapHoriz,
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
    compactToolbar,
    selectionWidth,
    onExpandedChange,
    displayMode,
    pinned,
    hasMultipleChannels,
    onSwitchChannel,
    onAdjustFont,
    onToggleDisplayMode,
    onTogglePin,
    onLock,
}) {
    const [expanded, setExpanded] = React.useState(false);

    const toggleExpanded = async (next) => {
        if (next) {
            onExpandedChange?.(true);
        } else {
            setExpanded(false);
        }
        let resized = false;
        try {
            const monitor = await currentMonitor();
            const position = await appWindow.outerPosition();
            const scaleFactor = monitor?.scaleFactor || (await appWindow.scaleFactor()) || 1;
            const maxWidth = monitor
                ? Math.max(
                      selectionWidth,
                      (monitor.position.x + monitor.size.width - position.x) / scaleFactor
                  )
                : 220;
            const width = next ? Math.min(220, maxWidth) : selectionWidth;
            await appWindow.setSize(new LogicalSize(Math.max(selectionWidth, width), window.innerHeight));
            resized = true;
        } catch {
            // The expanded actions remain horizontally scrollable if native resizing is unavailable.
        }
        if (next) {
            setExpanded(true);
        } else if (resized) {
            onExpandedChange?.(false);
        }
    };

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
            {compactToolbar && !expanded ? (
                <ToolButton title={t('overlay.expand_toolbar')} onClick={() => toggleExpanded(true)}>
                    <MdMoreHoriz size={16} />
                </ToolButton>
            ) : (
                <>
                    {compactToolbar && (
                        <ToolButton title={t('overlay.collapse_toolbar')} onClick={() => toggleExpanded(false)}>
                            <MdExpandLess size={16} />
                        </ToolButton>
                    )}
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
                    <ToolButton
                        title={displayMode === 'original' ? t('overlay.show_translation') : t('overlay.show_original')}
                        onClick={onToggleDisplayMode}
                        active={displayMode === 'original'}
                    >
                        <MdTranslate size={15} />
                    </ToolButton>
                    <ToolButton
                        title={pinned ? t('overlay.unpin') : t('overlay.pin')}
                        onClick={onTogglePin}
                        active={pinned}
                    >
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
                </>
            )}
        </div>
    );
}
