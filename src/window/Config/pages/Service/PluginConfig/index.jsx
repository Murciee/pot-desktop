import { INSTANCE_NAME_CONFIG_KEY } from '../../../../../utils/service_instance';
import { Button, Input } from '@nextui-org/react';
import { DropdownTrigger } from '@nextui-org/react';
import { DropdownMenu } from '@nextui-org/react';
import { DropdownItem } from '@nextui-org/react';
import { Dropdown } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/api/shell';
import { fetch as httpFetch } from '@tauri-apps/api/http';
import { MdVisibility, MdVisibilityOff } from 'react-icons/md';
import React, { useState } from 'react';

import { useConfig } from '../../../../../hooks';
import { modelsUrlFrom } from '../../../../../services/translate/openai/utils';
function firstValue(config, keys) {
    for (const key of keys) {
        if (typeof config[key] === 'string' && config[key] !== '') {
            return config[key];
        }
    }
    return '';
}

const SECRET_KEY = /(api[-_]?key|token|secret|password)/i;

function SecretField({ value, onChange, className }) {
    const { t } = useTranslation();
    const [visible, setVisible] = useState(false);
    return (
        <Input
            type={visible ? 'text' : 'password'}
            value={value}
            variant='bordered'
            className={className}
            onValueChange={onChange}
            endContent={
                <Button
                    isIconOnly
                    size='sm'
                    type='button'
                    variant='light'
                    aria-label={
                        visible ? t('services.translate.openai.hide_key') : t('services.translate.openai.show_key')
                    }
                    title={visible ? t('services.translate.openai.hide_key') : t('services.translate.openai.show_key')}
                    onPress={() => setVisible((v) => !v)}
                >
                    {visible ? <MdVisibilityOff size={18} /> : <MdVisibility size={18} />}
                </Button>
            }
        />
    );
}

function PluginModelField({ value, config, onChange }) {
    const { t } = useTranslation();
    const [models, setModels] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const requestPath = firstValue(config, ['requestPath', 'request_path', 'baseUrl', 'base_url', 'apiUrl']);
    const apiKey = firstValue(config, ['apiKey', 'api_key', 'key']);

    const fetchModels = async () => {
        if (!requestPath) {
            setError(t('services.translate.openai.models_no_path'));
            return;
        }
        setLoading(true);
        setError('');
        try {
            const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
            const res = await httpFetch(modelsUrlFrom(requestPath), {
                method: 'GET',
                headers,
                timeout: 15,
            });
            if (!res.ok) {
                throw new Error(t('services.translate.openai.models_http_error', { status: res.status }));
            }
            const data = res.data ?? {};
            const rawList = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
            const list = rawList
                .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name))
                .filter((item) => typeof item === 'string' && item !== '');
            if (list.length === 0) {
                throw new Error(t('services.translate.openai.models_empty'));
            }
            setModels(list);
        } catch (e) {
            setError(e?.message ?? e?.toString?.() ?? String(e));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className='w-[320px] max-w-full'>
            <Input
                value={value}
                variant='bordered'
                classNames={{ base: 'w-full', mainWrapper: 'w-full' }}
                onValueChange={onChange}
            />
            {requestPath && (
                <div className='flex gap-2 mt-2'>
                    <Dropdown className='flex-1'>
                        <DropdownTrigger>
                            <Button
                                variant='bordered'
                                className='w-[320px] max-w-full'
                                isDisabled={models.length === 0}
                            >
                                {t('services.translate.openai.model_select')}
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label='plugin model'
                            className='max-h-[40vh] overflow-y-auto'
                            onAction={(key) => onChange(String(key))}
                        >
                            {models.map((model) => (
                                <DropdownItem key={model}>{model}</DropdownItem>
                            ))}
                        </DropdownMenu>
                    </Dropdown>
                    <Button
                        className='flex-1'
                        variant='bordered'
                        isLoading={loading}
                        onPress={fetchModels}
                    >
                        {t('services.translate.openai.fetch_models')}
                    </Button>
                </div>
            )}
            {error !== '' && <p className='mt-1 text-[11px] text-red-500'>{error}</p>}
        </div>
    );
}

export function PluginConfig(props) {
    const { instanceKey, updateServiceList, onClose, name, pluginList } = props;
    const [pluginConfig, setPluginConfig] = useConfig(instanceKey, {}, { sync: false });
    const { t } = useTranslation();

    const renderTextInput = (x) => {
        const value = `${pluginConfig.hasOwnProperty(x.key) ? pluginConfig[x.key] : ''}`;
        const onChange = (value) => {
            setPluginConfig({
                ...pluginConfig,
                [x.key]: value,
            });
        };
        return SECRET_KEY.test(x.key) ? (
            <SecretField
                value={value}
                onChange={onChange}
                className='w-[320px] max-w-full'
            />
        ) : (
            <Input
                value={value}
                variant='bordered'
                className='w-[320px] max-w-full'
                onValueChange={onChange}
            />
        );
    };

    return (
        <>
            <div className={'config-item'}>
                <h3 className='my-auto select-none cursor-default'>{t('config.service.homepage')}</h3>
                <Button
                    onPress={() => {
                        open(pluginList[name].homepage);
                    }}
                >
                    {t('config.service.homepage')}
                </Button>
            </div>
            {pluginConfig && (
                <div className='config-item'>
                    <Input
                        label={t('services.instance_name')}
                        labelPlacement='outside-left'
                        value={pluginConfig[INSTANCE_NAME_CONFIG_KEY] ?? pluginList[name].display}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'w-[320px] max-w-full',
                        }}
                        onValueChange={(value) => {
                            setPluginConfig({
                                ...pluginConfig,
                                [INSTANCE_NAME_CONFIG_KEY]: value,
                            });
                        }}
                    />
                </div>
            )}

            {pluginList[name].needs.length === 0 ? (
                <div>{t('services.no_need')}</div>
            ) : (
                pluginList[name].needs.map((x) => {
                    return (
                        pluginConfig &&
                        (x.type ? (
                            <div
                                key={x.key}
                                className={`config-item`}
                            >
                                <h3 className='my-auto select-none cursor-default'>{x.display}</h3>
                                {x.type === 'input' &&
                                    (x.key === 'model' ? (
                                        <PluginModelField
                                            value={`${pluginConfig.hasOwnProperty(x.key) ? pluginConfig[x.key] : ''}`}
                                            config={pluginConfig}
                                            onChange={(value) => {
                                                setPluginConfig({
                                                    ...pluginConfig,
                                                    [x.key]: value,
                                                });
                                            }}
                                        />
                                    ) : (
                                        renderTextInput(x)
                                    ))}
                                {x.type === 'select' && (
                                    <Dropdown>
                                        <DropdownTrigger>
                                            <Button
                                                variant='bordered'
                                                className='w-[320px] max-w-full'
                                            >
                                                {
                                                    x.options[
                                                        pluginConfig.hasOwnProperty(x.key)
                                                            ? pluginConfig[x.key]
                                                            : Object.keys(x.options)[0]
                                                    ]
                                                }
                                            </Button>
                                        </DropdownTrigger>
                                        <DropdownMenu
                                            aria-label={x.key}
                                            className='max-h-[40vh] overflow-y-auto'
                                            onAction={(key) => {
                                                setPluginConfig({
                                                    ...pluginConfig,
                                                    [x.key]: key,
                                                });
                                            }}
                                        >
                                            {Object.keys(x.options).map((y) => {
                                                return <DropdownItem key={y}>{x.options[y]}</DropdownItem>;
                                            })}
                                        </DropdownMenu>
                                    </Dropdown>
                                )}
                            </div>
                        ) : (
                            <div
                                key={x.key}
                                className={`config-item`}
                            >
                                <h3 className='my-auto select-none cursor-default'>{x.display}</h3>
                                {x.key === 'model' ? (
                                    <PluginModelField
                                        value={`${pluginConfig.hasOwnProperty(x.key) ? pluginConfig[x.key] : ''}`}
                                        config={pluginConfig}
                                        onChange={(value) => {
                                            setPluginConfig({
                                                ...pluginConfig,
                                                [x.key]: value,
                                            });
                                        }}
                                    />
                                ) : (
                                    renderTextInput(x)
                                )}
                            </div>
                        ))
                    );
                })
            )}

            <div>
                <Button
                    fullWidth
                    color='primary'
                    onPress={() => {
                        setPluginConfig(pluginConfig, true);
                        updateServiceList(instanceKey);
                        onClose();
                    }}
                >
                    {t('common.save')}
                </Button>
            </div>
        </>
    );
}
