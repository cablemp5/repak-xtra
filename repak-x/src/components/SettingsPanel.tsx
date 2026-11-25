import React, { useState, useEffect, useRef } from 'react';
import { AnimatedThemeToggler } from './ui/AnimatedThemeToggler'
import Checkbox from './ui/Checkbox'
import { UiScaleSection, MotionSection, InstallingSection, HeaderButtonsSection, SearchSection, ModPrefs, WarningPrefs, NewStripPref, BuiltinsPref, AutoUpdatePref, resetUiPrefs } from '../custom/uiPrefs' // repakxtra
import RecentlyDeleted from '../custom/RecentlyDeleted' // repakxtra: Settings > Recently deleted
import CrashReports from '../custom/CrashReports' // repakxtra: Settings > Crash reports
import { ArchiveRestore, Bug, CircleHelp, ExternalLink, FileText, FolderOpen, FolderSearch, Gauge, GraduationCap, HardDrive, Keyboard, Library, LifeBuoy, List, Palette, RefreshCw, Rocket, RotateCcw, Settings, Settings2, SlidersHorizontal, Tags, TriangleAlert, Users, WandSparkles } from 'lucide-react' // repakxtra: one icon set, brand logos below stay
import { useDialogFocus } from '../custom/dialogFocus' // repakxtra
import { SettingsSearch, matches, useSettingsFilter } from '../custom/settingsSearch' // repakxtra: Settings search
import TailInput from './ui/TailInput'
import ConfirmRow from '../custom/ConfirmRow' // repakxtra: Auto-detect asks before it replaces a saved folder
import { FaDiscord, FaSteam } from "react-icons/fa"
import { SiEpicgames } from "react-icons/si"
import { LoadingBayIcon } from "../custom/icons/loadingBay" // repakxtra
import { REPAKXTRA_VERSION } from '../custom/version' // repakxtra
import CableDiscord, { RepakXDiscord } from '../custom/CableDiscord' // repakxtra: both servers as quiet cards
import CopySetupReport from '../custom/CopySetupReport' // repakxtra: setup report for help channels
import AppFiles from '../custom/AppFiles' // repakxtra: Check app files and Repair
import StorageCleanup from '../custom/StorageCleanup' // repakxtra: Settings > Storage
import Support from '../custom/Support'
import IsItSafe from '../custom/TrustSection' // repakxtra: Settings > Is it safe?
import { invoke } from '@tauri-apps/api/core'
import { ShortcutSetting } from '../custom/shortcut' // repakxtra
import { PreviewRimSetting } from '../custom/PreviewRimSetting' // repakxtra
import { APP_NAME } from '../custom/edition' // repakxtra
import './SettingsPanel.css'
import { useAlert } from './AlertHandler'
import { motion } from 'framer-motion'

const ACCENT_COLORS = {
  repakRed: '#be1c1c',
  blue: '#4a9eff',
  purple: '#9c27b0',
  green: '#4CAF50',
  orange: '#ff9800',
  pink: '#FF96BC'
};

const CATEGORIES = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'interface', label: 'Interface', icon: Palette },
  { id: 'library', label: 'Library', icon: List }, // repakxtra: Interface's mod and Library settings, its own page
  { id: 'storage', label: 'Storage', icon: HardDrive }, // repakxtra: its own page, by the other housekeeping pages
  { id: 'trash', label: 'Recently deleted', icon: ArchiveRestore }, // repakxtra
  { id: 'crashes', label: 'Crash reports', icon: Bug }, // repakxtra
  { id: 'help', label: 'Help & Community', icon: CircleHelp }
] as const;

type CategoryId = typeof CATEGORIES[number]['id'];

type SettingsPayload = {
  hideSuffix: boolean;
  autoOpenDetails: boolean;
  showHeroIcons: boolean;
  showHeroBg: boolean;
  showModType: boolean;
  showExperimental: boolean;
  autoCheckUpdates: boolean;
  parallelProcessing: boolean;
  enableDrp: boolean;
  holdToDelete: boolean;
  showSubfolderMods: boolean;
  bypassGameRunningLock: boolean;
  allowModOverwrite: boolean;
  launcherType: 'steam' | 'epic' | 'loadingbay';
  enableAnimations: boolean;
};

type SettingsPanelProps = {
  settings: Partial<SettingsPayload>;
  onSave: (settings: Partial<SettingsPayload>) => void; // repakxtra: one changed setting at a time
  onClose: () => void;
  theme: string;
  setTheme: (theme: string) => void;
  accentColor: string;
  setAccentColor: (accent: string) => void;
  gamePath?: string;
  foundGamePath?: string | null; // repakxtra: what Auto-detect found while the saved folder still exists, asked before it replaces it
  onUseFoundGamePath?: () => void;
  onKeepGamePath?: () => void;
  onAutoDetectGamePath: () => void;
  onBrowseGamePath: () => void;
  onSetGamePath?: (path: string) => void | Promise<void>;
  isGamePathLoading: boolean;
  setParallelProcessing: (enabled: boolean) => void;
  onCheckForUpdates: () => void;
  onViewChangelog: () => void;
  isCheckingUpdates: boolean;
  onReplayTour: () => void;
  onOpenShortcuts: () => void;
};


export default function SettingsPanel({ settings, onSave, onClose, theme, setTheme, accentColor, setAccentColor, gamePath, foundGamePath, onUseFoundGamePath, onKeepGamePath, onAutoDetectGamePath, onBrowseGamePath, onSetGamePath, isGamePathLoading, setParallelProcessing, onCheckForUpdates, onViewChangelog, isCheckingUpdates, onReplayTour, onOpenShortcuts }: SettingsPanelProps) {
  const alert = useAlert();
  const [activeCategory, setActiveCategory] = useState<CategoryId>('general');
  const focus = useDialogFocus(); // repakxtra
  const [query, setQuery] = useState(''); // repakxtra: Settings search, every page at once while it has text
  const searching = Boolean(query.trim());
  const contentRef = useRef<HTMLDivElement>(null);
  const [matchPages, setMatchPages] = useState<string[]>([]); // repakxtra: the pages a search found something on
  useSettingsFilter(contentRef, query, setMatchPages);
  // sidebar label matches take priority over body text (including unmounted pages like Recently deleted and Crash reports)
  const exactLabel = searching ? CATEGORIES.find(c => c.label.toLowerCase() === query.trim().toLowerCase())?.id : undefined;
  const labelMatches = searching ? CATEGORIES.filter(c => matches(c.label, query)).map(c => c.id) : [];
  const matchedPages = searching ? [...new Set([...(exactLabel ? [exactLabel] : []), ...labelMatches, ...matchPages])] : [];
  const excludedMatches = searching ? CATEGORIES.filter(c => (c.id === 'trash' || c.id === 'crashes') && labelMatches.includes(c.id)) : [];
  const shows = (id: CategoryId) => searching ? id !== 'trash' && id !== 'crashes' : activeCategory === id;
  const mark = (id: CategoryId) => searching && <span data-page={id} hidden />; // where a page starts, for the search
  const openPage = (id: CategoryId) => { setActiveCategory(id); setQuery('') };
  const [hideSuffix, setHideSuffix] = useState(settings.hideSuffix || false);
  const [autoOpenDetails, setAutoOpenDetails] = useState(settings.autoOpenDetails || false);
  const [showHeroIcons, setShowHeroIcons] = useState(settings.showHeroIcons || false);
  const [showHeroBg, setShowHeroBg] = useState(settings.showHeroBg || false);
  const [showModType, setShowModType] = useState(settings.showModType || false);
  const [showExperimental, setShowExperimental] = useState(settings.showExperimental || false);
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(settings.autoCheckUpdates || false);
  const [parallelProcessing, setLocalParallelProcessing] = useState(settings.parallelProcessing || false);
  const [holdToDelete, setHoldToDelete] = useState(settings.holdToDelete !== false);
  const [showSubfolderMods, setShowSubfolderMods] = useState(settings.showSubfolderMods !== false);
  const [bypassGameRunningLock, setBypassGameRunningLock] = useState(settings.bypassGameRunningLock || false);
  const [allowModOverwrite, setAllowModOverwrite] = useState(settings.allowModOverwrite || false);
  const [enableDrp, setEnableDrp] = useState(settings.enableDrp !== false);
  const [launcherType, setLauncherType] = useState<'steam' | 'epic' | 'loadingbay'>(settings.launcherType || 'steam');
  const [enableAnimations, setEnableAnimations] = useState(settings.enableAnimations !== false);
  const [showRatMode, setShowRatMode] = useState(false);

  // Easter egg: briefly show "Rat Mode" when switching to light theme
  const handleThemeToggle = (newTheme: string) => {
    if (newTheme === 'light') {
      setShowRatMode(true);
      setTimeout(() => setShowRatMode(false), 300);
    }
    setTheme(newTheme);
  };

  // repakxtra: every change applies and saves at once, like the rest of the app, so there is no Cancel or Save
  const live = <K extends keyof SettingsPayload>(key: K, set: (v: SettingsPayload[K]) => void) => (v: SettingsPayload[K]) => {
    set(v)
    onSave({ [key]: v } as Partial<SettingsPayload>)
  }

  // repakxtra: one Reset for the Interface and Library pages, at the end of Interface (it resets both)
  const resetSection = <ResetInterface onReset={() => {
    resetUiPrefs()
    onSave({ hideSuffix: true, autoOpenDetails: false, showHeroIcons: true, showHeroBg: true, showModType: true,
      showSubfolderMods: true, enableAnimations: true, holdToDelete: false, bypassGameRunningLock: false, allowModOverwrite: false })
    setHideSuffix(true); setAutoOpenDetails(false); setShowHeroIcons(true); setShowHeroBg(true); setShowModType(true)
    setShowSubfolderMods(true); setEnableAnimations(true); setHoldToDelete(false); setBypassGameRunningLock(false); setAllowModOverwrite(false)
    void invoke('preview_rim_set', { on: false })
      .then(() => window.dispatchEvent(new CustomEvent('repakxtra-preview-rim-changed', { detail: false })))
      .catch(e => alert.warning('Could not reset Rim lighting', String(e)))
  }} />

  // Sync local state with props when opening/changing
  useEffect(() => {
    if (settings.enableDrp !== undefined) {
      setEnableDrp(settings.enableDrp);
    }
  }, [settings.enableDrp]);

  useEffect(() => {
    setHoldToDelete(settings.holdToDelete !== false);
  }, [settings.holdToDelete]);

  useEffect(() => {
    setShowSubfolderMods(settings.showSubfolderMods !== false);
  }, [settings.showSubfolderMods]);

  useEffect(() => {
    setBypassGameRunningLock(settings.bypassGameRunningLock || false);
  }, [settings.bypassGameRunningLock]);

  useEffect(() => {
    setAllowModOverwrite(settings.allowModOverwrite || false);
  }, [settings.allowModOverwrite]);

  useEffect(() => {
    if (settings.launcherType) {
      setLauncherType(settings.launcherType);
    }
  }, [settings.launcherType]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div
        className="modal-content settings-modal settings-modal-split"
        role="dialog" aria-modal="true" aria-label="Settings"
        ref={focus.ref} onKeyDown={focus.onKeyDown} tabIndex={-1} // repakxtra: focus inside, Tab stays inside
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
      >
        <div className="modal-header">
          <h2>
            <Settings size={20} aria-hidden="true" /> Settings
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="settings-layout">
          <nav className="settings-sidebar" aria-label="Settings categories">
            <SettingsSearch value={query} onChange={setQuery} onEnter={() => { if (matchedPages[0]) openPage(matchedPages[0] as CategoryId) }} />{/* repakxtra */}
            {CATEGORIES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`settings-nav-item ${activeCategory === id && !searching ? 'active' : ''}${searching && !matchedPages.includes(id) ? ' no-match' : ''}`}
                onClick={() => openPage(id)}
                aria-current={activeCategory === id && !searching ? 'page' : undefined}
              >
                <Icon size={16} className="settings-nav-icon" />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="modal-body settings-content" key={searching ? 'search' : activeCategory} ref={contentRef}>
            {searching && excludedMatches.map(({ id, label, icon: Icon }) => (
              <div key={id} className="setting-section">
                <h3 className="setting-icon-label"><Icon size={18} aria-hidden="true" />{label}</h3>
                <div className="setting-group">
                  <div><button type="button" className="action-btn" onClick={() => openPage(id)}>Open {label}</button></div>
                </div>
              </div>
            ))}
            {searching && <p className="settings-search-empty" hidden>No settings match “{query.trim()}”.</p>}
            {shows('general') && (
              <>
                {mark('general')}
                <div className="setting-section">
                  <h3 className="setting-icon-label"><FolderOpen size={18} aria-hidden="true" />Mods folder</h3>
                  <div className="setting-group">
                    <p className="setting-hint">Your game's mods folder path.</p>
                    <div className="combined-input-group">
                      <TailInput
                        value={gamePath || ''}
                        placeholder="No game path set"
                        className="integrated-input"
                        onCommit={onSetGamePath}
                      />
                      <div className="input-actions">
                        <button
                          onClick={onAutoDetectGamePath}
                          disabled={isGamePathLoading}
                          className="action-btn"
                          title="Find the game's mods folder"
                        >
                          <WandSparkles size={16} aria-hidden="true" />
                          {isGamePathLoading ? 'Detecting…' : 'Auto-detect'}
                        </button>
                        <button
                          onClick={onBrowseGamePath}
                          className="action-btn icon-only"
                          title="Browse for the folder" aria-label="Browse for the folder"
                        >
                          <FolderSearch size={16} />
                        </button>
                        <button type="button" className="action-btn icon-only" disabled={!gamePath}
                          title="Open selected mods folder" aria-label="Open selected mods folder"
                          onClick={() => void invoke('open_in_explorer', { path: gamePath }).catch(e => alert.warning('Could not open mods folder', String(e)))}>
                          <ExternalLink size={16} />
                        </button>
                      </div>
                    </div>
                    {foundGamePath && <ConfirmRow danger={false} yes="Use it" busy={isGamePathLoading} onYes={() => onUseFoundGamePath?.()} onNo={() => onKeepGamePath?.()}
                      text={<>Found another install at <code title={foundGamePath}>{'…\\' + foundGamePath.replace(/[\\/]MarvelGame[\\/].*$/i, '').split(/[\\/]/).filter(Boolean).slice(-2).join('\\')}</code>. Use its mods folder instead of this one?</>} />}{/* repakxtra */}
                  </div>
                </div>

                <div className="setting-section">
                  <h3 className="setting-icon-label"><Rocket size={18} aria-hidden="true" />Launcher</h3>
                  <div className="setting-group">
                    <p className="setting-hint">Which launcher Launch uses.</p>

                    <div className="segmented-control" style={{ maxWidth: '520px' }}>
                      <button
                        className={`segment-btn ${launcherType === 'steam' ? 'active' : ''}`}
                        onClick={() => live('launcherType', setLauncherType)('steam')}
                        title="Launch via Steam protocol"
                      >
                        <FaSteam size={18} /> Steam
                      </button>
                      <button
                        className={`segment-btn ${launcherType === 'epic' ? 'active' : ''}`}
                        onClick={() => live('launcherType', setLauncherType)('epic')}
                        title="Launch via Epic Games executable"
                      >
                        <SiEpicgames size={16} /> Epic Games
                      </button>
                      <button
                        className={`segment-btn ${launcherType === 'loadingbay' ? 'active' : ''}`}
                        onClick={() => live('launcherType', setLauncherType)('loadingbay')}
                        title="Launch the Loading Bay install with the game's own launcher"
                      >
                        <LoadingBayIcon size={16} /> Loading Bay
                      </button>
                    </div>
                  </div>
                </div>

                <div className="setting-section">
                  <h3 className="setting-icon-label"><Gauge size={18} aria-hidden="true" />Performance</h3>
                  <div className="setting-group">
                    <div className="setting-item">
                      <Checkbox
                        checked={parallelProcessing}
                        onChange={(checked: boolean) => live('parallelProcessing', setLocalParallelProcessing)(checked)}
                      >
                        <span>Faster processing</span>
                      </Checkbox>
                      <p className="setting-subtext">
                        Installs, conflict checks, and previews use 75% of your CPU threads instead of 50%. The preview helpers also
                        stay open for 5 minutes after a preview or 3D view instead of 1, so the next one starts in seconds. They hold
                        about 3 GB of memory until then, and close when the game starts. Leave it off if the PC slows down.{/* repakxtra */}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="setting-section">{/* repakxtra: Integrations, one setting, folded in here */}
                  <h3 className="setting-icon-label"><FaDiscord size={18} aria-hidden="true" />Discord</h3>
                  <div className="setting-group">
                    <div className="setting-item">
                      <Checkbox
                        checked={enableDrp}
                        onChange={(checked: boolean) => live('enableDrp', setEnableDrp)(checked)}
                      >
                        <span>Show what you are modding on Discord</span>
                      </Checkbox>
                      <p className="setting-subtext">Discord's Rich Presence: your profile says {APP_NAME} is open and how many mods you manage.</p>
                    </div>
                  </div>
                </div>


                <ShortcutSetting />{/* repakxtra: desktop shortcut */}

                <div className="setting-section">
                  <h3 className="setting-icon-label"><RefreshCw size={18} aria-hidden="true" />Updates</h3>
                  <div className="setting-group">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                      <button
                        onClick={onCheckForUpdates}
                        disabled={isCheckingUpdates}
                        className="action-btn"
                        title="Check for updates now"
                        style={{ minWidth: '140px' }}
                      >
                        <RefreshCw size={16} className={isCheckingUpdates ? 'spin-animation' : ''} aria-hidden="true" />
                        {isCheckingUpdates ? 'Checking…' : 'Check now'}
                      </button>
                      <button
                        onClick={onViewChangelog}
                        className="action-btn"
                        title="View changelog"
                        style={{ minWidth: '160px' }}
                      >
                        <FileText size={16} aria-hidden="true" />
                        View changelog
                      </button>
                      <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>Current version v{REPAKXTRA_VERSION}</span>{/* repakxtra: repakxtra's version, which the updater checks */}
                    </div>

                    <Checkbox
                      checked={autoCheckUpdates}
                      onChange={(checked: boolean) => live('autoCheckUpdates', setAutoCheckUpdates)(checked)}
                    >
                      <span>Check for updates when {APP_NAME} starts</span>
                    </Checkbox>
                    <AutoUpdatePref />{/* repakxtra */}
                    <AppFiles alert={alert} />{/* repakxtra */}
                  </div>
                </div>
              </>
            )}

            {shows('interface') && (
              <>
                {mark('interface')}
                <UiScaleSection />
                <MotionSection extra={
                  <div className="setting-item">
                    <Checkbox
                      checked={enableAnimations}
                      onChange={(checked: boolean) => live('enableAnimations', setEnableAnimations)(checked)}
                    >
                      <span>Moving hero art and drop zones</span>
                    </Checkbox>
                    <p className="setting-subtext">The hero art behind mods drifts slowly, and the drop zones pulse while you drag files in.</p>
                  </div>
                } />
                <HeaderButtonsSection />
                <SearchSection />{/* repakxtra */}
                {resetSection}
              </>
            )}

            {/* repakxtra: Library, split from Interface so neither page holds 26 switches */}
            {shows('library') && (
              <>
                {mark('library')}
                <InstallingSection />
                <div className="setting-section">{/* repakxtra: every badge and tag on a mod, in one place */}
                  <h3 className="setting-icon-label"><Tags size={18} aria-hidden="true" />On each mod</h3>
                  <div className="setting-group">
                    <div className="setting-item">
                      <Checkbox checked={showHeroIcons} onChange={(checked: boolean) => live('showHeroIcons', setShowHeroIcons)(checked)}>
                        <span>Hero icon</span>
                      </Checkbox>
                    </div>
                    <div className="setting-item">
                      <Checkbox checked={showHeroBg} onChange={(checked: boolean) => live('showHeroBg', setShowHeroBg)(checked)}>
                        <span>Hero art behind the mod</span>
                      </Checkbox>
                    </div>
                    <div className="setting-item">
                      <Checkbox checked={showModType} onChange={(checked: boolean) => live('showModType', setShowModType)(checked)}>
                        <span>Mod type tag (Mesh, Texture, VFX…)</span>
                      </Checkbox>
                    </div>
                    <ModPrefs />
                  </div>
                </div>
                <WarningPrefs />{/* repakxtra */}

                <div className="setting-section">
                  <h3 className="setting-icon-label"><Library size={18} aria-hidden="true" />Library</h3>
                  <div className="setting-group">
                    <div className="setting-item">
                      <Checkbox checked={hideSuffix} onChange={(checked: boolean) => live('hideSuffix', setHideSuffix)(checked)}>
                        <span>Hide the file suffix in mod names (_9999999_P)</span>
                      </Checkbox>
                    </div>
                    <div className="setting-item">
                      <Checkbox checked={autoOpenDetails} onChange={(checked: boolean) => live('autoOpenDetails', setAutoOpenDetails)(checked)}>
                        <span>Open the details panel when you click a mod</span>
                      </Checkbox>
                    </div>
                    <div className="setting-item">
                      <Checkbox checked={showSubfolderMods} onChange={(checked: boolean) => live('showSubfolderMods', setShowSubfolderMods)(checked)}>
                        <span>Show mods from subfolders</span>
                      </Checkbox>
                      <p className="setting-subtext">Picking a folder also shows the mods in its subfolders.</p>
                    </div>
                    <NewStripPref />{/* repakxtra */}
                    <BuiltinsPref />{/* repakxtra */}
                  </div>
                </div>
                <PreviewRimSetting />{/* repakxtra: rim light on previews, with the other look-of-a-mod settings */}

                <div className="setting-section">
                  <h3 className="setting-icon-label"><SlidersHorizontal size={18} aria-hidden="true" />Advanced</h3>
                  <div className="setting-group">
                    <div className="setting-item">
                      <Checkbox
                        checked={holdToDelete}
                        onChange={(checked: boolean) => live('holdToDelete', setHoldToDelete)(checked)}
                      >
                        <span>Hold to delete (2 s)</span>
                      </Checkbox>
                      <p className={`setting-subtext ${!holdToDelete ? 'is-danger' : ''}`}>
                        {!holdToDelete
                          ? 'Deletes happen on click. Deleted mods stay in Recently deleted for 7 days, and an Undo button appears after each delete.'
                          : 'Hold the delete button for 2 seconds to confirm deletion.'}
                      </p>
                    </div>
                    <div className="setting-item">
                      <Checkbox
                        checked={allowModOverwrite}
                        onChange={(checked: boolean) => live('allowModOverwrite', setAllowModOverwrite)(checked)}
                      >
                        <span>Allow overwriting mods with the same name</span>
                      </Checkbox>
                      <p className="setting-subtext">
                        {allowModOverwrite
                          ? 'Renaming, moving, or switching a mod onto a name that is taken replaces the mod there.'
                          : 'Off: renaming, moving, or switching a mod onto a name that is taken is blocked.'}
                      </p>
                      {allowModOverwrite && <p className="setting-warn"><TriangleAlert size={14} aria-hidden="true" />The replaced mod is deleted for good, with no confirmation.</p>}
                    </div>
                    <div className="setting-item">
                      <Checkbox
                        checked={bypassGameRunningLock}
                        onChange={(checked: boolean) => live('bypassGameRunningLock', setBypassGameRunningLock)(checked)}
                      >
                        <span>Allow mod changes while the game runs</span>
                      </Checkbox>
                      <p className="setting-subtext">
                        {bypassGameRunningLock
                          ? 'Renaming, moving, switching, deleting, and priority changes stay on while the game runs.'
                          : 'Off: mod changes wait until the game is closed.'}
                      </p>
                      {/* repakxtra: the risk as a warning line under the setting, the same look as other risky settings */}
                      {bypassGameRunningLock && <p className="setting-warn"><TriangleAlert size={14} aria-hidden="true" />A change can crash the game or not load until a restart.</p>}
                    </div>
                  </div>
                </div>
              </>
            )}

            {shows('storage') && <>{mark('storage')}<StorageCleanup alert={alert} /></>}{/* repakxtra */}
            {shows('trash') && <RecentlyDeleted />}{/* repakxtra */}
            {shows('crashes') && <CrashReports />}{/* repakxtra */}

            {shows('help') && (
              <>
                {mark('help')}
                <div className="setting-section">
                  <h3 className="setting-icon-label"><LifeBuoy size={18} aria-hidden="true" />Help</h3>
                  <div className="setting-group">{/* repakxtra: a label, a gray note and a button per row, like the other sections */}
                    <div className="xs-row">
                      <div className="xs-text">
                        <span className="xs-label">App tour</span>
                        <span className="setting-subtext">A short walk through the main screens and features.</span>
                      </div>
                      <button onClick={onReplayTour} className="action-btn" title="Replay the onboarding tour">
                        <GraduationCap size={16} aria-hidden="true" /> Replay tour
                      </button>
                    </div>
                    <div className="xs-row">
                      <div className="xs-text">
                        <span className="xs-label">Keyboard shortcuts</span>
                        <span className="setting-subtext">Every shortcut in one list. F1 opens it from anywhere.</span>
                      </div>
                      <button onClick={onOpenShortcuts} className="action-btn" title="View keyboard shortcuts">
                        <Keyboard size={16} aria-hidden="true" /> Shortcuts
                      </button>
                    </div>
                    <div className="xs-row">{/* repakxtra: setup report */}
                      <div className="xs-text">
                        <span className="xs-label">Setup report</span>
                        <span className="setting-subtext">Your setup and the mods that are on, as text to paste in a help channel. No folder paths or user name.</span>
                      </div>
                      <CopySetupReport alert={alert} />
                    </div>
                  </div>
                </div>

                <div className="setting-section">
                  <h3 className="setting-icon-label"><Users size={18} aria-hidden="true" />Community</h3>
                  <div className="setting-group">
                    <p className="setting-subtext xs-note">{/* repakxtra: one gray note like the other sections */}
                      For help, bug reports, or ideas, join a Discord server: cable's for {APP_NAME}, or Repak X's for the app it is built on.
                    </p>
                    <RepakXDiscord />
                    <CableDiscord />{/* repakxtra: cable's server */}
                    <Support onError={error => alert.warning('Could not open link', error)} />
                  </div>
                </div>

                {/* repakxtra: Is repakxtra safe? last, after Help and Community (Serial Position: the trust facts close the page, read once) */}
                <IsItSafe alert={alert} />
              </>
            )}
          </div>
        </div>

        <div className="modal-footer settings-live-footer">{/* repakxtra: settings save as they change */}
          <span className="settings-live-note">Changes save as you make them.</span>
          <button type="button" onClick={onClose} className="btn-primary">Done</button>{/* repakxtra: the same blue Done as the other dialogs */}
        </div>
      </motion.div>
    </div>
  )
}

/** repakxtra: Reset, asked in the app's one in-place confirm (nothing else in Settings is undoable in one step). */
function ResetInterface({ onReset }: { onReset: () => void }) {
  const [sure, setSure] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useEffect(() => {
    if (!sure && restoreFocus.current) {
      restoreFocus.current = false
      btnRef.current?.focus()
    }
  }, [sure])
  const close = () => { restoreFocus.current = true; setSure(false) }
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><RotateCcw size={18} aria-hidden="true" />Reset</h3>
      <div className="setting-group">
        <p className="setting-hint">Puts every setting on the Interface and Library pages back to how {APP_NAME} starts. Your mods folder, launcher, loadouts, and mods stay as they are.</p>
        {sure
          ? <ConfirmRow text="Reset every Interface and Library setting?" yes="Reset" onYes={() => { onReset(); close() }} onNo={close} />
          : <div><button ref={btnRef} type="button" className="action-btn settings-reset-btn" onClick={() => setSure(true)}><RotateCcw size={15} aria-hidden="true" /> Reset Interface and Library to defaults</button></div>}
      </div>
    </div>
  )
}
