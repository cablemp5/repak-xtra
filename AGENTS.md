# Local build policy

- This default does not move existing exclusive features into Standard. Keep the existing edition boundaries unless the user explicitly changes them.
- Preparing release artifacts in separate release staging folders is allowed when requested. Do not repoint stable shortcuts or stable junctions to locally built replacements.
- Preserve the legacy internal edition identifiers, updater tags, and storage keys unless an explicit migration keeps existing clients working.

# Tool-call speed

- For iterative Blender inspection, tweaks, and rendering, use the open Blender session's MCP `execute_blender_code`; headless Blender is fine for one-shot batch pipelines.
- Batch independent shell steps into one command instead of many small ones.
