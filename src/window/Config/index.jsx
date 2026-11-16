import { useLocation, useRoutes } from 'react-router-dom';
import React, { useEffect, useState } from 'react';
import { appWindow, currentMonitor } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { Card, Divider } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';

import WindowControl from '../../components/WindowControl';
import { store } from '../../utils/store';
import SideBar from './components/SideBar';
import { osType } from '../../utils/env';
import { useConfig } from '../../hooks';
import routes from './routes';
import './style.css';

export default function Config() {
    const [transparent] = useConfig('transparent', true);
    const { t } = useTranslation();
    const location = useLocation();
    const page = useRoutes(routes);

    useEffect(() => {
        if (appWindow.label === 'config') {
            appWindow.show();
        }
    }, []);

    // Remember the window geometry. Config windows are always restored.
    useEffect(() => {
        if (appWindow.label !== 'config') {
            return;
        }
        let resizeTimeout = null;
        let moveTimeout = null;
        const unlistenResize = listen('tauri://resize', async () => {
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
            }
            resizeTimeout = setTimeout(async () => {
                const monitor = await currentMonitor();
                const factor = monitor?.scaleFactor ?? 1;
                const size = (await appWindow.outerSize()).toLogical(factor);
                await store.set('config_window_width', parseInt(size.width));
                await store.set('config_window_height', parseInt(size.height));
                await store.save();
            }, 100);
        });
        const unlistenMove = listen('tauri://move', async () => {
            if (moveTimeout) {
                clearTimeout(moveTimeout);
            }
            moveTimeout = setTimeout(async () => {
                const monitor = await currentMonitor();
                const factor = monitor?.scaleFactor ?? 1;
                const position = (await appWindow.outerPosition()).toLogical(factor);
                await store.set('config_window_position_x', parseInt(position.x));
                await store.set('config_window_position_y', parseInt(position.y));
                await store.save();
            }, 100);
        });
        return () => {
            unlistenResize.then((f) => f());
            unlistenMove.then((f) => f());
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
            }
            if (moveTimeout) {
                clearTimeout(moveTimeout);
            }
        };
    }, []);

    return (
        <>
            <Card
                shadow='none'
                className={`${
                    transparent ? 'bg-background/90' : 'bg-content1'
                } float-left w-[230px] h-screen rounded-none ${
                    osType === 'Linux' && 'rounded-l-[10px] border-1'
                } border-r-1 border-default-100 select-none cursor-default`}
            >
                <div className='h-[35px] p-[5px]'>
                    <div
                        className='w-full h-full'
                        data-tauri-drag-region='true'
                    />
                </div>
                <div className='p-[5px]'>
                    <div data-tauri-drag-region='true'>
                        <img
                            alt='pot logo'
                            src='icon.svg'
                            className='h-[60px] w-[60px] m-auto mb-[30px]'
                            draggable={false}
                        />
                    </div>
                </div>
                <SideBar />
            </Card>
            <div
                className={`bg-background ml-[230px] h-screen select-none cursor-default ${
                    osType === 'Linux' && 'rounded-r-[10px] border-1 border-l-0 border-default-100'
                }`}
            >
                <div
                    data-tauri-drag-region='true'
                    className='top-[5px] left-[235px] right-[5px] h-[30px] fixed'
                />
                <div className='h-[35px] flex justify-between'>
                    <div className='flex'>
                        <h2 className='m-auto ml-[10px]'>{t(`config.${location.pathname.slice(1)}.title`)}</h2>
                    </div>

                    <div className='flex'>{osType !== 'Darwin' && <WindowControl />}</div>
                </div>
                <Divider />
                <div
                    className={`p-[10px] overflow-y-auto ${
                        osType === 'Linux' ? 'h-[calc(100vh-38px)]' : 'h-[calc(100vh-36px)]'
                    }`}
                >
                    {page}
                </div>
            </div>
        </>
    );
}
