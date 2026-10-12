import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Flow, Seen, Shown, Tag } from '../types'

const TICK_MS = 10_000
const BEAT_MS = 30_000
const POLL_MS = 5_000
// A session that missed three beats is taken for dead: its file is skipped.
const STALE_MS = 90_000
const MINUTE_MS = 60_000
const LINE_CHARS = 160
// A session that finished calls for the person this long; then its color goes
// and it stays where it stood, with how long ago it ended.
const DONE_CALL_MIN = 5
// How a session reads on the board, in the order the rows stand: the ones that
// need an answer, the ones that broke off, the ones that finished, the ones at
// work, the ones that wait for another session, the ones not begun.
// A color behind the word is a call for the person. One at work has its word
// in the color the engine draws its own work in, with nothing behind it.
const ROWS: Record<Exclude<Shown, 'gone'>, { color?: 'warning' | 'success'; ink?: string }> = {
  asking: { color: 'warning' },
  permit: { color: 'warning' },
  failed: { color: 'warning' },
  done: { color: 'success' },
  working: { ink: 'claude' },
  waiting: {},
  idle: {},
}
const ORDER = Object.keys(ROWS)
const TIME_CELLS = 5
const GAPS = 3
const BAR_CELLS = 18

// The words of an answer that only tells the session to go on.
const GO_ON: ReadonlySet<string> = new Set(
  'ok okay k y yes yep yeah sure go on ahead continue proceed next do it keep going carry please then now thanks thank you ty'.split(' '),
)

// What the board says, in the language the person set (`language`). The words
// for how a session stands are short: they stand in a column of their own.
const TEXTS = {
  en: {
    words: { asking: 'ask', permit: 'approve', failed: 'error', done: 'done', working: 'work', waiting: 'wait', idle: 'idle' },
    reasons: { rate_limit: 'usage limit', overloaded: 'overloaded', server_error: 'server error' },
    minutes: (min: number) => `${min}m`,
    now: 'now',
    none: 'no other sessions · /board to hide',
    command: 'Show or hide other Claude Code sessions on this machine above this window\'s prompt',
    shown: 'The session board is on in this window. /board hides it.',
    hidden: 'The session board is off.',
    // an answer made of these words alone (ok, go on, continue) is no new ask
    isBrief: (ask: string) =>
      ask
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(Boolean)
        .every(word => GO_ON.has(word)),
  },
  ko: {
    words: { asking: '질문', permit: '권한', failed: '멎음', done: '끝남', working: '일함', waiting: '기다림', idle: '쉼' },
    reasons: { rate_limit: '사용량 한도', overloaded: '서버 혼잡', server_error: '서버 오류' },
    minutes: (min: number) => `${min}분`,
    now: '방금',
    none: '다른 세션 없음 · /board 로 끈다',
    command: '다른 세션 현황판을 이 창에 켜거나 끈다',
    shown: '세션 현황판을 이 창에 켰다. /board 로 끈다.',
    hidden: '세션 현황판을 껐다.',
    // a few letters (ㅇㅇ, 이어서) are no new ask
    isBrief: (ask: string) => ask.replace(/\s/g, '').length < 6,
  },
} as const

// set as the module registers, from the plugin's options
let text: (typeof TEXTS)[keyof typeof TEXTS] = TEXTS.en

const others = atom({ plugin: 'session-board', key: 'others' } as const, [])
// The board is drawn in the one window the person asked for it in (/board).
const isShown = atom({ plugin: 'session-board', key: 'isShown' } as const, false)

// what a text takes on a terminal row: a Hangul or CJK character takes two cells
const cells = (text: string) =>
  [...text].reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1), 0)

// the widest word of the language, with a cell on either side of it
const chipCells = () => Math.max(...Object.values(text.words).map(word => cells(word))) + 2

const textOf = (value: unknown) => (typeof value === 'string' ? value : undefined)
const countOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const split = (path: string) => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return { dir: path.slice(0, cut), file: path.slice(cut + 1) }
}

// The first line that says something, without its markdown marks.
const tidy = (text: string) => {
  const line = text
    .split(/\r?\n/)
    .map(one => one.replace(/^[\s#>*\-`|]+/, '').replace(/[*`]/g, '').trim())
    .find(one => one !== '')

  return line === undefined ? undefined : line.replace(/\s+/g, ' ').slice(0, LINE_CHARS)
}

// What the engine writes in the person's place is no ask of theirs: a delivery
// or a notification (in a tag of the engine's, its name hyphened), the summary a
// compaction leaves, an interrupt mark,
// the nudge after a usage limit resets.
const NOT_AN_ASK =
  /^(<[a-z]+(-[a-z]+)+[\s>]|This session is being continued|\[Request interrupted|Caveat:|Your claude\.ai usage limit has reset)/

// The person's ask as one line, or undefined when the text is not theirs.
const askOf = (text: string) =>
  NOT_AN_ASK.test(text.trimStart())
    ? undefined
    : tidy(text.replace(/\[Image #\d+\]/g, ''))

// A notification that background work ended names the kind in its summary:
// `Background command "..." completed`, `Dynamic workflow "..." completed`.
const ENDED = /<task-notification>[\s\S]*?<status>(?!running)\w+<\/status>[\s\S]*?<summary>([^<]*)/

const endedKindOf = (text: string) => {
  const summary = ENDED.exec(text)?.[1]
  if (summary === undefined) {
    return undefined
  }

  // by how the summary opens: a command's own words follow, and may say anything
  return /^Background command/.test(summary)
    ? 'shell'
    : /^(Dynamic )?workflow/i.test(summary)
      ? 'workflow'
      : /^Monitor/i.test(summary)
        ? 'monitor'
        : undefined
}

// An answer that only says go on is no new ask: the last one stands.
const isBrief = (ask: string) => text.isBrief(ask)

// Why a turn broke off, in the person's words.
const reasonOf = (error: string) => (text.reasons as Record<string, string>)[error] ?? error

// What a call that waits for the person's leave is, in a few words: the tool,
// and the program it runs, the file it touches or the host it reaches. Never
// the whole command or address: either may carry a secret, and this is kept on
// disk and drawn in other windows.
const permitLine = (tool: string, input: unknown) => {
  const one = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const what =
    textOf(one.command)?.trim().split(/\s+/)[0] ??
    (textOf(one.file_path) === undefined ? undefined : basename(textOf(one.file_path) ?? '')) ??
    /^[a-z]+:\/\/([^/?#]+)/i.exec(textOf(one.url) ?? '')?.[1]

  return `${tool} ${what ?? ''}`.trim().slice(0, LINE_CHARS)
}

// Running work stands in the color of its kind, by the engine's own word for
// it. None is a call's color: those are for the person to answer.
const KIND_COLORS: Record<string, string> = {
  agents: 'suggestion',
  shell: 'bashBorder',
  workflow: 'merged',
}
const OTHER_KIND_COLOR = 'planMode'

const kindsOf = (entry: Entry) => entry.jobs ?? []

// The engine files more under `monitor` than the Monitor tool's watches: the
// watch a published artifact leaves is one, and it is no work and never ends.
// So of the engine's monitors, only as many count as the session itself started.
let ownMonitors = 0

const kindsLeft = (tasks: readonly { type: string }[] | undefined) => {
  const kinds = (tasks ?? []).map(task => task.type).filter(kind => kind !== 'subagent')
  ownMonitors = Math.min(ownMonitors, kinds.filter(kind => kind === 'monitor').length)

  return [
    ...kinds.filter(kind => kind !== 'monitor'),
    ...Array.from({ length: ownMonitors }, () => 'monitor'),
  ]
}

const flowsOf = (entry: Entry) => entry.flows ?? []

// The name a Workflow call gives its run: the saved workflow's, the one in the
// script's meta, or the script file's.
const flowNameOf = (call: { name?: unknown; script?: unknown; scriptPath?: unknown }) => {
  if (typeof call.name === 'string' && call.name !== '') {
    return call.name
  }
  const inMeta =
    typeof call.script === 'string' ? /name:\s*['"]([^'"]+)['"]/.exec(call.script)?.[1] : undefined
  const file =
    typeof call.scriptPath === 'string' ? basename(call.scriptPath).replace(/\.[^.]*$/, '') : ''

  return inMeta ?? (file === '' ? 'workflow' : file)
}

const barOf = (done: number, started: number) => {
  const filled = started > 0 ? Math.round((Math.min(done, started) / started) * BAR_CELLS) : 0

  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

// agents 3, shell 2, workflow 1
const tagsOf = (entry: Entry): Tag[] => {
  const count = new Map<string, number>()
  if ((entry.agents ?? 0) > 0) {
    count.set('agents', entry.agents ?? 0)
  }
  for (const kind of kindsOf(entry)) {
    count.set(kind, (count.get(kind) ?? 0) + 1)
  }
  // a run drawn as a bar is not counted here again
  const uncounted = (count.get('workflow') ?? 0) - flowsOf(entry).length
  if (uncounted > 0) {
    count.set('workflow', uncounted)
  } else {
    count.delete('workflow')
  }

  return [...count].map(([kind, n]) => ({
    text: `${kind} ${n}`,
    color: KIND_COLORS[kind] ?? OTHER_KIND_COLOR,
  }))
}

// the session's own name first: several sessions share one folder
const label = (seen: { name?: string; where: string }) => seen.name ?? seen.where

const place = (entry: Entry) =>
  [entry.name === undefined ? '' : entry.where, entry.branch === entry.where ? '' : entry.branch]
    .filter(Boolean)
    .join(' · ')

// A session whose turn ended while its subagents or its background work still
// run has not finished: it wakes by itself when they report back.
// One that ended its turn on a message to a session that is still there waits
// for that session, not for the person.
const phaseOf = (entry: Entry, names: ReadonlySet<string>): Shown => {
  if (
    (entry.agents ?? 0) + kindsOf(entry).length + flowsOf(entry).length > 0 &&
    (entry.phase === 'done' || entry.phase === 'idle')
  ) {
    return 'working'
  }

  return entry.phase === 'done' && entry.to !== undefined && names.has(entry.to)
    ? 'waiting'
    : entry.phase
}

const lineOf = (entry: Entry, phase: Shown) => {
  if (phase === 'waiting') {
    return `→ ${entry.to} · ${entry.note ?? entry.task ?? place(entry)}`
  }
  const isWaiting = ROWS[phase as keyof typeof ROWS]?.color !== undefined

  return (isWaiting ? entry.note : undefined) ?? entry.task ?? place(entry)
}

const PHASES: ReadonlySet<string> = new Set(['idle', 'working', 'done', 'asking', 'permit', 'failed', 'gone'])

// A session's file as another process wrote it, held to the shape this version
// reads: sessions of other versions write into the same folder. One that does
// not hold is passed over, and the rest of the board stands.
const parseEntry = (raw: unknown): Entry | undefined => {
  const one = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const where = textOf(one.where)
  const since = countOf(one.since)
  if (typeof one.phase !== 'string' || !PHASES.has(one.phase) || where === undefined || since === undefined) {
    return undefined
  }

  return {
    name: textOf(one.name),
    where,
    branch: textOf(one.branch) ?? '',
    phase: one.phase as Entry['phase'],
    since,
    task: textOf(one.task),
    askedAt: countOf(one.askedAt),
    note: textOf(one.note),
    agents: countOf(one.agents),
    jobs: Array.isArray(one.jobs) ? one.jobs.filter((kind): kind is string => typeof kind === 'string') : [],
    to: textOf(one.to),
    flows: (Array.isArray(one.flows) ? one.flows : []).flatMap((flow: unknown): Flow[] => {
      const f = (typeof flow === 'object' && flow !== null ? flow : {}) as Record<string, unknown>
      const [name, done, started, at] = [textOf(f.name), countOf(f.done), countOf(f.started), countOf(f.since)]

      return name === undefined || done === undefined || started === undefined || at === undefined
        ? []
        : [{ name, done, started, since: at }]
    }),
  }
}

let mine: Entry | null = null
// the call the session waits for the person on: its question, or its leave
let waitingOn: string | undefined
let transcript: string | null = null
let savedAt = 0
// The runs going, by run id, each with the ids of its agents still at work.
const runs = new Map<string, Flow & { ids: Set<string> }>()
// The name each Workflow call gave its run, by the call's id: a run's agents
// carry that id. The last name stands in where a run carries none.
const flowNames = new Map<string, string>()
let flowName: string | undefined

const flowsNow = (): Flow[] =>
  [...runs.values()].map(({ name, done, started, since }) => ({ name, done, started, since }))

// One piece of background work of a kind ended: it leaves the count, and a
// workflow takes its run along (one whose agents all ended, before any other).
const jobsWithout = (entry: Entry, kind: string) => {
  const jobs = kindsOf(entry)
  const at = jobs.indexOf(kind)
  if (kind === 'monitor') {
    ownMonitors = Math.max(0, ownMonitors - 1)
  }
  if (kind === 'workflow') {
    const over =
      [...runs].find(([, run]) => run.ids.size === 0)?.[0] ?? [...runs.keys()][0]
    if (over !== undefined) {
      runs.delete(over)
    }
  }

  return { jobs: at < 0 ? jobs : jobs.filter((_, i) => i !== at), flows: flowsNow() }
}

// The engine's list of background work says which runs still go.
const jobsLeft = (tasks: readonly { type: string; name?: string }[]) => {
  const going = tasks.filter(task => task.type === 'workflow').map(task => task.name)
  for (const [id, run] of runs) {
    if (going.length === 0 || (!going.includes(undefined) && !going.includes(run.name))) {
      runs.delete(id)
    }
  }

  return { jobs: kindsLeft(tasks), flows: flowsNow() }
}

// Claude Code's own folder: where it was told to keep it, else under the home
// folder. With neither known the mod writes nothing: never into the work folder.
const configDir = async ($: EngineInterface) => {
  const set = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))

  return set ?? (home === undefined ? undefined : `${home}/.claude`)
}

// A session that moved into a worktree keeps the transcript of the folder it
// started in, so the folder is found by the session's id, not spelled from cwd.
const findTranscript = async ($: EngineInterface) => {
  const config = await configDir($)
  if (config === undefined) {
    return null
  }
  const projects = `${config}/projects`
  const file = `${await $.session.id()}.jsonl`
  const folders = await $.fs.list(projects).catch(() => [])

  for (const folder of folders) {
    const path = `${projects}/${folder.name}/${file}`
    if (folder.kind === 'dir' && (await $.fs.exists(path).catch(() => false))) {
      return path
    }
  }

  return null
}

// The name is the last `custom-title` row of the transcript. The file outgrows
// what `$.fs.read` takes, so git greps it, from its own folder (outside any repo).
const nameOf = async ($: EngineInterface) => {
  // looked for again after the session's id changed
  transcript ??= await findTranscript($)
  if (transcript === null) {
    return undefined
  }
  const { dir, file } = split(transcript)
  const ran = await $.process
    .run(['git', 'grep', '--no-index', '-h', '-o', '"customTitle":"[^"]*"', '--', file], {
      cwd: dir,
      timeoutMs: 5000,
    })
    .catch(() => undefined)
  const last = ran?.exitCode === 0 ? ran.stdout.trim().split(/\r?\n/).pop() : undefined
  try {
    const title: unknown = last === undefined ? undefined : JSON.parse(`{${last}}`).customTitle

    return typeof title === 'string' && title !== '' ? title : undefined
  } catch {
    return undefined
  }
}

const boardDir = async ($: EngineInterface) => {
  const config = await configDir($)

  return config === undefined ? undefined : `${config}/session-board`
}

// The folder the session works in: the worktree's own, wherever in it the
// shell stands, and not the project a worktree session was started from.
const whereOf = async ($: EngineInterface, cwd: string) => {
  const ran = await $.process
    .run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
    .catch(() => undefined)

  return basename(ran?.exitCode === 0 ? ran.stdout.trim() : cwd)
}

const branchOf = async ($: EngineInterface) => {
  const ran = await $.process
    .run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
    .catch(() => undefined)

  return ran?.exitCode === 0 ? ran.stdout.trim() : ''
}

const save = async ($: EngineInterface, id?: string) => {
  if (mine === null) {
    return
  }
  const dir = await boardDir($)
  if (dir === undefined) {
    throw new Error('no home folder to keep the board in')
  }
  await $.fs.write(`${dir}/${id ?? (await $.session.id())}.json`, JSON.stringify(mine))
  savedAt = await $.clock.now()
}

// Sets what changed and writes it. The board is a view: a failed write never
// stands in a tool's or a turn's way.
const put = async ($: EngineInterface, change: Partial<Entry>) => {
  // the clock is read first: a change another hook makes meanwhile is kept
  const now = await $.clock.now()
  if (mine === null) {
    return
  }
  const isNewPhase = change.phase !== undefined && change.phase !== mine.phase
  mine = { ...mine, ...change, since: isNewPhase ? now : mine.since }
  await save($).catch(() => undefined)
}

// Counts the subagents still running, and keeps the file fresh for the others.
const tick = async ($: EngineInterface) => {
  if (mine === null) {
    return
  }
  const list = await $.agent.list().catch(() => [])
  const agents = list.filter(agent => agent.status === 'running').length
  const isStale = (await $.clock.now()) - savedAt >= BEAT_MS
  if (agents !== (mine.agents ?? 0) || isStale) {
    await put($, { agents })
  }
}

const poll = async ($: EngineInterface) => {
  if (!(await read($, isShown))) {
    return
  }
  const dir = await boardDir($)
  const ownFile = `${await $.session.id()}.json`
  const now = await $.clock.now()
  const files = dir === undefined ? [] : await $.fs.list(dir).catch(() => [])
  const live: Entry[] = []

  for (const file of files) {
    const isLive =
      file.kind === 'file' &&
      file.name.endsWith('.json') &&
      file.name !== ownFile &&
      now - file.mtimeMs < STALE_MS
    if (!isLive) {
      continue
    }
    try {
      const entry = parseEntry(JSON.parse(String(await $.fs.read(`${dir}/${file.name}`))))
      if (entry !== undefined && entry.phase !== 'gone') {
        live.push(entry)
      }
    } catch {
      // half-written or unreadable: the next poll reads it again
    }
  }
  // this window's session can be the one waited for
  const names = new Set(
    [mine, ...live].flatMap(entry => (entry?.name === undefined ? [] : [entry.name])),
  )
  const seen: Seen[] = live.map(entry => {
    const phase = phaseOf(entry, names)

    return {
      name: entry.name,
      where: entry.where,
      branch: entry.branch,
      phase,
      waitedMin: Math.floor((now - entry.since) / MINUTE_MS),
      workedMin:
        phase === 'working' && entry.askedAt !== undefined
          ? Math.floor((now - entry.askedAt) / MINUTE_MS)
          : undefined,
      // a session that calls says what it wants: what it runs is beside the point
      tags: phase === 'working' ? tagsOf(entry) : [],
      line: lineOf(entry, phase),
      flows: flowsOf(entry).map(({ name, done, started, since }) => ({
        name,
        done,
        started,
        min: Math.floor((now - since) / MINUTE_MS),
      })),
    }
  })
  seen.sort(
    (a, b) =>
      ORDER.indexOf(a.phase) - ORDER.indexOf(b.phase) ||
      b.waitedMin - a.waitedMin ||
      label(a).localeCompare(label(b)),
  )

  if (JSON.stringify(await read($, others)) !== JSON.stringify(seen)) {
    await update($, others, () => seen)
  }
}

export const register: Register = (on, options) => {
  text = options.language === 'ko' ? TEXTS.ko : TEXTS.en

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) {
      return started
    }

    transcript = await findTranscript($)

    // A session the mod is loaded into midway has a past: it is not one that
    // never began. It reads as finished, by its last words, until a tool runs.
    const past = await $.session.messages().catch(() => [])
    const linesOf = (role: string) =>
      [...past]
        .reverse()
        .flatMap(m => (m.role === role ? [askOf(m.text)] : []))
        .flatMap(line => (line === undefined ? [] : [line]))
    const asks = linesOf('user')
    // a reload starts the module over: what its own file says of the ask stands
    const before = await $.fs
      .read(`${await boardDir($)}/${await $.session.id()}.json`)
      .then(text => parseEntry(JSON.parse(String(text))))
      .catch(() => undefined)

    mine = {
      name: await nameOf($),
      where: await whereOf($, e.cwd),
      branch: await branchOf($),
      phase: past.length > 0 ? 'done' : 'idle',
      // one that had finished before the reload finished then, not now
      since: before?.phase === 'done' && past.length > 0 ? before.since : await $.clock.now(),
      task: asks.find(ask => !isBrief(ask)) ?? asks[0],
      askedAt: before?.askedAt,
      note: linesOf('assistant')[0],
    }
    const isKept = await save($).then(
      () => true,
      () => false,
    )
    if (!isKept) {
      mine = null
      $.ui.toast('session-board: cannot write under the Claude Code folder, so it is off in this session')

      return started
    }
    await $.command.register({
      name: 'board',
      description: text.command,
    })
    await tick($)
    await poll($)
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))

    return started
  })

  on('turn.start', async ($, e, next) => {
    // a turn a delivery or a notification started carries no ask of the person's
    if (mine === null) {
      return next(e)
    }
    waitingOn = undefined
    const asked = askOf(e.text)
    const ended = endedKindOf(e.text)
    const isNewAsk = asked !== undefined && !(isBrief(asked) && mine?.task !== undefined)
    await put($, {
      ...(ended === undefined || mine === null ? {} : jobsWithout(mine, ended)),
      name: await nameOf($),
      where: await whereOf($, mine?.where ?? ''),
      branch: await branchOf($),
      task: isNewAsk ? asked : mine?.task,
      askedAt: isNewAsk ? await $.clock.now() : mine?.askedAt,
      note: undefined,
      phase: 'working',
      to: undefined,
    })

    return next(e)
  })

  // The end of a turn, and of a subagent, says what still runs in the
  // background. Subagents are left out: the tick counts them as they start and end.
  on('classic.Stop', async ($, e, next) => {
    await put($, jobsLeft(e.background_tasks ?? []))

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    if (e.background_tasks !== undefined) {
      await put($, jobsLeft(e.background_tasks))
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    await put($, { note: reasonOf(e.error), phase: 'failed' })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    // a subagent's turn ends inside the main one: the session still works
    if (e.agentId === undefined && mine?.phase !== 'failed') {
      waitingOn = undefined
      await put($, { note: tidy(e.answer), phase: 'done' })
    }
    const run = [...runs.values()].find(one => one.ids.has(e.agentId ?? ''))
    if (run !== undefined) {
      run.ids.delete(e.agentId ?? '')
      run.done += 1
      await put($, { flows: flowsNow() })
    }

    return completed
  })

  // A workflow run is followed by its agents: each one it starts, each that ends.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const runId = e.workflow?.runId ?? ''
    if (runId === '' || spawned.deny !== undefined) {
      return spawned
    }
    const run = runs.get(runId) ?? {
      name: flowNames.get(e.tool_use_id ?? '') ?? flowName ?? 'workflow',
      done: 0,
      started: 0,
      since: await $.clock.now(),
      ids: new Set<string>(),
    }
    run.started = Math.max(run.started + 1, e.workflow?.agentIndex ?? 0)
    if (spawned.agentId !== undefined) {
      run.ids.add(spawned.agentId)
    }
    runs.set(runId, run)
    await put($, { flows: flowsNow() })

    return spawned
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Workflow') {
      flowName = flowNameOf(e)
      flowNames.set(e.tool_use_id, flowName)
    }
    if (e.tool === 'AskUserQuestion') {
      waitingOn = e.tool_use_id
      await put($, { note: tidy(e.questions[0]?.question ?? ''), phase: 'asking' })
    } else if (e.tool === 'SendMessage' && typeof e.to === 'string') {
      // a listing's " [ref]" is no part of the name
      await put($, { to: e.to.replace(/\s*\[[^\]]*\]$/, '') })
    } else if (mine?.phase === 'idle' || mine?.phase === 'done') {
      // a tool runs, so a turn does: the mod loaded mid-turn, or the session
      // went on by itself when a subagent reported back
      await put($, { phase: 'working' })
    }
    const ran = await next(e)
    // started mid-turn, it shows at once: the engine's list comes at the turn's end
    const started =
      e.tool === 'Workflow'
        ? 'workflow'
        : (e.tool === 'Bash' || e.tool === 'PowerShell') && e.run_in_background === true
          ? 'shell'
          : e.tool === 'Monitor'
            ? 'monitor'
            : undefined
    if (started === 'monitor' && e.agentId === undefined) {
      ownMonitors += 1
    }
    // a subagent's shell is its own to wait for: the session's are the main loop's
    if (started !== undefined && mine !== null && e.agentId === undefined) {
      await put($, { jobs: [...kindsOf(mine), started] })
    }
    // another call ending meanwhile (a subagent's, one of a batch) ends no wait
    if ((mine?.phase === 'asking' || mine?.phase === 'permit') && e.tool_use_id === waitingOn) {
      waitingOn = undefined
      await put($, { note: undefined, phase: 'working' })
    }

    return ran
  })

  // Work that ends while a turn is on reports into that turn: no turn starts
  // for it, so its notification is read as it is put to the session.
  on('prompt.submit', async ($, e, next) => {
    const ended = mine?.phase === 'working' ? endedKindOf(e.text) : undefined
    if (ended !== undefined && mine !== null) {
      await put($, jobsWithout(mine, ended))
    }

    return next(e)
  })

  on('classic.UserPromptSubmit', ($, e, next) => {
    transcript = e.transcript_path || transcript

    return next(e)
  })

  // A call the engine's own verdict puts to the person waits for them until it
  // settles: the `tool.call` around it sets the session back to work. Under a
  // mode that decides by itself the wait is over at once.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const isWaiting =
      verdict.decision === 'ask' &&
      e.tool_use_id !== undefined &&
      e.tool !== 'AskUserQuestion' &&
      mine?.phase === 'working'
    if (isWaiting) {
      waitingOn = e.tool_use_id
      await put($, { note: permitLine(e.tool, e.input), phase: 'permit' })
    }

    return verdict
  })

  on('session.end', async ($, e, next) => {
    if (mine !== null) {
      const last = mine
      mine = { ...last, phase: 'gone' }
      await save($, e.sessionId).catch(() => undefined)
      // After a /clear or a resume the process goes on under a new id, with no
      // session.start: the mod goes on too, from an entry of its own for it.
      const goesOn = e.reason === 'clear' || e.reason === 'resume'
      runs.clear()
      flowNames.clear()
      ownMonitors = 0
      waitingOn = undefined
      transcript = null
      mine = goesOn
        ? { where: last.where, branch: last.branch, phase: 'idle', since: await $.clock.now() }
        : null
    }

    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    const isOn = !(await read($, isShown))
    await update($, isShown, () => isOn)
    await poll($)

    return { text: isOn ? text.shown : text.hidden }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isShown))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, others)
    if (rows.length === 0) {
      return <Text dimColor>{text.none}</Text>
    }
    const chip = chipCells()
    const nameCells = Math.max(...rows.map(s => cells(label(s)))) + 1
    const lineCells = Math.max(
      10,
      e.props.bodyColumns - chip - nameCells - TIME_CELLS - GAPS,
    )

    return (
      <Box flexDirection="column">
        {rows.map(s => {
          const row = ROWS[s.phase as keyof typeof ROWS]
          const waits = row.color !== undefined
          const isCall = waits && !(s.phase === 'done' && s.waitedMin >= DONE_CALL_MIN)

          return (
            <Box key={`${label(s)}:${s.where}:${s.branch}`} flexDirection="row" gap={1}>
              <Box width={chip}>
                {isCall ? (
                  <Text backgroundColor={row.color} color="inverseText" bold>
                    {` ${text.words[s.phase as keyof typeof text.words]} `}
                  </Text>
                ) : (
                  <Text
                    color={row.ink}
                    bold={row.ink !== undefined}
                    dimColor={row.ink === undefined}
                    wrap="truncate-end"
                  >
                    {` ${text.words[s.phase as keyof typeof text.words]}`}
                  </Text>
                )}
              </Box>
              <Box width={nameCells}>
                <Text bold={isCall} dimColor={!isCall && row.ink === undefined} wrap="truncate-end">
                  {label(s)}
                </Text>
              </Box>
              <Box width={lineCells}>
                {/* the counts lead: at the end of a long line they are the part cut off */}
                <Text wrap="truncate-end">
                  {s.tags.map(tag => (
                    <Text key={tag.text} color={tag.color} bold>
                      {`${tag.text}  `}
                    </Text>
                  ))}
                  {s.flows.flatMap(flow => [
                    <Text key={flow.name} color={KIND_COLORS.workflow} bold>
                      {`${flow.name} ${barOf(flow.done, flow.started)}`}
                    </Text>,
                    <Text key={`${flow.name}:count`} dimColor>
                      {` ${flow.done}/${flow.started} · ${flow.min > 0 ? text.minutes(flow.min) : text.now}  `}
                    </Text>,
                  ])}
                  <Text dimColor={!isCall}>{s.line}</Text>
                </Text>
              </Box>
              <Box width={TIME_CELLS} justifyContent="flex-end">
                {/* a call: how long it has waited for the person. At work: how long on the ask */}
                {waits ? (
                  <Text dimColor>{s.waitedMin > 0 ? text.minutes(s.waitedMin) : text.now}</Text>
                ) : (
                  s.workedMin !== undefined && <Text dimColor>{text.minutes(s.workedMin)}</Text>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
