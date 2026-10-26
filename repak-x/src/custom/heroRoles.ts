// repakxtra: each hero's role by id, for Force default skin's role buttons (BuiltinMods.tsx). From the modding notes'
// costume list (Claude Assisted Mods modding-kb/reference/character-costume-ids.txt, 2026-10-25). Deadpool (1057) has
// no role there, so no role button picks him. A hero added later shows in the picker, just not under a role until here.
export const ROLES = {
  Vanguards: ['1011', '1018', '1022', '1027', '1035', '1037', '1039', '1042', '1051', '1053', '1056', '1062', '1065', '1066'],
  Duelists: ['1014', '1015', '1017', '1021', '1024', '1026', '1029', '1030', '1032', '1033', '1034', '1036', '1038', '1040', '1041', '1043',
    '1044', '1045', '1048', '1049', '1052', '1054', '1055', '1059', '1061', '1063', '1067'],
  Strategists: ['1016', '1020', '1023', '1025', '1028', '1031', '1046', '1047', '1050', '1058', '1060', '1064'],
} as const
export type Role = keyof typeof ROLES

if (import.meta.env.DEV) {
  const all = Object.values(ROLES).flat()
  console.assert(new Set(all).size === all.length, 'a hero has one role')
}
