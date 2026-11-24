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
                className='fixed inset-0 w-screen h-screen select-none block'
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
                            const imgScaleX = rw > 0 ? imgWidth / rw : 1;
                            const imgScaleY = rh > 0 ? imgHeight / rh : imgScaleX;

                            const leftCss = Math.min(mouseDownX, e.clientX) - rect.left;
                            const topCss = Math.min(mouseDownY, e.clientY) - rect.top;
                            const rightCss = Math.max(mouseDownX, e.clientX) - rect.left;
                            const bottomCss = Math.max(mouseDownY, e.clientY) - rect.top;

                            const cropLeft = Math.max(0, Math.round(leftCss * imgScaleX));
                            const cropTop = Math.max(0, Math.round(topCss * imgScaleY));
                            const cropRight = Math.min(imgWidth, Math.round(rightCss * imgScaleX));
                            const cropBottom = Math.min(imgHeight, Math.round(bottomCss * imgScaleY));
                            const cropWidth = cropRight - cropLeft;
                            const cropHeight = cropBottom - cropTop;
                            if (cropWidth <= 0 || cropHeight <= 0) {
                                warn('Screenshot area is too small');
                                return;
                            }
                            await appWindow.hide();
                            try {
                                const monitor = await currentMonitor();
                                const winPhysW = monitor?.size?.width || imgWidth;
                                const winPhysH = monitor?.size?.height || imgHeight;
                                const winScaleX = rw > 0 ? winPhysW / rw : imgScaleX;
                                const winScaleY = rh > 0 ? winPhysH / rh : imgScaleY;

                                const winLeft = Math.max(0, Math.round(leftCss * winScaleX));
                                const winTop = Math.max(0, Math.round(topCss * winScaleY));
                                const winRight = Math.min(winPhysW, Math.round(rightCss * winScaleX));
                                const winBottom = Math.min(winPhysH, Math.round(bottomCss * winScaleY));
                                const winWidth = Math.max(1, winRight - winLeft);
                                const winHeight = Math.max(1, winBottom - winTop);
                                const effectiveDpr = monitor?.scaleFactor || window.devicePixelRatio || imgScaleX;

                                const cropInfo = await invoke('cut_image', {
                                    left: cropLeft,
                                    top: cropTop,
                                    width: cropWidth,
                                    height: cropHeight,
                                });
                                const padRatioX = imgWidth > 0 ? winPhysW / imgWidth : 1;
                                const padRatioY = imgHeight > 0 ? winPhysH / imgHeight : 1;
                                await emit('overlay_rect', {
                                    left: winLeft,
                                    top: winTop,
                                    width: winWidth,
                                    height: winHeight,
                                    dpr: effectiveDpr,
                                    screenX: (monitor?.position?.x ?? 0) + winLeft,
                                    screenY: (monitor?.position?.y ?? 0) + winTop,
                                    paddingLeft: Math.round(cropInfo.paddingLeft * padRatioX),
                                    paddingTop: Math.round(cropInfo.paddingTop * padRatioY),
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
