# Office: orchestration + pixel office — build plan

Written 2026-10-04 on Fable 5.1 (xhigh). Supersedes `redesign-plan.md`.
~~Status: waiting for your approval. Nothing in this plan is built yet~~ (superseded by the status below).
Revised 2026-10-04 after your review: two-level budget guard, bigger scene, build ceilings, labels explained.

## Status, 2026-10-05

Checked against the code in `mod/hooks`. The rest of this document is the original plan, kept as history.

| Plan item | Status |
| --- | --- |
| Office scene with walking characters, drawn in depth order | Built, tested |
| Activities shown from each session's last tool | Built, tested |
| Chat window for the selected session | Built |
| Text board (`t`) | Built |
| Manager role (`/office manage`) and project notebook (`post_note` / `read_notes`) | Built, tested |
| Router with rules / Claude / Jev backends | Built, tested |
| `/route-eval` and `evals/routing.jsonl` | Built, tested; never run, so no accuracy numbers yet |
| Budget guard (soft and hard lines) | Built, tested |
| `/spawn` workers in `bg`, `headless` and `subagent` modes | Built, tested |
| Codex review (`/codex-review`) | Built; an agent's `codex_review` rounds are capped per branch (§3.5, 2026-10-08) |
| Worker git worktrees (option `workerWorktree`) | Partly built, in progress on `feat/worker-worktrees` |
| Every subagent of a conversation drawn as a character | Partly built, in progress on `feat/worker-worktrees` |
| Lobby view with one door per project | Not built; only a fallback lobby room (`h`/`l` switch offices) |
| `z` size key (§5.5) | Not built |
| Clicking sprites in the picture | Not built; crew list rows below the picture are clickable |
| Manager walking to desks when delegating | Not built |
| Per-job usage deltas (§3.4) | Not built; `costUsd` is parsed in `spawn.ts` but never stored |

## 0. Goal and what "done" means

One command center inside Claude Code for all your coding agents.

| Goal | Done when |
| --- | --- |
| **See** every session and worker | `/office` shows each one as a crew member in the room for its state |
| **Steer** | You can message any lead; a manager session can run a project for you |
| **Route** | Every delegated task gets a model + effort decision, and you have a measured accuracy number for the router |
| **Stay inside your limits** | Spawning stops by itself near your 5-hour / weekly ceilings |
| **Enjoy it** | The office is animated pixel art, not a text list |

## 1. Decisions I made for you (veto any of them)

| # | Decision | Why |
| --- | --- | --- |
| D1 | Build in the Claude Code office mod, not T3 Code | Routing, spawning and messaging already exist here. Core logic stays free of plugin calls so it can move to a T3 Code fork later. |
| D2 | Jev later | Router already falls back Jev → Claude → rules. We measure the fallback now; Jev gets the same test the day your key exists. No code change needed then. |
| D3 | A **manager** is a role you assign with `/office manage`, one per project | Explicit beats guessing. Other sessions in that repo become senior devs who report to it. |
| D4 | Sessions share context through a **project notebook**, not by reading each other's transcripts | Small, cheap, and auditable. |
| D5 | Budget limits are enforced **in code** at spawn time, at two levels: from 80% (5-hour) / 85% (week) only small tasks start, at 95% nothing does | A prompt asking an agent to be careful is not a limit. Your call on the numbers. |
| D6 | Sprites are **original characters** in an 8-bit handheld-RPG style, full color (16-color palette) | The look you asked for, without copying any game's actual characters or tiles. |
| D7 | `/office` opens the scene once the still scene passes a live check; `t` toggles the text board; narrow panes fall back to text | The text board keeps working throughout. |
| D8 | Same repo, no manager assigned → both sessions are CEOs sharing one office | Matches how you work today. |
| D9 | The office tab opens wide (~62% of the terminal) with a `z` key to change size | Characters must be readable without straining (§5.5). |

## 2. Architecture

```
 ~/.claude/sessions/*.json ──┐
 claude agents --json        ├─► sessions.ts / spawn.ts (exist) ──► SessionCard[], Job[]
 office jobs (workers)       ┘                                          │
                                                                        ▼
   CORE (pure, no plugin calls, unit-tested, portable)
   ├─ router.ts        (exists)  rules / Claude-reply / Jev-reply parsing
   ├─ evals.ts         (new)     score router decisions against labels
   ├─ budget.ts        (new)     rate limits + caps → allow / refuse
   ├─ manager.ts       (new)     role prompt text, notebook entry format
   └─ scene/           (new)     model.ts  crew, roles, rooms
                                 motion.ts paths, frames
                                 art.ts    tiles + sprites (string grids)
                                 paint.ts  frame buffer
                                 encode.ts frame → terminal cells / PNG
                                                                        │
   SHELL (plugin hooks, the only files that touch `$`)                  ▼
   ├─ board.tsx   (exists)  /office, messaging, usage tool
   ├─ jobs.tsx    (exists)  /spawn, /route-task, codex, workers  + budget guard, /route-eval
   ├─ manage.tsx  (new)     /office manage, notebook tools, prompt sections
   └─ scene.tsx   (new)     draws the scene, animation timer, selection, clicks
```

Rule from the engine: `$` cannot be passed into an imported function, so everything
testable lives in the core and each shell file keeps its own `$` calls.

## 3. Orchestration

### 3.1 Roles

| Role | Who | You can message it | In the office |
| --- | --- | --- | --- |
| **Manager** | The session where you ran `/office manage` | yes | Manager's office |
| **Lead / senior dev** | Any other session you started (Ghostty or backgrounded) | yes | Desk, break room, meeting room |
| **Worker** | Started by `/spawn` or `spawn_worker` (exists) | no | Walks in, works, reports, leaves |

### 3.2 What the manager does (new)

1. You give it a goal.
2. It splits the goal into tasks.
3. Each task: `route_task` (exists) picks model + effort → `spawn_worker` (exists) or
   `message_session` (exists) to a senior dev.
4. Results come back through the existing delivery path; it posts a note and reports to you.

How it gets the role: a `prompt.compose` hook adds a short manager section to that
session's system prompt (tools, protocol, "check the budget before spawning"). Senior
devs in a managed project get a two-line "report to the manager when done or blocked"
section. Who manages what is kept in the mod's store and cleared when that session ends.

### 3.3 Shared context: the project notebook (new)

- One append-only file per project under `~/.claude/office/notes/`.
- Tools: `post_note` (text + tag), `read_notes` (last n).
- The last few entries are added to every lead's prompt in that project, marked as
  information, not instructions.
- Workers cannot post (same reasoning as the existing rule that workers cannot message
  sessions: a hijacked worker must not be able to steer your leads).

### 3.4 Budget guard (new; `session_usage` tool exists as of tonight)

Two lines per window, checked in code wherever a worker or Codex job starts, next to the
existing `maxWorkers` check (and `maxOpusWorkers`, a separate cap on workers running on Opus-tier models):

| Usage | What happens |
| --- | --- |
| Below the soft line (5-hour < 80%, week < 85%) | Everything is allowed |
| Between soft and hard | The router sizes the task. **Small** tasks start; larger ones are refused with the reason and the reset time |
| At the hard line (95% of either window) | Nothing new starts. A `/spawn --force` typed by you is the only override |

- **Small** = the router picked Haiku (any effort) or Sonnet at low or medium effort.
- Jev makes this call once your key exists. It runs outside your Claude limits, so sizing
  a task near the cap costs you nothing. Until then the Claude → rules fallback decides.
- Each finished job records how far the 5-hour figure moved, by model and effort. A later
  version can then predict "this task would take you past 95%" from your own
  measurements, replacing the fixed size classes.
- A `/spawn` you type with an explicit `--model` is allowed in the soft zone with a
  warning; spawns started by an agent follow the table.
- Settings: `budgetSoftFiveHourPct` (80), `budgetSoftSevenDayPct` (85), `budgetHardPct` (95).
- Shown in the scene footer as two bars.

### 3.5 Codex review rounds (built 2026-10-08)

Managers re-ran `codex_review` on the same branch until no P1/P2 was left; each full Sol
review of a branch costs ~4% of the ChatGPT plan's 5-hour Codex limit. The rules are now in
code (`codex-rounds.ts`, wired in `jobs.tsx`):

| Call | What runs |
| --- | --- |
| Round 1 of a branch | A full review on `codexReviewModel` (Sol), as before |
| A later round, no target | Only the changes since the last reviewed commit, on `codexRereviewModel` (Luna, effort medium), told the earlier rounds' findings: check each is fixed, look for problems the fixes added |
| A later round after a rebase, more than `codexRereviewMaxLines` (400) changed lines or `full: true` | A full re-review of the whole branch scope, still on Luna, told the earlier rounds' findings; still a round |
| A later round with an explicit target | That target as given, on Luna, told the earlier findings |
| Same HEAD as the last round, clean tree | Refused: nothing new |
| `codexMaxRounds` (3) rounds already | Refused: the manager summarises the open findings and asks you |

- The ledger lives in `$.store` (`codexRounds`), keyed by the repo's git common dir and the
  branch: each round's HEAD, base, model, job id, time, and its final text (first 4 KB) once
  done. A failed or killed round is dropped; rounds older than 14 days are pruned. Writes take
  their own cross-session flock (`codex-rounds.lock`), as the capacity lock does.
- **Sol only for a branch's first round.** Every later round, including yours (`/codex-review`)
  and a full re-review, runs on Luna. Exceptions: `deep` (the deep model, only when you ask) and
  your own `--model` keep their model on every round (`roundTiers`). Luna "has context" from the
  earlier rounds' findings in its instructions (the last 3, 4 KB each); the first Codex session is
  not resumed, as that re-reads the whole first review and costs more. There is no cap on full
  reviews per window.
- **Codex out of usage:** a codex run failing on "usage limit", "rate limit" or "hit your limit"
  (`isUsageLimit`), and a budget-guard refusal, add a fallback to the result: run an Opus review via
  a subagent; it is a same-model-family review with lower trust (Claude also wrote the code), so
  verify each finding, a clean one is no evidence the branch is correct, and the PR description
  says "reviewed by Opus (Codex out of usage), not independent".
- Your `/codex-review` is never refused by the round cap and runs as typed (`--force` still passes the budget
  guard); it is recorded, so it counts toward an agent's cap.
- **Usage alerts** (`usageAlertPct`, 90; 0 = off): when your Claude or Codex 5-hour or weekly window
  reaches that percent, you get one toast, `Usage alert: <Claude|Codex> <5-hour|weekly> window at N%
  (resets <local time>).`, and the same line leads that session's next `session_usage`,
  `spawn_worker` or `codex_review` result so a manager relays it. Once per window per reset, across
  sessions: the first to write the `$.store` key `usageAlert:<provider>:<window>:<reset>` (under the
  `usage-alerts` flock) shows it; workers never alert. Claude's windows are checked where the plugin
  already reads them (`session.measure`, `session_usage`, the spawn budget guard); Codex's only on the
  live read the Codex budget guard already makes. The budget guards (80% / 95%) are unchanged.
- The job title and the start message show the round: `codex re-review 2/3 vs a1b2c3d (luna)`.

## 4. Routing

**Today (exists):** `auto` tries Jev (skipped, no key) → Claude (`routerModel`, a small
low-effort call) → rules (regex, instant). Effort from the router never exceeds high.
Routed tiers (since 2026-10-07): Haiku 5.5 (basic), Sonnet 5.5 (medium), Opus 5.5 (high-level). Fable runs only when named.

**New: the routing test.**

| Piece | What |
| --- | --- |
| `evals/routing.jsonl` | ~30 tasks, each with the model and effort **you** would pick, and one line of why |
| `evals.ts` | Scores decisions against labels: exact match, model match, within one tier, over-routing (paid more than needed), under-routing (quality risk), latency |
| `/route-eval [rules\|claude\|jev\|all]` | Runs the set through a backend, prints the table, saves the result with a date |

**What a label is.** One label = your answer for one task: the model and effort you
would pick if you were choosing by hand. The router's pick is compared against it.

| Example task | Example label | Why |
| --- | --- | --- |
| Rename `user_id` to `account_id` across three files | Haiku · low | Mechanical |
| Summarize this 200-line error log | Haiku · low | Reading, no judgment |
| Find why the incremental dbt model double-counts late-arriving rows | Opus · high | Real debugging |
| Design the schema and migration plan for multi-tenant billing | Opus · high | Architecture; expensive if wrong |

About 30 of these, spread across easy, medium and hard, is enough to tell a router that
agrees with you 60% of the time from one that agrees 90%. The soft budget zone (§3.4)
depends on the router, so this number tells you whether to trust it there.

- Rules cost nothing to score; the Claude backend is ~30 tiny calls.
- When your Jev key exists: add it to Keychain, run `/route-eval jev`, compare. That
  before/after table is the result worth showing in an interview.
- During this build I'll also log what the router would have picked for each agent task
  next to what I picked. That's free extra test data; I won't let it choose yet.

## 5. The office UI

### 5.1 What the engine allows (checked in the API)

| Element | Gives | Limits |
| --- | --- | --- |
| `Raster` | Grid of colored cells, repainted at frame rate; works in every terminal session | No clicks. Half-block cells ≈ 100 × 80 "pixels" in your dock |
| `Image` | Real pixels (true Game Boy resolution and beyond) | Only when the session draws directly in Ghostty (not background sessions). No clicks |
| `Client` | Clicks with cell coordinates, own frame clock, keys | Draws text only; capped at 100,000 serialized characters, too small for a full detailed scene |
| `Button` | Clickable, can be positioned over other elements | Paints its own label |

### 5.2 Drawing test first (phase 2 decides two things)

| Question | Options, in order of preference |
| --- | --- |
| **Resolution** | **HI:** 208 × 160 px, 16-px tiles, via `Image`, if it is crisp and holds ~6 fps. Background sessions then get the same frame halved onto `Raster`. **LO:** if HI fails, 8-px art drawn natively for `Raster` (104 × 80). |
| **Clicks** | (1) Name tags under each sprite are `Button`s placed over the scene → click a tag to select. (2) An empty `Client` layered on top, if it doesn't hide the scene. (3) Keys only. |

One tile map (13 × 10 tiles) and one art set either way. The test needs you looking at
the pane in a Ghostty-direct session and telling me "crisp" or "blurry".

### 5.2.1 Drawing test results (2026-10-04, Ghostty-direct session)

| Finding | Decision |
| --- | --- |
| Picture x4 (we upscale, nearest-neighbour) is sharp; picture x1 is blurred by the terminal's own smoothing | Always draw through `Image`, upscaled by us by a whole number. Never let the terminal scale. |
| Cells: 15 frames/s (target 8), but half resolution loses one-pixel detail | Cells are only the fallback for background sessions |
| `[tag]` Button draws over the picture in every view | Overlay works visually; click not yet confirmed |
| The person's verdict on the look: "goofy, like a child drew it" | Test-card figures were placeholders, but the art needs a real Game Boy Color method (§5.6) |

### 5.6 Art direction (Game Boy Color rules, as Gold/Silver/Crystal use them)

- Native canvas 160 × 144 (10 × 9 metatiles of 16 px), scaled ×4 or ×5 by us.
- 8 × 8 tiles grouped into 16 × 16 metatiles; every tile uses one 4-color palette (8 background palettes).
- Characters: 16 × 16 overworld sprites, 3 colors + transparent, dark outline, big head (about half the height),
  4 directions (right is mirrored left), 2-frame walk.
- 3/4 top-down view: walls show their front face, furniture has a lit top and a shaded front, light from above.
- Floors and walls are quiet patterns; detail goes on furniture so crew stand out.
- Original art only: the style, not Pokémon's tiles or characters.
- Source: a vetted CC0 / CC-BY Game Boy-style interior pack if one fits, else authored to these rules; a contact
  sheet is approved by the person before anything is wired in.

 (signals that exist today)

| Signal | Room | What you see |
| --- | --- | --- |
| `busy` / worker `active` | Coding corner | Walks to a free desk, typing |
| `idle` | Break room | Couch or coffee |
| `waiting` / `blocked` (needs you) | Meeting room | `!` bubble blinking |
| Manager | Manager's office | At the big desk when idle; visits desks when delegating |
| Worker `done` | Manager's office → door | Reports, walks out, removed |
| Worker `failed` | Manager's office | Red `✗` bubble until dismissed |
| New session / worker | Lobby door | Appears, walks to its room |

Several projects → a lobby with one door per project; one project → straight into its office.

### 5.4 Controls

| Input | Action |
| --- | --- |
| `1`–`9`, `j`/`k`, or click a name tag | Select a lead; footer shows name, state, last line |
| `m` | Message the selected lead (existing approval rules apply) |
| `e` / `Esc` | Enter a project office from the lobby / go back |
| `[` `]` | Previous / next project |
| `t` | Toggle the text board |
| `b`, `Tab` | Manga tab, switch tabs (exist) |

Workers are visible and never selectable.

### 5.5 Size on screen

- **Opens wide.** The office tab asks for ~62% of the terminal (about 130 of your 213
  columns). Each character is then about 10 columns wide and 5 rows tall, up from about
  7 columns at the reader's 45%.
- **`z` changes size:** side (45%) → big (62%) → max (the chat narrows to ~40 columns).
- **Text stays text.** Names, states and usage bars are normal terminal text at your font
  size. Nothing you need to read is drawn in a pixel font.
- **Comfort check in the drawing test.** If characters still look small to you, the map
  drops from 13 × 10 to 11 × 8 tiles (each tile ~18% larger) before any art is drawn.
- A dock width you dragged still wins over the request (engine rule); `Ctrl+X` `←` widens it.
- The `Raster` fallback for background sessions cannot enlarge its pixels on this screen;
  it shows the same map at 8 columns per tile.

## 6. Build

### 6.1 Phases

| # | Phase | Who | Exit check |
| --- | --- | --- | --- |
| 0 | `git init`, `.gitignore`, first commit; remove `.DS_Store`. (Old `waiting-room` mod already moved to the Trash, 2026-10-04.) | me | Clean `git status` |
| 1 | Contracts: types and function signatures for every new core file | me | `tsc` clean |
| 2 | Drawing test (§5.2) | me + you | Resolution and click method written into this file |
| 3 | Core modules in parallel (§6.2) | 6 agents | Each module's tests pass in its own copy |
| 4 | Integration: `scene.tsx`, `manage.tsx`, `/route-eval`, budget guard, wiring into `/office` | me | All tests, `tsc`, `claude plugin validate` |
| 5 | Review: 3 reviewers on the diff, each finding verified before I fix it | 3 agents + me | No confirmed findings left |
| 6 | Live check in Ghostty with you; first `/route-eval rules` and `claude` numbers | you + me | You say it works |

Shippable order if the budget runs short: git → routing test → budget guard → manager +
notebook → still scene → select/message → walking → lobby → workers in the scene.

### 6.2 The parallel agents (phase 3), each in its own git worktree, disjoint files

| Agent | Writes | Model |
| --- | --- | --- |
| scene-model | `scene/model.ts` + tests: roles, projects, state → room, seat assignment | Sonnet |
| paint | `scene/paint.ts`, `scene/encode.ts` + tests: frame buffer, cells, PNG | Opus |
| art | `scene/art.ts`: tile map, ~12 tiles, 3 base sprites × 5 frames, palette; a contact-sheet PNG for you to look at | Opus |
| motion | `scene/motion.ts` + tests: walk paths between rooms, frame stepping | Sonnet |
| evals | `evals.ts` + tests; draft `evals/routing.jsonl` (generic tasks, none of your real prompts) | Sonnet |
| orchestration | `budget.ts`, `manager.ts` + tests: budget verdict, role prompt, notebook format | Sonnet |

Total: 6 builders + 3 reviewers = 9 agents (your workflow guideline is under 10).

### 6.3 Budget for the build

Measured just now: this session's context 23%; 5-hour window 4% used; week 14% used
(resets Oct 8).

- **Estimate (rough):** about 2 million tokens across all agents, in the region of
  10–15% of a 5-hour window and a few points of the week. I can't predict it exactly.
- **Guard:** I read `session_usage` before phases 3, 4 and 5 and stop launching agents at
  80% of the 5-hour window or 85% of the week, the same soft lines as §3.4.
- Builders run at high effort at most.

## 7. Risks

| Risk | Handling |
| --- | --- |
| The plugin API is beta and may change | Core is plain TypeScript with tests; only the four shell files depend on the API |
| `Image` scaling is blurry or slow | LO path on `Raster` (§5.2) |
| Clicking sprites directly isn't possible | Name-tag buttons or keys |
| Subagents inside other sessions are invisible across sessions | Out of scope; only office-spawned workers appear |
| A manager spawning too much | Budget guard + existing `maxWorkers` (4) + `maxOpusWorkers` (Opus-tier workers at once; 0, the default, sets no separate limit) + job timeout (30 min) |
| Router quality unproven | It only advises until the routing test shows a number you accept |

## 8. What I need from you

1. **Routing labels:** I draft 30 tasks with labels and you correct them (~15 min), or you write the labels yourself.
2. **Approval to start**, and any veto on §1.
