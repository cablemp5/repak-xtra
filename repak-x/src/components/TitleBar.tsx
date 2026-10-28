import { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CgMinimizeAlt } from "react-icons/cg";
import { CgMaximizeAlt } from "react-icons/cg";
import { MdMinimize } from "react-icons/md";
import { GrClose } from 'react-icons/gr';
import './TitleBar.css';
import ModularLogo from './ui/ModularLogo';

interface TitleBarProps {
    title?: string;
    hideMaximize?: boolean;
}

const TitleBar = ({ title = "repakxtra", hideMaximize = false }: TitleBarProps) => {
    const [appWindow, setAppWindow] = useState<ReturnType<typeof getCurrentWindow> | null>(null);
    const [isMaximized, setIsMaximized] = useState(false);
    const [isFocused, setIsFocused] = useState(true);

    useEffect(() => {
        // Get the current window instance
        const win = getCurrentWindow();
        setAppWindow(win);

        // Check initial state
        win.isMaximized().then(setIsMaximized);

        const checkMaximizedState = async () => {
            if (win) {
                try {
                    const max = await win.isMaximized();
                    setIsMaximized(max);
                } catch (e) {
                    // Window might be closing or destroyed, ignore
                }
            }
        };

        // repakxtra: the resize event keeps the maximize icon right (Snap Layouts too), instead of asking every second
        const unlistenResize = win.onResized(checkMaximizedState);

        // Focus listeners
        const unlistenFocus = win.listen('tauri://focus', () => {
            // console.log('Window focused');
            setIsFocused(true);
        });

        const unlistenBlur = win.listen('tauri://blur', () => {
            // console.log('Window blurred');
            setIsFocused(false);
        });

        return () => {
            unlistenResize.then(f => { try { f(); } catch (e) { } }).catch(() => { });
            unlistenFocus.then(f => { try { f(); } catch (e) { } }).catch(() => { });
            unlistenBlur.then(f => { try { f(); } catch (e) { } }).catch(() => { });
        };
    }, []);

    const handleMinimize = () => {
        appWindow?.minimize();
    };

    const handleMaximize = async () => {
        if (appWindow) {
            await appWindow.toggleMaximize();
            // Update state immediately after toggle
            const max = await appWindow.isMaximized();
            setIsMaximized(max);
        }
    };

    const handleClose = () => {
        appWindow?.close();
    };

    return (
        <div className={`titlebar ${isFocused ? 'focused' : 'blurred'}`}>
            <div className="titlebar-drag-region" data-tauri-drag-region>
                {/* Icon and Title */}
                <ModularLogo size={16} className="titlebar-icon" />
                <span className="titlebar-title">{title}</span>
            </div>

            <div className="titlebar-controls">
                <button className="titlebar-button" onClick={handleMinimize} title="Minimize">
                    <MdMinimize />
                </button>
                {!hideMaximize && (
                    <button className="titlebar-button" onClick={handleMaximize} title={isMaximized ? "Restore" : "Maximize"}>
                        {isMaximized ? <CgMinimizeAlt /> : <CgMaximizeAlt />}
                    </button>
                )}
                <button className="titlebar-button close" onClick={handleClose} title="Close">
                    <GrClose />
                </button>
            </div>
        </div>
    );
};

export default TitleBar;
