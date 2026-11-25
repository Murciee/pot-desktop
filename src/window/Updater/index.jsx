import { Code, Card, CardBody, Button, Progress, Skeleton } from '@nextui-org/react';
import { checkUpdate, installUpdate } from '@tauri-apps/api/updater';
import React, { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { appWindow } from '@tauri-apps/api/window';
import { relaunch } from '@tauri-apps/api/process';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';

import { useConfig, useToastStyle } from '../../hooks';
import { appVersion, osType } from '../../utils/env';
import { normalizeVersionLabel, stripLeadingVersionHeading } from '../../utils/updater_notes';

export default function Updater() {
    const [transparent] = useConfig('transparent', true);
    const [downloaded, setDownloaded] = useState(0);
    const [total, setTotal] = useState(0);
    const [body, setBody] = useState('');
    const [checking, setChecking] = useState(true);
    const [hasUpdate, setHasUpdate] = useState(false);
    const [currentVersion, setCurrentVersion] = useState(() => normalizeVersionLabel(appVersion));
    const [newVersion, setNewVersion] = useState('');
    const { t } = useTranslation();
    const toastStyle = useToastStyle();

    useEffect(() => {
        let disposed = false;
        let activeEventId = null;

        if (appWindow.label === 'updater') {
            appWindow.show();
        }

        if (!normalizeVersionLabel(appVersion)) {
            getVersion()
                .then((ver) => {
                    if (!disposed) {
                        setCurrentVersion(normalizeVersionLabel(ver));
                    }
                })
                .catch(() => {});
        }

        checkUpdate().then(
            (update) => {
                if (disposed) {
                    return;
                }
                if (update.shouldUpdate) {
                    const targetVer = normalizeVersionLabel(update.manifest?.version);
                    setNewVersion(targetVer);
                    setHasUpdate(true);
                    setBody(stripLeadingVersionHeading(update.manifest?.body ?? '', targetVer));
                } else {
                    setHasUpdate(false);
                    setNewVersion('');
                    setBody(t('updater.latest'));
                }
                setChecking(false);
            },
            (e) => {
                if (disposed) {
                    return;
                }
                setHasUpdate(false);
                setBody(e.toString());
                setChecking(false);
                toast.error(e.toString(), { style: toastStyle });
            }
        );

        const unlistenPromise = listen('tauri://update-download-progress', (e) => {
            if (activeEventId === null) {
                activeEventId = e.id;
            }
            if (e.id === activeEventId) {
                setTotal(e.payload.contentLength);
                setDownloaded((a) => a + e.payload.chunkLength);
            }
        });

        return () => {
            disposed = true;
            unlistenPromise.then((fn) => fn()).catch(() => {});
        };
    }, []);

    const headerVersionLabel =
        hasUpdate && newVersion
            ? currentVersion
                ? `v${currentVersion} → v${newVersion}`
                : `v${newVersion}`
            : currentVersion
              ? `v${currentVersion}`
              : '';

    return (
        <div
            className={`${transparent ? 'bg-background/90' : 'bg-background'} h-screen ${
                osType === 'Linux' && 'rounded-[10px] border-1 border-default-100'
            }`}
        >
            <Toaster />
            <div className='p-[5px] h-[35px] w-full select-none cursor-default'>
                <div
                    data-tauri-drag-region='true'
                    className={`h-full w-full flex items-center ${osType === 'Darwin' ? 'justify-end' : 'justify-start'}`}
                >
                    <img
                        src='icon.png'
                        className='h-[25px] w-[25px] mr-[10px]'
                        draggable={false}
                    />
                    <h2>{t('updater.title')}</h2>
                    {headerVersionLabel && (
                        <span className='ml-2 px-2 py-0.5 rounded-full text-xs font-mono bg-default-200/70 text-default-700'>
                            {headerVersionLabel}
                        </span>
                    )}
                </div>
            </div>
            <Card className='mx-[80px] mt-[10px] overscroll-auto h-[calc(100vh-150px)]'>
                <CardBody>
                    {checking ? (
                        <div className='space-y-3'>
                            <Skeleton className='w-3/5 rounded-lg'>
                                <div className='h-3 w-3/5 rounded-lg bg-default-200'></div>
                            </Skeleton>
                            <Skeleton className='w-4/5 rounded-lg'>
                                <div className='h-3 w-4/5 rounded-lg bg-default-200'></div>
                            </Skeleton>
                            <Skeleton className='w-2/5 rounded-lg'>
                                <div className='h-3 w-2/5 rounded-lg bg-default-300'></div>
                            </Skeleton>
                        </div>
                    ) : (
                        <>
                            {hasUpdate && newVersion && (
                                <div className='mb-3 select-text'>
                                    <div className='flex items-baseline justify-between gap-2 flex-wrap'>
                                        <h2 className='text-[24px] font-bold leading-tight'>v{newVersion}</h2>
                                        {currentVersion && (
                                            <span className='text-xs text-default-500 font-mono'>
                                                v{currentVersion} → v{newVersion}
                                            </span>
                                        )}
                                    </div>
                                    <hr className='mt-2 border-default-200' />
                                </div>
                            )}
                            <ReactMarkdown
                                className='markdown-body select-text'
                                components={{
                                    code: ({ node, ...props }) => {
                                        const { children } = props;
                                        return <Code size='sm'>{children}</Code>;
                                    },
                                    h2: ({ node, ...props }) => (
                                        <b>
                                            <h2
                                                className='text-[24px]'
                                                {...props}
                                            />
                                            <hr />
                                            <br />
                                        </b>
                                    ),
                                    h3: ({ node, ...props }) => (
                                        <b>
                                            <br />
                                            <h3
                                                className='text-[18px]'
                                                {...props}
                                            />
                                            <br />
                                        </b>
                                    ),
                                    li: ({ node, ...props }) => {
                                        const { children } = props;
                                        return (
                                            <li
                                                className='list-disc list-inside'
                                                children={children}
                                            />
                                        );
                                    },
                                }}
                            >
                                {body}
                            </ReactMarkdown>
                            {!hasUpdate && currentVersion && body === t('updater.latest') && (
                                <p className='mt-2 text-sm text-default-500 select-text font-mono'>
                                    v{currentVersion}
                                </p>
                            )}
                        </>
                    )}
                </CardBody>
            </Card>
            {downloaded !== 0 && (
                <Progress
                    aria-label='Downloading...'
                    label={t('updater.progress')}
                    value={total > 0 ? (downloaded / total) * 100 : 0}
                    classNames={{
                        base: 'w-full px-[80px]',
                        track: 'drop-shadow-md border border-default',
                        indicator: 'bg-gradient-to-r from-pink-500 to-yellow-500',
                        label: 'tracking-wider font-medium text-default-600',
                        value: 'text-foreground/60',
                    }}
                    showValueLabel
                    size='sm'
                />
            )}

            <div className='grid gap-4 grid-cols-2 h-[50px] my-[10px] mx-[80px]'>
                <Button
                    variant='flat'
                    isLoading={downloaded !== 0}
                    isDisabled={checking || !hasUpdate || downloaded !== 0}
                    color='primary'
                    onPress={() => {
                        installUpdate().then(
                            () => {
                                toast.success(t('updater.installed'), { style: toastStyle, duration: 10000 });
                                relaunch();
                            },
                            (e) => {
                                toast.error(e.toString(), { style: toastStyle });
                            }
                        );
                    }}
                >
                    {downloaded !== 0
                        ? total > 0 && downloaded > total
                            ? t('updater.installing')
                            : t('updater.downloading')
                        : t('updater.update')}
                </Button>
                <Button
                    variant='flat'
                    color='danger'
                    onPress={() => {
                        appWindow.close();
                    }}
                >
                    {t('updater.cancel')}
                </Button>
            </div>
        </div>
    );
}
