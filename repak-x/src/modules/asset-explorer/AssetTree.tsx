// The virtualized row list at the heart of the Asset Explorer.
//
// The per-mod FileTree renders every node and expands them all by default,
// which is fine for one mod and impossible across all of them: a typical
// install is six figures of assets. Here the tree is flattened into an ordered
// row array and only the slice inside the viewport is mounted, with spacers
// standing in for the rest. Rows are a fixed height so the mapping between
// scroll offset and row index stays a division.
//
// repakxtra: keyboard use (U09). The list is one Tab stop (a tree, or a listbox
// in flat mode) that points aria-activedescendant at the active row. Arrows,
// Home/End and PageUp/PageDown move it (custom/treeKeys.ts), Enter opens a
// folder or selects a file, Shift + F10 or the menu key opens its actions. A row
// is scrolled into the mounted slice before it becomes the active descendant,
// so the attribute never names a row that is not in the DOM.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
    VscFolder,
    VscFolderOpened,
    VscChevronRight,
    VscChevronDown,
} from 'react-icons/vsc'
import { IoMdWarning } from 'react-icons/io'
import type { AssetRow, FileNode, FlatRow, FolderNode } from './assetIndex'
import { flattenTree } from './assetIndex'
import type { ExplorerMod } from './types'
import { KIND_BADGES, KIND_LABELS } from './types'
import { chainAt, findActive, treeKey, type KeyRows } from '../../custom/treeKeys' // repakxtra
import { useMenuKeys } from '../../custom/menuKeys' // repakxtra
import '../../components/ContextMenu.css' // repakxtra: the row actions menu uses the Library menu's look

export const ROW_HEIGHT = 26
const OVERSCAN = 12
/** .ae-tree-scroll's vertical padding: row i starts this far below the scroll top. */
const PAD = 4

/** DOM id for a row: ids are paths, and an IDREF cannot hold whitespace. */
const rowDomId = (key: string) => `ae-row-${key.replace(/\s/g, '_')}`

type AssetTreeProps = {
    root: FolderNode
    mods: ExplorerMod[]
    expanded: Set<string>
    onToggleFolder: (id: string) => void
    /**
     * Flat mode: the already-filtered rows, rendered without any folder
     * hierarchy. Passing the raw rows rather than prebuilt nodes is deliberate
     * — see the `visible` memo.
     */
    flatRows?: AssetRow[]
    conflictPaths: Map<string, number>
    onRevealMod: (modPath: string) => void
    selectedPath: string | null
    onSelectFile: (node: FileNode) => void
}

/** Copy variants, matching the per-mod FileTree so the muscle memory carries. */
const copyVariant = (fullPath: string, nameOnly: boolean, stripExtension: boolean) => {
    let value = nameOnly ? (fullPath.split('/').pop() || fullPath) : fullPath
    if (stripExtension) value = value.replace(/\.[^./]+$/, '')
    return value
}

type MenuItem = { label: string; run: () => void }

export default function AssetTree({
    root,
    mods,
    expanded,
    onToggleFolder,
    flatRows,
    conflictPaths,
    onRevealMod,
    selectedPath,
    onSelectFile,
}: AssetTreeProps) {
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const [scrollTop, setScrollTop] = useState(0)
    const [viewportHeight, setViewportHeight] = useState(600)
    const [copied, setCopied] = useState<{ id: string; label: string } | null>(null)
    // repakxtra: the active row by key and the folders above it, so it survives filtering, closing a folder and refresh
    const [active, setActive] = useState<{ chain: string[]; index: number } | null>(null)
    const [menu, setMenu] = useState<{ x: number; y: number; row: FlatRow } | null>(null)
    const pointerDown = useRef(false)

    const isFlat = !!flatRows

    const treeRows: FlatRow[] | null = useMemo(
        () => (flatRows ? null : flattenTree(root, expanded)),
        [root, expanded, flatRows]
    )

    const rowCount = flatRows ? flatRows.length : treeRows!.length

    // Flat mode wraps only the rows it is asked for. Building a node per asset
    // up front would allocate six figures of objects on every filter change to
    // render the fifty that are visible.
    const rowAt = useCallback((i: number): FlatRow => {
        if (!flatRows) return treeRows![i]
        const row = flatRows[i]
        const id = `${row.path}#${row.modIndex}`
        return { key: id, depth: 0, pos: i + 1, size: flatRows.length, node: { type: 'file', id, row, conflict: conflictPaths.has(row.path) } }
    }, [flatRows, treeRows, conflictPaths])

    const keyRows: KeyRows = useMemo(() => ({
        count: rowCount,
        depth: i => (flatRows ? 0 : treeRows![i].depth),
        key: i => (flatRows ? `${flatRows[i].path}#${flatRows[i].modIndex}` : treeRows![i].key),
        folder: i => !flatRows && treeRows![i].node.type === 'folder',
        open: i => !flatRows && expanded.has(treeRows![i].key),
    }), [flatRows, treeRows, rowCount, expanded])

    const activeIndex = useMemo(
        () => (active ? findActive(keyRows, active) : rowCount > 0 ? 0 : -1),
        [keyRows, active, rowCount]
    )

    // Track the viewport so the visible window is sized to the real container
    // rather than a guess that breaks when the user resizes.
    useEffect(() => {
        const el = scrollRef.current
        if (!el) return
        const measure = () => setViewportHeight(el.clientHeight)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => observer.disconnect()
    }, [rowCount === 0])

    // A filter change can shorten the list below the current offset; without
    // this the view would sit in empty space until the user scrolls.
    useEffect(() => {
        const el = scrollRef.current
        if (el && el.scrollTop > rowCount * ROW_HEIGHT) {
            el.scrollTop = 0
            setScrollTop(0)
        }
    }, [rowCount])

    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        setScrollTop(e.currentTarget.scrollTop)
    }, [])

    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
    const end = Math.min(rowCount, start + visibleCount)

    const visible: FlatRow[] = useMemo(() => {
        const out: FlatRow[] = []
        for (let i = start; i < end; i++) out.push(rowAt(i))
        return out
    }, [rowAt, start, end])

    // Stable identities, so the memoized rows below really do skip re-rendering
    // on scroll. Each row closes over its own node instead of being handed a
    // freshly allocated arrow on every parent render.
    const copy = useCallback((id: string, fullPath: string, nameOnly: boolean, stripExtension: boolean) => {
        const value = copyVariant(fullPath, nameOnly, stripExtension)
        navigator.clipboard.writeText(value).then(() => {
            setCopied({ id, label: nameOnly ? 'Copied name' : 'Copied path' })
            setTimeout(() => setCopied(null), 1400)
        }).catch(err => console.error('[AssetExplorer] copy failed:', err))
    }, [])

    const handleCopy = useCallback((e: React.MouseEvent, id: string, fullPath: string) => {
        e.preventDefault()
        e.stopPropagation()
        copy(id, fullPath, e.ctrlKey || e.metaKey, e.shiftKey)
    }, [copy])

    // Focus goes back to the list unless something else took it (useMenuKeys' own restore misses under StrictMode)
    const closeMenu = useCallback(() => {
        setMenu(null)
        const now = document.activeElement
        if (!now || now === document.body || now.closest('.ae-row-menu')) scrollRef.current?.focus({ preventScroll: true })
    }, [])

    if (rowCount === 0) {
        return (
            <div className="ae-tree-empty">
                No assets match the current filters.
            </div>
        )
    }

    // ---- keyboard (repakxtra) ----------------------------------------------

    const activate = (i: number) => setActive({ chain: chainAt(keyRows, i), index: i })

    /** Scroll row i into view, and into the mounted slice in the same render. */
    const reveal = (i: number) => {
        const el = scrollRef.current
        if (!el) return
        const top = PAD + i * ROW_HEIGHT
        let next = el.scrollTop
        if (top - PAD < next) next = top - PAD
        else if (top + ROW_HEIGHT + PAD > next + el.clientHeight) next = top + ROW_HEIGHT + PAD - el.clientHeight
        if (next === el.scrollTop) return
        el.scrollTop = next
        setScrollTop(el.scrollTop)
    }

    const menuItems = ({ key, node }: FlatRow): MenuItem[] => {
        const path = node.type === 'file' ? node.row.path : node.path
        const mod = node.type === 'file' ? mods[node.row.modIndex] : node.modIndex !== undefined ? mods[node.modIndex] : undefined
        const items: MenuItem[] = [
            { label: 'Copy path', run: () => copy(key, path, false, false) },
            { label: 'Copy name', run: () => copy(key, path, true, false) },
        ]
        if (node.type === 'file') {
            items.push(
                { label: 'Copy path without extension', run: () => copy(key, path, false, true) },
                { label: 'Copy name without extension', run: () => copy(key, path, true, true) },
            )
        }
        if (mod) items.push({ label: 'Select mod in repakxtra', run: () => onRevealMod(mod.path) })
        return items
    }

    const openMenu = (i: number) => {
        const el = scrollRef.current
        if (!el) return
        activate(i)
        reveal(i)
        const box = el.getBoundingClientRect()
        const row = rowAt(i)
        setMenu({ x: box.left + 28 + row.depth * 14, y: box.top + PAD + (i + 1) * ROW_HEIGHT - el.scrollTop, row })
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget || activeIndex < 0 || e.altKey || e.ctrlKey || e.metaKey) return
        const at = activeIndex
        if (e.key === 'Enter') {
            const { node } = rowAt(at)
            if (node.type === 'folder') onToggleFolder(node.id)
            else onSelectFile(node)
            activate(at)
            reveal(at)
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            openMenu(at)
        } else {
            const move = treeKey(keyRows, at, e.key, Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1))
            if (!move) return
            const i = 'to' in move ? move.to : move.toggle
            if ('toggle' in move) onToggleFolder(rowAt(i).key)
            activate(i)
            reveal(i)
        }
        e.preventDefault()
    }

    // A click makes its row the active one. Tabbing in brings the active row back into view.
    const handleMouseDown = (e: React.MouseEvent) => {
        pointerDown.current = true
        const row = (e.target as Element).closest<HTMLElement>('[data-index]')
        if (row) activate(Number(row.dataset.index))
    }
    const handleFocus = (e: React.FocusEvent) => {
        if (e.target === e.currentTarget && !pointerDown.current && activeIndex >= 0) reveal(activeIndex)
        pointerDown.current = false
    }

    const activeMounted = activeIndex >= start && activeIndex < end
    const activeKey = activeIndex >= 0 ? keyRows.key(activeIndex) : null

    return (
        <>
            <div
                className="ae-tree-scroll"
                ref={scrollRef}
                onScroll={handleScroll}
                role={isFlat ? 'listbox' : 'tree'}
                aria-label="Assets"
                tabIndex={0}
                aria-activedescendant={activeMounted && activeKey ? rowDomId(activeKey) : undefined}
                onKeyDown={handleKeyDown}
                onMouseDown={handleMouseDown}
                onFocus={handleFocus}
                onBlur={() => { pointerDown.current = false }}
            >
                {/* The spacer owns the full scroll height; the mounted slice is
                    positioned absolutely inside it so its own height never adds to
                    the scroll range. */}
                <div style={{ height: rowCount * ROW_HEIGHT, position: 'relative' }}>
                    <div
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            transform: `translateY(${start * ROW_HEIGHT}px)`,
                        }}
                    >
                        {/* Striping keys off the absolute row index: the mounted
                            slice starts at a different parity as you scroll, so
                            :nth-child() would make the bands jump. */}
                        {visible.map(({ key, depth, node, pos, size }, i) => (
                            node.type === 'folder' ? (
                                <FolderRow
                                    key={key}
                                    node={node}
                                    depth={depth}
                                    index={start + i}
                                    pos={pos}
                                    size={size}
                                    active={start + i === activeIndex}
                                    alt={(start + i) % 2 === 1}
                                    isOpen={expanded.has(node.id)}
                                    mod={node.modIndex !== undefined ? mods[node.modIndex] : undefined}
                                    copiedLabel={copied?.id === key ? copied.label : null}
                                    onToggle={onToggleFolder}
                                    onCopy={handleCopy}
                                    onReveal={onRevealMod}
                                />
                            ) : (
                                <FileRow
                                    key={key}
                                    node={node}
                                    depth={depth}
                                    index={start + i}
                                    pos={pos}
                                    size={size}
                                    active={start + i === activeIndex}
                                    alt={(start + i) % 2 === 1}
                                    mod={mods[node.row.modIndex]}
                                    showFullPath={isFlat}
                                    selected={selectedPath === node.id}
                                    copiedLabel={copied?.id === key ? copied.label : null}
                                    onSelect={onSelectFile}
                                    onCopy={handleCopy}
                                    onReveal={onRevealMod}
                                />
                            )
                        ))}
                    </div>
                </div>
            </div>
            {/* repakxtra: says what a copy did, for a screen reader (the row's own label is visual) */}
            <span className="ae-sr" role="status">{copied?.label ?? ''}</span>
            {menu && <RowMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={closeMenu} />}
        </>
    )
}

/** repakxtra: a row's actions for the keyboard (Shift + F10 or the menu key), the Library menu's keys and look. */
function RowMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
    const ref = useRef<HTMLDivElement | null>(null)
    const [pos, setPos] = useState({ x, y })
    const onKeyDown = useMenuKeys(ref, onClose, () => undefined)

    // Kept on screen: above the row when there is no room below it
    useLayoutEffect(() => {
        const r = ref.current?.getBoundingClientRect()
        if (!r) return
        setPos({
            x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
            y: y + r.height > window.innerHeight - 8 ? Math.max(8, y - ROW_HEIGHT - r.height) : y,
        })
    }, [x, y])

    useEffect(() => {
        // Esc closes the menu only, and focus goes back to the list (useMenuKeys)
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
        const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
        window.addEventListener('keydown', esc, true)
        window.addEventListener('mousedown', away, true)
        return () => { window.removeEventListener('keydown', esc, true); window.removeEventListener('mousedown', away, true) }
    }, [onClose])

    return (
        <div ref={ref} className="context-menu ae-row-menu" aria-label="Asset actions" style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown}>
            {items.map(item => (
                <div key={item.label} className="context-menu-item" onClick={() => { onClose(); item.run() }}>{item.label}</div>
            ))}
        </div>
    )
}

type FolderRowProps = {
    node: FolderNode
    depth: number
    /** Absolute row index, and the place among its siblings (the list only mounts a slice). */
    index: number
    pos: number
    size: number
    /** The keyboard's active row. */
    active: boolean
    /** Odd absolute row index — the zebra band. */
    alt: boolean
    isOpen: boolean
    mod?: ExplorerMod
    copiedLabel: string | null
    onToggle: (id: string) => void
    onCopy: (e: React.MouseEvent, id: string, fullPath: string) => void
    onReveal: (modPath: string) => void
}

const FolderRow = React.memo(function FolderRow({
    node, depth, index, pos, size, active, alt, isOpen, mod, copiedLabel, onToggle, onCopy, onReveal,
}: FolderRowProps) {
    const isModGroup = node.modIndex !== undefined
    const count = `${node.assetCount.toLocaleString()} asset${node.assetCount === 1 ? '' : 's'}`

    return (
        <div
            id={rowDomId(node.id)}
            data-index={index}
            role="treeitem"
            aria-level={depth + 1}
            aria-posinset={pos}
            aria-setsize={size}
            aria-expanded={isOpen}
            aria-label={`${node.name}, ${count}${node.conflictCount > 0 ? `, ${node.conflictCount} overlapping` : ''}`}
            className={`ae-row ae-row-folder ${alt ? 'is-alt' : ''} ${isModGroup ? 'is-mod-group' : ''} ${active ? 'is-active' : ''}`}
            style={{ paddingLeft: 6 + depth * 14, height: ROW_HEIGHT }}
            onClick={() => onToggle(node.id)}
            onDoubleClick={isModGroup && mod
                ? (e) => { e.stopPropagation(); onReveal(mod.path) }
                : undefined}
            onContextMenu={(e) => onCopy(e, node.id, node.path)}
            title={isModGroup ? `${node.path}\nShift + F10: more actions` : `${node.path}\nRight click to copy path\nShift + F10: more actions`}
        >
            <span className="ae-chevron">
                {isOpen ? <VscChevronDown /> : <VscChevronRight />}
            </span>
            {isModGroup ? (
                <span className={`ae-mod-dot ${mod?.enabled ? 'is-on' : 'is-off'}`} />
            ) : isOpen ? (
                <VscFolderOpened className="ae-icon ae-icon-folder" />
            ) : (
                <VscFolder className="ae-icon ae-icon-folder" />
            )}
            <span className="ae-name">{node.name}</span>

            {isModGroup && mod && (
                <span className="ae-chip ae-chip-quiet">{mod.category}</span>
            )}
            <span className="ae-meta">{node.assetCount.toLocaleString()}</span>
            {!isModGroup && node.modCount > 1 && (
                <span className="ae-meta ae-meta-dim">{node.modCount} mods</span>
            )}
            {node.conflictCount > 0 && (
                <span className="ae-conflict-count" title={`${node.conflictCount} overlapping asset(s) inside`}>
                    <IoMdWarning />
                    {node.conflictCount}
                </span>
            )}
            {copiedLabel && <span className="ae-copied">{copiedLabel}</span>}
        </div>
    )
})

type FileRowProps = {
    node: FileNode
    depth: number
    /** Absolute row index, and the place among its siblings (the list only mounts a slice). */
    index: number
    pos: number
    size: number
    /** The keyboard's active row. */
    active: boolean
    /** Odd absolute row index — the zebra band. */
    alt: boolean
    mod: ExplorerMod
    showFullPath: boolean
    selected: boolean
    copiedLabel: string | null
    onSelect: (node: FileNode) => void
    onCopy: (e: React.MouseEvent, id: string, fullPath: string) => void
    onReveal: (modPath: string) => void
}

const FileRow = React.memo(function FileRow({
    node, depth, index, pos, size, active, alt, mod, showFullPath, selected, copiedLabel, onSelect, onCopy, onReveal,
}: FileRowProps) {
    const { row, conflict } = node
    const label = showFullPath ? row.path.replace(/^Game\//, '') : row.name

    return (
        <div
            id={rowDomId(node.id)}
            data-index={index}
            // Flat mode is a listbox of options, the tree view a tree (no level there)
            role={showFullPath ? 'option' : 'treeitem'}
            aria-level={showFullPath ? undefined : depth + 1}
            aria-posinset={pos}
            aria-setsize={size}
            aria-selected={selected}
            aria-label={`${label}, ${KIND_LABELS[row.kind]}, ${mod.display_name}${conflict ? ', overlapping' : ''}`}
            className={`ae-row ae-row-file ${alt ? 'is-alt' : ''} ${conflict ? 'is-conflict' : ''} ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''}`}
            style={{ paddingLeft: 6 + depth * 14, height: ROW_HEIGHT }}
            onClick={() => onSelect(node)}
            onDoubleClick={(e) => { e.stopPropagation(); onReveal(mod.path) }}
            onContextMenu={(e) => onCopy(e, node.id, row.path)}
            title={`${row.path}\n${mod.display_name}\n\nDouble click to show this mod in Repak X\nRight click to copy full path\nCtrl + right click: name only\nShift + right click: without extension\nShift + F10: more actions`}
        >
            <span className="ae-chevron" />
            <span className={`ae-kind-dot ae-kind-${row.kind}`} title={KIND_LABELS[row.kind]} />
            <span className="ae-name">{label}</span>
            {conflict && (
                <span className="ae-conflict-flag" title="Also shipped by another visible mod">
                    <IoMdWarning />
                </span>
            )}
            <span className={`ae-chip ae-chip-kind ${KIND_BADGES[row.kind]}`}>{KIND_LABELS[row.kind]}</span>
            <span className={`ae-chip ae-chip-mod ${mod.enabled ? '' : 'is-disabled'}`}>
                {mod.display_name}
            </span>
            {copiedLabel && <span className="ae-copied">{copiedLabel}</span>}
        </div>
    )
})
