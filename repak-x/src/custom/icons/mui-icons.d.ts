// repakxtra: @mui/icons-material is no longer installed. vitePlugin.ts turns these imports into Lucide icons (map.ts
// MUI_ICONS), so this only gives upstream's imports their types. A name added here needs its MUI_ICONS entry too.
declare module '@mui/icons-material' {
  type Icon = ReturnType<typeof import('./wrap').muiIcon>
  export const Cancel: Icon, Check: Icon, CheckCircle: Icon, CheckCircleOutline: Icon, ChevronRight: Icon, Clear: Icon,
    Close: Icon, CloudDownload: Icon, CloudUpload: Icon, ContentCopy: Icon, CreateNewFolder: Icon, Download: Icon,
    Error: Icon, ExpandMore: Icon, Folder: Icon, GridView: Icon, Info: Icon, InsertDriveFileOutlined: Icon,
    PlayArrow: Icon, Refresh: Icon, Search: Icon, Security: Icon, Share: Icon, ToggleOff: Icon, ToggleOn: Icon,
    ViewHeadline: Icon, ViewList: Icon, ViewModule: Icon, ViewSidebar: Icon, WarningAmberRounded: Icon, Wifi: Icon,
    WifiOff: Icon
}
