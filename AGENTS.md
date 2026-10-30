# Local build policy

- Never directly rebuild or overwrite the installed stable app. The user updates it through the in-app updater.
- Build local changes with `build.ps1 -Test`.
- For live development, use `dev.ps1` (amber). Dev copies share the real library/settings and single-instance lock; close the other app copy first.
- Preparing release artifacts in separate release staging folders is allowed when requested. Do not repoint stable shortcuts or stable junctions to locally built replacements.
- Preserve the updater's "standard" ZIP name and edition.json, the update tags, and storage keys unless an explicit migration keeps existing clients working.

# Tool-call speed

- For iterative Blender inspection, tweaks, and rendering, use the open Blender session's MCP `execute_blender_code`; headless Blender is fine for one-shot batch pipelines.
- Batch independent shell steps into one command instead of many small ones.
