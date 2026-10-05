# Office redesign: build plan

> **Superseded by `build-plan.md` (2026-10-04).** Kept for the original room sketch and
> renderer notes. The "edit through the symlink" line below applied only to one session's
> hot reload; this folder is the real code.

Turns the `/office` text board into a pixel-art office (Pokémon Gold look) where each
session is a crew member walking between rooms by state. Design decisions are in memory
(`project_office_redesign.md`); this file is the *how*. Written 2026-10-04.

## 1. Constraints that shape everything

| Constraint | Consequence |
| --- | --- |
| Must work in background sessions too (`claude --bg`, a parked `/exit`) | Can't rely on `Image` (Ghostty-only pixels). Draw with **cells**. |
| A dock is ~85 cols × 55 rows | Half-block cells (`▀`, fg = top pixel, bg = bottom) give **~85 × 110 px**. Game Boy is 160 × 144, so this is GB-*ish*: 8×8 tiles and 8×12 sprites. |
| Clicking a crew member is a core interaction | The renderer must report which cell was clicked. |
| `$` can't cross file imports (validator rule) | Pure logic (scene model, sprite data, paths) lives in `$`-free files; only `board.tsx`-style hook files touch `$`. |
| Edits must hot-reload | Edit through `dev-mods/<session>/office/` (the symlink), never the real path. |

## 2. Rendering: three options, decided by a spike

| | How | Clicks | Animation | Risk |
| --- | --- | --- | --- | --- |
| **A. Raster** | `Raster` element, cells packed as base64 u32 triples; `$.ui.blit` repaints | ✗ (Raster has no `onPress` "yet") → keys only | `$.clock` timer in hooks → blit ~8 fps | Low. Lose click-to-select. |
| **B. Client** | A `Client` surface module draws `Text` runs (`▀` with `color` + `backgroundColor`) | ✓ `surface.onPointer` gives cell x/y | `surface.every(125, …)` local frame clock, no `$` round trip | Tree size: 85×55 cells ≈ 1–2k Text runs per frame may exceed bounds or overrun → instance unmounts. |
| **C. Hybrid** | Raster scene + an absolutely positioned, empty `Client` on top as a click layer | ✓ if the overlay is transparent to paint | blit from hooks | Unknown whether an overlaid Client hides the Raster beneath. |

**Spike (phase 0, ~1 hour):** draw a full-dock static room three ways and record: does it
render, does it unmount, frame time at 8 fps, do clicks arrive. Pick the first of
**B → C → A** that passes. A is the guaranteed fallback; clicks can come back when
Raster gains `onPress`.

## 3. Architecture

```
registry (~/.claude/sessions/*.json) ─┐
claude agents --json (bg state)       ├─► sessions.ts / spawn.ts (exists)
office jobs atom (spawned workers)    ┘          │ SessionCard[], Job[]
                                                 ▼
                         scene/model.ts  (pure)  crew[] = { id, role, project, tag, state, room }
                                                 │ state → room → target tile
                         scene/motion.ts (pure)  waypoint paths between rooms, 1 tile/frame
                                                 │ positions per frame
                         scene/paint.ts  (pure)  tiles + sprites → cell grid (Uint32 triples)
                                                 │
                         office-scene.tsx (hooks, or Client module per §2)
                                                 │ click/keys → select → existing message Input
```

Everything above the last box is `$`-free and unit-testable with plain arrays, the same
pattern as `fitPage` / `parseRegistry` today.

## 4. Who is a CEO, who is a worker (from data we already have)

| Signal (exists today) | Role |
| --- | --- |
| registry `kind: "interactive"`, no `parkedJobId` | **CEO** of its project |
| registry `kind: "bg"` not spawned by office | **CEO** (a session you backgrounded) |
| office `Job` with `kind: "worker"` (`bgId` / `sessionId` / `agentId`) | **Worker**, reports to the session that spawned it |
| subagents inside another session | Not visible across sessions today → **phase 5, optional** (would need reading that session's transcript folder) |

**Project** = git toplevel of `cwd` (`repoRoot()` already exists in `board.tsx`); outside a
repo, the cwd. One project → skip the lobby. Several → the lobby shows one door per project.

Open question Q1: two interactive sessions in the same repo: two CEOs in one office, or
one CEO and one "senior dev"?

## 5. State → room (real signals)

Registry `status` takes `busy | idle | waiting | blocked` (seen in the CLI's code);
background agents report `active | blocked | done | failed`.

| Signal | Room | Motion |
| --- | --- | --- |
| `busy` / `active` | Coding corner | walks to a free desk, typing anim (2 frames) |
| `idle` | Break room | walks to couch / coffee |
| `waiting` / `blocked` (needs you) | Meeting room | walks in, `!` bubble blinks |
| worker `done` | Manager office → exit | walks to its CEO, then out the door, then removed |
| worker `failed` | Manager office | stays with a red `✗` bubble until dismissed |
| new session / new worker | Lobby (spawn point) | appears at the door, walks to its room |

"No subtle indicators": every state change is a walk to another room, plus a bubble where
the person must act.

## 6. Layout sketch (one project office, ~10 × 13 tiles of 8 px)

```
┌──────────────┬───────────────┐
│ MANAGER      │ MEETING ROOM  │
│  [desk] CEO  │  [ table  ]   │
├──────┬───────┴───────┬───────┤
│      │ CODING CORNER │       │
│BREAK │ [▣] [▣] [▣]   │       │
│ROOM  │ [▣] [▣] [▣]   │       │
│ ☕ ▭  ├───────────────┘       │
│      │      LOBBY / DOOR ▯   │
└──────┴───────────────────────┘
 name tags under sprites · footer: selected crew + message box
```

The lobby view (several projects) is a hallway of doors, a CEO in front of each with a
2-word tag (from `lastText`). `E` or click on a door enters that office; `Esc` returns.

## 7. Interaction model

| Input | Action |
| --- | --- |
| Click a CEO (or `1`–`9`) | Select: footer shows name, state, last line |
| `m` / click the footer box | Message the selected CEO (reuses `message_session` and its approval) |
| `E` / click a door (lobby) | Enter that project's office |
| `Esc` | Back to lobby (or close at top level) |
| `[` / `]` | Previous / next project office (like chapters in `/manga`) |
| Workers | Visible, never selectable (design rule: only CEOs are interactive) |

## 8. Phases (each one shippable, each with tests)

| # | Deliverable | Done when |
| --- | --- | --- |
| 0 | Spike §2 | Renderer chosen, numbers written into this file |
| 1 | Static office: tiles + one sprite per real session, placed in its state's room | `/office` shows it; `model.ts` and `paint.ts` unit tests pass |
| 2 | Selection + messaging (keys, then clicks if §2 allows) | Can message a CEO from the scene |
| 3 | Motion: waypoint walks on state change, 2-frame idle/typing | No frame over budget at 8 fps |
| 4 | Lobby + per-project offices, `E` / `Esc` / `[` `]` | Two repos open → lobby; one → straight in |
| 5 | Workers: spawned jobs walk in, report, clock out | A `/spawn` worker appears and exits on done |
| 6 | Text board stays as `/office text` (fallback, and for narrow terminals) | |

## 9. Open questions for you

- **Q1** Same-repo sessions: two CEOs, or a hierarchy?
- **Q2** Sprite art: hand-draw 8×12 sprites (I can author them as string grids), or do you want to draw them?
- **Q3** Palette: true GB-green 4 shades, or Gold/Silver color?
- **Q4** Should the scene replace `/office` by default, with the text board behind a flag, or the other way round until phase 3?
