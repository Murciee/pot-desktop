import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { Input, Switch, Button } from '@nextui-org/react';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/api/shell';
import React, { useState } from 'react';

import { useConfig } from '../../../hooks/useConfig';
import { useToastStyle } from '../../../hooks';
import { recognize, Language } from './index';

const TEST_IMAGE =
    'iVBORw0KGgoAAAANSUhEUgAAADsAAAAeCAYAAACSRGY2AAAAAXNSR0IArs4c6QAAArNJREFUWEftl19IU1Ecxz+O5uQiNTCJkNj0ZWhkSOyh7CEy0CWZQQoTWYgvk17KFAdr9GBBYGb/qD0oUpgSCZViGkTRQ/hwEVOYIIhlMF8kUjbGZGPFdGtrGvcWzTa79/Gec+79fb7fc36/38nQ6/Xf+E+eDAV2mzqdns6WtDNRqYP5UQ71D8i2RoGVLdW/mqg4K6287G3sqHtEdYEP8clrdpZXYdCCxzWE/dkHjp5poXa/AMEVZodvU+ea2/Dn0n2NnK8wYsgVQAWEAng+TfHiZTddy75NI83LtdBRfSS2xruIONKNNftccs9sFPbLkpqcXUCmei1At2uO3YU6CKnR7AhDLDJ204bdH4u/tKSdjkodmvCrEKz6A2iE9fWEVhAftmF1JwBnmxm0msjPinzHH2A1U42GFcSJZYzGJCaodVhYnRqgZngUCmw8rStC419gzOnA7iuio8HG8b3wccTC2clIkFkWhppPkKcK4H7bTev7cWbDQ5kHcZxqorpQAO8M929dp+eHPgJtNXepNajh6wx9j+9E3BeoONBCc7mOnCx18rJxFDYGYmbwson85Sm67nXSB9SXO7loFPCIDzj2anwtdOPhTpxlueB+h7W3BzF+w6pM9F8wYxACTPc30jAfHTTR22ymeMP78HicEMkqPX8Ku5kAMV6Ba/VOKvQJu4GIkCzx5sYlWuOOxE8CphcsbBQxjBOFXeD5VQftiekr2aUnOc4qsNvV2W12ZuVlYx9irxWrO82zMXLqbFz5WseVqLNlOnKyU7DOhkP/qx2Uysf05BLFJVvQQf1uUxHdmIY9Fq5UxfW5wQCezxK9sbYKx+mTGPMi/fRW9cbSd4rUnyH71pP6KNIRKrDSGqXnDMXZ9PRNOmrF2USNtFotXq+XYDAoLV8Kz5DlrAKbwg7+KrTvuhRWXxXeDuUAAAAASUVORK5CYII=';

export function Config(props) {
    const { instanceKey, updateServiceList, onClose } = props;
    const { t } = useTranslation();
    const [config, setConfig] = useConfig(
        instanceKey,
        {
            [INSTANCE_NAME_CONFIG_KEY]: t('services.recognize.openai_ocr.title'),
            model: 'gpt-4o',
            requestPath: 'https://api.openai.com',
            apiKey: '',
            customPrompt: '',
            disableThinking: false,
        },
        { sync: false }
    );
    const [isLoading, setIsLoading] = useState(false);

    const toastStyle = useToastStyle();

    const inputProps = {
        variant: 'bordered',
        classNames: {
            mainWrapper: 'w-[320px] max-w-full',
        },
    };

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
                    <Input
                        {...inputProps}
                        value={config[INSTANCE_NAME_CONFIG_KEY]}
                        onValueChange={(value) => {
                            setConfig({ ...config, [INSTANCE_NAME_CONFIG_KEY]: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.model')}</h3>
                    <Input
                        {...inputProps}
                        value={config['model']}
                        onValueChange={(value) => {
                            setConfig({ ...config, model: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.request_path')}</h3>
                    <Input
                        {...inputProps}
                        value={config['requestPath']}
                        onValueChange={(value) => {
                            setConfig({ ...config, requestPath: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.api_key')}</h3>
                    <Input
                        {...inputProps}
                        type='password'
                        value={config['apiKey']}
                        onValueChange={(value) => {
                            setConfig({ ...config, apiKey: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.custom_prompt')}</h3>
                    <Input
                        {...inputProps}
                        value={config['customPrompt']}
                        placeholder={t('services.recognize.openai_ocr.custom_prompt_placeholder')}
                        onValueChange={(value) => {
                            setConfig({ ...config, customPrompt: value });
                        }}
                    />
                </div>
                <div className='config-item'>
                    <h3 className='my-auto'>{t('services.recognize.openai_ocr.disable_thinking')}</h3>
                    <Switch
                        isSelected={config['disableThinking'] ?? false}
                        onValueChange={(value) => {
                            setConfig({ ...config, disableThinking: value });
                        }}
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
