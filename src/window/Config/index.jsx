import { useLocation, useRoutes } from 'react-router-dom';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { appWindow } from '@tauri-apps/api/window';
import { Card, Divider } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';

import WindowControl from '../../components/WindowControl';
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
    const contentRef = useRef(null);

    useEffect(() => {
        if (appWindow.label === 'config') {
            appWindow.show();
        }
    }, []);

    // Start every settings page at the top: keeping the previous scroll offset
    // made the new page's controls appear shifted down.
    useLayoutEffect(() => {
        if (contentRef.current) {
            contentRef.current.scrollTop = 0;
        }
    }, [location.pathname]);

    return (
        <div
            className={`flex h-screen w-screen min-w-0 overflow-hidden ${
                osType === 'Windows_NT' ? 'rounded-[14px] border border-default-200' : ''
            }`}
        >
            <Card
                shadow='none'
                className={`${
                    transparent ? 'bg-background/90' : 'bg-content1'
                } h-full w-[230px] shrink-0 rounded-none ${
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
                className={`bg-background flex h-full min-w-0 flex-1 flex-col overflow-hidden select-none cursor-default ${
                    osType === 'Linux' && 'rounded-r-[10px] border-1 border-l-0 border-default-100'
                }`}
            >
                <div
                    data-tauri-drag-region='true'
                    className='top-[5px] left-[235px] right-[5px] h-[30px] fixed'
                />
                <div className='flex h-[35px] shrink-0 justify-between'>
                    <div className='flex'>
                        <h2 className='m-auto ml-[10px]'>{t(`config.${location.pathname.slice(1)}.title`)}</h2>
                    </div>

                    <div className='flex'>{osType !== 'Darwin' && <WindowControl />}</div>
                </div>
                <Divider />
                <div
                    ref={contentRef}
                    className='min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-[10px]'
                >
                    {page}
                </div>
            </div>
        </div>
    );
}
