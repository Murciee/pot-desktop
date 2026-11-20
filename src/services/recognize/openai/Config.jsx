import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { Input, Switch, Button, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from '@nextui-org/react';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { fetch as httpFetch } from '@tauri-apps/api/http';
import { open } from '@tauri-apps/api/shell';
import React, { useState } from 'react';

import { useConfig } from '../../../hooks/useConfig';
import { useToastStyle } from '../../../hooks';
import { modelsUrlFrom } from '../../translate/openai/utils';
import { recognize, Language } from './index';

const TEST_IMAGE =
    'iVBORw0KGgoAAAANSUhEUgAAADsAAAAeCAYAAACSRGY2AAAAAXNSR0IArs4c6QAAArNJREFUWEftl19IU1Ecxz+O5uQiNTCJkNj0ZWhkSOyh7CEy0CWZQQoTWYgvk17KFAdr9GBBYGb/qD0oUpgSCZViGkTRQ/hwEVOYIIhlMF8kUjbGZGPFdGtrGvcWzTa79/Gec+79fb7fc36/38nQ6/Xf+E+eDAV2mzqdns6WtDNRqYP5UQ71D8i2RoGVLdW/mqg4K6287G3sqHtEdYEP8clrdpZXYdCCxzWE/dkHjp5poXa/AMEVZodvU+ea2/Dn0n2NnK8wYsgVQAWEAng+TfHiZTddy75NI83LtdBRfSS2xruIONKNNftccs9sFPbLkpqcXUCmei1At2uO3YU6CKnR7AhDLDJ204bdH4u/tKSdjkodmvCrEKz6A2iE9fWEVhAftmF1JwBnmxm0msjPinzHH2A1U42GFcSJZYzGJCaodVhYnRqgZngUCmw8rStC419gzOnA7iuio8HG8b3wccTC2clIkFkWhppPkKcK4H7bTev7cWbDQ5kHcZxqorpQAO8M929dp+eHPgJtNXepNajh6wx9j+9E3BeoONBCc7mOnCx18rJxFDYGYmbwson85Sm67nXSB9SXO7loFPCIDzj2anwtdOPhTpxlueB+h7W3BzF+w6pM9F8wYxACTPc30jAfHTTR22ymeMP78HicEMkqPX8Ku5kAMV6Ba/VOKvQJu4GIkCzx5sYlWuOOxE8CphcsbBQxjBOFXeD5VQftiekr2aUnOc4qsNvV2W12ZuVlYx9irxWrO82zMXLqbFz5WseVqLNlOnKyU7DOhkP/qx2Uysf05BLFJVvQQf1uUxHdmIY9Fq5UxfW5wQCezxK9sbYKx+mTGPMi/fRW9cbSd4rUnyH71pP6KNIRKrDSGqXnDMXZ9PRNOmrF2USNtFotXq+XYDAoLV8Kz5DlrAKbwg7+KrTvuhRWXxXeDuUAAAAASUVORK5CYII=';

const PRESETS = [
    { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions' },
    { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1/chat/completions' },
    { name: 'Volcengine Ark', url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' },
    { name: 'DashScope', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
    { name: 'Gemini', url: 'https://generativelanguage.googleapis.com' },
    { name: 'Ollama', url: 'http://localhost:11434/v1/chat/completions' },
    { name: 'OneAPI', url: 'http://localhost:3000/v1/chat/completions' },
];

const NON_CHAT_MODEL = /(embed|whisper|tts|dall-?e|moderation|rerank|image)/i;

function isGoogleNative(path) {
    return path.includes('generativelanguage.googleapis.com') && !/\/openai(\/|$)/.test(path);
}

function googleModelsUrl(path, apiKey) {
    const base = path
        .replace(/\/+$/, '')
        .replace(/\/v1beta\/models$/, '')
        .replace(/\/v1beta$/, '');
    return `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
}

export function Config(props) {
    const { instanceKey, updateServiceList, onClose } = props;
    const { t } = useTranslation();
    const [config, setConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.recognize.openai_ocr.title'),
            model: 'gpt-4o',
            requestPath: 'https://api.openai.com/v1/chat/completions',
            apiKey: '',
            customPrompt: '',
            disableThinking: false,
            modelList: [],
        },
        { sync: false }
    );
    const [isLoading, setIsLoading] = useState(false);
    const [fetchingModels, setFetchingModels] = useState(false);

    const toastStyle = useToastStyle();

    const updateConfig = (patch) => {
        setConfig({ ...config, ...patch });
    };

    const currentPreset = config ? PRESETS.find((item) => item.url === config.requestPath) : null;

    const handleFetchModels = async () => {
        if (!config.apiKey) {
            toast.error(t('services.recognize.openai_ocr.api_key_required'), { style: toastStyle });
            return;
        }
        setFetchingModels(true);
        try {
            const url = isGoogleNative(config.requestPath)
                ? googleModelsUrl(config.requestPath, config.apiKey)
                : modelsUrlFrom(config.requestPath);
            const res = await httpFetch(url, {
                method: 'GET',
                headers: isGoogleNative(config.requestPath) ? {} : { Authorization: `Bearer ${config.apiKey}` },
                timeout: 15,
            });
            if (!res.ok) {
                throw new Error(t('services.recognize.openai_ocr.models_http_error', { status: res.status }));
            }
            const data = res.data ?? {};
            const rawList = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
            const modelList = rawList
                .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name))
                .filter((item) => typeof item === 'string' && item !== '');
            if (modelList.length === 0) {
                throw new Error(t('services.recognize.openai_ocr.models_empty'));
            }
            updateConfig({ modelList });
            toast.success(t('services.recognize.openai_ocr.models_fetched', { count: modelList.length }), {
                style: toastStyle,
            });
        } catch (e) {
            toast.error(t('services.recognize.openai_ocr.models_failed') + e.toString(), {
                style: toastStyle,
                duration: 6000,
            });
        } finally {
            setFetchingModels(false);
        }
    };

    const textInput = (value, onChange, extra = {}) => (
        <Input
            variant='bordered'
            classNames={{ base: 'w-full', mainWrapper: 'w-full' }}
            value={value}
            onValueChange={onChange}
            {...extra}
        />
    );

    return (
        config !== null && (
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    setIsLoading(true);
                    recognize(TEST_IMAGE, Language.auto, { config }).then(
                        () => {
                            setIsLoading(false);
                            setConfig(config, true);
                            updateServiceList(instanceKey);
                            onClose();
                        },
                        (e) => {
                            setIsLoading(false);
                            toast.error(t('config.service.test_failed') + e.toString(), { style: toastStyle });
                        }
                    );
                }}
            >
                <Toaster />
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.instance_name')}</h3>
                    {textInput(config[INSTANCE_NAME_CONFIG_KEY], (value) =>
                        updateConfig({ [INSTANCE_NAME_CONFIG_KEY]: value })
                    )}
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.preset')}</h3>
                    <Dropdown>
                        <DropdownTrigger>
                            <Button variant='bordered'>
                                {currentPreset ? currentPreset.name : t('services.recognize.openai_ocr.preset_custom')}
                            </Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            aria-label='address preset'
                            onAction={(key) => {
                                const preset = PRESETS.find((item) => item.name === key);
                                if (preset) {
                                    updateConfig({ requestPath: preset.url, modelList: [] });
                                }
                            }}
                        >
                            {PRESETS.map((preset) => (
                                <DropdownItem key={preset.name}>{preset.name}</DropdownItem>
                            ))}
                        </DropdownMenu>
                    </Dropdown>
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.request_path')}</h3>
                    {textInput(config.requestPath, (value) => updateConfig({ requestPath: value, modelList: [] }))}
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.api_key')}</h3>
                    {textInput(config.apiKey, (value) => updateConfig({ apiKey: value }), { type: 'password' })}
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.model')}</h3>
                    <div className='w-full'>
                        {textInput(config.model, (value) => updateConfig({ model: value }))}
                        <div className='flex gap-2 mt-2'>
                            <Dropdown className='flex-1'>
                                <DropdownTrigger>
                                    <Button
                                        variant='bordered'
                                        className='w-full'
                                        isDisabled={(config.modelList ?? []).length === 0}
                                    >
                                        {t('services.recognize.openai_ocr.model_select')}
                                    </Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='model list'
                                    className='max-h-[40vh] overflow-y-auto'
                                    onAction={(key) => {
                                        const model = String(key);
                                        if (!NON_CHAT_MODEL.test(model)) {
                                            updateConfig({ model });
                                        }
                                    }}
                                >
                                    {(config.modelList ?? []).map((model) => {
                                        const nonChat = NON_CHAT_MODEL.test(model);
                                        return (
                                            <DropdownItem
                                                key={model}
                                                isDisabled={nonChat}
                                            >
                                                <span className='break-all'>{model}</span>
                                                {nonChat && (
                                                    <span className='ml-2 text-default-400'>
                                                        {t('services.recognize.openai_ocr.non_chat_model')}
                                                    </span>
                                                )}
                                            </DropdownItem>
                                        );
                                    })}
                                </DropdownMenu>
                            </Dropdown>
                            <Button
                                variant='bordered'
                                isLoading={fetchingModels}
                                onPress={handleFetchModels}
                            >
                                {t('services.recognize.openai_ocr.fetch_models')}
                            </Button>
                        </div>
                    </div>
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.custom_prompt')}</h3>
                    {textInput(config.customPrompt, (value) => updateConfig({ customPrompt: value }), {
                        placeholder: t('services.recognize.openai_ocr.custom_prompt_placeholder'),
                    })}
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.disable_thinking')}</h3>
                    <Switch
                        isSelected={config.disableThinking ?? false}
                        onValueChange={(value) => updateConfig({ disableThinking: value })}
                    />
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.help')}</h3>
                    <Button
                        onPress={() => {
                            open('https://github.com/pot-app/pot-app-recognize-plugin-openai');
                        }}
                    >
                        {t('services.help')}
                    </Button>
                </div>
                <Button
                    type='submit'
                    isLoading={isLoading}
                    color='primary'
                    fullWidth
                >
                    {t('common.save')}
                </Button>
            </form>
        )
    );
}
