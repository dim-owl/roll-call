import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Entry } from '../types'

const DIR = 'C:/home/.claude/roll-call'
// where Claude Code itself lists its sessions, one file a process
const SESSIONS = 'C:/home/.claude/sessions'
const NOW = 10_000_000
const ENGINE_BAND = 'engine band'
const NEWLINE = String.fromCharCode(10)
// the board's words in Korean: most tests read them
const KO = { options: { language: 'ko' } }
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { top: 0, bodyRows: 10, rows: 0 },
} as never

// the engine hands a path on in the host's own spelling
const slashed = (path: string) => path.replaceAll('\\', '/')

type Disk = Map<string, { text: string; mtimeMs: number }>
type Past = { role: string; text: string }

// What the test sets of the session the mod runs in.
type Session = {
  /** The name the person gave it, as Claude Code lists it. */
  name?: string
  /** The process ids running now, when the process list can be had at all. */
  alive?: readonly number[] | null
  past?: readonly Past[]
  /** Subagents running now; the test changes it as they start and end. */
  agents?: number
  /** The environment, when it is not the usual one. */
  env?: Record<string, string>
  /** Whether the disk takes a write. */
  isReadOnly?: boolean
  /** What happens under an AskUserQuestion call while it is up. */
  whileAsking?: () => Promise<void>
}

// The world beneath the mod: a disk in memory, a clock the test moves, one session.
const world = (on: On, disk: Disk, session: Session = {}) => {
  const clock = mock.clock(on, { now: NOW })
  disk.set(`${SESSIONS}/100.json`, {
    text: JSON.stringify({ pid: 100, sessionId: 'me', cwd: 'C:/work/proj', kind: 'interactive', name: session.name, status: 'busy', updatedAt: NOW }),
    mtimeMs: NOW,
  })

  mock.env(on, session.env ?? { USERPROFILE: 'C:/home' })
  on('session.id', () => ({ value: 'me' }))
  on('session.messages', () => ({ value: session.past ?? [] }) as never)
  on('agent.list', () => ({
    value: Array.from({ length: session.agents ?? 0 }, (_, i) => ({
      id: `a${i}`,
      description: 'review',
      type: 'general-purpose',
      status: 'running',
    })),
  }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('turn.complete', () => ({ text: '' }))
  // what the session's own file said while each tool ran
  const duringTool: Entry[] = []
  on('tool.call', async (_$, e) => {
    duringTool.push(JSON.parse(disk.get(`${DIR}/me.json`)?.text ?? '{}') as Entry)
    if (e.tool === 'AskUserQuestion') {
      await session.whileAsking?.()
    }

    return { result: 'ok' } as never
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'tasklist' || e.argv[0] === 'ps') {
      const alive = session.alive === undefined ? [100] : session.alive
      const stdout = (alive ?? []).map(pid => (e.argv[0] === 'ps' ? ` ${pid}` : `"claude.exe","${pid}","Console","1","300,000 K"`)).join(NEWLINE)

      return { value: { exitCode: alive === null ? 1 : 0, stdout, stderr: '' } } as never
    }
    const stdout = e.argv.includes('--show-toplevel') ? 'C:/work/proj/.claude/worktrees/feature-a' : 'feat/x'

    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('fs.write', (_$, e) => {
    if (session.isReadOnly === true) {
      throw new Error('EROFS')
    }
    disk.set(slashed(e.path), { text: e.text, mtimeMs: clock.now() })

    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const file = disk.get(slashed(e.path))
    if (file === undefined) {
      throw new Error('ENOENT')
    }

    return { value: file.text }
  })
  on('fs.list', (_$, e) => ({
    value: [...disk]
      .filter(([path]) => path.startsWith(`${slashed(e.path)}/`))
      .map(([path, file]) => ({
        name: path.slice(slashed(e.path).length + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })),
  }))
  // what the engine draws in the band when the mod draws nothing of its own
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, null, ENGINE_BAND) as never
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined } as never
  })

  return { clock, duringTool, toasts }
}

const put = (disk: Disk, id: string, entry: Partial<Entry>, mtimeMs = NOW - 1_000) =>
  disk.set(`${DIR}/${id}.json`, {
    text: JSON.stringify({
      where: id,
      branch: 'main',
      phase: 'working',
      since: NOW - 180_000,
      ...entry,
    }),
    mtimeMs,
  })

// a session as Claude Code lists it, the mod not loaded into it
const list = (disk: Disk, pid: number, one: Record<string, unknown>) =>
  disk.set(`${SESSIONS}/${pid}.json`, {
    text: JSON.stringify({ pid, sessionId: `s${pid}`, cwd: 'C:/work/other', kind: 'interactive', status: 'idle', updatedAt: NOW - 120_000, ...one }),
    mtimeMs: NOW - 120_000,
  })

const start = ($: Engine) =>
  $.session.start({ cwd: 'C:/work/proj/frontend', surface: 'terminal', isInteractive: true })

const own = (disk: Disk) => JSON.parse(disk.get(`${DIR}/me.json`)?.text ?? '{}') as Entry

// the person typing /board at the prompt
const board = ($: Engine) => $.command.run({ command: 'board', args: '' } as never)

const draw = async ($: Engine) => {
  const drawn = await $.ui.mount({
    plugin: 'roll-call',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: BAND,
  })
  const texts = await drawn.findAll({ type: 'Text' })
  await drawn.unmount()

  return texts
}

const band = async ($: Engine) => (await draw($)).map(t => t.text).join('|')

const endTurn = ($: Engine, answer: string, agentId?: string) =>
  $.turn.complete({ answer, reason: 'answer', turnId: 't1', isAborted: false, agentId } as never)

test('writes its phase, what it was asked and how it ended, as the turn goes', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)

  await start($)
  // named by the worktree it works in, not by the folder the shell wandered into
  expect(own(disk)).toMatchObject({ where: 'feature-a', branch: 'feat/x', phase: 'idle' })

  await $.turn.start({ text: '착수 메모 써 줘\n자세히', turnId: 't1' })
  expect(own(disk)).toMatchObject({ phase: 'working', task: '착수 메모 써 줘' })

  await endTurn($, '## 끝났다\n\n메모는 docs 에 있다')
  expect(own(disk)).toMatchObject({ phase: 'done', note: '끝났다', task: '착수 메모 써 줘' })
})

test('a turn another session or a notification started keeps the last ask', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)

  await start($)
  await $.turn.start({ text: '머지 검증해 줘', turnId: 't1' })
  await $.turn.start({ text: '<cross-session-message from="x">알림</cross-session-message>', turnId: 't2' })
  await $.turn.start({
    text: 'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.',
    turnId: 't3',
  })

  expect(own(disk).task).toBe('머지 검증해 줘')
})

test('names itself by the last title the person gave the session', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, { name: '머지 세션' })

  await start($)

  expect(own(disk)).toMatchObject({ name: '머지 세션', where: 'feature-a' })
})

test('loaded into a session with a past, reads as finished by its last words', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, {
    past: [
      { role: 'user', text: '[Image #3] 기능 구현해 줘' },
      { role: 'user', text: 'This session is being continued from a previous conversation that ran out of context.' },
      { role: 'assistant', text: '머지 요청을 보냈다' },
      { role: 'user', text: '<task-notification>done</task-notification>' },
    ],
  })

  await start($)

  expect(own(disk)).toMatchObject({
    phase: 'done',
    task: '기능 구현해 줘',
    note: '머지 요청을 보냈다',
  })
})

test('a tool that runs shows a turn is on, whatever the mod took it for', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, { past: [{ role: 'assistant', text: '하는 중' }] })

  await start($)
  expect(own(disk).phase).toBe('done')

  await $.tool.call({ tool: 'Read', file_path: 'a.txt' } as never)

  expect(own(disk).phase).toBe('working')
})

test('writes the question it asks, and goes back to work once answered', KO, async ($, on) => {
  const disk: Disk = new Map()
  const { duringTool } = world(on, disk)

  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: '기본값은 켬으로 둘까?', header: '기본값', options: [], multiSelect: false }],
  } as never)

  expect(duringTool[0]).toMatchObject({ phase: 'asking', note: '기본값은 켬으로 둘까?' })
  expect(own(disk).phase).toBe('working')
  expect(own(disk).note).toBe(undefined)
})

test('a call put to the person reads as waiting for leave, until it settles', KO, async ($, on) => {
  const disk: Disk = new Map()
  const { duringTool } = world(on, disk)
  let decision = 'ask'
  on('tool.check', () => ({ decision }) as never)
  const check = (verdict: string) => {
    decision = verdict

    return $.tool.check({ tool: 'Bash', input: { command: 'git push https://tok3n@host/x main' }, tool_use_id: 'u1' } as never)
  }

  await start($)
  await $.turn.start({ text: '올려 줘', turnId: 't1' })
  await check('ask')
  // the program, not its arguments: a command may carry a secret
  expect(own(disk)).toMatchObject({ phase: 'permit', note: 'Bash git' })

  // the call around it runs or is refused: either way the wait is over
  // a subagent's call ending meanwhile ends no wait
  await $.tool.call({ tool: 'Read', file_path: 'a.txt', tool_use_id: 'u0', agentId: 'a1' } as never)
  expect(own(disk).phase).toBe('permit')
  expect(JSON.stringify(own(disk))).not.toContain('tok3n')

  await $.tool.call({ tool: 'Bash', command: 'git push origin main', tool_use_id: 'u1' } as never)
  expect(duringTool.at(-1)?.phase).toBe('permit')
  expect(own(disk)).toMatchObject({ phase: 'working' })

  await check('allow')
  expect(own(disk).phase).toBe('working')
})

test('a subagent ending its turn leaves the session working', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)

  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await endTurn($, 'report', 'a1')

  expect(own(disk).phase).toBe('working')
})

test('counts its running subagents as they start and end', KO, async ($, on) => {
  const disk: Disk = new Map()
  const session: Session = { agents: 0 }
  const { clock } = world(on, disk, session)

  await start($)
  session.agents = 3
  await clock.advance(10_000)
  expect(own(disk).agents).toBe(3)

  session.agents = 0
  await clock.advance(10_000)
  expect(own(disk).agents).toBe(0)
})

const others = (disk: Disk) => {
  put(disk, 'a', { name: '검토 세션', phase: 'done', note: '검토 넷 끝', task: '2차 검토' })
  put(disk, 'verify', { phase: 'asking', note: '기본값은 켬으로 둘까?' })
  put(disk, 'c', { name: '화면 세션', phase: 'working', task: '화면 확인', agents: 3, askedAt: NOW - 840_000 })
  put(disk, 'crashed', { phase: 'done' }, NOW - 600_000)
  put(disk, 'closed', { phase: 'gone' })
}

test('draws nothing in a window the person did not ask for the board in', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  others(disk)

  await start($)

  expect(await band($)).toBe(ENGINE_BAND)
})

test('/board lists every other live session: the calls first, each with its one line', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  others(disk)

  await start($)
  await board($)
  const texts = await band($)

  // a waiting session says what it wants, a working one what it was asked
  expect(texts).toContain('기본값은 켬으로 둘까?')
  expect(texts).toContain('검토 넷 끝')
  expect(texts).toContain('agents 3')
  expect(texts).toContain('화면 확인')
  // only a session that calls says how long it has waited
  expect(texts.split('|3분').length - 1).toBe(2)
  // one at work says how long since the person asked
  expect(texts).toContain('|14분')
  expect(texts).not.toContain('crashed')
  expect(texts).not.toContain('closed')
  // needs an answer, then finished, then at work
  expect(texts.indexOf('verify')).toBeLessThan(texts.indexOf('검토 세션'))
  expect(texts.indexOf('검토 세션')).toBeLessThan(texts.indexOf('화면 세션'))
})

test('only a session that calls for the person stands in color', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  others(disk)

  await start($)
  await board($)
  const chips = (await draw($)).filter(t => t.props.backgroundColor !== undefined)

  expect(chips.map(t => [t.text.trim(), t.props.backgroundColor])).toEqual([
    ['질문', 'warning'],
    ['끝남', 'success'],
  ])
})

test('a session whose turn ended while its subagents run reads as at work', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  put(disk, 'a', { name: '구현 세션', phase: 'done', note: '기다리는 중', task: '리뷰 돌려 줘', agents: 2 })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts).toContain('일함')
  expect(texts).toContain('agents 2')
  expect(texts).toContain('리뷰 돌려 줘')
  expect(texts).not.toContain('끝남')
})

test('a turn that ends with a background shell running leaves the session at work', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  on('classic.Stop', () => ({}) as never)

  await start($)
  await $.turn.start({ text: '검증 돌려 줘', turnId: 't1' })
  await endTurn($, '검증을 돌리는 중이다')
  await $.classic.Stop({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', description: 'merge-verify' },
      { id: 'a1', type: 'subagent', status: 'running', description: 'review' },
    ],
  } as never)
  // the subagent is the tick's to count
  expect(own(disk)).toMatchObject({ phase: 'done', jobs: ['shell'] })

  // it starts a workflow in its next turn: that shows before the turn ends
  await $.turn.start({ text: '마무리 관문 돌려 줘', turnId: 't2' })
  await $.tool.call({ tool: 'Workflow', name: 'final-gate' } as never)
  expect(own(disk).jobs).toEqual(['shell', 'workflow'])

  // the engine's list at the turn's end is the one that counts
  await $.classic.Stop({ hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [] } as never)
  expect(own(disk).jobs).toEqual([])
})

test('a session whose turn ended while its background work runs reads as at work', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  put(disk, 'a', { name: '머지 세션', phase: 'done', note: '돌리는 중', task: '검증 돌려 줘', jobs: ['shell', 'workflow', 'shell'] })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts).toContain('shell 2')
  expect(texts).toContain('workflow 1')
  expect(texts).toContain('검증 돌려 줘')
  expect(texts).not.toContain('끝남')
})

test('an answer of a few letters leaves the last ask standing', KO, async ($, on) => {
  const disk: Disk = new Map()
  const { clock } = world(on, disk)

  await start($)
  await $.turn.start({ text: '이어서', turnId: 't0' })
  // nothing stands yet, so even a short word is the ask
  expect(own(disk).task).toBe('이어서')

  await $.turn.start({ text: '머지 검증해 줘', turnId: 't1' })
  await clock.advance(60_000)
  await $.turn.start({ text: 'ㅇㅇ', turnId: 't2' })
  // and the work on it began when it was asked
  expect(own(disk)).toMatchObject({ task: '머지 검증해 줘', askedAt: NOW })

  // a reload starts the module over: the file keeps when the ask was
  await start($)
  expect(own(disk).askedAt).toBe(NOW)
})

test('a turn that breaks off on an API error reads as stopped, with the reason', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  on('classic.StopFailure', () => ({}) as never)

  await start($)
  await $.turn.start({ text: '검증 돌려 줘', turnId: 't1' })
  await $.classic.StopFailure({ hook_event_name: 'StopFailure', error: 'rate_limit' } as never)
  await endTurn($, '')
  expect(own(disk)).toMatchObject({ phase: 'failed', note: '사용량 한도' })

  await $.turn.start({ text: '이어서', turnId: 't2' })
  expect(own(disk)).toMatchObject({ phase: 'working', task: '검증 돌려 줘' })
})

test('a session that ended its turn on a message to another waits for that one', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, { name: '머지 세션' })
  put(disk, 'a', { name: '구현 세션', phase: 'done', note: '머지 요청을 보냈다', to: '머지 세션' })
  // the one it wrote to is not there any more: it reads as finished
  put(disk, 'b', { name: '화면 세션', phase: 'done', note: '끝', to: '닫힌 세션' })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts).toContain('기다림')
  expect(texts).toContain('→ 머지 세션 · 머지 요청을 보냈다')
  expect(texts.indexOf('화면 세션')).toBeLessThan(texts.indexOf('구현 세션'))
})

test('writes down the session it sends a message to, until its next turn', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)

  await start($)
  await $.turn.start({ text: '머지 요청 보내 줘', turnId: 't1' })
  await $.tool.call({ tool: 'SendMessage', to: '머지 세션 [a1b2]', message: '머지 요청' } as never)
  expect(own(disk).to).toBe('머지 세션')

  await $.turn.start({ text: '<cross-session-message from="x">답</cross-session-message>', turnId: 't2' })
  expect(own(disk).to).toBe(undefined)
})

test('follows a workflow run by the agents it starts and the ones that end', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  let spawned = 0
  on('agent.spawn', () => ({ model: 'm', agentId: `w${++spawned}` }) as never)
  on('classic.Stop', () => ({}) as never)
  const spawn = (agentIndex: number) =>
    $.agent.spawn({ prompt: 'p', workflow: { runId: 'wf_abc123', agentIndex } } as never)

  await start($)
  await $.turn.start({ text: '마무리 관문 돌려 줘', turnId: 't1' })
  await $.tool.call({ tool: 'Workflow', script: "export const meta = { name: 'final-gate' }" } as never)
  await spawn(1)
  await spawn(2)
  await spawn(3)
  await endTurn($, 'found', 'w1')
  await endTurn($, 'found', 'w3')
  expect(own(disk).flows).toMatchObject([{ name: 'final-gate', done: 2, started: 3 }])
  // its own turn is still on
  expect(own(disk).phase).toBe('working')

  // the engine's list at a turn's end keeps a run that still goes
  await $.classic.Stop({
    hook_event_name: 'Stop',
    stop_hook_active: false,
    background_tasks: [{ id: 'w', type: 'workflow', status: 'running', description: 'd', name: 'final-gate' }],
  } as never)
  expect(own(disk)).toMatchObject({ jobs: ['workflow'], flows: [{ name: 'final-gate' }] })

  // the run reports back: it goes at once, while the turn it woke is still on
  await endTurn($, 'found', 'w2')
  await $.turn.start({
    text: [
      '<task-notification>',
      '<task-id>w</task-id>',
      '<status>completed</status>',
      '<summary>Dynamic workflow "마무리 관문" completed</summary>',
      '</task-notification>',
    ].join(NEWLINE),
    turnId: 't2',
  })
  expect(own(disk)).toMatchObject({ jobs: [], flows: [] })

  // a run that ends while a turn is on reports into that turn
  await spawn(1)
  await $.tool.call({ tool: 'Bash', command: 'sleep 9', run_in_background: true, agentId: 'w9' } as never)
  // a workflow agent's own shell is not the session's
  expect(own(disk).jobs).toEqual([])
  await $.prompt.submit({
    text: [
      '<task-notification>',
      '<status>completed</status>',
      '<summary>Dynamic workflow "마무리 관문" completed</summary>',
      '</task-notification>',
    ].join(NEWLINE),
  } as never)
  expect(own(disk).flows).toEqual([])

  await spawn(1)
  // the run is no more in the engine's list: its line goes
  await $.classic.Stop({ hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [] } as never)
  expect(own(disk).flows).toEqual([])
})

test('draws a workflow run as a bar on the line of its session', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  put(disk, 'a', {
    name: '머지 세션',
    phase: 'done',
    task: '마무리 관문 돌려 줘',
    jobs: ['workflow', 'shell'],
    flows: [{ name: 'final-gate', done: 9, started: 18, since: NOW - 840_000 }],
  })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts).toContain('일함')
  expect(texts).toContain(`final-gate ${'█'.repeat(9)}${'░'.repeat(9)}`)
  expect(texts).toContain('9/18 · 14분')
  expect(texts).toContain('shell 1')
  // the run has its bar: it is not counted beside the others again
  expect(texts).not.toContain('workflow 1')
})

test('the watch a published artifact leaves is no work of the session', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  on('classic.Stop', () => ({}) as never)
  const stop = (kinds: string[]) =>
    $.classic.Stop({
      hook_event_name: 'Stop',
      stop_hook_active: false,
      background_tasks: kinds.map((type, i) => ({ id: `t${i}`, type, status: 'running', description: 'd' })),
    } as never)

  await start($)
  await $.turn.start({ text: '보고서 올려 줘', turnId: 't1' })
  await $.tool.call({ tool: 'Artifact', file_path: 'report.html' } as never)
  await stop(['monitor', 'monitor'])
  expect(own(disk).jobs).toEqual([])

  // a watch the session set itself with the Monitor tool is its work
  await $.turn.start({ text: '배포 지켜봐 줘', turnId: 't2' })
  await $.tool.call({ tool: 'Monitor', command: 'tail -f log' } as never)
  await stop(['monitor', 'monitor', 'monitor'])
  expect(own(disk).jobs).toEqual(['monitor'])
})

test('a session that finished a while ago stands without its color', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  put(disk, 'a', { name: '방금 세션', phase: 'done', note: '끝', since: NOW - 240_000 })
  put(disk, 'b', { name: '아까 세션', phase: 'done', note: '끝', since: NOW - 300_000 })

  await start($)
  await board($)
  const chips = (await draw($)).filter(t => t.props.backgroundColor !== undefined)
  const texts = await band($)

  expect(chips.length).toBe(1)
  // it keeps its word and how long ago it ended
  expect(texts.split('끝남').length - 1).toBe(2)
  expect(texts).toContain('|5분')
})

test('a session at work has its word in color, with nothing behind it', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  others(disk)

  await start($)
  await board($)
  const word = (await draw($)).find(t => t.text.trim() === '일함')

  expect(word?.props.color).toBe('claude')
  expect(word?.props.backgroundColor).toBe(undefined)
})

test('speaks English unless the person sets another language', async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  put(disk, 'a', { name: 'review', phase: 'done', note: 'four reviews done', since: NOW - 180_000 })
  put(disk, 'b', { name: 'build', phase: 'working', task: 'run the build', askedAt: NOW - 840_000 })

  await start($)
  expect(await board($)).toMatchObject({ text: 'The session board is on in this window. /board hides it.' })
  const texts = await band($)

  expect(texts).toContain('done')
  expect(texts).toContain('work')
  expect(texts).toContain('|3m')
  expect(texts).toContain('|14m')

  // a short answer in English is no new ask either
  await $.turn.start({ text: 'run the whole test suite', turnId: 't1' })
  await $.turn.start({ text: 'ok go on', turnId: 't2' })
  expect(own(disk).task).toBe('run the whole test suite')
})

test('a question stays up while a subagent goes on working', KO, async ($, on) => {
  const disk: Disk = new Map()
  const phases: string[] = []
  world(on, disk, {
    // while the question is up, a subagent's tool runs and ends
    whileAsking: async () => {
      await $.tool.call({ tool: 'Grep', pattern: 'x', tool_use_id: 's1', agentId: 'a1' } as never)
      phases.push(own(disk).phase)
    },
  })

  await start($)
  await $.turn.start({ text: '리뷰 돌리고 물어봐 줘', turnId: 't1' })
  await $.tool.call({
    tool: 'AskUserQuestion',
    tool_use_id: 'q1',
    questions: [{ question: '기본값은 켬으로 둘까?', header: '기본값', options: [], multiSelect: false }],
  } as never)

  expect(phases).toEqual(['asking'])
  // answered, it goes back to work
  expect(own(disk).phase).toBe('working')
})

test('a file that does not hold the shape is passed over, and the rest of the board stands', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  put(disk, 'good', { name: '검토 세션', phase: 'done', note: '검토 넷 끝' })
  disk.set(`${DIR}/empty.json`, { text: '{}', mtimeMs: NOW - 1_000 })
  disk.set(`${DIR}/number.json`, { text: '7', mtimeMs: NOW - 1_000 })
  // a phase a later version added
  put(disk, 'newer', { name: '새 판 세션', phase: 'reviewing' as never })
  put(disk, 'odd', { name: '어긋난 세션', phase: 'working', jobs: 3 as never, flows: 'x' as never, since: 'now' as never })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts).toContain('검토 세션')
  expect(texts).not.toContain('새 판 세션')
  expect(texts).not.toContain('어긋난 세션')
})

test('a control character in the file of another session is not drawn', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  const ESC = String.fromCharCode(27)
  put(disk, 'a', { name: `검토${ESC}[2J세션`, phase: 'done', note: `끝${ESC}]0;x${String.fromCharCode(7)}났다` })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts).toContain('검토 [2J세션')
  expect(texts).not.toContain(ESC)
  expect(texts).not.toContain(String.fromCharCode(7))
})

test('goes on under the new id after a clear or a resume', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)

  await start($)
  await $.turn.start({ text: '머지 검증해 줘', turnId: 't1' })
  await $.session.end({ reason: 'resume', sessionId: 'me', resume: {} } as never)
  expect(own(disk).phase).toBe('gone')

  // what it was asked before is of the conversation left behind
  await $.turn.start({ text: '이번에는 배포 문서 고쳐 줘', turnId: 't2' })
  expect(own(disk)).toMatchObject({ phase: 'working', task: '이번에는 배포 문서 고쳐 줘' })
})

test('keeps its files under the folder Claude Code was told to use', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, { env: { CLAUDE_CONFIG_DIR: 'C:/home/.claude', HOME: 'C:/elsewhere' } })

  await start($)

  expect(own(disk).phase).toBe('idle')
})

test('with no home folder known it writes nothing, and says so once', KO, async ($, on) => {
  const disk: Disk = new Map()
  const { toasts } = world(on, disk, { env: {} })

  await start($)
  await $.turn.start({ text: '머지 검증해 줘', turnId: 't1' })

  expect([...disk.keys()].filter(path => path.startsWith(DIR)).length).toBe(0)
  expect(toasts.length).toBe(1)
})

test('a disk that takes no write stands in no tool\'s or turn\'s way', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, { isReadOnly: true })

  await start($)
  await $.turn.start({ text: '머지 검증해 줘', turnId: 't1' })

  expect(await $.tool.call({ tool: 'Read', file_path: 'a.txt' } as never)).toMatchObject({ result: 'ok' })
  expect([...disk.keys()].filter(path => path.startsWith(DIR)).length).toBe(0)
})

test('a command that names a workflow is still a command that ended', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)

  await start($)
  await $.turn.start({ text: '검증 돌려 줘', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm run workflow:lint', run_in_background: true } as never)
  await $.tool.call({ tool: 'Workflow', name: 'final-gate' } as never)
  expect(own(disk).jobs).toEqual(['shell', 'workflow'])

  await $.prompt.submit({
    text: [
      '<task-notification>',
      '<status>completed</status>',
      '<summary>Background command "npm run workflow:lint" completed (exit code 0)</summary>',
      '</task-notification>',
    ].join(NEWLINE),
  } as never)
  expect(own(disk).jobs).toEqual(['workflow'])
})

test('in English a short ask is an ask, and only go-on words are not', async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)

  await start($)
  await $.turn.start({ text: 'run the whole test suite', turnId: 't1' })
  await $.turn.start({ text: 'fix the bug', turnId: 't2' })
  expect(own(disk).task).toBe('fix the bug')

  await $.turn.start({ text: 'Yes, please continue.', turnId: 't3' })
  expect(own(disk).task).toBe('fix the bug')

  // what the person pasted in angle brackets is theirs
  await $.turn.start({ text: '<div> is not closed in App.tsx', turnId: 't4' })
  expect(own(disk).task).toBe('<div> is not closed in App.tsx')
})

test('/board a second time turns the board off again', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)
  others(disk)

  await start($)
  await board($)
  await board($)

  expect(await band($)).toBe(ENGINE_BAND)
})

test('picks up a session that starts waiting later, at the next poll', KO, async ($, on) => {
  const disk: Disk = new Map()
  const { clock } = world(on, disk)

  await start($)
  await board($)
  expect(await band($)).toContain('다른 세션 없음')

  put(disk, 'verify', { phase: 'done', since: clock.now() }, clock.now())
  await clock.advance(5_000)

  expect(await band($)).toContain('verify')
})

test('marks itself gone when the session ends', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk)

  await start($)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'me', resume: {} } as never)

  expect(own(disk).phase).toBe('gone')
})

test('a session without the mod is on the board as Claude Code lists it', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, { alive: [100, 200, 300, 400] })
  list(disk, 200, { name: '검토 세션', status: 'busy' })
  list(disk, 300, { status: 'waiting', cwd: 'C:/work/api' })
  list(disk, 400, { name: '쉬는 세션' })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts).toContain('검토 세션')
  expect(texts).toContain('일함')
  expect(texts).toContain('api')
  expect(texts).toContain('질문')
  expect(texts).toContain('쉬는 세션')
})

test('a listed session whose process ended, or whose file does not read, is not drawn', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, { alive: [100, 200] })
  list(disk, 200, { name: '산 세션' })
  list(disk, 300, { name: '죽은 세션' })
  disk.set(`${SESSIONS}/500.json`, { text: '{"pid":500,"sessionId":"s500"}}}junk', mtimeMs: NOW })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts).toContain('산 세션')
  expect(texts).not.toContain('죽은 세션')
})

test('a session that writes its own file is drawn from that file, once', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, { alive: [100, 200] })
  list(disk, 200, { sessionId: 'a', name: '머지 세션', status: 'idle' })
  put(disk, 'a', { name: '머지 세션', phase: 'done', note: '다 올렸다' })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts.split('머지 세션').length - 1).toBe(1)
  expect(texts).toContain('다 올렸다')
})

test('with no process list to be had, only the sessions that write their own file are drawn', KO, async ($, on) => {
  const disk: Disk = new Map()
  world(on, disk, { alive: null })
  list(disk, 200, { name: '모르는 세션', status: 'busy' })
  put(disk, 'a', { name: '아는 세션' })

  await start($)
  await board($)
  const texts = await band($)

  expect(texts).toContain('아는 세션')
  expect(texts).not.toContain('모르는 세션')
})
