// repakxtra: takes folder paths and the Windows user name out of text that leaves the app (Copy setup report, the Logs
// drawer's copies and saved file, the crash screen's error details).

/** Last line of defense: any absolute Windows path left loses its drive and folders. Folder names may hold spaces
 *  (C:\Users\First Last\..., D:/Build Farm/...), so a path runs to its last separator before the line, a | or quote, a
 *  square bracket, or the next drive path ends it: too much goes rather than a name staying. A network path (\\server\share or
 *  //server/share) goes whole. */
const ENDS = String.raw`\r\n|"'<>\]` // not ): Program Files (x86) is one folder
const NEXT_DRIVE = String.raw`(?![A-Za-z]:[\\/])`
export const scrub = (text: string) => text
  // the // of https:// follows a colon, so it is not a network path
  .replace(new RegExp(String.raw`(?<![:\w])[\\/]{2}[^\s\\/|"']+[\\/][^${ENDS}]*`, 'g'), '<network path>')
  // a drive letter stands alone: the s: of https:// is not one
  // a path under a user folder keeps only its file name (or what follows ~mods): folder names (OneDrive - Company) can
  // name the player too
  .replace(new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/]+Users[\\/]+(?:${NEXT_DRIVE}(?![\\/]~mods[\\/])[^${ENDS}])*[\\/]`, 'gi'), '%USERPROFILE%\\…\\')
  .replace(/(?<![A-Za-z])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n|"']+/gi, '%USERPROFILE%')
  .replace(new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/](?:${NEXT_DRIVE}[^${ENDS}])*?[\\/](~mods[\\/])`, 'gi'), '$1')
  .replace(new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/](?:${NEXT_DRIVE}[^${ENDS}])*[\\/]`, 'g'), '') // any other drive path keeps only its file name
  .replace(/(?<![A-Za-z])[A-Za-z]:[\\/](?=[^\\/]*$)/gm, '') // a file at a drive's root
  // ids and secrets a log line can carry: an email, a Steam id, a login token
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
  .replace(/\b7656119\d{10}\b/g, '<account id>')
  .replace(/\b[0-9a-f]{32}\b/gi, '<account id>') // an Epic account id (any other 32-character hex value goes too)
  .replace(/\b(bearer)\s+[\w.~+/=-]{8,}/gi, '$1 <hidden>')
  .replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]+/g, '<hidden>') // a JWT
  .replace(/\b(authorization)(["']?\s*[=:]\s*)(?:(?:basic|bearer)\s+)?[^\s"'&,;]+/gi, '$1$2<hidden>')
  // a user name written plainly runs to the end of its field: "Username: First Last"
  .replace(/\b(user[ _]?name)(\s*[=:]\s*)(?!\\?["'])([^\r\n,;|&"'<>{}]+)/gi, '$1$2<hidden>')
  // a keyed value: accessToken=, account_id:, username="First Last" (a quoted value goes whole, escaped JSON too)
  .replace(/\b(\w*?(?:token|password|passwd|secret|api[-_]?key|account[ _]?id|client[ _]?id|user[ _]?id|user[ _]?name|authorization))(\\?["']?\s*[=:]\s*)(\\"(?:[^\\]|\\[^"])*\\"|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'&,;\\]+)/gi, '$1$2<hidden>')

if (import.meta.env.DEV) {
  console.assert(scrub('C:\\Users\\someone\\Desktop\\x and D:/Games/MarvelRivals/~mods/a.pak') === '%USERPROFILE%\\…\\x and ~mods/a.pak', 'no user name, no drive paths', scrub('C:\\Users\\someone\\Desktop\\x and D:/Games/MarvelRivals/~mods/a.pak'))
  console.assert(scrub('at C:\\Users\\First Last\\Marvel\\x.cpp') === 'at %USERPROFILE%\\…\\x.cpp', 'a user folder with a space goes whole', scrub('at C:\\Users\\First Last\\Marvel\\x.cpp'))
  console.assert(scrub('C:\\Users\\x\\OneDrive - Contoso Ltd\\Games\\a.pak') === '%USERPROFILE%\\…\\a.pak', 'no folders under the user folder', scrub('C:\\Users\\x\\OneDrive - Contoso Ltd\\Games\\a.pak'))
  console.assert(scrub('C:\\Users\\x\\Games\\MarvelRivals\\~mods\\Sub\\a.pak') === '%USERPROFILE%\\…\\~mods\\Sub\\a.pak', 'a mods folder under the user folder', scrub('C:\\Users\\x\\Games\\MarvelRivals\\~mods\\Sub\\a.pak'))
  console.assert(scrub('home is C:\\Users\\Alice now') === 'home is %USERPROFILE%', 'the user folder alone, the rest of the line too', scrub('home is C:\\Users\\Alice now'))
  console.assert(scrub('see \\\\SERVER\\Shared Folder\\Users\\someone\\file.cpp\nnext') === 'see <network path>\nnext', 'a network path goes whole, spaces too', scrub('see \\\\SERVER\\Shared Folder\\Users\\someone\\file.cpp\nnext'))
  console.assert(scrub('https://github.com/x/y') === 'https://github.com/x/y', 'a web address is not a path')
  console.assert(scrub('[File:D:/Build Farm/Alice Smith/project/crash.cpp]') === '[File:crash.cpp]', 'folders with spaces go whole', scrub('[File:D:/Build Farm/Alice Smith/project/crash.cpp]'))
  console.assert(scrub('at //SERVER/Shared Folder/Alice/file.cpp') === 'at <network path>', 'a forward-slash network path goes whole', scrub('at //SERVER/Shared Folder/Alice/file.cpp'))
  console.assert(scrub('C:/Program Files (x86)/Steam/MarvelRivals/~mods/a.pak') === '~mods/a.pak', 'a mods folder under a spaced path', scrub('C:/Program Files (x86)/Steam/MarvelRivals/~mods/a.pak'))
  console.assert(scrub('C:/a/b.pak and D:/c d/e.pak') === 'b.pak and e.pak', 'two paths on a line keep both file names', scrub('C:/a/b.pak and D:/c d/e.pak'))
  const ids = 'mail me@x.com, steam 76561198000000000, Bearer abcdefgh123, token=abc123&x=1'
  const keyed = 'accountId=123456789 username="Jane Doe" accessToken=abc123xyz author: Someone'
  const more = 'Authorization: Basic dXNlcjpwYXNz x-api-key=k1 jwt eyJhbGciOi.eyJzdWIiOi.sig github_token=abc'
  console.assert(scrub(more) === 'Authorization: <hidden> x-api-key=<hidden> jwt <hidden> github_token=<hidden>', 'headers, dashed keys, JWTs, prefixed tokens', scrub(more))
  const spaced = 'Account ID: 123456789 {"username":"Jane \\"JJ\\" Doe","x":1}'
  console.assert(scrub(spaced) === 'Account ID: <hidden> {"username":<hidden>,"x":1}', 'spaced keys, a quoted value with escaped quotes goes whole', scrub(spaced))
  const escaped = '{\\"access_token\\":\\"abc123\\",\\"account_id\\":\\"42\\"} Username: Jane Doe, next'
  console.assert(scrub(escaped) === '{\\"access_token\\":<hidden>,\\"account_id\\":<hidden>} Username: <hidden>, next', 'escaped JSON values, a plain user name to the end of its field', scrub(escaped))
  console.assert(scrub(keyed) === 'accountId=<hidden> username=<hidden> accessToken=<hidden> author: Someone', 'keyed ids, quoted names, camelCase tokens', scrub(keyed))
  console.assert(scrub(ids) ==='mail <email>, steam <account id>, Bearer <hidden>, token=<hidden>&x=1', 'ids and tokens', scrub(ids))
}
