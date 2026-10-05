import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { MangaShelf } from '../types'

// ~/Manga/<Series>/<chapter>: a chapter is a folder of PNGs or a .cbz/.zip of images.
// A cbz is unpacked into ~/Library/Caches/office-manga (never into ~/Manga) and its pages
// converted to PNG, the one format Image takes. Both roots come from HOME at runtime: see roots().
const CACHE_KEEP = 12 // newest-opened chapter dirs kept per series
const MARKER = '.office-manga.json'
const PREFETCH_WITHIN = 3 // last pages of a chapter that start unpacking the next one
const PANE = 'manga'
// The pane size the reader last asked a wider dock for, so a render asks only once per size.
let askedFor: string | undefined
const EMPTY_HINT = 'Drop chapter folders of PNGs into ~/Manga/<Series>/ (convert JPG: sips -s format png *.jpg --out .)'

const shelf = atom({ plugin: 'office', key: 'shelf' } as const, { series: '', chapters: [], pages: [], dir: '', ready: [], loading: false } as MangaShelf)
const chapter = atom({ plugin: 'office', key: 'chapter' } as const, 0)
const page = atom({ plugin: 'office', key: 'page' } as const, 0)

type Position = { series: string; chapter: string | null; page: number }

// ── pure logic (no `$`), covered by manga.test.ts ────────────────────────
export const LAST = Number.MAX_SAFE_INTEGER // "last page", clamped once the chapter is listed

export const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi))

const KNOWN_EXT = /\.(cbz|zip|png|jpe?g|webp)$/i

// The LAST number in a name, extension aside: "chapters8-10458000kingdom-chapter-458.cbz" is 458.
export function lastNumber(name: string): number {
  const found = name.replace(KNOWN_EXT, '').match(/\d+(?:\.\d+)?/g)
  return found ? Number(found[found.length - 1]) : Number.POSITIVE_INFINITY
}

// Chapters and pages both: by last number, natural sort for ties.
export function byLastNumber(a: string, b: string) {
  const x = lastNumber(a)
  const y = lastNumber(b)
  return x === y ? byNumber(a, b) : x < y ? -1 : 1
}

export const isCbz = (name: string) => /\.(cbz|zip)$/i.test(name)
export const isImage = (name: string) => /\.(png|jpe?g|webp)$/i.test(name) && !name.startsWith('.')
export const isPng = (name: string) => /\.png$/i.test(name)
const stemOf = (name: string) => name.replace(KNOWN_EXT, '')

// <cache root>/<series>/<cbz name without extension>
export const cachePath = (cacheRoot: string, series: string, name: string) => `${cacheRoot}/${series}/${stemOf(name)}`

export const unzipArgv = (cbz: string, dir: string) => ['unzip', '-o', '-j', '-qq', cbz, '-d', dir]
export const sipsArgv = (from: string, to: string) => ['sips', '-s', 'format', 'png', from, '--out', to]

export type Marker = { size: number; mtimeMs: number; openedAt: number }

// The cache holds this archive as it is now only when size and mtime both match.
export function markerFresh(marker: unknown, stat: { size: number; mtimeMs: number }) {
  const m = marker as Partial<Marker> | null | undefined
  return !!m && m.size === stat.size && m.mtimeMs === stat.mtimeMs
}

// One entry per page, in reading order: `png` is the file Image shows, `src` what to convert it from
// (the same name when it is already a PNG).
export function planPages(files: string[]) {
  const byStem = new Map<string, { src: string; png: string }>()
  for (const f of files.filter(isImage).sort(byNumber)) {
    const stem = stemOf(f)
    const have = byStem.get(stem)
    if (!have || isPng(f)) byStem.set(stem, { src: f, png: isPng(f) ? f : `${stem}.png` })
  }
  return [...byStem.values()].sort((a, b) => byLastNumber(a.png, b.png))
}

// Names to delete so only the `keep` most recently opened remain.
export function staleNames(entries: { name: string; openedAt: number }[], keep: number) {
  return [...entries].sort((a, b) => b.openedAt - a.openedAt).slice(keep).map(x => x.name)
}

// The delete guard: a resolved path strictly under the resolved cache root.
export const isInsideCache = (root: string, real: string) => real.startsWith(`${root}/`) && real.length > root.length + 1

export const needsPrefetch = (p: number, total: number) => total > 0 && p >= total - PREFETCH_WITHIN

// Where one page turn lands: rolls into the next chapter's first page or the previous chapter's last.
export function step(c: number, p: number, delta: number, pageCount: number, chapterCount: number) {
  const next = p + delta
  if (next >= pageCount && c < chapterCount - 1) return { chapter: c + 1, page: 0 }
  if (next < 0 && c > 0) return { chapter: c - 1, page: LAST }
  return { chapter: c, page: clamp(next, 0, pageCount - 1) }
}

// "Ch 458" from "chapters8-10458000kingdom-chapter-458.cbz", "Chapter 12" or "12"; the name when it has no number.
export function chapterLabel(name: string | undefined) {
  if (!name) return '?'
  const n = lastNumber(name)
  return Number.isFinite(n) ? String(n) : stemOf(name).replace(/^ch(apter)?[\s._-]*/i, '')
}

// Manga pages are roughly 1:1.42 and Ghostty cells about 2.14 times as tall as wide,
// so a page `rows` tall is about rows * 1.5 cells wide.
const PAGE_ASPECT = 1.5

// The largest page that fits the pane body, one row kept for the controls.
export function fitPage(bodyRows: number, bodyColumns: number) {
  const maxRows = clamp(bodyRows - 1, 8, 255)
  const maxColumns = clamp(bodyColumns, 10, 255)
  const rows = Math.min(maxRows, Math.floor(maxColumns / PAGE_ASPECT))
  return { rows: Math.max(rows, 4), columns: Math.min(maxColumns, Math.round(rows * PAGE_ASPECT)) }
}

// Image draws through the kitty graphics protocol, which the engine enables from the
// terminal's own environment. A background session (claude --bg, or one moved there by
// /exit) runs in the daemon's pty host as plain xterm-256color, so pages draw as alt text.
export function graphicsLikely(termProgram?: string, term?: string, kittyWindow?: string) {
  if (kittyWindow) return true
  if (termProgram && /^(ghostty|iTerm\.app|WezTerm|kitty)$/i.test(termProgram)) return true
  return !!term && /kitty|ghostty|wezterm/i.test(term)
}

// /exit in a Ghostty session parks it in the background host, which cannot pass pictures on.
export function noGraphicsHint(sessionId: string) {
  return (
    'No page images here: this session runs in the background host (TERM=xterm-256color), ' +
    'which cannot pass pictures to Ghostty. In a Ghostty tab run ' +
    `\`claude stop ${sessionId.slice(0, 8)}\` then \`claude --resume ${sessionId}\` ` +
    '(the office mod loads from ~/.zshrc). /exit parks a session back in the background host.'
  )
}

// The dock width to ask for: about 45% of the terminal, so the chat keeps the rest.
export function dockColumns(terminalColumns: number) {
  return clamp(Math.round(terminalColumns * 0.45), 40, 160)
}

// The dock width that lets a page fill the body floor to ceiling, held to 60% of the
// terminal so the chat keeps the rest. Undefined when the current width already fits.
export function dockToFill(bodyRows: number, bodyColumns: number, terminalColumns: number) {
  const want = clamp(Math.ceil((bodyRows - 1) * PAGE_ASPECT), 40, Math.round(terminalColumns * 0.6))
  return want > bodyColumns ? want : undefined
}

export function pageAlt(name: string | undefined, p: number, total: number) {
  return `Ch ${chapterLabel(name)} p ${p + 1}/${total}`
}

// An environment that cannot be read counts as capable, so the hint never shows by mistake.
async function termGraphics($: EngineInterface): Promise<boolean> {
  try {
    return graphicsLikely(await $.env.get('TERM_PROGRAM'), await $.env.get('TERM'), await $.env.get('KITTY_WINDOW_ID'))
  } catch {
    return true
  }
}

// ── fs helpers ───────────────────────────────────────────────────────────
async function roots($: EngineInterface): Promise<{ manga: string; cache: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  return { manga: `${home}/Manga`, cache: `${home}/Library/Caches/office-manga` }
}

async function listSeries($: EngineInterface): Promise<string[]> {
  const { manga } = await roots($)
  if (!(await $.fs.exists(manga))) return []
  const entries = await $.fs.list(manga)
  return entries.filter(x => x.kind === 'dir' && !x.name.startsWith('.')).map(x => x.name).sort(byNumber)
}

// Folders and archives alike, in chapter-number order.
async function listChapters($: EngineInterface, series: string): Promise<string[]> {
  if (!series) return []
  const entries = await $.fs.list(`${(await roots($)).manga}/${series}`)
  return entries
    .filter(x => !x.name.startsWith('.') && (x.kind === 'dir' || (x.kind === 'file' && isCbz(x.name))))
    .map(x => x.name)
    .sort(byLastNumber)
}

// A chapter folder's PNGs. Nothing is ever converted or written inside ~/Manga.
async function listPages($: EngineInterface, series: string, name: string | undefined): Promise<string[]> {
  if (!name) return []
  const entries = await $.fs.list(`${(await roots($)).manga}/${series}/${name}`)
  return entries
    .filter(x => x.kind === 'file' && isPng(x.name) && !x.name.startsWith('.'))
    .map(x => x.name)
    .sort(byLastNumber)
}

async function readMarker($: EngineInterface, dir: string): Promise<Marker | undefined> {
  const text = await $.fs.read(`${dir}/${MARKER}`).catch(() => undefined)
  try {
    return typeof text === 'string' ? (JSON.parse(text) as Marker) : undefined
  } catch {
    return undefined
  }
}

// rm -rf only a directory that resolves to somewhere strictly inside the cache root.
async function removeCacheDir($: EngineInterface, path: string): Promise<boolean> {
  const root = await $.fs.stat((await roots($)).cache, { resolve: true }).catch(() => undefined)
  const own = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (!root?.realPath || !own?.realPath || own.kind !== 'dir') return false
  if (!isInsideCache(root.realPath, own.realPath)) return false
  await $.process.run(['rm', '-rf', '--', own.realPath])
  return true
}

async function pruneCache($: EngineInterface, series: string) {
  const base = `${(await roots($)).cache}/${series}`
  if (!(await $.fs.exists(base))) return
  const dirs = (await $.fs.list(base)).filter(x => x.kind === 'dir')
  const seen = await Promise.all(
    dirs.map(async x => ({ name: x.name, openedAt: (await readMarker($, `${base}/${x.name}`))?.openedAt ?? 0 })),
  )
  for (const name of staleNames(seen, CACHE_KEEP)) await removeCacheDir($, `${base}/${name}`)
}

// Unpack a cbz into its cache dir once; a marker of the archive's size and mtime says it is still good.
async function unpack($: EngineInterface, series: string, name: string) {
  const { manga, cache } = await roots($)
  const cbz = `${manga}/${series}/${name}`
  const dir = cachePath(cache, series, name)
  const stat = await $.fs.stat(cbz)
  if (!markerFresh(await readMarker($, dir), stat)) {
    if (await $.fs.exists(dir)) await removeCacheDir($, dir)
    // unzip -d creates only the last path segment, so make the series dir and cache root first.
    await $.process.run(['mkdir', '-p', dir])
    const ran = await $.process.run(unzipArgv(cbz, dir), { timeoutMs: 120000 })
    // 1 is unzip's "warnings"; the pages are there
    if (ran.exitCode > 1) throw new Error(`unzip exited ${ran.exitCode}: ${ran.stderr.trim().slice(0, 160)}`)
  }
  const marker: Marker = { size: stat.size, mtimeMs: stat.mtimeMs, openedAt: await $.clock.now() }
  await $.fs.write(`${dir}/${MARKER}`, JSON.stringify(marker))
  await pruneCache($, series)
  const files = (await $.fs.list(dir)).filter(x => x.kind === 'file').map(x => x.name)
  return { dir, plans: planPages(files) }
}

// sips to a dot-named temp, then rename, so a page that exists is a whole page.
async function convertPage($: EngineInterface, dir: string, plan: { src: string; png: string }): Promise<boolean> {
  if (plan.src === plan.png || (await $.fs.exists(`${dir}/${plan.png}`))) return true
  const tmp = `${dir}/.${plan.png}.part.png`
  const ran = await $.process.run(sipsArgv(`${dir}/${plan.src}`, tmp), { timeoutMs: 60000 })
  if (ran.exitCode === 0) await $.process.run(['mv', '-f', tmp, `${dir}/${plan.png}`])
  return $.fs.exists(`${dir}/${plan.png}`)
}

// ── background jobs (run from $.clock.after(0), never inside a hook's own time) ──
const converting = new Set<string>()
const prefetched = new Set<string>()

// Convert the rest of a chapter, from the page being read onward, then the earlier pages; each one ready redraws the pane.
async function convertRest($: EngineInterface, dir: string, plans: { src: string; png: string }[], from: number) {
  if (converting.has(dir)) return
  converting.add(dir)
  try {
    const order = [...plans.keys()].filter(i => i >= from).concat([...plans.keys()].filter(i => i < from))
    for (const i of order) {
      const plan = plans[i]
      if (!plan || !(await convertPage($, dir, plan))) continue
      await update($, shelf, cur => (cur.dir === dir ? { ...cur, ready: cur.ready.map((r, j) => r || j === i) } : cur))
    }
  } finally {
    converting.delete(dir)
  }
}

async function prefetchChapter($: EngineInterface, series: string, name: string) {
  const { dir, plans } = await unpack($, series, name)
  await convertRest($, dir, plans, 0)
}

// Once per chapter per session, when the reader nears the end of a cbz chapter.
function prefetchNext($: EngineInterface, series: string, chapters: string[], c: number) {
  const name = chapters[c + 1]
  if (!name || !isCbz(name) || prefetched.has(`${series}/${name}`)) return
  prefetched.add(`${series}/${name}`)
  $.clock.after(0, () => void prefetchChapter($, series, name).catch(() => prefetched.delete(`${series}/${name}`)))
}

// ── state writers (handlers only, never while rendering) ─────────────────
async function openChapter($: EngineInterface, series: string, index: number, atPage: number) {
  const chapters = await listChapters($, series)
  const i = clamp(index, 0, chapters.length - 1)
  const name = chapters[i]
  let dir = `${(await roots($)).manga}/${series}/${name}`
  let pages: string[]
  let ready: boolean[]
  let plans: { src: string; png: string }[] = []
  let p = 0

  if (name && isCbz(name)) {
    // Show "Unpacking" at once; unzip, then convert only the page being read before drawing it.
    await update($, shelf, () => ({ series, chapters, pages: [], dir: '', ready: [], loading: true }))
    await update($, chapter, () => i)
    await update($, page, () => 0)
    const unpacked = await unpack($, series, name).catch((err: unknown) => {
      $.ui.toast(`manga: could not unpack ${name}: ${err instanceof Error ? err.message : String(err)}`)
      return { dir: '', plans }
    })
    dir = unpacked.dir
    plans = unpacked.plans
    pages = plans.map(x => x.png)
    p = clamp(atPage, 0, pages.length - 1)
    ready = plans.map(x => x.src === x.png)
    const first = plans[p]
    if (first && !ready[p]) ready[p] = await convertPage($, dir, first)
  } else {
    pages = await listPages($, series, name)
    p = clamp(atPage, 0, pages.length - 1)
    ready = pages.map(() => true)
  }

  await update($, shelf, () => ({ series, chapters, pages, dir, ready, loading: false }))
  await update($, chapter, () => i)
  await update($, page, () => p)
  await $.store.set('position', { series, chapter: name ?? null, page: p } satisfies Position)

  if (ready.some(r => !r)) $.clock.after(0, () => void convertRest($, dir, plans, p).catch(() => undefined))
  if (needsPrefetch(p, pages.length)) prefetchNext($, series, chapters, i)
}

async function turn($: EngineInterface, delta: number) {
  const { series, chapters, pages } = await read($, shelf)
  const c = await read($, chapter)
  const to = step(c, await read($, page), delta, pages.length, chapters.length)
  if (to.chapter !== c) return openChapter($, series, to.chapter, to.page)
  await update($, page, () => to.page)
  await $.store.set('position', { series, chapter: chapters[c] ?? null, page: to.page } satisfies Position)
  if (needsPrefetch(to.page, pages.length)) prefetchNext($, series, chapters, c)
}

async function jump($: EngineInterface, delta: number) {
  const { series, chapters } = await read($, shelf)
  const c = await read($, chapter)
  if (c + delta < 0 || c + delta >= chapters.length) return
  return openChapter($, series, c + delta, 0)
}

// The last terminal width a command or render saw; a Button press does not carry it.
let terminalColumns = 160
function noteTerminalColumns(columns: number | undefined) {
  if (columns && columns > 0) terminalColumns = columns
}

// Loads the saved place (or the `asked` series) into the shelf; text says what opened or why not.
async function loadReader($: EngineInterface, asked = ''): Promise<{ ok: boolean; text: string }> {
  const all = await listSeries($)
  if (all.length === 0) return { ok: false, text: EMPTY_HINT }

  const saved = (await $.store.get('position')) as Position | undefined
  // Match against the listing so the arg can never reach outside ~/Manga.
  const series = asked
    ? all.find(s => s.toLowerCase() === asked.toLowerCase())
    : saved?.series && all.includes(saved.series)
      ? saved.series
      : all[0]
  if (!series) return { ok: false, text: `No series "${asked}" in ~/Manga. Have: ${all.join(', ')}` }

  const chapters = await listChapters($, series)
  if (chapters.length === 0) return { ok: false, text: `No chapters in ~/Manga/${series}/. ${EMPTY_HINT}` }

  // A saved chapter that is gone (deleted, renamed) falls back to the first one, at its page 0.
  const resume = saved?.series === series ? saved : undefined
  const found = resume?.chapter ? chapters.indexOf(resume.chapter) : -1
  const at = Math.max(0, found)
  await openChapter($, series, at, found >= 0 ? (resume?.page ?? 0) : 0)
  return { ok: true, text: `Opened ${series} / Ch ${chapterLabel(chapters[at])}.` }
}

export function installManga(on: On) {
  // Every open of the reader, from /manga, the board's button or a resize, comes through here:
  // each ui.open resets closeOnEscape, title and rows, so this fills the whole set every time.
  // focus: the pane takes the keyboard, so the Buttons' hotkeys press and clicks land.
  // closeOnEscape: Esc closes it. No holdToasts: the pane stays open while Claude works.
  // Fullscreen docks the pane beside the transcript, floor to ceiling, `columns` wide;
  // the main screen seats it inline, `rows` asking for all the height the layout spares.
  on('ui.open', { id: PANE }, async ($, e, next) => {
    if (!(await read($, shelf)).series) await loadReader($)
    const { series } = await read($, shelf)
    return next({
      ...e,
      title: series ? `Manga: ${series}` : 'Manga',
      closeOnEscape: true,
      rows: 200,
      columns: e.columns ?? dockColumns(terminalColumns),
    })
  })

  // The matcher keeps this off board.tsx's bare session.start (a repeat throws); a pane needs a person anyway.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.command.register({
      name: 'manga',
      description: 'Read manga in a side pane while Claude works',
      argumentHint: '[series]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'manga' }, async ($, e) => {
    noteTerminalColumns(e.presentation.columns)
    const loaded = await loadReader($, e.args.trim())
    if (!loaded.ok) return { text: loaded.text }

    askedFor = undefined
    const opened = await $.ui.open({ id: PANE, focus: true })
    const where = opened.isPlaced ? '' : ` (pane waits: ${opened.reason})`
    const tip = e.presentation.isFullscreen ? '' : ' Tip: /tui fullscreen docks the reader beside the chat.'
    return { text: `${loaded.text} Keys: j/k page, h/l chapter, o office tab, Tab switches tabs, Esc closes.${where}${tip}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Image = 'Image' in els ? els.Image : undefined // terminal only
    const { series, chapters, pages, dir, ready, loading } = await read($, shelf)
    const c = await read($, chapter)
    const p = await read($, page)
    const file = pages[p]
    const alt = pageAlt(chapters[c], p, pages.length)
    const graphics = await termGraphics($)
    noteTerminalColumns(e.viewport?.columns)

    const controls = (
      <Box gap={1}>
        <Button plain key="prev-ch" label="Prev ch" hotkey="h" onPress={() => jump($, -1)} />
        <Button plain key="prev" label="Prev" hotkey="j" onPress={() => turn($, -1)} />
        <Button plain autoFocus key="next" label="Next" hotkey="k" onPress={() => turn($, 1)} />
        <Button plain key="next-ch" label="Next ch" hotkey="l" onPress={() => jump($, 1)} />
        <Button plain key="office" label="Office" hotkey="o" onPress={() => $.ui.open({ id: 'office', title: 'Office', focus: true })} />
        <Text dimColor>
          {chapters[c] ? `Ch ${chapterLabel(chapters[c])}` : '-'} · {pages.length ? p + 1 : 0}/{pages.length}
        </Text>
        <Text dimColor>Esc closes</Text>
      </Box>
    )

    if (!series) {
      return (
        <Box flexDirection="column">
          {controls}
          <Text dimColor>Run /manga [series] to start. {EMPTY_HINT}</Text>
        </Box>
      )
    }

    // A cbz page waits here until the background job has converted it and written the state.
    if (loading || (file && !ready[p])) {
      return (
        <Box flexDirection="column">
          {controls}
          <Text dimColor>Unpacking ch {chapterLabel(chapters[c])}…</Text>
        </Box>
      )
    }

    if (!file) {
      return (
        <Box flexDirection="column">
          {controls}
          <Text dimColor>No pages in this chapter.</Text>
        </Box>
      )
    }

    // Fit the page inside the pane's own body (not the whole terminal), less the controls row.
    const bodyRows = e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 40) - 6
    const bodyColumns = e.props.bodyColumns || 80
    const { rows, columns } = fitPage(bodyRows, bodyColumns)

    // A docked page held back by the width asks once per size for a dock wide enough to
    // fill the height. A width the person dragged still wins; that ends the asking.
    const wider = e.props.placement === 'dock' && e.viewport ? dockToFill(bodyRows, bodyColumns, e.viewport.columns) : undefined
    const askKey = `${bodyRows}x${e.viewport?.columns}`
    if (wider && askedFor !== askKey) {
      askedFor = askKey
      void $.ui.open({ id: PANE, columns: wider, ...(e.props.isFocused ? { focus: true as const } : {}) })
    }
    const imagePath = `${dir}/${file}`
    const imageExists = file ? await $.fs.exists(imagePath) : false

    return (
      <Box flexDirection="column">
        {controls}
        {Image && imageExists ? (
          <Image
            key="page"
            source={{ file: imagePath, format: 'png' }}
            columns={columns}
            rows={rows}
            alt={alt}
          />
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{alt}</Text>
            {!imageExists && <Text dimColor>file not found: {imagePath}</Text>}
            {!Image && <Text dimColor>Image element unavailable</Text>}
          </Box>
        )}
        {!graphics && <Text dimColor>{noGraphicsHint(await $.session.id())}</Text>}
      </Box>
    )
  })
}
