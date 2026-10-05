import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { cachePath, fitPage, graphicsLikely, sipsArgv, unzipArgv } from './manga'

const HOME = '/Users/aatrey'
const ROOT = `${HOME}/Manga`
type Entry = { name: string; kind: 'dir' | 'file'; size: number; mtimeMs: number; isLink: boolean }
const dir = (name: string): Entry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
const png = (name: string): Entry => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

// The test environment has no disk: answer $.fs from a tree of path -> entries.
function fakeDisk(on: On, tree: Record<string, Entry[]>) {
  mock.env(on, { HOME, TERM_PROGRAM: 'ghostty' })
  on('fs.exists', (_$, e) => ({ value: e.path in tree }))
  on('fs.list', (_$, e) => ({ value: tree[e.path] ?? [] }))
}

// Same for $.store, kept readable so a test can assert what was persisted.
function fakeStore(on: On, entries: Record<string, unknown> = {}) {
  const kept = new Map(Object.entries(entries))
  on('store.get', (_$, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_$, e) => {
    kept.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  return kept
}

const DISK = {
  [ROOT]: [dir('Kingdom'), dir('Berserk')],
  [`${ROOT}/Kingdom`]: [dir('10'), dir('2'), dir('1')],
  [`${ROOT}/Kingdom/1`]: [png('2.png'), png('10.png'), png('1.png')],
  [`${ROOT}/Kingdom/2`]: [png('1.png'), png('2.png')],
  [`${ROOT}/Kingdom/10`]: [png('1.png')],
  [`${ROOT}/Berserk`]: [dir('1')],
  [`${ROOT}/Berserk/1`]: [png('1.png')],
}

// The pane's placement is the surface's; record what the plugin asked for.
// `up` seeds panes already open (the office board), so a test can watch the reader close them.
function fakePanes(on: On, up: string[] = []) {
  const opened: { id: string; title?: string; focus?: true; closeOnEscape?: true; holdToasts?: true }[] = []
  const live = new Set(up)
  on('ui.open', (_$, e) => {
    opened.push(e)
    live.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({
    value: [...live].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.close', (_$, e) => {
    live.delete(e.id)
    return { value: undefined }
  })
  return Object.assign(opened, { live })
}

describe('/manga pane', () => {

  test('/manga leaves the office board open beside it as a tab', async ($, on) => {
    fakeStore(on)
    const opened = fakePanes(on, ['office'])
    fakeDisk(on, DISK)
    await $.command.run({ command: 'manga', args: '', ...RUN })
    expect([...opened.live].sort()).toEqual(['manga', 'office'])
  })

  test('any open of the reader keeps Esc-to-close and the title (each open resets them)', async ($, on) => {
    fakeStore(on)
    const opened = fakePanes(on)
    fakeDisk(on, DISK)
    await $.command.run({ command: 'manga', args: 'kingdom', ...RUN })
    // A narrow dock: the render asks for a wider one, by id and columns alone.
    const ui = await $.ui.mount({
      plugin: 'office',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'manga',
      props: {
        title: 'Manga: Kingdom',
        isFocused: false,
        bodyColumns: 40,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 50 },
        view: {},
      },
      viewport: { columns: 200, rows: 60 },
    })
    await ui.find({ type: 'Text', text: /Esc closes/ })
    expect(opened[1]).toMatchObject({ id: 'manga', title: 'Manga: Kingdom', closeOnEscape: true, columns: 74 })
    expect(opened[1]?.focus).toBeUndefined()
    await ui.unmount()
  })

  test('draws, pages and rolls over on the terminal', async ($, on) => {
    const store = fakeStore(on)
    const opened = fakePanes(on)
    fakeDisk(on, DISK)
    await $.command.run({ command: 'manga', args: 'kingdom', ...RUN })
    expect(store.get('position')).toEqual({ series: 'Kingdom', chapter: '1', page: 0 })
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ id: 'manga', focus: true, closeOnEscape: true })
    expect(opened[0]?.holdToasts).toBeUndefined()

    const ui = await $.ui.mount({
      plugin: 'office',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'manga',
      props: {
        title: 'Manga: Kingdom',
        isFocused: true,
        bodyColumns: 80,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
      viewport: { columns: 100, rows: 40 },
    })
    expect(await ui.find({ type: 'Text', text: /1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Esc closes/ })).toBeDefined()

    await ui.press({ key: 'next' })
    await ui.press({ key: 'next' })
    expect(store.get('position')).toEqual({ series: 'Kingdom', chapter: '1', page: 2 })
    await ui.press({ key: 'next' })
    expect(store.get('position')).toEqual({ series: 'Kingdom', chapter: '2', page: 0 })
    await ui.press({ key: 'prev' })
    expect(store.get('position')).toEqual({ series: 'Kingdom', chapter: '1', page: 2 })
    await ui.press({ key: 'next-ch' })
    expect(store.get('position')).toEqual({ series: 'Kingdom', chapter: '2', page: 0 })
    await ui.unmount()
  })

  test('no series arg resumes the last one read', async ($, on) => {
    fakeStore(on, { position: { series: 'Berserk', chapter: '1', page: 0 } })
    fakePanes(on)
    fakeDisk(on, DISK)
    const ran = await $.command.run({ command: 'manga', args: '', ...RUN })
    expect(ran).toMatchObject({ text: expect.stringContaining('Berserk') })
    const missing = await $.command.run({ command: 'manga', args: 'Nope', ...RUN })
    expect(missing).toMatchObject({ text: expect.stringContaining('No series "Nope"') })
  })
})

// ── cbz chapters ─────────────────────────────────────────────────────────
const CACHE = `${HOME}/Library/Caches/office-manga`
const MARKER = '.office-manga.json'
const cbzName = (n: number) => `chapters8-10${n}000kingdom-chapter-${n}.cbz`
const SIZE = 4242
const MTIME = 1700000000000
const PANE_PROPS = {
  title: 'Manga: Kingdom',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

describe('graphics detection', () => {
  test('Ghostty, kitty, iTerm2 and WezTerm count; the background host does not', () => {
    expect(graphicsLikely('ghostty', 'xterm-ghostty')).toBe(true)
    expect(graphicsLikely(undefined, 'xterm-kitty')).toBe(true)
    expect(graphicsLikely('iTerm.app', 'xterm-256color')).toBe(true)
    expect(graphicsLikely(undefined, 'xterm-256color', '7')).toBe(true)
    // a claude --bg session: the daemon's pty host, no TERM_PROGRAM
    expect(graphicsLikely(undefined, 'xterm-256color')).toBe(false)
  })
})

describe('page sizing', () => {
  test('a tall docked pane is limited by its width, keeping the page aspect', () => {
    // dock 90 cols x 60 rows: height-bound; 80 rows would need 119 cols, so width-bound
    expect(fitPage(60, 90)).toEqual({ rows: 59, columns: 89 })
    expect(fitPage(80, 90)).toEqual({ rows: 60, columns: 90 })
  })
})

// A disk the fake `unzip`, `mv` and `rm` change: unzipped dirs exist, converted pages exist, written texts read back.
type World = {
  markers?: Record<string, unknown>
  realOf?: Record<string, string>
  cacheDirs?: Record<string, Entry[]>
  alwaysDirs?: Record<string, Entry[]> // on disk before and after, like the cache's per-series folder
  preexisting?: boolean // cache dirs are already on disk
}

function fakeCbzWorld(on: On, opts: World = {}) {
  mock.env(on, { HOME, TERM_PROGRAM: 'ghostty' })
  const unzipped = new Set<string>()
  const made = new Set<string>()
  const texts = new Map<string, string>(Object.entries(opts.markers ?? {}).map(([d, m]) => [`${d}/${MARKER}`, JSON.stringify(m)]))
  const calls: string[][] = []
  const jpgs = [png('10.jpg'), png('2.jpg'), png('1.jpg'), png('ComicInfo.xml')]
  const cacheDirs: Record<string, Entry[]> = {
    [cachePath(CACHE, 'Kingdom', cbzName(458))]: jpgs,
    [cachePath(CACHE, 'Kingdom', cbzName(459))]: jpgs,
    ...opts.cacheDirs,
  }
  const tree: Record<string, Entry[]> = {
    [ROOT]: [dir('Kingdom')],
    [`${ROOT}/Kingdom`]: [png(cbzName(459)), png(cbzName(458))],
    [CACHE]: [dir('Kingdom')],
    ...opts.alwaysDirs,
  }
  const present = (path: string) => !!opts.preexisting || unzipped.has(path)
  on('fs.exists', (_$, e) => ({
    value: e.path in tree || (e.path in cacheDirs && present(e.path)) || made.has(e.path) || texts.has(e.path),
  }))
  on('fs.list', (_$, e) => ({ value: tree[e.path] ?? (present(e.path) ? cacheDirs[e.path] : undefined) ?? [] }))
  on('fs.read', (_$, e) => {
    const text = texts.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    texts.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => ({
    value: {
      kind: e.path.endsWith('.cbz') ? ('file' as const) : ('dir' as const),
      size: SIZE,
      mtimeMs: MTIME,
      isLink: false,
      realPath: e.resolve ? (opts.realOf?.[e.path] ?? e.path) : undefined,
    },
  }))
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    if (e.argv[0] === 'unzip') unzipped.add(e.argv[6] ?? '')
    if (e.argv[0] === 'mv') made.add(e.argv[3] ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { calls, texts }
}

const DIR458 = cachePath(CACHE, 'Kingdom', cbzName(458))
const DIR459 = cachePath(CACHE, 'Kingdom', cbzName(459))
const CBZ458 = `${ROOT}/Kingdom/${cbzName(458)}`
const MISSING = { series: 'Kingdom', chapter: 'ch-000-gone', page: 7 } // the old test folder, deleted

async function openKingdom($: Engine, args = 'Kingdom') {
  return $.command.run({ command: 'manga', args, ...RUN })
}

async function mountKingdom($: Engine) {
  return $.ui.mount({
    plugin: 'office',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'manga',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 40 },
  })
}

const sipsCalls = (calls: string[][]) => calls.filter(c => c[0] === 'sips')

describe('/manga with cbz chapters', () => {
  test('a missing saved chapter clamps to the first; unzip, then only the page being read, then the rest', async ($, on) => {
    const store = fakeStore(on, { position: MISSING })
    fakePanes(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    const { calls, texts } = fakeCbzWorld(on)

    const ran = await openKingdom($)
    expect(ran).toMatchObject({ text: expect.stringContaining('Ch 458') })
    expect(store.get('position')).toEqual({ series: 'Kingdom', chapter: cbzName(458), page: 0 })
    // unzip -d makes only the last segment, so the cache dir is created first
    expect(calls[0]).toEqual(['mkdir', '-p', DIR458])
    expect(calls[1]).toEqual(unzipArgv(CBZ458, DIR458))
    // Only page 1 (001 = "1.jpg") is converted before the pane draws; temp name, then renamed.
    expect(sipsCalls(calls)).toEqual([sipsArgv(`${DIR458}/1.jpg`, `${DIR458}/.1.png.part.png`)])
    expect(calls).toContainEqual(['mv', '-f', `${DIR458}/.1.png.part.png`, `${DIR458}/1.png`])
    expect(JSON.parse(texts.get(`${DIR458}/${MARKER}`) ?? '{}')).toEqual({ size: SIZE, mtimeMs: MTIME, openedAt: 1_000_000 })

    const ui = await mountKingdom($)
    expect(await ui.find({ type: 'Text', text: /Ch 458 · 1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Image' })).toBeDefined()

    // Page 2 is not converted yet: the pane says so instead of drawing an Image.
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /Unpacking ch 458…/ })).toBeDefined()
    expect(await ui.find({ type: 'Image' })).toBeUndefined()

    await clock.advance(0) // the background job writes state; the pane redraws
    expect(sipsCalls(calls).map(c => c[4]).filter(f => f?.startsWith(DIR458))).toEqual([`${DIR458}/1.jpg`, `${DIR458}/2.jpg`, `${DIR458}/10.jpg`])
    expect(await ui.find({ type: 'Image' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Unpacking/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a matching marker reuses the cache: no unzip, no delete', async ($, on) => {
    fakeStore(on)
    fakePanes(on)
    mock.clock(on, { now: 1_000_000 })
    const { calls, texts } = fakeCbzWorld(on, { preexisting: true, markers: { [DIR458]: { size: SIZE, mtimeMs: MTIME, openedAt: 5 } } })
    await openKingdom($)
    expect(calls.some(c => c[0] === 'unzip' || c[0] === 'rm')).toBe(false)
    expect(JSON.parse(texts.get(`${DIR458}/${MARKER}`) ?? '{}').openedAt).toBe(1_000_000) // reopening refreshes recency
  })

  test('a changed archive size drops the cache and extracts again', async ($, on) => {
    fakeStore(on)
    fakePanes(on)
    mock.clock(on, { now: 1_000_000 })
    const { calls } = fakeCbzWorld(on, { preexisting: true, markers: { [DIR458]: { size: SIZE + 1, mtimeMs: MTIME, openedAt: 5 } } })
    await openKingdom($)
    expect(calls[0]).toEqual(['rm', '-rf', '--', DIR458])
    expect(calls[1]).toEqual(['mkdir', '-p', DIR458])
    expect(calls[2]).toEqual(unzipArgv(CBZ458, DIR458))
  })

  test('near the end of a chapter the next one unpacks in the background', async ($, on) => {
    fakeStore(on)
    fakePanes(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    const { calls } = fakeCbzWorld(on)
    await openKingdom($)
    expect(calls.filter(c => c[0] === 'unzip')).toHaveLength(1) // 3 pages: already within the last 3, but nothing runs before the timer
    await clock.advance(0)
    expect(calls).toContainEqual(unzipArgv(`${ROOT}/Kingdom/${cbzName(459)}`, DIR459))
    expect(sipsCalls(calls).some(c => c[4] === `${DIR459}/1.jpg`)).toBe(true)
  })

  test('the cap deletes the oldest cache dirs, and only ones that resolve inside the cache root', async ($, on) => {
    fakeStore(on)
    fakePanes(on)
    const clock = mock.clock(on, { now: 1_000_000 })
    const base = `${CACHE}/Kingdom`
    const old = Array.from({ length: 14 }, (_, i) => `old-${i + 1}`)
    const { calls } = fakeCbzWorld(on, {
      markers: Object.fromEntries(old.map((n, i) => [`${base}/${n}`, { size: 1, mtimeMs: 1, openedAt: i + 1 }])),
      realOf: { [`${base}/old-1`]: '/Users/aatrey/Documents/old-1' }, // a link out of the cache
      alwaysDirs: { [base]: [...old.map(dir), dir(DIR458.split('/').pop() ?? '')] },
    })
    await openKingdom($)
    await clock.advance(0)
    const removed = new Set(calls.filter(c => c[0] === 'rm').map(c => c[3]))
    expect(removed).toEqual(new Set([`${base}/old-2`, `${base}/old-3`])) // old-1 is oldest but resolves outside: refused
    expect(calls.some(c => c.includes('/Users/aatrey/Documents/old-1'))).toBe(false)
    for (const c of calls.filter(c => c[0] === 'rm')) expect(c[3]?.startsWith(`${CACHE}/`)).toBe(true)
  })
})
