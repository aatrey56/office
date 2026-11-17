// The manga library: one cover per series in ~/Manga, in rows that wrap to the pane. Pure (no `$`);
// manga.tsx lists the folders, builds the covers in the background and draws them.

// A cover is 20 columns by 13 rows: the reader's page aspect (about 1.5 cells wide per row), and room
// under it for "1: Kingdom · ch 458".
export const COVER_COLUMNS = 20
export const COVER_ROWS = 13
export const COVER_GAP = 2
export const COVER_PNG = 'cover.png'

const COVER_FILE = /^cover\.(png|jpe?g|webp)$/i
const COVER_RANK = ['png', 'jpg', 'jpeg', 'webp']

export type CoverPick = { kind: 'file' | 'dir' | 'cbz'; name: string } | { kind: 'none' }

// A cover.(png|jpg|jpeg|webp) in the series folder; else the first chapter (already sorted), whose
// first page the shell finds; else nothing.
export function coverSource(entries: { name: string; kind: string }[], firstChapter: string | undefined): CoverPick {
  const rank = (name: string) => COVER_RANK.indexOf(name.split('.').pop()?.toLowerCase() ?? '')
  const own = entries.filter(x => x.kind === 'file' && COVER_FILE.test(x.name)).sort((a, b) => rank(a.name) - rank(b.name))[0]
  if (own) return { kind: 'file', name: own.name }
  if (!firstChapter) return { kind: 'none' }
  return { kind: /\.(cbz|zip)$/i.test(firstChapter) ? 'cbz' : 'dir', name: firstChapter }
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// An archive's entries (`unzip -Z1`) that can be pages: files, no macOS resource forks or dot files.
export const archivePages = (entries: string[]) =>
  entries.filter(e => e && !e.endsWith('/') && !/(^|\/)__MACOSX\//.test(e) && !baseName(e).startsWith('.'))

// unzip reads its member arguments as wildcards with `\` the escape: escape it and the characters that would match others.
export const zipPattern = (entry: string) => entry.replace(/[\\[*?]/g, c => `\\${c}`)
// `unzip -Z1` prints one bare name per line: split on the newlines alone, since a name may start or end with a space.
export const zipListing = (stdout: string) => stdout.split('\n')
export const unzipListArgv = (cbz: string) => ['unzip', '-Z1', cbz]
export const unzipOneArgv = (cbz: string, entry: string, dir: string) => ['unzip', '-o', '-j', '-qq', cbz, zipPattern(entry), '-d', dir]

// Outside every <cache root>/<series>/ chapter folder, so the per-series prune never sees it.
export const coverDir = (cacheRoot: string, series: string) => `${cacheRoot}/.covers/${series}`

// Each build stages in its own folder inside the cover dir, so two builds never share a file; the finished
// cover is renamed into place. `token` is unique per build (time, random, a counter).
export const coverStaging = (dir: string, token: string) => `${dir}/.build-${token}`
// The per-series build lock, outside every cover dir and series folder, so no cleanup removes a lock in use.
export const coverLockPath = (cacheRoot: string, series: string) => `${cacheRoot}/.locks/cover-${series}.lock`

export type CoverMarker = { source: string; size: number; mtimeMs: number }

// The cached cover is current while it came from the same file at the same size and mtime.
export function coverFresh(marker: unknown, source: string, stat: { size: number; mtimeMs: number }) {
  const m = marker as Partial<CoverMarker> | null | undefined
  return !!m && m.source === source && m.size === stat.size && m.mtimeMs === stat.mtimeMs
}

// How many covers fit side by side in a pane body this wide; always at least one.
export const coversPerRow = (bodyColumns: number) => Math.max(1, Math.floor((bodyColumns + COVER_GAP) / (COVER_COLUMNS + COVER_GAP)))

export function inRows<T>(items: T[], perRow: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow))
  return rows
}

// "Kingdom · ch 458" with the chapter last read (its label), the title alone without one.
export const coverCaption = (series: string, chapter: string | undefined) => (chapter ? `${series} · ch ${chapter}` : series)

// Cut to `width` columns, an ellipsis marking the cut.
export const fitCaption = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`)

// The first nine covers answer 1-9; the rest are pressed or clicked.
export const coverHotkey = (index: number) => (index < 9 ? String(index + 1) : undefined)

// ── reading progress in $.store ──────────────────────────────────────────
// Each series' place under its own key, so sessions saving different series never write the same record
// ($.store has no versioned write). Older versions kept one `progress` map and the last place in `position`.
export type Position = { series: string; chapter: string | null; page: number }
export const PROGRESS_PREFIX = 'progress:'
export const progressKey = (series: string) => `${PROGRESS_PREFIX}${series}`

const isPosition = (x: unknown): x is Position => {
  const p = x as Partial<Position> | null | undefined
  return !!p && typeof p.series === 'string' && p.series !== '' && typeof p.page === 'number'
}

// The legacy records, series by series: the last place wins for its series (it was written last).
export function legacyProgress(map: unknown, last: unknown): Record<string, Position> {
  const out: Record<string, Position> = {}
  for (const [s, p] of Object.entries(map && typeof map === 'object' ? map : {})) if (isPosition(p)) out[s] = p
  if (isPosition(last)) out[last.series] = last
  return out
}

// The per-series records from the store's own entries, by series.
export function ownProgress(entries: [string, unknown][]): Record<string, Position> {
  const out: Record<string, Position> = {}
  for (const [k, v] of entries) if (k.startsWith(PROGRESS_PREFIX) && isPosition(v)) out[k.slice(PROGRESS_PREFIX.length)] = v
  return out
}

// What a reader resumes from: a series' own record, else its legacy one.
export const mergedProgress = (own: Record<string, Position>, legacy: Record<string, Position>) => ({ ...legacy, ...own })

// The legacy records not yet under their own key: what a save migrates first. Empty once migrated.
export const toMigrate = (own: Record<string, Position>, legacy: Record<string, Position>) =>
  Object.fromEntries(Object.entries(legacy).filter(([s]) => !(s in own)))
