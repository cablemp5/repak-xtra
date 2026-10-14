"""Turn Repak-X tag groups into repakXcable loadouts. Run: python -I repak-x/scripts/tags-to-loadouts.py,
then start the app: it adds the new loadouts by itself (names that already exist are skipped)."""
import json, os, re, sys, collections

APP = os.path.join(os.environ['APPDATA'], 'Repak-X', 'state.json')
MODS = r'C:\Program Files (x86)\Steam\steamapps\common\MarvelRivals\MarvelGame\Marvel\Content\Paks\~mods'
# The app merges this file on its next start, then renames it (caleb_import.rs)
OUT = os.path.join(os.environ['APPDATA'], 'Repak-X', 'caleb-import-loadouts.json')

def norm(stem):
    s = re.sub(r'(\.pak)?(\.bak_repak|\.pak_disabled)?$', '', stem, flags=re.I)
    s = re.sub(r'_disabled$', '', s, flags=re.I)
    return re.sub(r'(_\d+_P)+$', '', s, flags=re.I)

installed = {}  # key -> enabled
for root, _, files in os.walk(MODS):
    for f in files:
        low = f.lower()
        if low.endswith('.pak') or low.endswith('.bak_repak') or low.endswith('.pak_disabled'):
            installed[norm(f)] = low.endswith('.pak')

state = json.load(open(APP, encoding='utf-8'))
tags = collections.defaultdict(list)
for key, ts in state.get('mod_tags', {}).items():
    for t in ts:
        tags[t].append(norm(key))

def latest(keys):
    """Keep only the newest _vN of each mod; keys without a version stay."""
    best = {}
    for k in keys:
        m = re.search(r'_v(\d+)(?=_|$)', k)
        base, n = (k[:m.start()] + k[m.end():], int(m.group(1))) if m else (k, -1)
        if base not in best or n > best[base][1]:
            best[base] = (k, n)
    return sorted(k for k, _ in best.values())

present = lambda keys: [k for k in keys if k in installed]

LOOKS = ['catboy', 'cosmic', 'Cyan', 'cyan flaming', 'el blue', 'flaming', 'gal claw', 'kow cosmic', 'ultimatebp', 'void', 'electric vfx']
EMOTES = ['emote wheel 1', 'emote wheel 2']
SOLO = ['Performance', 'comp', 'catboy extra']

def color_name(k):
    m = re.match(r'(.+?)ColoredVFX$', k)
    if m:
        return re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', m.group(1)) + ' VFX'
    m = re.match(r'bp-(\w+)-vfx', k)
    return (m.group(1).capitalize() + ' VFX') if m else k

loadouts, report = [], []
looks_scope = sorted({k for t in LOOKS + ['colored vfx'] for k in present(tags[t])})
for t in LOOKS:
    on = latest(present(tags[t]))
    if on:
        loadouts.append({'name': t, 'label': 'Panther looks', 'scope': looks_scope, 'on': on})
        report.append((t, 'Panther looks', on, len(tags[t])))
for k in latest(present(tags['colored vfx'])):
    loadouts.append({'name': color_name(k), 'label': 'Panther looks', 'scope': looks_scope, 'on': [k]})
    report.append((color_name(k), 'Panther looks', [k], 1))
emote_scope = sorted({k for t in EMOTES for k in present(tags[t])})
for t in EMOTES:
    on = latest(present(tags[t]))
    if not on: continue
    loadouts.append({'name': t, 'label': 'Emote wheels', 'scope': emote_scope, 'on': on})
    report.append((t, 'Emote wheels', on, len(tags[t])))
for t in SOLO:
    keys = present(tags[t])
    enabled_now = [k for k in keys if installed[k]]
    on = latest(enabled_now or keys)
    if not on: continue
    loadouts.append({'name': t, 'label': t, 'scope': sorted(keys), 'on': on})
    report.append((t, t + (' (what is on now)' if enabled_now else ''), on, len(tags[t])))

covered = set(LOOKS + EMOTES + SOLO + ['colored vfx'])
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({'format': 'repakxcable-loadouts', 'version': 1, 'loadouts': loadouts}, open(OUT, 'w', encoding='utf-8'), indent=2)
for name, group, on, tagged in report:
    print(f'{name:<16} {group:<32} {len(on):>2} on (tag has {tagged})')
print('skipped, nothing installed:', [t for t in sorted(tags) if not present(tags[t])])
print('uncovered tags:', sorted(set(tags) - covered))
print('looks scope', len(looks_scope), 'emote scope', len(emote_scope))
print('wrote', OUT, len(loadouts), 'loadouts')
