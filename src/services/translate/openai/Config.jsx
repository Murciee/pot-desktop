import { Input, Button, Switch, Textarea } from '@nextui-org/react';
import { DropdownTrigger } from '@nextui-org/react';
import { MdDeleteOutline, MdVisibility, MdVisibilityOff } from 'react-icons/md';
import { DropdownMenu } from '@nextui-org/react';
import { DropdownItem } from '@nextui-org/react';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Dropdown } from '@nextui-org/react';
import { open } from '@tauri-apps/api/shell';
import { fetch as httpFetch } from '@tauri-apps/api/http';
import React, { useEffect, useMemo, useState } from 'react';

import { useConfig } from '../../../hooks/useConfig';
import { useToastStyle } from '../../../hooks';
import { translate } from './index';
import { Language } from './info';
import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { defaultPromptList, defaultRequestArguments, modelsUrlFrom } from './utils';

export { defaultRequestArguments };

const PRESETS = [
    { key: 'openai', url: 'https://api.openai.com/v1/chat/completions' },
    { key: 'deepseek', url: 'https://api.deepseek.com/v1/chat/completions' },
    { key: 'moonshot', url: 'https://api.moonshot.cn/v1/chat/completions' },
    { key: 'zhipu', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
    { key: 'siliconflow', url: 'https://api.siliconflow.cn/v1/chat/completions' },
    { key: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions' },
    { key: 'ollama', url: 'http://localhost:11434/v1/chat/completions' },
    { key: 'oneapi', url: 'http://localhost:3000/v1/chat/completions' },
];

const NON_CHAT_MODEL = /(embed|whisper|tts|dall-?e|moderation|rerank)/i;

export function Config(props) {
    const { instanceKey, updateServiceList, onClose } = props;
    const { t } = useTranslation();
    const [openaiConfig, setOpenaiConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.translate.openai.title'),
            service: 'openai',
            requestPath: 'https://api.openai.com/v1/chat/completions',
            model: 'gpt-3.5-turbo',
            apiKey: '',
            stream: false,
            disableThinking: false,
            promptList: defaultPromptList,
            requestArguments: defaultRequestArguments,
            modelList: [],
            modelListUpdatedAt: 0,
        },
        { sync: false }
    );
    const [isTesting, setIsTesting] = useState(false);
    const [fetchingModels, setFetchingModels] = useState(false);
    const [advanced, setAdvanced] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [showKey, setShowKey] = useState(false);

    // 兼容旧版本
    useEffect(() => {
        if (openaiConfig) {
            const patch = {};
            if (openaiConfig.promptList === undefined) {
                patch.promptList = defaultPromptList;
            }
            if (openaiConfig.requestArguments === undefined) {
                patch.requestArguments = defaultRequestArguments;
            }
            if (openaiConfig.disableThinking === undefined) {
                patch.disableThinking = false;
            }
            if (openaiConfig.modelList === undefined) {
                patch.modelList = [];
            }
            if (openaiConfig.modelListUpdatedAt === undefined) {
                patch.modelListUpdatedAt = 0;
            }
            if (Object.keys(patch).length > 0) {
                setOpenaiConfig({ ...openaiConfig, ...patch });
            }
        }
    }, [openaiConfig]);

    const toastStyle = useToastStyle();

    const requestArgumentsError = useMemo(() => {
        if (!openaiConfig) {
            return '';
        }
        try {
            const parsed = JSON.parse(openaiConfig.requestArguments ?? defaultRequestArguments);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return t('services.translate.openai.json_object_required');
            }
            return '';
        } catch {
            return t('services.translate.openai.invalid_json');
        }
    }, [openaiConfig?.requestArguments, t]);

    const userPromptCount = (openaiConfig?.promptList ?? []).filter((item) => item.role === 'user').length;
    const promptError = userPromptCount === 0 ? t('services.translate.openai.at_least_one_user') : '';
    const canSave = requestArgumentsError === '' && promptError === '';

    const updateConfig = (patch) => {
        setOpenaiConfig({ ...openaiConfig, ...patch });
    };

    const invalidateModels = (patch) => {
        updateConfig({ ...patch, modelList: [], modelListUpdatedAt: 0 });
    };

    const currentPreset = PRESETS.find((item) => item.url === openaiConfig?.requestPath);

    const handleFetchModels = async () => {
        if (!openaiConfig.apiKey) {
            toast.error(t('services.translate.openai.api_key_required'), { style: toastStyle });
            return;
        }
        setFetchingModels(true);
        try {
            const res = await httpFetch(modelsUrlFrom(openaiConfig.requestPath), {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${openaiConfig.apiKey}`,
                },
                timeout: 15,
            });
            if (!res.ok) {
                if (res.status === 401) {
                    throw new Error('401');
                }
                if (res.status === 404) {
                    throw new Error('404');
                }
                throw new Error(t('services.translate.openai.models_http_error', { status: res.status }));
            }
            const data = res.data ?? {};
            const rawList = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
            const modelList = rawList
                .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name))
                .filter((item) => typeof item === 'string' && item !== '');
            if (modelList.length === 0) {
                throw new Error(t('services.translate.openai.models_empty'));
            }
            updateConfig({ modelList, modelListUpdatedAt: Date.now() });
            toast.success(t('services.translate.openai.models_fetched', { count: modelList.length }), {
                style: toastStyle,
            });
        } catch (e) {
            const message = e?.message ?? e?.toString() ?? '';
            let hint = message;
            if (message.includes('401')) {
                hint = t('services.translate.openai.models_401');
            } else if (message.includes('404')) {
                hint = t('services.translate.openai.models_404');
            } else if (/timeout|timed out|超时/i.test(message)) {
                hint = t('services.translate.openai.models_timeout');
            }
            toast.error(hint, { style: toastStyle, duration: 6000 });
        } finally {
            setFetchingModels(false);
        }
    };

    const handleTest = async () => {
        if (!canSave) {
            return;
        }
        setIsTesting(true);
        setTestResult(null);
        const start = Date.now();
        try {
            const result = await translate('hello', Language.auto, Language.zh_cn, { config: openaiConfig });
            const elapsed = Date.now() - start;
            const text = typeof result === 'string' ? result.trim() : JSON.stringify(result);
            setTestResult({
                ok: true,
                text: t('services.translate.openai.test_success', {
                    ms: elapsed,
                    text: text.slice(0, 60),
                }),
            });
        } catch (e) {
            setTestResult({ ok: false, text: e?.toString() ?? String(e) });
            toast.error(t('config.service.test_failed') + (e?.toString() ?? String(e)), { style: toastStyle });
        } finally {
            setIsTesting(false);
        }
    };

    return (
        openaiConfig !== null && (
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!canSave) {
                        return;
                    }
                    setOpenaiConfig(openaiConfig, true);
                    updateServiceList(instanceKey);
                    onClose();
                }}
            >
                <Toaster />
                <div className='config-item'>
                    <Input
                        label={t('services.instance_name')}
                        labelPlacement='outside-left'
                        value={openaiConfig[INSTANCE_NAME_CONFIG_KEY]}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'w-[320px] max-w-full',
                        }}
                        onValueChange={(value) => {
                            updateConfig({ [INSTANCE_NAME_CONFIG_KEY]: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.help')}</h3>
                    <Button
                        onPress={() => {
                            open('https://pot-app.com/docs/api/translate/openai.html');
                        }}
                    >
                        {t('services.help')}
                    </Button>
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.translate.openai.service')}</h3>
                    <Dropdown>
                        <DropdownTrigger>
                            <Button variant='bordered'>{t(`services.translate.openai.${openaiConfig.service}`)}</Button>
                        </DropdownTrigger>
                        <DropdownMenu
                            autoFocus='first'
                            aria-label='service'
                            onAction={(key) => {
                                updateConfig({ service: key });
                            }}
                        >
                            <DropdownItem key='openai'>{t(`services.translate.openai.openai`)}</DropdownItem>
                            <DropdownItem key='azure'>{t(`services.translate.openai.azure`)}</DropdownItem>
                        </DropdownMenu>
                    </Dropdown>
                </div>
                {openaiConfig.service === 'openai' && (
                    <div className='config-item'>
                        <h3 className='my-auto'>{t('services.translate.openai.preset')}</h3>
                        <Dropdown>
                            <DropdownTrigger>
                                <Button variant='bordered'>
                                    {currentPreset
                                        ? t(`services.translate.openai.preset_${currentPreset.key}`)
                                        : t('services.translate.openai.preset_custom')}
                                </Button>
                            </DropdownTrigger>
                            <DropdownMenu
                                aria-label='provider preset'
                                className='max-h-[40vh] overflow-y-auto'
                                onAction={(key) => {
                                    const preset = PRESETS.find((item) => item.key === key);
                                    if (preset) {
                                        invalidateModels({
                                            requestPath: preset.url,
                                            model: '',
                                        });
                                    }
                                }}
                            >
                                {PRESETS.map((preset) => (
                                    <DropdownItem key={preset.key}>
                                        {t(`services.translate.openai.preset_${preset.key}`)}
                                    </DropdownItem>
                                ))}
                            </DropdownMenu>
                        </Dropdown>
                    </div>
                )}
                <div className='config-item'>
                    <Input
                        label={t('services.translate.openai.request_path')}
                        labelPlacement='outside-left'
                        value={openaiConfig['requestPath']}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'w-[320px] max-w-full',
                        }}
                        onValueChange={(value) => {
                            invalidateModels({ requestPath: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <Input
                        label={t('services.translate.openai.api_key')}
                        labelPlacement='outside-left'
                        type={showKey ? 'text' : 'password'}
                        value={openaiConfig['apiKey']}
                        variant='bordered'
                        classNames={{
                            base: 'justify-between',
                            label: 'text-[length:--nextui-font-size-medium]',
                            mainWrapper: 'w-[320px] max-w-full',
                        }}
                        endContent={
                            <Button
                                isIconOnly
                                size='sm'
                                type='button'
                                variant='light'
                                aria-label={showKey ? t('services.translate.openai.hide_key') : t('services.translate.openai.show_key')}
                                title={showKey ? t('services.translate.openai.hide_key') : t('services.translate.openai.show_key')}
                                onPress={() => setShowKey((value) => !value)}
                            >
                                {showKey ? <MdVisibilityOff size={18} /> : <MdVisibility size={18} />}
                            </Button>
                        }
                        onValueChange={(value) => {
                            invalidateModels({ apiKey: value });
                        }}
                    />
                </div>
                <div className={`config-item ${openaiConfig.service === 'azure' && 'hidden'}`}>
                    <h3 className='my-auto'>{t('services.translate.openai.model')}</h3>
                    <div className='w-[320px] max-w-full'>
                        <Input
                            aria-label={t('services.translate.openai.model')}
                            value={openaiConfig['model']}
                            variant='bordered'
                            placeholder='gpt-4o-mini'
                            classNames={{
                                base: 'w-full',
                                mainWrapper: 'w-full',
                            }}
                            onValueChange={(value) => {
                                updateConfig({ model: value });
                            }}
                        />
                        <div className='flex gap-2 mt-2'>
                            <Dropdown className='flex-1'>
                                <DropdownTrigger>
                                    <Button
                                        variant='bordered'
                                        className='w-full'
                                        isDisabled={(openaiConfig.modelList ?? []).length === 0}
                                        title={openaiConfig.model}
                                    >
                                        {t('services.translate.openai.model_select')}
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
                                    {(openaiConfig.modelList ?? []).map((model) => {
                                        const nonChat = NON_CHAT_MODEL.test(model);
                                        return (
                                            <DropdownItem
                                                key={model}
                                                isDisabled={nonChat}
                                            >
                                                <span className='break-all'>{model}</span>
                                                {nonChat && (
                                                    <span className='ml-2 text-default-400'>
                                                        {t('services.translate.openai.non_chat_model')}
                                                    </span>
                                                )}
                                            </DropdownItem>
                                        );
                                    })}
                                </DropdownMenu>
                            </Dropdown>
                            <Button
                                className='flex-1'
                                variant='bordered'
                                isLoading={fetchingModels}
                                onPress={handleFetchModels}
                            >
                                {t('services.translate.openai.fetch_models')}
                            </Button>
                        </div>
                    </div>
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.translate.openai.test_connection')}</h3>
                    <Button
                        variant='bordered'
                        isLoading={isTesting}
                        isDisabled={!canSave}
                        onPress={handleTest}
                    >
                        {t('services.translate.openai.test_connection')}
                    </Button>
                </div>
                {testResult && (
                    <p className={`text-[12px] break-all ${testResult.ok ? 'text-green-500' : 'text-red-500'}`}>
                        {testResult.text}
                    </p>
                )}
                <div className='config-item'>
                    <Button
                        fullWidth
                        variant='flat'
                        onPress={() => setAdvanced(!advanced)}
                    >
                        {advanced
                            ? t('services.translate.openai.hide_advanced')
                            : t('services.translate.openai.advanced')}
                    </Button>
                </div>
                {advanced && (
                    <>
                        <div className='config-item'>
                            <Switch
                                isSelected={openaiConfig['stream']}
                                onValueChange={(value) => {
                                    updateConfig({ stream: value });
                                }}
                                classNames={{
                                    base: 'flex flex-row-reverse justify-between w-full max-w-full',
                                }}
                            >
                                {t('services.translate.openai.stream')}
                            </Switch>
                        </div>
                        <div className='config-item'>
                            <Switch
                                isSelected={openaiConfig['disableThinking'] ?? false}
                                onValueChange={(value) => {
                                    updateConfig({ disableThinking: value });
                                }}
                                classNames={{
                                    base: 'flex flex-row-reverse justify-between w-full max-w-full',
                                }}
                            >
                                {t('services.translate.openai.disable_thinking')}
                            </Switch>
                        </div>
                        <p className='text-[10px] text-default-500'>
                            {t('services.translate.openai.disable_thinking_hint')}
                        </p>
                        <div className='config-item'>
                            <h3 className='my-auto'>Prompt List</h3>
                            <Button
                                size='sm'
                                variant='bordered'
                                onPress={() => updateConfig({ promptList: defaultPromptList })}
                            >
                                {t('services.translate.openai.restore_default_prompt')}
                            </Button>
                        </div>
                        <p className='text-[10px] text-default-700'>
                            {t('services.translate.openai.prompt_description')}
                        </p>

                        <div className='bg-content2 rounded-[10px] p-3'>
                            {openaiConfig.promptList &&
                                openaiConfig.promptList.map((prompt, index) => {
                                    const isLastUser =
                                        prompt.role === 'user' && userPromptCount <= 1;
                                    return (
                                        <div
                                            className='config-item'
                                            key={index}
                                        >
                                            <Textarea
                                                label={prompt.role}
                                                labelPlacement='outside'
                                                variant='faded'
                                                value={prompt.content}
                                                placeholder={`Input Some ${prompt.role} Prompt`}
                                                onValueChange={(value) => {
                                                    updateConfig({
                                                        promptList: openaiConfig.promptList.map((p, i) =>
                                                            i === index ? { ...p, content: value } : p
                                                        ),
                                                    });
                                                }}
                                            />
                                            <Button
                                                isIconOnly
                                                color='danger'
                                                className='my-auto mx-1'
                                                variant='flat'
                                                isDisabled={isLastUser}
                                                onPress={() => {
                                                    updateConfig({
                                                        promptList: openaiConfig.promptList.filter(
                                                            (_, i) => i !== index
                                                        ),
                                                    });
                                                }}
                                            >
                                                <MdDeleteOutline className='text-[18px]' />
                                            </Button>
                                        </div>
                                    );
                                })}
                            {promptError !== '' && <p className='text-[12px] text-red-500'>{promptError}</p>}
                            <Button
                                fullWidth
                                onPress={() => {
                                    updateConfig({
                                        promptList: [
                                            ...openaiConfig.promptList,
                                            {
                                                role:
                                                    openaiConfig.promptList.length === 0
                                                        ? 'system'
                                                        : openaiConfig.promptList.length % 2 === 0
                                                          ? 'assistant'
                                                          : 'user',
                                                content: '',
                                            },
                                        ],
                                    });
                                }}
                            >
                                {t('services.translate.openai.add')}
                            </Button>
                        </div>
                        <br />

                        <h3 className='my-auto'>Request Arguments</h3>
                        <div className='config-item'>
                            <Textarea
                                label=''
                                labelPlacement='outside'
                                variant='faded'
                                isInvalid={requestArgumentsError !== ''}
                                errorMessage={requestArgumentsError}
                                value={openaiConfig['requestArguments']}
                                placeholder={`Input API Request Arguments`}
                                onValueChange={(value) => {
                                    updateConfig({ requestArguments: value });
                                }}
                            />
                        </div>
                        <br />
                    </>
                )}
                <Button
                    type='submit'
                    isDisabled={!canSave}
                    fullWidth
                    color='primary'
                >
                    {t('common.save')}
                </Button>
            </form>
        )
    );
}
