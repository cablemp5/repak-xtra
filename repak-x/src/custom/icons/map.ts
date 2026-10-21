// repakxtra: icon name in react-icons / @mui/icons-material -> lucide-react (T3 Code's icon set).
// Names not listed (brand logos: Discord, Steam, Epic, GitHub) keep their original icon.
// A new upstream icon also keeps its original until it is added here.

export const REACT_ICONS: Record<string, Record<string, string>> = {
  bi: { BiCopyAlt: 'Copy' },
  bs: { BsFiletypeRaw: 'FileType', BsKeyboardFill: 'Keyboard' },
  cg: { CgMaximizeAlt: 'Maximize2', CgMinimizeAlt: 'Minimize2', CgPerformance: 'Gauge' },
  fa: { FaExchangeAlt: 'ArrowLeftRight', FaTag: 'Tag', FaTerminal: 'Terminal', FaUsers: 'Users' },
  fa6: { FaSort: 'ArrowUpDown', FaTag: 'Tag', FaToolbox: 'Wrench' },
  fi: { FiChevronDown: 'ChevronDown', FiDownload: 'Download', FiExternalLink: 'ExternalLink', FiHeart: 'Heart', FiSearch: 'Search', FiX: 'X' },
  gi: { GiLightningTrio: 'Blend' }, // VFX Updater: mixing colors (cable's pick, 2026-10-21)
  gr: { GrClose: 'X', GrInstall: 'Download' },
  io: { IoIosSettings: 'Settings', IoIosSkipForward: 'SkipForward', IoMdWarning: 'TriangleAlert', IoMdWifi: 'Wifi' },
  io5: { IoLayersSharp: 'Layers', IoWarningOutline: 'TriangleAlert' },
  lu: { LuFolderInput: 'FolderInput', LuMoon: 'Moon', LuSun: 'Sun' },
  md: {
    MdCheckCircle: 'CircleCheck', MdClearAll: 'ListX', MdClose: 'X', MdContentCopy: 'Copy',
    MdCreateNewFolder: 'FolderPlus', MdDownload: 'Download', MdDriveFileMoveOutline: 'FolderInput',
    MdExtension: 'Puzzle', MdInstallDesktop: 'MonitorDown', MdMinimize: 'Minus', MdOpenInNew: 'ExternalLink',
    MdRemoveModerator: 'ShieldOff',
  },
  ri: { RiDeleteBin2Fill: 'Trash2', RiFileZipFill: 'FileArchive', RiGraduationCapFill: 'GraduationCap', RiSparkling2Fill: 'WandSparkles' },
  vsc: {
    VscCheck: 'Check', VscChevronDown: 'ChevronDown', VscChevronRight: 'ChevronRight', VscClearAll: 'ListX',
    VscClose: 'X', VscFile: 'File', VscFolder: 'Folder', VscFolderOpened: 'FolderOpen', VscLibrary: 'Library',
    VscListTree: 'ListTree', VscNewFolder: 'FolderPlus', VscPackage: 'Package',
  },
}

export const MUI_ICONS: Record<string, string> = {
  Cancel: 'CircleX', Check: 'Check', CheckCircle: 'CircleCheck', CheckCircleOutline: 'CircleCheck',
  ChevronRight: 'ChevronRight', Clear: 'X', Close: 'X', CloudDownload: 'CloudDownload', CloudUpload: 'CloudUpload',
  ContentCopy: 'Copy', CreateNewFolder: 'FolderPlus', Download: 'Download', Error: 'CircleAlert',
  ExpandMore: 'ChevronDown', Folder: 'Folder', GridView: 'LayoutGrid', Info: 'Info',
  InsertDriveFileOutlined: 'File', PlayArrow: 'Play', Refresh: 'RefreshCw', Search: 'Search', Security: 'Shield',
  Share: 'Share2', ToggleOff: 'ToggleLeft', ToggleOn: 'ToggleRight', ViewHeadline: 'AlignJustify',
  ViewList: 'List', ViewModule: 'Grid3x3', ViewSidebar: 'PanelRight', WarningAmberRounded: 'TriangleAlert',
  Wifi: 'Wifi', WifiOff: 'WifiOff',
}
