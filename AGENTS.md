# Local build policy

- New features default to both repakxtra (Standard) and repakxploit. Restrict a new feature to repakxploit only when the user explicitly requests it, for example: "Add this feature to repakxploit only."
- This default does not move existing exclusive features into Standard. Keep the existing edition boundaries unless the user explicitly changes them.
- Never directly rebuild or overwrite the installed stable Standard or repakxploit app. The user updates both stable apps through the in-app updater.
- Build local changes with `build.ps1 -Test -Edition Standard` or `build.ps1 -Test -Edition Repakxploit`.
- For live development, use `dev.ps1 -Edition Standard` (amber) or `dev.ps1 -Edition Repakxploit` (pink). Dev copies share the real library/settings and single-instance lock; close the other app copy first.
- Preparing release artifacts in separate release staging folders is allowed when requested. Do not repoint stable shortcuts or stable junctions to locally built replacements.
- Preserve the legacy internal edition identifiers, updater tags, and storage keys unless an explicit migration keeps existing clients working.
- Force default skin, Custom Quake, Sigeon tools, and the AMOLED black theme belong only to repakxploit; do not expose them in Standard.

# Tool-call speed

- For iterative Blender inspection, tweaks, and rendering, use the open Blender session's MCP `execute_blender_code`; headless Blender is fine for one-shot batch pipelines.
- Batch independent shell steps into one command instead of many small ones.
