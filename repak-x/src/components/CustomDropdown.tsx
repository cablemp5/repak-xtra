import React, { useState, useEffect, useRef } from 'react';
import './CustomDropdown.css';

type DropdownOption = string | { value: string; label: string; showDelete?: boolean };

type CustomDropdownProps = {
    options?: DropdownOption[];
    value?: string;
    onChange: (value: string) => void;
    placeholder?: string;
    icon?: React.ReactNode;
    className?: string;
    disabled?: boolean;
    onAddNew?: () => void;
    addNewLabel?: string;
    onDeleteOption?: (value: string) => void;
    alwaysShowDeleteIcon?: boolean;
};

/**
 * A generic custom dropdown component.
 * 
 * @param {Object} props
 * @param {Array<string|{value: string, label: string}>} props.options - List of options to display
 * @param {string} props.value - Currently selected value
 * @param {Function} props.onChange - Callback when an option is selected
 * @param {string} props.placeholder - Text to display when no value is selected
 * @param {string} props.className - Optional additional classes
 * @param {boolean} props.disabled - Whether the dropdown is disabled
 */
const CustomDropdown = ({
    options = [],
    value,
    onChange,
    placeholder = "Select...",
    icon = null,
    className = "",
    disabled = false,
    onAddNew,
    addNewLabel = "+ Add New",
    onDeleteOption,
    alwaysShowDeleteIcon = false
}: CustomDropdownProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement | null>(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && event.target instanceof Node && !dropdownRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };

        // repakxtra: Esc closes an open menu first (before a page or dialog takes it)
        const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setIsOpen(false); } };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            window.addEventListener('keydown', handleEscape, true);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            window.removeEventListener('keydown', handleEscape, true);
        };
    }, [isOpen]);

    const handleToggle = () => {
        if (!disabled) {
            setIsOpen(!isOpen);
        }
    };

    const handleSelect = (option: DropdownOption) => {
        const optionValue = typeof option === 'string' ? option : option.value;
        onChange(optionValue);
        setIsOpen(false);
    };

    // Helper to get display label
    // repakxtra: keyboard use. Arrow keys open the list and move through it, Enter or Space picks, Esc closes
    const menuRef = useRef<HTMLDivElement | null>(null);
    const moveFocus = (dir: 1 | -1) => {
        const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[at < 0 ? Math.max(0, items.findIndex(i => i.getAttribute('aria-selected') === 'true')) : (at + dir + items.length) % items.length]?.focus();
    };
    const onKeys = (e: React.KeyboardEvent) => {
        if (isOpen && (e.key === 'Home' || e.key === 'End')) {
            e.preventDefault();
            const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
            items?.[e.key === 'Home' ? 0 : items.length - 1]?.focus();
            return;
        }
        if (disabled || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
        e.preventDefault();
        if (!isOpen) { setIsOpen(true); requestAnimationFrame(() => moveFocus(1)); } else moveFocus(e.key === 'ArrowDown' ? 1 : -1);
    };

    const getLabel = (val?: string) => {
        if (!val) return placeholder;
        const found = options.find(opt => (typeof opt === 'string' ? opt : opt.value) === val);
        if (!found) return val; // Fallback to value if option not found
        return typeof found === 'string' ? found : found.label;
    };

    return (
        <div className={`custom-dropdown-container ${className}`} ref={dropdownRef} onKeyDown={onKeys}
            onBlur={(e) => { if (isOpen && !dropdownRef.current?.contains(e.relatedTarget as Node | null)) setIsOpen(false); }}>
            <button
                className={`custom-dropdown-trigger ${isOpen ? 'open' : ''} ${value ? 'active' : ''}`}
                onClick={handleToggle}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                title={getLabel(value)}
                disabled={disabled}
                style={disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}}
            >
                {icon && <span className="custom-dropdown-icon">{icon}</span>}
                <span className="custom-dropdown-text">{getLabel(value)}</span>
            </button>

            {isOpen && !disabled && (
                <div className="custom-dropdown-menu" role="listbox" ref={menuRef}>
                    {/* Optional "Clear" or "All" option if placeholder suggests it */}
                    {/* For now, we assume parent handles specific "All" options by passing them in options array if needed, 
                        BUT for consistency with previous Tag behavior, if value is present, we might want a way to clear it?
                        Actually, existing TagFilterDropdown had an "All Tags" option hardcoded. 
                        Let's make sure the parent provides "All Tags" as an option if desired. 
                     */}

                    {options.length === 0 ? (
                        <div className="custom-dropdown-item disabled">
                            No options
                        </div>
                    ) : (
                        options.map((option, index) => {
                            const optValue = typeof option === 'string' ? option : option.value;
                            const optLabel = typeof option === 'string' ? option : option.label;
                            const optShowDelete = typeof option === 'string' ? true : option.showDelete === true;
                            const isSelected = optValue === value;

                            // Optional separator logic could be passed in, but for now simple list
                            return (
                                <div
                                    key={`${optValue}-${index}`}
                                    className={`custom-dropdown-item ${isSelected ? 'selected' : ''}`}
                                    role="option" aria-selected={isSelected} tabIndex={-1}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelect(option); dropdownRef.current?.querySelector<HTMLElement>('.custom-dropdown-trigger')?.focus(); } }}
                                    onClick={() => handleSelect(option)}
                                    title={optLabel}
                                >
                                    <span className="custom-dropdown-item-label">{optLabel}</span>
                                    {onDeleteOption && optValue && optShowDelete && (
                                        <button
                                            className={`custom-dropdown-item-delete ${alwaysShowDeleteIcon ? 'always-visible' : ''}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDeleteOption(optValue);
                                            }}
                                            title={`Remove "${optLabel}"`}
                                        >
                                            ×
                                        </button>
                                    )}
                                </div>
                            );
                        })
                    )}
                    {onAddNew && (
                        <>
                            <div className="custom-dropdown-separator" />
                            <div
                                className="custom-dropdown-item add-new"
                                role="option" aria-selected={false} tabIndex={-1}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAddNew(); setIsOpen(false); } }}
                                onClick={() => { onAddNew(); setIsOpen(false); }}
                            >
                                {addNewLabel}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export default CustomDropdown;
