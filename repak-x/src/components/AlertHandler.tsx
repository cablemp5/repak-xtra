import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, memo } from 'react';
import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X } from 'lucide-react'; // repakxtra: a plain check for success, X for Clear all
import './ui/Alert.css';
import { alertSound } from '../custom/sounds' // repakxtra
import { quietToast } from '../custom/uiPrefs' // repakxtra
import { ToastAnnouncer, clockElapsed, holdClock, survivor, type ToastClock } from '../custom/toastA11y' // repakxtra
import { focusInto, topModal } from '../custom/dialogFocus' // repakxtra

// Toast Icons
type ToastColor = 'success' | 'danger' | 'warning' | 'info' | 'default' | 'crash' | 'primary' | 'secondary';
type IconColor = Exclude<ToastColor, 'primary' | 'secondary'>;

const Icons: Record<IconColor, React.ReactNode> = {
    success: <Check size={18} strokeWidth={2.5} />,
    danger: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
    ),
    warning: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
    ),
    info: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
    ),
    default: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
        </svg>
    ),
    crash: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
    )
};

type ToastAction = {
    label?: string;
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

type Toast = {
    id: number;
    color?: ToastColor;
    variant?: string;
    title?: string;
    description?: string;
    duration?: number;
    createdAt?: number;
    icon?: React.ReactNode;
    hideIcon?: boolean;
    endContent?: React.ReactNode;
    action?: ToastAction | React.ReactNode;
    isLoading?: boolean;
    progressValue?: number;
    [key: string]: unknown;
};

type PromiseToastState = {
    title?: string;
    description?: string;
    [key: string]: unknown;
};

type PromiseToastConfig = PromiseToastState | ((value: any) => PromiseToastState);

type AlertOptions = Partial<Toast> & {
    loading?: PromiseToastState;
    success?: PromiseToastConfig;
    error?: PromiseToastConfig;
};

type AlertContextValue = {
    showAlert: (alertConfig: AlertOptions) => number;
    dismissAlert: (id: number) => void;
    dismissAllAlerts: () => void;
    updateToast: (id: number, updates: AlertOptions) => void;
    success: (title: string, description?: string, options?: AlertOptions) => number;
    error: (title: string, description?: string, options?: AlertOptions) => number;
    warning: (title: string, description?: string, options?: AlertOptions) => number;
    info: (title: string, description?: string, options?: AlertOptions) => number;
    crash: (title?: string, description?: string, options?: AlertOptions) => number;
    promise: <T = any>(promiseOrFn: Promise<T> | (() => Promise<T>), options?: AlertOptions) => number;
};

type AlertProviderProps = {
    children: ReactNode;
    placement?: string;
};

// Create the Alert Context
const AlertContext = createContext<AlertContextValue | null>(null);

// Custom hook to use alerts from any component
export const useAlert = (): AlertContextValue => {
    const context = useContext(AlertContext);
    if (!context) {
        throw new Error('useAlert must be used within an AlertProvider');
    }
    return context;
};

// Default configuration
const DEFAULT_CONFIG = {
    placement: 'bottom-center', // bottom-center as requested
    maxVisible: 5,
    defaultDuration: 5000
};

// Alert Provider Component
export function AlertProvider({ children, placement = DEFAULT_CONFIG.placement }: AlertProviderProps) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    // Add a new toast
    const showAlert = useCallback((alertConfig: AlertOptions) => {
        if (quietToast(alertConfig)) return -1; // repakxtra: Minimal toasts skips everyday confirmations
        const id = Date.now() + Math.random();
        const toast: Toast = {
            id,
            color: 'default',
            variant: 'flat',
            ...alertConfig,
            duration: typeof alertConfig.duration === 'number'
                ? alertConfig.duration
                : DEFAULT_CONFIG.defaultDuration,
            createdAt: Date.now()
        };

        setToasts(prev => [...prev, toast]);
        alertSound(toast.color, toast.isLoading); // repakxtra
        return id;
    }, []);

    // Dismiss a toast by ID
    const dismissAlert = useCallback((id: number) => {
        setToasts(prev => prev.filter(toast => toast.id !== id));
    }, []);

    // Dismiss all toasts
    const dismissAllAlerts = useCallback(() => {
        setToasts([]);
    }, []);

    // Update an existing toast
    const updateToast = useCallback((id: number, updates: AlertOptions) => {
        // repakxtra: Minimal toasts: a progress toast that finished as an everyday success goes away instead
        if (updates.color && quietToast(updates)) { setToasts(prev => prev.filter(toast => toast.id !== id)); return; }
        if (updates.color) alertSound(updates.color, updates.isLoading); // repakxtra: a loading toast that finished
        setToasts(prev => prev.map(toast =>
            toast.id === id ? { ...toast, ...updates } : toast
        ));
    }, []);

    // Convenience methods for common toast types
    const success = useCallback((title: string, description?: string, options: AlertOptions = {}) => {
        return showAlert({ color: 'success', title, description, ...options });
    }, [showAlert]);

    const error = useCallback((title: string, description?: string, options: AlertOptions = {}) => {
        return showAlert({ color: 'danger', title, description, ...options });
    }, [showAlert]);

    const warning = useCallback((title: string, description?: string, options: AlertOptions = {}) => {
        return showAlert({ color: 'warning', title, description, ...options });
    }, [showAlert]);

    const info = useCallback((title: string, description?: string, options: AlertOptions = {}) => {
        return showAlert({ color: 'primary', title, description, ...options });
    }, [showAlert]);

    const crash = useCallback((title?: string, description?: string, options: AlertOptions = {}) => {
        return showAlert({
            color: 'danger',
            icon: Icons.crash,
            title: title || 'Game Crashed',
            description,
            duration: 0, // Persistent by default
            ...options
        });
    }, [showAlert]);

    // Promise toast - shows loading state while promise is pending
    const promise = useCallback(<T = any>(promiseOrFn: Promise<T> | (() => Promise<T>), options: AlertOptions = {}) => {
        const {
            loading = { title: 'Loading...', description: 'Please wait' },
            success: successConfig = { title: 'Success', description: 'Operation completed' },
            error: errorConfig = { title: 'Error', description: 'Something went wrong' },
            ...restOptions
        } = options;

        // Create the loading toast
        const id = showAlert({
            ...loading,
            color: 'default',
            isLoading: true,
            duration: 0, // Don't auto-dismiss while loading
            ...restOptions
        });

        // Execute the promise
        const thePromise = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;

        thePromise
            .then((result) => {
                // Update to success state
                const successOptions = typeof successConfig === 'function'
                    ? successConfig(result)
                    : successConfig;
                updateToast(id, {
                    ...successOptions,
                    color: 'success',
                    isLoading: false,
                    duration: DEFAULT_CONFIG.defaultDuration
                });
            })
            .catch((err) => {
                // Update to error state
                const errorOptions = typeof errorConfig === 'function'
                    ? errorConfig(err)
                    : errorConfig;
                updateToast(id, {
                    ...errorOptions,
                    color: 'danger',
                    isLoading: false,
                    duration: DEFAULT_CONFIG.defaultDuration
                });
            });

        return id;
    }, [showAlert, updateToast]);

    // Memoize context value to prevent unnecessary re-renders
    const contextValue = useMemo(() => ({
        showAlert,
        dismissAlert,
        dismissAllAlerts,
        updateToast,
        success,
        error,
        warning,
        info,
        crash,
        promise
    }), [showAlert, dismissAlert, dismissAllAlerts, updateToast, success, error, warning, info, crash, promise]);

    return (
        <AlertContext.Provider value={contextValue}>
            {children}
            <ToastContainer
                toasts={toasts}
                onDismiss={dismissAlert}
                onDismissAll={dismissAllAlerts}
                placement={placement}
            />
            <ToastAnnouncer toasts={toasts} />{/* repakxtra: results read out once, failures at once */}
        </AlertContext.Provider>
    );
}

// Animation variants - extracted as constants to avoid recalculation
const ANIMATION_VARIANTS = {
    bottomCenter: {
        initial: { opacity: 0, y: 50, scale: 0.9 },
        animate: { opacity: 1, x: 0, y: 0, scale: 1 },
        exit: { opacity: 0, y: 20, scale: 0.9 }
    },
    topCenter: {
        initial: { opacity: 0, y: -50, scale: 0.9 },
        animate: { opacity: 1, x: 0, y: 0, scale: 1 },
        exit: { opacity: 0, y: -20, scale: 0.9 }
    },
    left: {
        initial: { opacity: 0, x: -100, scale: 0.9 },
        animate: { opacity: 1, x: 0, y: 0, scale: 1 },
        exit: { opacity: 0, x: -50, scale: 0.9 }
    },
    right: {
        initial: { opacity: 0, x: 100, scale: 0.9 },
        animate: { opacity: 1, x: 0, y: 0, scale: 1 },
        exit: { opacity: 0, x: 50, scale: 0.9 }
    }
};

// Get animation variants based on placement
function getAnimationVariants(placement: string) {
    const isBottom = placement.startsWith('bottom');
    const isCenter = placement.includes('center');
    const isLeft = placement.includes('left');

    if (isCenter) {
        return isBottom ? ANIMATION_VARIANTS.bottomCenter : ANIMATION_VARIANTS.topCenter;
    } else if (isLeft) {
        return ANIMATION_VARIANTS.left;
    }
    return ANIMATION_VARIANTS.right;
}

// Toast Container - renders all active toasts with card stacking
function ToastContainer({ toasts, onDismiss, onDismissAll, placement }: { toasts: Toast[]; onDismiss: (id: number) => void; onDismissAll: () => void; placement: string }) {
    const [isPointer, setIsHovered] = useState(false);
    const [hasFocus, setHasFocus] = useState(false); // repakxtra: keyboard focus fans the stack out too
    const isHovered = isPointer || hasFocus;
    const maxVisible = 3; // Show max 3 stacked cards

    // Get the most recent toasts (reverse so newest is first)
    const recentToasts = [...toasts].reverse().slice(0, maxVisible);

    // repakxtra: a focused toast that goes (Close, Undo, Clear all) hands focus to the toast now in its place, else back
    // to where focus came from, else into the open dialog. Never when focus has moved on by itself
    const focusedId = useRef<number | null>(null);
    const cameFrom = useRef<HTMLElement | null>(null);
    const order = useRef<number[]>([]);
    useEffect(() => {
        const before = order.current;
        const now = [...toasts].reverse().map(t => t.id);
        order.current = now;
        const gone = focusedId.current;
        if (gone === null || now.includes(gone)) return;
        const active = document.activeElement;
        if (active && active !== document.body && !active.closest(`[data-toast-id="${gone}"]`)) return;
        focusedId.current = null;
        const next = survivor(before, now, gone);
        const target = next === null ? null : document.querySelector<HTMLElement>(`[data-toast-id="${next}"] button`);
        const back = cameFrom.current;
        if (target) target.focus();
        else if (back?.isConnected && !back.closest('[inert]')) back.focus();
        else { const top = topModal(); if (top) focusInto(top); }
    }, [toasts]);
    const onFocus = (e: React.FocusEvent<HTMLDivElement>) => {
        const toast = (e.target as HTMLElement).closest<HTMLElement>('[data-toast-id]');
        focusedId.current = toast ? Number(toast.dataset.toastId) : null;
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) cameFrom.current = e.relatedTarget as HTMLElement | null;
        setHasFocus(true);
    };
    const onBlur = (e: React.FocusEvent<HTMLDivElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        // Moved on by itself, or clicked away while that toast stays: not a toast that went
        if (e.relatedTarget || toasts.some(t => t.id === focusedId.current)) focusedId.current = null;
        setHasFocus(false);
    };

    // repakxtra: fanned out on hover, each toast sits 8px past the real height of the ones in front of it (a fixed
    // 100px step left big gaps under short toasts)
    const [heights, setHeights] = useState<Record<number, number>>({});
    const reportHeight = useCallback((id: number, h: number) => setHeights(prev => (prev[id] === h ? prev : { ...prev, [id]: h })), []);
    const spread = recentToasts.map((_, i) => recentToasts.slice(0, i).reduce((sum, t) => sum + (heights[t.id] ?? 72) + 8, 0));
    // repakxtra: the stack's visible height (its toasts are absolute), so the footer below it never covers one
    const extent = Math.max(0, ...recentToasts.map((t, i) => (heights[t.id] ?? 72) * (isHovered ? 1 : 1 - i * 0.05) + (isHovered ? spread[i] : i * 10)));

    const isBottom = placement.startsWith('bottom');

    return (
        <div
            className={`toast-container ${placement}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onFocus={onFocus} onBlur={onBlur} // repakxtra
        >
            {/* Wrapper for stacked cards - relative positioned to contain absolutes */}
            <div
                className="toast-stack-wrapper"
                style={{
                    position: 'relative',
                    width: '100%',
                    height: extent, // repakxtra: was minHeight 70px
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: isBottom ? 'flex-end' : 'flex-start',
                }}
            >
                <AnimatePresence mode="popLayout">
                    {recentToasts.map((toast, index) => (
                        <ToastItem
                            key={toast.id}
                            toast={toast}
                            onDismiss={onDismiss}
                            index={index}
                            total={recentToasts.length}
                            isHovered={isHovered}
                            placement={placement}
                            spread={spread[index]}
                            onHeight={reportHeight}
                        />
                    ))}
                </AnimatePresence>
            </div>

            {/* repakxtra: footer below the stack */}
            {toasts.length > 1 && (
                <div className="toast-footer-overlay">
                    {toasts.length > maxVisible && (
                        <span className="toast-count-badge">
                            +{toasts.length - maxVisible}
                        </span>
                    )}
                    <button
                        className="toast-clear-all"
                        onClick={onDismissAll}
                        title="Clear all notifications"
                    >
                        <X size={14} /> Clear all
                    </button>
                </div>
            )}
        </div>
    );
}

// Individual Toast Item with card stacking effect - memoized to prevent unnecessary re-renders
const ToastItem = memo(function ToastItem({ toast, onDismiss, index, total, isHovered, placement, spread = index * 100, onHeight }: any) {
    const itemRef = useRef<HTMLDivElement>(null);
    useEffect(() => { // repakxtra: report this toast's height so the hovered stack spaces by it
        const el = itemRef.current;
        if (!el || !onHeight) return;
        const ro = new ResizeObserver(() => onHeight(toast.id, el.offsetHeight));
        ro.observe(el);
        return () => ro.disconnect();
    }, [toast.id, onHeight]);
    const [progress, setProgress] = useState(100);
    const [isPaused, setIsPaused] = useState(false);
    const [hasFocus, setHasFocus] = useState(false); // repakxtra: focus in the toast holds its timer, like the pointer
    const held = isPaused || hasFocus;
    const clock = useRef<ToastClock>({ elapsed: 0, since: null }); // repakxtra: time run so far, kept across holds

    const { id, title, description, color, variant, icon, hideIcon, duration, endContent, action, isLoading, progressValue } = toast;

    // Only the front toast (index 0) should auto-dismiss
    const shouldAutoDismiss = index === 0;

    // Handle auto-dismiss with progress (repakxtra: held while hovered or focused, either one)
    useEffect(() => {
        if (!shouldAutoDismiss || duration <= 0 || held) return;
        clock.current = holdClock(clock.current, false, Date.now());

        const interval = setInterval(() => {
            const remaining = Math.max(0, 100 - (clockElapsed(clock.current, Date.now()) / duration) * 100);
            setProgress(remaining);

            if (remaining <= 0) {
                clearInterval(interval);
                onDismiss(id);
            }
        }, 50);

        return () => {
            clearInterval(interval);
            clock.current = holdClock(clock.current, true, Date.now());
        };
    }, [id, duration, held, onDismiss, shouldAutoDismiss]);

    // Get the appropriate icon
    const getIcon = () => {
        if (isLoading) {
            return (
                <svg className="toast-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25"></circle>
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"></path>
                </svg>
            );
        }
        if (icon) return icon;
        if (color === 'primary' || color === 'secondary') return Icons.info;
        return color && color in Icons ? Icons[color as IconColor] : Icons.default;
    };

    // Card stacking calculations - expands on hover
    const isBottom = placement.startsWith('bottom');

    // When hovered, expand the cards; when not hovered, stack them tightly
    const stackOffset = 10; // stacked tightly; hovered, spread (measured heights) decides
    const scaleReduction = isHovered ? 0 : 0.05; // No scale reduction when hovered
    const opacityReduction = isHovered ? 0 : 0.2; // Full opacity when hovered

    // Calculate transforms for stacking effect
    const yOffset = (isBottom ? -1 : 1) * (isHovered ? spread : index * stackOffset);
    const scale = 1 - (index * scaleReduction);
    const opacity = index === 0 ? 1 : Math.max(0.6, 1 - (index * opacityReduction));
    const zIndex = 100 - index;

    return (
        <motion.div
            ref={itemRef}
            layout
            // repakxtra: transitions.dev Banner stacking. A new banner rises in from a blur and pushes the others back
            // (three deep, each smaller and dimmer); a dismissed one blurs out where it is
            initial={{
                opacity: 0,
                y: isBottom ? 24 : -24,
                scale: 0.96,
                filter: 'blur(4px)'
            }}
            animate={{
                opacity: opacity,
                y: yOffset,
                scale: scale,
                filter: index === 0 || isHovered ? 'blur(0px)' : `blur(${index * 0.5}px)`
            }}
            exit={{
                opacity: 0,
                scale: 0.96,
                filter: 'blur(4px)'
            }}
            transition={{
                duration: 0.4,
                ease: [0.22, 1, 0.36, 1]
            }}
            className={`toast-item ${color} ${variant}${isLoading || typeof progressValue === 'number' ? ' is-working' : ''}`} /* repakxtra: shimmer while it works */
            style={{
                position: 'absolute',
                bottom: isBottom ? 0 : 'auto',
                top: !isBottom ? 0 : 'auto',
                left: 0,
                right: 0,
                zIndex: zIndex,
                transformOrigin: isBottom ? 'bottom center' : 'top center',
            }}
            onMouseEnter={() => setIsPaused(true)}
            onMouseLeave={() => setIsPaused(false)}
            onFocus={() => setHasFocus(true)} // repakxtra
            onBlur={(e: React.FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHasFocus(false); }}
            data-toast-id={id}
        >
            {!hideIcon && (
                <div className="toast-icon">
                    {getIcon()}
                </div>
            )}

            <div className="toast-content">
                {title && <div className="toast-title">{title}</div>}
                {description && <div className="toast-description">{description}</div>}
            </div>

            {action && (
                <div className="toast-end-content">
                    {action.label && action.onClick ? (
                        <button
                            className="toast-action-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                action.onClick(e);
                            }}
                        >
                            {action.label}
                        </button>
                    ) : (
                        action
                    )}
                </div>
            )}

            {endContent && (
                <div className="toast-end-content">
                    {endContent}
                </div>
            )}

            <button
                className="toast-close"
                onClick={() => onDismiss(id)}
                aria-label="Close"
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>

            {/* Progress bar - either auto-dismiss or manual progress */}
            {((shouldAutoDismiss && duration > 0) || typeof progressValue === 'number') && (
                <div className="toast-progress-track">
                    <div
                        className="toast-progress-bar"
                        style={{ transform: `scaleX(${(typeof progressValue === 'number' ? progressValue : progress) / 100})` }}
                    />
                </div>
            )}
        </motion.div>
    );
});

export default AlertProvider;
