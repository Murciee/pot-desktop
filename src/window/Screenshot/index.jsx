import React, { useEffect, useState, useRef } from 'react';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { currentMonitor } from '@tauri-apps/api/window';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import { appWindow } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';
import { warn } from 'tauri-plugin-log-api';
import { sendNotification } from '@tauri-apps/api/notification';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api';

export default function Screenshot() {
    const { t } = useTranslation();
    const [imgurl, setImgurl] = useState('');
    const [imageReady, setImageReady] = useState(false);
    const [isMoved, setIsMoved] = useState(false);
    const [isDown, setIsDown] = useState(false);
    const [mouseDownX, setMouseDownX] = useState(0);
    const [mouseDownY, setMouseDownY] = useState(0);
    const [mouseMoveX, setMouseMoveX] = useState(0);
    const [mouseMoveY, setMouseMoveY] = useState(0);

    const imgRef = useRef();

    useEffect(() => {
        const capture = async () => {
            try {
                const monitor = await currentMonitor();
                if (!monitor) {
                    throw new Error('No monitor available');
                }
                await invoke('screenshot', {
                    x: monitor.position.x,
                    y: monitor.position.y,
                });
                const cacheDir = await appCacheDir();
                const filePath = await join(cacheDir, 'pot_screenshot.png');
                setImgurl(convertFileSrc(filePath));
            } catch (e) {
                warn(`Failed to capture screen: ${e}`);
                void sendNotification({
                    title: t('overlay.capture_failed_title'),
                    body: `${t('overlay.capture_failed_body')} ${e}`,
                }).catch(() => {});
                void appWindow.close();
            }
        };
        void capture();
    }, [t]);

    const imgRect = imgRef.current?.getBoundingClientRect();
    const renderWidth = imgRect?.width || window.innerWidth;
    const renderHeight = imgRect?.height || window.innerHeight;
    const dpiX =
        imgRef.current?.naturalWidth && renderWidth > 0
            ? imgRef.current.naturalWidth / renderWidth
            : window.devicePixelRatio || 1;
    const dpiY =
        imgRef.current?.naturalHeight && renderHeight > 0
            ? imgRef.current.naturalHeight / renderHeight
            : dpiX;

    const selLeft = Math.min(mouseDownX, mouseMoveX);
    const selTop = Math.min(mouseDownY, mouseMoveY);
    const selRight = Math.max(mouseDownX, mouseMoveX);
    const selBottom = Math.max(mouseDownY, mouseMoveY);
    const selPhysWidth = Math.max(0, Math.round((selRight - selLeft) * dpiX));
    const selPhysHeight = Math.max(0, Math.round((selBottom - selTop) * dpiY));

    return (
        <>
            <img
                ref={imgRef}
                className='fixed top-0 left-0 w-full select-none'
                src={imgurl}
                draggable={false}
                onLoad={() => {
                    if (imgurl !== '' && imgRef.current.complete) {
                        setImageReady(true);
                        void appWindow.show();
                        void appWindow.setFocus();
                        void appWindow.setResizable(false);
                    }
                }}
                onError={() => {
                    if (!imgurl) {
                        return;
                    }
                    warn('Failed to load screenshot image');
                    void sendNotification({
                        title: t('overlay.capture_failed_title'),
                        body: t('overlay.capture_failed_body'),
                    }).catch(() => {});
                    void appWindow.close();
                }}
            />
            {imageReady && (
                <>
                    {!isMoved && (
                        <>
                            <div
                                className='fixed inset-0 pointer-events-none'
                                style={{ background: 'rgba(0, 0, 0, 0.35)' }}
                            />
                            <div
                                className='fixed top-4 left-1/2 -translate-x-1/2 pointer-events-none select-none px-3 py-1.5 rounded-full text-xs text-white'
                                style={{
                                    background: 'rgba(24, 24, 27, 0.85)',
                                    border: '1px solid rgba(255, 255, 255, 0.16)',
                                }}
                            >
                                {t('overlay.screenshot_hint')}
                            </div>
                        </>
                    )}
                    {isMoved && (
                        <div
                            className='fixed border border-solid border-sky-400 pointer-events-none'
                            style={{
                                top: selTop,
                                left: selLeft,
                                width: Math.max(0, selRight - selLeft),
                                height: Math.max(0, selBottom - selTop),
                                boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.35)',
                            }}
                        >
                            {selPhysWidth > 0 && selPhysHeight > 0 && (
                                <div
                                    className='absolute left-0 px-1.5 py-0.5 rounded text-[11px] font-mono text-white whitespace-nowrap'
                                    style={{
                                        top: selTop >= 24 ? -22 : 4,
                                        background: 'rgba(24, 24, 27, 0.88)',
                                    }}
                                >
                                    {selPhysWidth} × {selPhysHeight}
                                </div>
                            )}
                        </div>
                    )}
                    <div
                        className='fixed top-0 left-0 bottom-0 right-0 cursor-crosshair select-none'
                        onMouseDown={(e) => {
                            if (e.buttons === 1) {
                                setIsDown(true);
                                setMouseDownX(e.clientX);
                                setMouseDownY(e.clientY);
                                setMouseMoveX(e.clientX);
                                setMouseMoveY(e.clientY);
                            } else {
                                void appWindow.close();
                            }
                        }}
                        onMouseMove={(e) => {
                            if (isDown) {
                                setIsMoved(true);
                                setMouseMoveX(e.clientX);
                                setMouseMoveY(e.clientY);
                            }
                        }}
                        onMouseUp={async (e) => {
                            if (!isDown || !imgRef.current?.naturalWidth) {
                                return;
                            }
                            setIsDown(false);
                            setIsMoved(false);
                            const rect = imgRef.current.getBoundingClientRect();
                            const rw = rect.width || window.innerWidth;
                            const rh = rect.height || window.innerHeight;
                            const imgWidth = imgRef.current.naturalWidth;
                            const imgHeight = imgRef.current.naturalHeight;
                            const dpi = rw > 0 ? imgWidth / rw : 1;
                            const scaleY = rh > 0 ? imgHeight / rh : dpi;

                            const leftCss = Math.min(mouseDownX, e.clientX) - rect.left;
                            const topCss = Math.min(mouseDownY, e.clientY) - rect.top;
                            const rightCss = Math.max(mouseDownX, e.clientX) - rect.left;
                            const bottomCss = Math.max(mouseDownY, e.clientY) - rect.top;

                            const left = Math.max(0, Math.floor(leftCss * dpi));
                            const top = Math.max(0, Math.floor(topCss * scaleY));
                            const right = Math.min(imgWidth, Math.floor(rightCss * dpi));
                            const bottom = Math.min(imgHeight, Math.floor(bottomCss * scaleY));
                            const width = right - left;
                            const height = bottom - top;
                            if (width <= 0 || height <= 0) {
                                warn('Screenshot area is too small');
                                return;
                            }
                            await appWindow.hide();
                            try {
                                const cropInfo = await invoke('cut_image', { left, top, width, height });
                                const monitor = await currentMonitor();
                                await emit('overlay_rect', {
                                    left,
                                    top,
                                    width,
                                    height,
                                    dpr: dpi,
                                    screenX: monitor.position.x + left,
                                    screenY: monitor.position.y + top,
                                    paddingLeft: cropInfo.paddingLeft,
                                    paddingTop: cropInfo.paddingTop,
                                });
                                await emit('success');
                                await appWindow.close();
                            } catch (error) {
                                warn(`Failed to crop screenshot: ${error}`);
                                void sendNotification({
                                    title: t('overlay.capture_failed_title'),
                                    body: `${t('overlay.capture_failed_body')} ${error}`,
                                }).catch(() => {});
                                await appWindow.close();
                            }
                        }}
                    />
                </>
            )}
        </>
    );
}
