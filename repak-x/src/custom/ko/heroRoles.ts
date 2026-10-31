// repakxtra: the KO Editor's hero list groups heroes by role. The game files the editor reads have no role, so this is a
// list by hero id, from the modding notes' costume list (Claude Assisted Mods modding-kb/reference/character-costume-ids.txt,
// 2026-10-25, the same list Force default skin's role buttons used). Deadpool (1057) has no role there, and a hero added
// later shows under Other heroes until here, never missing.
export type HeroRole = 'Vanguard' | 'Duelist' | 'Strategist' | 'Other heroes'
export const ROLE_ORDER: HeroRole[] = ['Vanguard', 'Duelist', 'Strategist', 'Other heroes']

const ROLES: Record<Exclude<HeroRole, 'Other heroes'>, number[]> = {
  Vanguard: [1011, 1018, 1022, 1027, 1035, 1037, 1039, 1042, 1051, 1053, 1056, 1062, 1065, 1066],
  Duelist: [1014, 1015, 1017, 1021, 1024, 1026, 1029, 1030, 1032, 1033, 1034, 1036, 1038, 1040, 1041, 1043, 1044, 1045, 1048, 1049, 1052, 1054, 1055,
    1059, 1061, 1063, 1067],
  Strategist: [1016, 1020, 1023, 1025, 1028, 1031, 1046, 1047, 1050, 1058, 1060, 1064],
}
const BY_ID = new Map(Object.entries(ROLES).flatMap(([role, ids]) => ids.map(id => [String(id), role as HeroRole])))
export const heroRole = (id: string): HeroRole => BY_ID.get(id) ?? 'Other heroes'

if (import.meta.env?.DEV) {
  const all = Object.values(ROLES).flat()
  console.assert(new Set(all).size === all.length, 'a hero has one role')
}
