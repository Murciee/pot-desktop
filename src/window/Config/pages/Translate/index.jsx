import { DropdownTrigger } from '@nextui-org/react';
import { DropdownMenu } from '@nextui-org/react';
import { DropdownItem } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { CardBody } from '@nextui-org/react';
import { Dropdown } from '@nextui-org/react';
import { Switch } from '@nextui-org/react';
import { Button } from '@nextui-org/react';
import { Input } from '@nextui-org/react';
import { Card } from '@nextui-org/react';
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BaseDirectory, readTextFile } from '@tauri-apps/api/fs';

import { languageList } from '../../../../utils/language';
import { getServiceName, getServiceSouceType, ServiceSourceType } from '../../../../utils/service_instance';
import { useConfig } from '../../../../hooks/useConfig';
import { store } from '../../../../utils/store';
import { osType } from '../../../../utils/env';
import { invoke } from '@tauri-apps/api';
import { fetch as httpFetch } from '@tauri-apps/api/http';
import { modelsUrlFrom } from '../../../../services/translate/openai/utils';

const NON_CHAT_MODEL = /(embed|whisper|tts|dall-?e|moderation|rerank)/i;

export default function Translate() {
    const [sourceLanguage, setSourceLanguage] = useConfig('translate_source_language', 'auto');
    const [targetLanguage, setTargetLanguage] = useConfig('translate_target_language', 'zh_cn');
    const [secondLanguage, setSecondLanguage] = useConfig('translate_second_language', 'en');
    const [detectEngine, setDetectEngine] = useConfig('translate_detect_engine', 'baidu');
    const [autoCopy, setAutoCopy] = useConfig('translate_auto_copy', 'disable');
    const [incrementalTranslate, setIncrementalTranslate] = useConfig('incremental_translate', false);
    const [historyDisable, setHistoryDisable] = useConfig('history_disable', false);
    const [dynamicTranslate, setDynamicTranslate] = useConfig('dynamic_translate', false);
    const [deleteNewline, setDeleteNewline] = useConfig('translate_delete_newline', false);
    const [rememberLanguage, setRememberLanguage] = useConfig('translate_remember_language', false);
    // const [translateFontSize, setTranslateFontSize] = useConfig('translate_font_size', 16);
    const [windowPosition, setWindowPosition] = useConfig('translate_window_position', 'mouse');
    const [rememberWindowSize, setRememberWindowSize] = useConfig('translate_remember_window_size', false);
    const [hideSource, setHideSource] = useConfig('hide_source', false);
    const [hideLanguage, setHideLanguage] = useConfig('hide_language', false);
    const [hideWindow, setHideWindow] = useConfig('translate_hide_window', false);
    const [closeOnBlur, setCloseOnBlur] = useConfig('translate_close_on_blur', true);
    const [alwaysOnTop, setAlwaysOnTop] = useConfig('translate_always_on_top', false);
    const [translateServiceInstanceList] = useConfig('translate_service_list', []);
    const [recognizeServiceInstanceList] = useConfig('recognize_service_list', ['system', 'tesseract']);
    const [overlayService, setOverlayService] = useConfig('overlay_service_instance', '');
    const [overlayOcrService, setOverlayOcrService] = useConfig('overlay_ocr_service', '');
    const [overlayModel, setOverlayModel] = useConfig('overlay_model', '');
    const [overlayTargetLanguage, setOverlayTargetLanguage] = useConfig('overlay_target_language', '');
    const [overlayOpacity, setOverlayOpacity] = useConfig('overlay_opacity', 0.85);
    const [overlayFontScale, setOverlayFontScale] = useConfig('overlay_font_scale', 1);
    const [overlayConcurrency, setOverlayConcurrency] = useConfig('overlay_max_concurrency', 3);
    const [overlayTheme, setOverlayTheme] = useConfig('overlay_theme', 'auto');
    const [overlayRefreshHotkey] = useConfig('hotkey_overlay_refresh', '');
    const [instanceNames, setInstanceNames] = useState({});
    const [overlayServiceConfig, setOverlayServiceConfig] = useState(null);
    const [overlayModelList, setOverlayModelList] = useState([]);
    const [fetchingOverlayModels, setFetchingOverlayModels] = useState(false);
    const [overlayModelError, setOverlayModelError] = useState('');
    const { t } = useTranslation();
    const navigate = useNavigate();
    const overlayOcrOptions = recognizeServiceInstanceList?.length
        ? recognizeServiceInstanceList
        : ['system'];
    const effectiveOverlayOcrService =
        overlayOcrService || overlayOcrOptions[0] || 'system';
    const effectiveOverlayService =
        overlayService || (translateServiceInstanceList ?? [])[0] || '';
    const overlayServiceName = effectiveOverlayService.split('@')[0];
    const overlayModelVisible =
        overlayServiceConfig !== null &&
        overlayServiceConfig.service !== 'azure' &&
        (overlayServiceName === 'openai' || overlayServiceConfig.service === 'openai');

    useEffect(() => {
        let disposed = false;
        (async () => {
            const names = {};
            for (const instanceKey of translateServiceInstanceList ?? []) {
                const instanceConfig = (await store.get(instanceKey)) ?? {};
                names[instanceKey] = instanceConfig.instanceName || instanceKey.split('@')[0];
            }
            for (const instanceKey of recognizeServiceInstanceList ?? []) {
                const instanceConfig = (await store.get(instanceKey)) ?? {};
                const serviceName = getServiceName(instanceKey);
                let serviceDisplay = serviceName;
                if (getServiceSouceType(instanceKey) === ServiceSourceType.PLUGIN) {
                    try {
                        const info = JSON.parse(
                            await readTextFile(`plugins/recognize/${serviceName}/info.json`, {
                                dir: BaseDirectory.AppConfig,
                            })
                        );
                        serviceDisplay = info.display || serviceName;
                    } catch {
                        // Keep the plugin id as a stable fallback if its metadata is unavailable.
                    }
                } else {
                    serviceDisplay = t(`services.recognize.${serviceName}.title`);
                    if (serviceDisplay === `services.recognize.${serviceName}.title`) {
                        serviceDisplay = serviceName;
                    }
                }
                names[instanceKey] = instanceConfig.instanceName || serviceDisplay;
            }
            if (!disposed) {
                setInstanceNames(names);
            }
        })();
        return () => {
            disposed = true;
        };
    }, [translateServiceInstanceList, recognizeServiceInstanceList, t]);

    useEffect(() => {
        let disposed = false;
        (async () => {
            const config = effectiveOverlayService
                ? (await store.get(effectiveOverlayService)) ?? {}
                : {};
            if (!disposed) {
                setOverlayServiceConfig(config);
                setOverlayModelList(Array.isArray(config.modelList) ? config.modelList : []);
                setOverlayModelError('');
            }
        })();
        return () => {
            disposed = true;
        };
    }, [effectiveOverlayService, translateServiceInstanceList]);

    const fetchOverlayModels = async () => {
        const config = overlayServiceConfig ?? {};
        if (!config.requestPath || !config.apiKey) {
            setOverlayModelError(t('config.translate.overlay_model_need_config'));
            return;
        }
        setFetchingOverlayModels(true);
        setOverlayModelError('');
        try {
            const res = await httpFetch(modelsUrlFrom(config.requestPath), {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                },
                timeout: 15,
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = res.data ?? {};
            const rawList = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
            const list = rawList
                .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name))
                .filter((item) => typeof item === 'string' && item !== '');
            if (list.length === 0) {
                throw new Error(t('config.translate.overlay_model_empty'));
            }
            setOverlayModelList(list);
        } catch (e) {
            setOverlayModelError(e?.toString?.() ?? String(e));
        } finally {
            setFetchingOverlayModels(false);
        }
    };

    return (
        <>
            <Card className='mb-[10px]'>
                <CardBody>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.source_language')}</h3>
                        {sourceLanguage !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{t(`languages.${sourceLanguage}`)}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='source language'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setSourceLanguage(key);
                                    }}
                                >
                                    <DropdownItem key='auto'>{t('languages.auto')}</DropdownItem>
                                    {languageList.map((item) => {
                                        return <DropdownItem key={item}>{t(`languages.${item}`)}</DropdownItem>;
                                    })}
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.target_language')}</h3>
                        {targetLanguage !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{t(`languages.${targetLanguage}`)}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='target language'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setTargetLanguage(key);
                                    }}
                                >
                                    {languageList.map((item) => {
                                        return <DropdownItem key={item}>{t(`languages.${item}`)}</DropdownItem>;
                                    })}
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.second_language')}</h3>
                        {secondLanguage !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{t(`languages.${secondLanguage}`)}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='second language'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setSecondLanguage(key);
                                    }}
                                >
                                    {languageList.map((item) => {
                                        return <DropdownItem key={item}>{t(`languages.${item}`)}</DropdownItem>;
                                    })}
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.detect_engine')}</h3>
                        {detectEngine !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{t(`config.translate.${detectEngine}`)}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='detect engine'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setDetectEngine(key);
                                    }}
                                >
                                    <DropdownItem key='baidu'>{t(`config.translate.baidu`)}</DropdownItem>
                                    <DropdownItem key='tencent'>{t(`config.translate.tencent`)}</DropdownItem>
                                    <DropdownItem key='niutrans'>{t(`config.translate.niutrans`)}</DropdownItem>
                                    <DropdownItem key='google'>{t(`config.translate.google`)}</DropdownItem>
                                    <DropdownItem key='bing'>{t(`config.translate.bing`)}</DropdownItem>
                                    <DropdownItem key='yandex'>{t(`config.translate.yandex`)}</DropdownItem>
                                    <DropdownItem key='local'>{t(`config.translate.local`)}</DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                </CardBody>
            </Card>
            <Card className='mb-[10px]'>
                <CardBody>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.auto_copy')}</h3>
                        {autoCopy !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{t(`config.translate.${autoCopy}`)}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='auto copy'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setAutoCopy(key);
                                        invoke('update_tray', { language: '', copyMode: key });
                                    }}
                                >
                                    <DropdownItem key='source'>{t('config.translate.source')}</DropdownItem>
                                    <DropdownItem key='target'>{t('config.translate.target')}</DropdownItem>
                                    <DropdownItem key='source_target'>
                                        {t('config.translate.source_target')}
                                    </DropdownItem>
                                    <DropdownItem key='disable'>{t('config.translate.disable')}</DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className='config-item'>
                        <h3>{t('config.translate.history_disable')}</h3>
                        {historyDisable !== null && (
                            <Switch
                                isSelected={historyDisable}
                                onValueChange={(v) => {
                                    setHistoryDisable(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.incremental_translate')}</h3>
                        {incrementalTranslate !== null && (
                            <Switch
                                isSelected={incrementalTranslate}
                                onValueChange={(v) => {
                                    setIncrementalTranslate(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.dynamic_translate')}</h3>
                        {dynamicTranslate !== null && (
                            <Switch
                                isSelected={dynamicTranslate}
                                onValueChange={(v) => {
                                    setDynamicTranslate(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.delete_newline')}</h3>
                        {deleteNewline !== null && (
                            <Switch
                                isSelected={deleteNewline}
                                onValueChange={(v) => {
                                    setDeleteNewline(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.remember_language')}</h3>
                        {rememberLanguage !== null && (
                            <Switch
                                isSelected={rememberLanguage}
                                onValueChange={(v) => {
                                    setRememberLanguage(v);
                                }}
                            />
                        )}
                    </div>
                </CardBody>
            </Card>
            <Card>
                <CardBody>
                    {/* <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.font_size.title')}</h3>
                        {translateFontSize !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>
                                        {t(`config.translate.font_size.${translateFontSize}`)}
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='window position'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setTranslateFontSize(key);
                                    }}
                                >
                                    <DropdownItem key={10}>{t(`config.translate.font_size.10`)}</DropdownItem>
                                    <DropdownItem key={12}>{t(`config.translate.font_size.12`)}</DropdownItem>
                                    <DropdownItem key={14}>{t(`config.translate.font_size.14`)}</DropdownItem>
                                    <DropdownItem key={16}>{t(`config.translate.font_size.16`)}</DropdownItem>
                                    <DropdownItem key={18}>{t(`config.translate.font_size.18`)}</DropdownItem>
                                    <DropdownItem key={20}>{t(`config.translate.font_size.20`)}</DropdownItem>
                                    <DropdownItem key={24}>{t(`config.translate.font_size.24`)}</DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div> */}
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.window_position')}</h3>
                        {windowPosition !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{t(`config.translate.${windowPosition}`)}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='window position'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setWindowPosition(key);
                                    }}
                                >
                                    <DropdownItem key='mouse'>{t('config.translate.mouse')}</DropdownItem>
                                    <DropdownItem key='pre_state'>{t('config.translate.pre_state')}</DropdownItem>
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.remember_window_size')}</h3>
                        {rememberWindowSize !== null && (
                            <Switch
                                isSelected={rememberWindowSize}
                                onValueChange={(v) => {
                                    setRememberWindowSize(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.close_on_blur')}</h3>
                        {closeOnBlur !== null && (
                            <Switch
                                isSelected={closeOnBlur}
                                onValueChange={(v) => {
                                    setCloseOnBlur(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.always_on_top')}</h3>
                        {alwaysOnTop !== null && (
                            <Switch
                                isSelected={alwaysOnTop}
                                onValueChange={(v) => {
                                    setAlwaysOnTop(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.hide_source')}</h3>
                        {hideSource !== null && (
                            <Switch
                                isSelected={hideSource}
                                onValueChange={(v) => {
                                    setHideSource(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.hide_language')}</h3>
                        {hideLanguage !== null && (
                            <Switch
                                isSelected={hideLanguage}
                                onValueChange={(v) => {
                                    setHideLanguage(v);
                                }}
                            />
                        )}
                    </div>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.translate.hide_window')}</h3>
                        {hideWindow !== null && (
                            <Switch
                                isSelected={hideWindow}
                                onValueChange={(v) => {
                                    setHideWindow(v);
                                }}
                            />
                        )}
                    </div>
                </CardBody>
            </Card>
            {osType === 'Windows_NT' && (
                <Card className='mt-[10px]'>
                    <CardBody>
                        <h2 className='mb-[10px]'>{t('config.translate.overlay_title')}</h2>
                        <div className='config-item'>
                            <h3 className='my-auto mx-0'>{t('config.translate.overlay_service')}</h3>
                            {overlayService !== null && (
                                <Dropdown>
                                    <DropdownTrigger>
                                        <Button
                                            variant='bordered'
                                            className='max-w-[50%]'
                                        >
                                            {overlayService === ''
                                                ? t('config.translate.overlay_service_follow')
                                                : instanceNames[overlayService] || overlayService}
                                        </Button>
                                    </DropdownTrigger>
                                    <DropdownMenu
                                        aria-label='overlay service'
                                        className='max-h-[50vh] overflow-y-auto'
                                        onAction={(key) => {
                                            setOverlayService(key === 'follow' ? '' : key);
                                            setOverlayModel('');
                                            setOverlayModelList([]);
                                            setOverlayModelError('');
                                        }}
                                    >
                                        <DropdownItem key='follow'>
                                            {t('config.translate.overlay_service_follow')}
                                        </DropdownItem>
                                        {(translateServiceInstanceList ?? []).map((instanceKey) => (
                                            <DropdownItem key={instanceKey}>
                                                {instanceNames[instanceKey] || instanceKey}
                                            </DropdownItem>
                                        ))}
                                    </DropdownMenu>
                                </Dropdown>
                            )}
                        </div>
                        <div className='config-item items-start'>
                            <h3 className='my-auto mx-0'>{t('config.translate.overlay_ocr_service')}</h3>
                            {overlayOcrService !== null && (
                                <div className='w-[320px] max-w-full'>
                                    <Dropdown className='w-full'>
                                        <DropdownTrigger>
                                            <Button variant='bordered' className='w-full'>
                                                {instanceNames[effectiveOverlayOcrService] || effectiveOverlayOcrService}
                                            </Button>
                                        </DropdownTrigger>
                                        <DropdownMenu
                                            aria-label='overlay OCR service'
                                            className='max-h-[50vh] overflow-y-auto'
                                            onAction={(key) => setOverlayOcrService(String(key))}
                                        >
                                            {overlayOcrOptions.map((instanceKey) => (
                                                <DropdownItem key={instanceKey}>
                                                    {instanceNames[instanceKey] || getServiceName(instanceKey)}
                                                </DropdownItem>
                                            ))}
                                        </DropdownMenu>
                                    </Dropdown>
                                    <p className='mt-1 text-[11px] text-default-500'>
                                        {t('config.translate.overlay_ocr_service_hint')}
                                    </p>
                                </div>
                            )}
                        </div>
                        {overlayModelVisible && (
                            <div className='config-item'>
                                <h3 className='my-auto mx-0'>{t('config.translate.overlay_model')}</h3>
                                {overlayModel !== null && (
                                    <div className='w-[320px] max-w-full'>
                                        <Input
                                            value={overlayModel}
                                            variant='bordered'
                                            placeholder={
                                                overlayServiceConfig?.model ||
                                                t('config.translate.overlay_model_follow')
                                            }
                                            classNames={{
                                                base: 'w-full',
                                                mainWrapper: 'w-full',
                                            }}
                                            onValueChange={(value) => setOverlayModel(value)}
                                        />
                                        <p className='mt-1 text-[11px] text-default-500'>
                                            {t('config.translate.overlay_model_current')}:{' '}
                                            {overlayModel ||
                                                overlayServiceConfig?.model ||
                                                t('config.translate.overlay_model_follow')}
                                        </p>
                                        <div className='flex gap-2 mt-2'>
                                            <Dropdown className='flex-1'>
                                                <DropdownTrigger>
                                                    <Button
                                                        variant='bordered'
                                                        className='w-full'
                                                        isDisabled={overlayModelList.length === 0}
                                                    >
                                                        {t('config.translate.overlay_model_select')}
                                                    </Button>
                                                </DropdownTrigger>
                                                <DropdownMenu
                                                    aria-label='overlay model'
                                                    className='max-h-[40vh] overflow-y-auto'
                                                    onAction={(key) => setOverlayModel(key === 'follow' ? '' : key)}
                                                >
                                                    <DropdownItem key='follow'>
                                                        {t('config.translate.overlay_model_follow')}
                                                    </DropdownItem>
                                                    {overlayModelList.map((model) => (
                                                        <DropdownItem
                                                            key={model}
                                                            isDisabled={NON_CHAT_MODEL.test(model)}
                                                        >
                                                            {model}
                                                            {NON_CHAT_MODEL.test(model) && (
                                                                <span className='ml-2 text-default-400'>
                                                                    {t('services.translate.openai.non_chat_model')}
                                                                </span>
                                                            )}
                                                        </DropdownItem>
                                                    ))}
                                                </DropdownMenu>
                                            </Dropdown>
                                            <Button
                                                className='flex-1'
                                                variant='bordered'
                                                isLoading={fetchingOverlayModels}
                                                onPress={fetchOverlayModels}
                                            >
                                                {t('config.translate.overlay_model_fetch')}
                                            </Button>
                                        </div>
                                        <p className='text-[11px] text-default-500'>
                                            {t('config.translate.overlay_model_hint')}
                                        </p>
                                        {overlayModelError !== '' && (
                                            <p className='text-[11px] text-red-500'>{overlayModelError}</p>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                        <div className='config-item'>
                            <h3 className='my-auto mx-0'>{t('config.translate.overlay_target_language')}</h3>
                            {overlayTargetLanguage !== null && (
                                <div className='w-[320px] max-w-full'>
                                    <Dropdown className='w-full'>
                                        <DropdownTrigger>
                                            <Button variant='bordered' className='w-full'>
                                                {overlayTargetLanguage === ''
                                                    ? t('config.translate.overlay_target_follow')
                                                    : t(`languages.${overlayTargetLanguage}`)}
                                            </Button>
                                        </DropdownTrigger>
                                        <DropdownMenu
                                            aria-label='overlay target language'
                                            className='max-h-[50vh] overflow-y-auto'
                                            onAction={(key) => {
                                                setOverlayTargetLanguage(key === 'follow' ? '' : key);
                                            }}
                                        >
                                            <DropdownItem key='follow'>
                                                {t('config.translate.overlay_target_follow')}
                                            </DropdownItem>
                                            {languageList.map((item) => (
                                                <DropdownItem key={item}>{t(`languages.${item}`)}</DropdownItem>
                                            ))}
                                        </DropdownMenu>
                                    </Dropdown>
                                </div>
                            )}
                        </div>
                        <div className='config-item'>
                            <h3 className='my-auto mx-0'>{t('config.translate.overlay_opacity')}</h3>
                            {overlayOpacity !== null && (
                                <Input
                                    type='number'
                                    variant='bordered'
                                    min={0.3}
                                    max={1}
                                    step={0.05}
                                    value={String(overlayOpacity)}
                                    className='w-[120px] max-w-full'
                                    onValueChange={(v) => {
                                        const value = parseFloat(v);
                                        if (Number.isNaN(value)) {
                                            setOverlayOpacity(0.85);
                                        } else {
                                            setOverlayOpacity(Math.min(1, Math.max(0.3, value)));
                                        }
                                    }}
                                />
                            )}
                        </div>
                        <div className='config-item'>
                            <h3 className='my-auto mx-0'>{t('config.translate.overlay_theme')}</h3>
                            {overlayTheme !== null && (
                                <Dropdown>
                                    <DropdownTrigger>
                                        <Button variant='bordered'>
                                            {t(config.translate.overlay_theme_)}
                                        </Button>
                                    </DropdownTrigger>
                                    <DropdownMenu
                                        aria-label='overlay theme'
                                        onAction={(key) => setOverlayTheme(String(key))}
                                    >
                                        <DropdownItem key='auto'>
                                            {t('config.translate.overlay_theme_auto')}
                                        </DropdownItem>
                                        <DropdownItem key='light'>
                                            {t('config.translate.overlay_theme_light')}
                                        </DropdownItem>
                                        <DropdownItem key='dark'>
                                            {t('config.translate.overlay_theme_dark')}
                                        </DropdownItem>
                                    </DropdownMenu>
                                </Dropdown>
                            )}
                        </div>
                        <div className='config-item'>
                            <h3 className='my-auto mx-0'>{t('config.translate.overlay_font_scale')}</h3>
                            {overlayFontScale !== null && (
                                <Input
                                    type='number'
                                    variant='bordered'
                                    min={0.5}
                                    max={2}
                                    step={0.1}
                                    value={String(overlayFontScale)}
                                    className='w-[120px] max-w-full'
                                    onValueChange={(v) => {
                                        const value = parseFloat(v);
                                        if (Number.isNaN(value)) {
                                            setOverlayFontScale(1);
                                        } else {
                                            setOverlayFontScale(Math.min(2, Math.max(0.5, value)));
                                        }
                                    }}
                                />
                            )}
                        </div>
                        <div className='config-item'>
                            <h3 className='my-auto mx-0'>{t('config.translate.overlay_concurrency')}</h3>
                            {overlayConcurrency !== null && (
                                <Input
                                    type='number'
                                    variant='bordered'
                                    min={1}
                                    max={10}
                                    step={1}
                                    value={String(overlayConcurrency)}
                                    className='w-[120px] max-w-full'
                                    onValueChange={(v) => {
                                        const value = parseInt(v);
                                        if (Number.isNaN(value)) {
                                            setOverlayConcurrency(3);
                                        } else {
                                            setOverlayConcurrency(Math.min(10, Math.max(1, value)));
                                        }
                                    }}
                                />
                            )}
                        </div>
                        <div className='config-item'>
                            <h3 className='my-auto mx-0'>{t('config.translate.overlay_refresh_hotkey')}</h3>
                            <div className='flex w-[320px] max-w-full flex-wrap items-center gap-2'>
                                <Input
                                    isReadOnly
                                    variant='bordered'
                                    className='w-full min-w-0'
                                    value={overlayRefreshHotkey || ''}
                                    placeholder={t('config.translate.overlay_hotkey_hint')}
                                />
                                <Button
                                    variant='bordered'
                                    className='shrink-0 whitespace-nowrap'
                                    onPress={() => navigate('/hotkey')}
                                >
                                    {t('config.translate.overlay_go_hotkey')}
                                </Button>
                            </div>
                        </div>
                        <p className='text-[11px] text-default-500'>{t('config.translate.overlay_only_windows')}</p>
                    </CardBody>
                </Card>
            )}
        </>
    );
}
