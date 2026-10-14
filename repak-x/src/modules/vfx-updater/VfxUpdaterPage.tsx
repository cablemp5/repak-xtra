// VFX Updater - Main Page Component (for separate window)

import React from "react";
import VfxUpdaterPanel from "./VfxUpdaterPanel";
import "./VfxUpdater.css";
import TitleBar from "../../components/TitleBar";

export default function VfxUpdaterPage() {
  return (
    <div className="vfx-window-container">
      <TitleBar title="repakXtra VFX Updater" hideMaximize={true} />
      <div className="vfx-updater-page">
        <VfxUpdaterPanel />
      </div>
    </div>
  );
}
