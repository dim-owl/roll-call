/**
 * idle: no turn yet. done / asking / permit: the session waits for the person.
 * failed: its turn broke off on an API error. gone: it ended.
 */
export type Phase = 'idle' | 'working' | 'done' | 'asking' | 'permit' | 'failed' | 'gone'

/** As the board reads a session. waiting: it finished its turn on a message to another session. */
export type Shown = Phase | 'waiting'

/** What a session writes about itself, one file per session. */
export type Entry = {
  /** The name the person gave the session, when it has one. */
  name?: string
  where: string
  branch: string
  phase: Phase
  since: number
  /** What the person last asked of it, one line. */
  task?: string
  /** When they asked it: the work on it began then, whatever turns it took since. */
  askedAt?: number
  /** What it wants of the person while it waits: its question, or how it ended. */
  note?: string
  /** Subagents of its own still running. */
  agents?: number
  /**
   * Background work of its own in flight, one kind a piece as the engine names
   * it: shell, workflow, monitor. Added to as the session starts one, and set
   * right by the engine's own list each time a turn or a subagent ends.
   */
  jobs?: string[]
  /** The session it wrote to in its turn, by name. */
  to?: string
  /** The workflow runs it has going, as it counted their agents. */
  flows?: Flow[]
}

/**
 * A workflow run by its agents: how many it started and how many of those
 * ended. A run starts agents as it goes, so `started` is not what it will come to.
 */
export type Flow = { name: string; done: number; started: number; since: number }

/** Another session as this one last read it. */
export type Seen = {
  name?: string
  where: string
  branch: string
  /** As the board reads it: a session whose subagents or background work still run is at work. */
  phase: Shown
  waitedMin: number
  /** Minutes since the person asked what it works on; absent when it is not at work. */
  workedMin?: number
  /** What it has running, each a kind and a count: agents 3, shell 2. */
  tags: Tag[]
  /** The one line beside the name. */
  line: string
  /** Its workflow runs, each a bar on its line, ahead of what it was asked. */
  flows: (Pick<Flow, 'name' | 'done' | 'started'> & { min: number })[]
}

/** A count of one kind of running work, in the color of its kind. */
export type Tag = { text: string; color: string }

declare module 'claude-code' {
  interface PluginState {
    'roll-call': { others: Seen[]; isShown: boolean }
  }
}
