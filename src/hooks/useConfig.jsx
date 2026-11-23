import { useCallback, useEffect } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { useGetState } from './useGetState';
import {
    deleteConfigKey,
    flushConfigSaves,
    getCachedConfig,
    scheduleConfigSave,
    setConfigValue,
    store,
} from '../utils/store';

export const useConfig = (key, defaultValue, options = {}) => {
    const [property, setPropertyState, getProperty] = useGetState(getCachedConfig(key));
    const { sync = true } = options;

    // 同步到Store (State -> Store)
    const syncToStore = useCallback(
        (v) => {
            scheduleConfigSave(key, v, 150);
            const eventKey = key.replaceAll('.', '_').replaceAll('@', ':');
            emit(`${eventKey}_changed`, v);
        },
        [key]
    );

    // 同步到State (Store -> State)
    const syncToState = useCallback(
        (v) => {
            if (v !== null) {
                setPropertyState(v);
            } else {
                store.get(key).then((stored) => {
                    if (stored === null) {
                        setPropertyState(defaultValue);
                        void setConfigValue(key, defaultValue);
                    } else {
                        setPropertyState(stored);
                    }
                });
            }
        },
        [key]
    );

    const setProperty = useCallback(
        (v, forceSync = false) => {
            setPropertyState(v);
            const isSync = forceSync || sync;
            if (isSync) {
                syncToStore(v);
            }
        },
        [sync, syncToStore]
    );

    // 初始化
    useEffect(() => {
        syncToState(null);
        const eventKey = key.replaceAll('.', '_').replaceAll('@', ':');
        const unlisten = listen(`${eventKey}_changed`, (e) => {
            syncToState(e.payload);
        });
        return () => {
            void flushConfigSaves([key]);
            unlisten.then((f) => {
                f();
            });
        };
    }, [key]);

    return [property, setProperty, getProperty];
};

export const deleteKey = (key) => {
    void deleteConfigKey(key);
};
