import React, { useState, useEffect } from 'react';
import { AnimatedThemeToggler } from './ui/AnimatedThemeToggler'
import Checkbox from './ui/Checkbox'
import { UiScaleSection, MotionSection, InstallingSection, HeaderButtonsSection, ModPrefs, WarningPrefs, NewStripPref, BuiltinsPref, resetUiPrefs } from '../custom/uiPrefs' // repakxtra
import RecentlyDeleted from '../custom/RecentlyDeleted' // repakxtra: Settings > Recently deleted
import CrashReports from '../custom/CrashReports' // repakxtra: Settings > Crash reports
import { TriangleAlert } from 'lucide-react' // repakxtra: setting warnings
import { useDialogFocus } from '../custom/dialogFocus' // repakxtra
import TailInput from './ui/TailInput'
import { LuFolderInput, LuFolderOpen, LuLibrary, LuLifeBuoy, LuRefreshCw, LuRocket, LuRotateCcw, LuSlidersHorizontal, LuTags, LuUsers } from "react-icons/lu"
import { RiSparkling2Fill } from "react-icons/ri"
import {
  MdRefresh,
  MdArticle,
  MdTune,
  MdBugReport, // repakxtra: Crash reports
  MdPalette,
  MdHelpOutline,
  MdRestoreFromTrash,
  MdViewList
} from "react-icons/md"
import { FaDiscord, FaSteam } from "react-icons/fa"
import { CgPerformance } from "react-icons/cg"
import { SiEpicgames } from "react-icons/si"
import { RiGraduationCapFill } from "react-icons/ri"
import { BsKeyboardFill } from "react-icons/bs"
import { IoIosSettings } from "react-icons/io"
import { REPAKXTRA_VERSION } from '../custom/version' // repakxtra
import CableDiscord, { RepakXDiscord } from '../custom/CableDiscord' // repakxtra: both servers as quiet cards
import CopySetupReport from '../custom/CopySetupReport' // repakxtra: setup report for help channels
import AppFiles from '../custom/AppFiles' // repakxtra: Check app files and Repair
import Support from '../custom/Support'
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
  { id: 'general', label: 'General', icon: MdTune },
  { id: 'interface', label: 'Interface', icon: MdPalette },
  { id: 'library', label: 'Library', icon: MdViewList }, // repakxtra: Interface's mod and Library settings, its own page
  { id: 'trash', label: 'Recently deleted', icon: MdRestoreFromTrash }, // repakxtra
  { id: 'crashes', label: 'Crash reports', icon: MdBugReport }, // repakxtra
  { id: 'help', label: 'Help & Community', icon: MdHelpOutline }
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
  launcherType: 'steam' | 'epic';
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
  onAutoDetectGamePath: () => void;
  onBrowseGamePath: () => void;
  isGamePathLoading: boolean;
  setParallelProcessing: (enabled: boolean) => void;
  onCheckForUpdates: () => void;
  onViewChangelog: () => void;
  isCheckingUpdates: boolean;
  onReplayTour: () => void;
  onOpenShortcuts: () => void;
};


export default function SettingsPanel({ settings, onSave, onClose, theme, setTheme, accentColor, setAccentColor, gamePath, onAutoDetectGamePath, onBrowseGamePath, isGamePathLoading, setParallelProcessing, onCheckForUpdates, onViewChangelog, isCheckingUpdates, onReplayTour, onOpenShortcuts }: SettingsPanelProps) {
  const alert = useAlert();
  const [activeCategory, setActiveCategory] = useState<CategoryId>('general');
  const focus = useDialogFocus(); // repakxtra
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
  const [launcherType, setLauncherType] = useState<'steam' | 'epic'>(settings.launcherType || 'steam');
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

  // repakxtra: one Reset for the Interface and Library pages, at the end of each (it resets both)
  const resetSection = <ResetInterface onReset={() => {
    resetUiPrefs()
    onSave({ hideSuffix: true, autoOpenDetails: false, showHeroIcons: true, showHeroBg: true, showModType: true,
      showSubfolderMods: true, enableAnimations: true, holdToDelete: false, bypassGameRunningLock: false, allowModOverwrite: false })
    setHideSuffix(true); setAutoOpenDetails(false); setShowHeroIcons(true); setShowHeroBg(true); setShowModType(true)
    setShowSubfolderMods(true); setEnableAnimations(true); setHoldToDelete(false); setBypassGameRunningLock(false); setAllowModOverwrite(false)
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
            <IoIosSettings size={20} /> Settings
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="settings-layout">
          <nav className="settings-sidebar" aria-label="Settings categories">
            {CATEGORIES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className={`settings-nav-item ${activeCategory === id ? 'active' : ''}`}
                onClick={() => setActiveCategory(id)}
                aria-current={activeCategory === id ? 'page' : undefined}
              >
                <Icon size={16} className="settings-nav-icon" />
                <span>{label}</span>
              </button>
            ))}
          </nav>

          <div className="modal-body settings-content" key={activeCategory}>
            {activeCategory === 'general' && (
              <>
                <div className="setting-section">
                  <h3 className="setting-icon-label"><LuFolderOpen size={18} aria-hidden="true" />Mods folder</h3>
                  <div className="setting-group">
                    <p className="setting-hint">Your game's mods folder path.</p>
                    <div className="combined-input-group">
                      <TailInput
                        value={gamePath || ''}
                        placeholder="No game path set"
                        className="integrated-input"
                      />
                      <div className="input-actions">
                        <button
                          onClick={onAutoDetectGamePath}
                          disabled={isGamePathLoading}
                          className="action-btn"
                          title="Find the game's mods folder"
                        >
                          <RiSparkling2Fill />
                          {isGamePathLoading ? 'Detecting…' : 'Auto-detect'}
                        </button>
                        <button
                          onClick={onBrowseGamePath}
                          className="action-btn icon-only"
                          title="Browse for the folder"
                        >
                          <LuFolderInput size={16} />
                        </button>
                        <button type="button" className="action-btn icon-only" disabled={!gamePath}
                          title="Open selected mods folder" aria-label="Open selected mods folder"
                          onClick={() => void invoke('open_in_explorer', { path: gamePath }).catch(e => alert.warning('Could not open mods folder', String(e)))}>
                          <LuFolderOpen size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="setting-section">
                  <h3 className="setting-icon-label"><LuRocket size={18} aria-hidden="true" />Launcher</h3>
                  <div className="setting-group">
                    <p className="setting-hint">Which launcher Launch uses.</p>

                    <div className="segmented-control" style={{ maxWidth: '400px' }}>
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
                    </div>
                  </div>
                </div>

                <div className="setting-section">
                  <h3 className="setting-icon-label"><CgPerformance size={18} aria-hidden="true" />Performance</h3>
                  <div className="setting-group">
                    <div className="setting-item">
                      <Checkbox
                        checked={parallelProcessing}
                        onChange={(checked: boolean) => live('parallelProcessing', setLocalParallelProcessing)(checked)}
                      >
                        <span>Faster processing</span>
                      </Checkbox>
                      <p className="setting-subtext">
                        Installs, conflict checks and previews use 75% of your CPU threads instead of 50%. Leave it off if the PC
                        slows down while the game runs.
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
                      <p className="setting-subtext">Discord's Rich Presence: your profile says repakxtra is open and how many mods you manage.</p>
                    </div>
                  </div>
                </div>


                <ShortcutSetting />{/* repakxtra: desktop shortcut */}
                <PreviewRimSetting />{/* repakxtra: rim light on previews */}

                <div className="setting-section">
                  <h3 className="setting-icon-label"><LuRefreshCw size={18} aria-hidden="true" />Updates</h3>
                  <div className="setting-group">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                      <button
                        onClick={onCheckForUpdates}
                        disabled={isCheckingUpdates}
                        className="action-btn"
                        title="Check for updates now"
                        style={{ minWidth: '140px' }}
                      >
                        <MdRefresh className={isCheckingUpdates ? 'spin-icon' : ''} />
                        {isCheckingUpdates ? 'Checking…' : 'Check now'}
                      </button>
                      <button
                        onClick={onViewChangelog}
                        className="action-btn"
                        title="View changelog"
                        style={{ minWidth: '160px' }}
                      >
                        <MdArticle />
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
                    <AppFiles alert={alert} />{/* repakxtra */}
                  </div>
                </div>
              </>
            )}

            {activeCategory === 'interface' && (
              <>
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
                {resetSection}
              </>
            )}

            {/* repakxtra: Library, split from Interface so neither page holds 26 switches */}
            {activeCategory === 'library' && (
              <>
                <InstallingSection />
                <div className="setting-section">{/* repakxtra: every badge and tag on a mod, in one place */}
                  <h3 className="setting-icon-label"><LuTags size={18} aria-hidden="true" />On each mod</h3>
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
                  <h3 className="setting-icon-label"><LuLibrary size={18} aria-hidden="true" />Library</h3>
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

                <div className="setting-section">
                  <h3 className="setting-icon-label"><LuSlidersHorizontal size={18} aria-hidden="true" />Advanced</h3>
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
                {resetSection}
              </>
            )}

            {activeCategory === 'trash' && <RecentlyDeleted />}{/* repakxtra */}
            {activeCategory === 'crashes' && <CrashReports />}{/* repakxtra */}

            {activeCategory === 'help' && (
              <>
                <div className="setting-section">
                  <h3 className="setting-icon-label"><LuLifeBuoy size={18} aria-hidden="true" />Help</h3>
                  <div className="setting-group">{/* repakxtra: a label, a gray note and a button per row, like the other sections */}
                    <div className="xs-row">
                      <div className="xs-text">
                        <span className="xs-label">App tour</span>
                        <span className="setting-subtext">A short walk through the main screens and features.</span>
                      </div>
                      <button onClick={onReplayTour} className="action-btn" title="Replay the onboarding tour">
                        <RiGraduationCapFill /> Replay tour
                      </button>
                    </div>
                    <div className="xs-row">
                      <div className="xs-text">
                        <span className="xs-label">Keyboard shortcuts</span>
                        <span className="setting-subtext">Every shortcut in one list. F1 opens it from anywhere.</span>
                      </div>
                      <button onClick={onOpenShortcuts} className="action-btn" title="View keyboard shortcuts">
                        <BsKeyboardFill /> Shortcuts
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
                  <h3 className="setting-icon-label"><LuUsers size={18} aria-hidden="true" />Community</h3>
                  <div className="setting-group">
                    <p className="setting-subtext xs-note">{/* repakxtra: one gray note like the other sections */}
                      For help, bug reports or ideas, join a Discord server: cable's for repakxtra, or Repak X's for the app it is built on.
                    </p>
                    <RepakXDiscord />
                    <CableDiscord />{/* repakxtra: cable's server */}
                    <Support onError={error => alert.warning('Could not open link', error)} />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="modal-footer settings-live-footer">{/* repakxtra: settings save as they change */}
          <span className="settings-live-note">Changes save as you make them.</span>
          <button onClick={onClose} className="btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.9rem', minWidth: 'auto' }}>
            Done
          </button>
        </div>
      </motion.div>
    </div>
  )
}

/** repakxtra: Reset, with a second click to confirm (nothing else in Settings is undoable in one step). */
function ResetInterface({ onReset }: { onReset: () => void }) {
  const [sure, setSure] = useState(false)
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><LuRotateCcw size={18} aria-hidden="true" />Reset</h3>
      <div className="setting-group">
        <p className="setting-hint">Puts every setting on the Interface and Library pages back to how repakxtra starts. Your mods folder, launcher, loadouts, and mods stay as they are.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          {!sure
            ? <button type="button" className="action-btn settings-reset-btn" onClick={() => setSure(true)}><LuRotateCcw size={15} aria-hidden="true" /> Reset to defaults</button>
            : <>
                <button type="button" className="action-btn settings-reset-btn is-confirm" onClick={() => { onReset(); setSure(false) }}>Yes, reset them</button>
                <button type="button" className="action-btn" onClick={() => setSure(false)}>Cancel</button>
              </>}
        </div>
      </div>
    </div>
  )
}
