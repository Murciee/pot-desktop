import { appWindow } from '@tauri-apps/api/window';
import { BrowserRouter } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { warn } from 'tauri-plugin-log-api';
import React, { useEffect } from 'react';
import { useTheme } from 'next-themes';

import { invoke } from '@tauri-apps/api/tauri';
import Screenshot from './window/Screenshot';
import Overlay from './window/Overlay';
import Translate from './window/Translate';
import Recognize from './window/Recognize';
import Updater from './window/Updater';
import Config from './window/Config';
import { useConfig } from './hooks';
import { flushConfigSaves } from './utils/store';
import './style.css';
import './i18n';

const windowMap = {
    translate: <Translate />,
    screenshot: <Screenshot />,
    overlay: <Overlay />,
    recognize: <Recognize />,
    config: <Config />,
    updater: <Updater />,
};

class WindowErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { message: '' };
    }

    static getDerivedStateFromError(e) {
        return { message: String((e && e.stack) || e) };
    }

    componentDidCatch(e) {
        warn(`[window:${appWindow.label}] render failed: ${(e && e.stack) || e}`);
    }

    render() {
        if (this.state.message) {
            return (
                <div
                    style={{
                        padding: 16,
                        fontFamily: 'monospace',
                        fontSize: 12,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        height: '100vh',
                        overflow: 'auto',
                        background: '#202020',
                        color: '#e7e7e7',
                    }}
                >
                    {this.state.message}
                </div>
            );
        }
        return this.props.children;
    }
}

export default function App() {
    const [devMode] = useConfig('dev_mode', false);
    const [appTheme] = useConfig('app_theme', 'system');
    const [appLanguage] = useConfig('app_language', 'en');
    const [appFont] = useConfig('app_font', 'default');
    const [appFallbackFont] = useConfig('app_fallback_font', 'default');
    const [appFontSize] = useConfig('app_font_size', 16);
    const { setTheme } = useTheme();
    const { i18n } = useTranslation();

    useEffect(() => {
        const onKeyDown = async (e) => {
            const allowKeys = ['c', 'v', 'x', 'a', 'z', 'y'];
            if (e.ctrlKey && !allowKeys.includes(e.key.toLowerCase())) {
                e.preventDefault();
            }
            if (devMode && e.key === 'F12') {
                await invoke('open_devtools');
            }
            if (e.key.startsWith('F') && e.key.length > 1) {
                e.preventDefault();
            }
            if (e.key === 'Escape') {
                try {
                    await flushConfigSaves();
                } catch {
                    // Closing still has to happen if flush fails.
                }
                if (appWindow.label === 'config') {
                    try {
                        await invoke('save_config_window_geometry_now');
                    } catch {
                        // Closing still has to happen if geometry save fails.
                    }
                }
                await appWindow.close();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [devMode]);

    useEffect(() => {
        if (appTheme !== null) {
            if (appTheme !== 'system') {
                setTheme(appTheme);
            } else {
                try {
                    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                        setTheme('dark');
                    } else {
                        setTheme('light');
                    }
                    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                        if (e.matches) {
                            setTheme('dark');
                        } else {
                            setTheme('light');
                        }
                    });
                } catch {
                    warn("Can't detect system theme.");
                }
            }
        }
    }, [appTheme]);

    useEffect(() => {
        if (appLanguage !== null) {
            i18n.changeLanguage(appLanguage);
        }
    }, [appLanguage]);

    useEffect(() => {
        if (appFont !== null && appFallbackFont !== null) {
            document.documentElement.style.fontFamily = `"${appFont === 'default' ? 'sans-serif' : appFont}","${
                appFallbackFont === 'default' ? 'sans-serif' : appFallbackFont
            }"`;
        }
        if (appFontSize !== null) {
            document.documentElement.style.fontSize = `${appFontSize}px`;
        }
    }, [appFont, appFallbackFont, appFontSize]);

    return (
        <WindowErrorBoundary>
            <BrowserRouter>
                {windowMap[appWindow.label] ?? (
                    <div style={{ padding: 16, fontFamily: 'monospace', color: '#e7e7e7' }}>
                        Unknown window label: {appWindow.label}
                    </div>
                )}
            </BrowserRouter>
        </WindowErrorBoundary>
    );
}
