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
                    <div
                        className={`fixed bg-[#2080f020] border border-solid border-sky-500 ${!isMoved && 'hidden'}`}
                        style={{
                            top: Math.min(mouseDownY, mouseMoveY),
                            left: Math.min(mouseDownX, mouseMoveX),
                            bottom: screen.height - Math.max(mouseDownY, mouseMoveY),
                            right: screen.width - Math.max(mouseDownX, mouseMoveX),
                        }}
                    />
                    <div
                        className='fixed top-0 left-0 bottom-0 right-0 cursor-crosshair select-none'
                        onMouseDown={(e) => {
                            if (e.buttons === 1) {
                                setIsDown(true);
                                setMouseDownX(e.clientX);
                                setMouseDownY(e.clientY);
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
                            await appWindow.hide();
                            setIsDown(false);
                            setIsMoved(false);
                            const imgWidth = imgRef.current.naturalWidth;
                            const dpi = imgWidth / screen.width;
                            const left = Math.floor(Math.min(mouseDownX, e.clientX) * dpi);
                            const top = Math.floor(Math.min(mouseDownY, e.clientY) * dpi);
                            const right = Math.floor(Math.max(mouseDownX, e.clientX) * dpi);
                            const bottom = Math.floor(Math.max(mouseDownY, e.clientY) * dpi);
                            const width = right - left;
                            const height = bottom - top;
                            if (width <= 0 || height <= 0) {
                                warn('Screenshot area is too small');
                                await appWindow.close();
                            } else {
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
                            }
                        }}
                    />
                </>
            )}
        </>
    );
}
