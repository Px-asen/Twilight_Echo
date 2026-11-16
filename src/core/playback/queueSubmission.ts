import type {
  CoreQueueSubmitCommand,
  CoreQueueSubmitReply,
  CoreQueueTrackInput,
  CoreQueueInsert
} from '../../shared/coreQueueSubmission.ts'
import {
  LIBRARY_QUEUE_BUILD_IDLE_MS,
  LIBRARY_QUEUE_BUILD_MAX_ENTRIES,
  type LibraryQueueSeedItem
} from '../../shared/libraryQueueBuild.ts'
import type { CorePlaybackSession } from './session.ts'

interface Submission {
  id: string
  clientId: string
  sequence: number
  total: number
  selectedIndex: number
  progressive: boolean
  progressiveCommitting: boolean
  adopted: boolean
  adoptedQueueId: string | null
  extended: boolean
  controller: AbortController
  append: ((items: readonly LibraryQueueSeedItem[]) => Promise<void>) | null
  finish(): void
  work: Promise<void>
  busy: boolean
  committing: boolean
  cancelTimer(): void
}
interface Options {
  playback: Pick<CorePlaybackSession, 'fromPages' | 'edit' | 'snapshot'> &
    Partial<
      Pick<CorePlaybackSession, 'canExtendSubmitted' | 'extendSubmitted' | 'finishSubmitted'>
    >
  resolve(
    items: readonly CoreQueueTrackInput[],
    signal: AbortSignal
  ): Promise<LibraryQueueSeedItem[]>
  newId(): string
  schedule(callback: () => void, delay: number): () => void
}

/** A bounded upload into the existing hidden SQLite builder, not another
 * playback state owner. Progressive foreground uploads commit once the initial
 * selected batch lands and stream remaining batches through extendSubmitted. */
export class CoreQueueSubmission {
  private readonly submissions = new Map<string, Submission>()
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
  }
  async insert(command: CoreQueueInsert, signal: AbortSignal) {
    const items = await this.options.resolve(command.items, signal)
    signal.throwIfAborted()
    await this.options.playback.edit(command.id, command.revision, {
      kind: 'insert', afterEntryId: command.afterEntryId, beforeEntryId: command.beforeEntryId,
      items: items.map((item) => ({ id: item.id, snapshot: item.localSnapshot ?? item.snapshot }))
    })
    return this.options.playback.snapshot().queue
  }

  async submit(clientId: string, command: CoreQueueSubmitCommand): Promise<CoreQueueSubmitReply> {
    if (command.kind === 'begin') return this.begin(clientId, command)
    const submission = this.submissions.get(command.id)
    if (!submission || submission.clientId !== clientId)
      throw new Error('队列提交已结束，请重新选择')
    if (command.kind === 'abort') {
      submission.controller.abort(new Error('队列提交已取消'))
      await submission.work.catch(() => {})
      this.cleanup(submission)
      return this.reply(submission, 'aborted')
    }
    if (submission.busy || submission.committing) throw new Error('请等待上一批队列提交完成')
    if (command.sequence !== submission.sequence + 1)
      throw new Error('队列批次已变化，不可重放旧批次')
    submission.controller.signal.throwIfAborted()
    submission.busy = true
    submission.cancelTimer()
    try {
      if (command.kind === 'append') {
        if (submission.total + command.items.length > LIBRARY_QUEUE_BUILD_MAX_ENTRIES)
          throw new Error('队列已达到容量上限')
        const items = await this.options.resolve(command.items, submission.controller.signal)
        submission.controller.signal.throwIfAborted()
        if (submission.adopted) {
          const extended = await this.options.playback.extendSubmitted!(
            submission.adoptedQueueId!,
            items,
            submission.controller.signal
          )
          submission.sequence = command.sequence
          if (!extended) {
            this.cleanup(submission)
            return this.reply(submission, 'aborted')
          }
          submission.total += items.length
          submission.extended = true
          this.arm(submission)
          return this.reply(submission, 'committed')
        }
        await submission.append!(items)
        submission.sequence = command.sequence
        submission.total += items.length
        if (submission.progressive && submission.total > submission.selectedIndex) {
          submission.committing = true
          submission.progressiveCommitting = true
          submission.finish()
          await submission.work
          submission.committing = false
          submission.progressiveCommitting = false
          const queueId = this.options.playback.snapshot().queue?.id ?? null
          if (!queueId) {
            this.cleanup(submission)
            return this.reply(submission, 'aborted')
          }
          submission.adopted = true
          submission.adoptedQueueId = queueId
          this.arm(submission)
          return this.reply(submission, 'committed')
        }
        this.arm(submission)
        return this.reply(submission, 'building')
      }
      if (submission.adopted) {
        submission.sequence = command.sequence
        this.cleanup(submission)
        if (submission.extended) {
          await this.options.playback.finishSubmitted?.(submission.adoptedQueueId!)
        }
        return this.reply(submission, 'committed')
      }
      if (submission.selectedIndex >= submission.total) throw new Error('队列选中项不存在')
      submission.committing = true
      submission.sequence = command.sequence
      submission.finish()
      await submission.work
      this.cleanup(submission)
      return this.reply(submission, 'committed')
    } catch (error) {
      submission.progressiveCommitting = false
      submission.committing = false
      submission.controller.abort(error)
      await submission.work.catch(() => {})
      this.cleanup(submission)
      throw error
    } finally {
      submission.busy = false
    }
  }

  private async begin(
    clientId: string,
    command: Extract<CoreQueueSubmitCommand, { kind: 'begin' }>
  ) {
    // A window has one upload in flight. Replacing it discards only its hidden builder.
    await this.disconnect(clientId)
    const progressive =
      command.progressive === true &&
      command.play !== false &&
      Boolean(this.options.playback.extendSubmitted) &&
      (this.options.playback.canExtendSubmitted?.() ?? true)
    const controller = new AbortController()
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    let finish!: () => void
    const complete = new Promise<void>((resolve, reject) => {
      finish = resolve
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true
      })
    })
    void complete.catch(() => {})
    const submission: Submission = {
      id: this.options.newId(),
      clientId,
      sequence: 0,
      total: 0,
      selectedIndex: command.selectedIndex,
      progressive,
      progressiveCommitting: false,
      adopted: false,
      adoptedQueueId: null,
      extended: false,
      controller,
      append: null,
      finish,
      work: Promise.resolve(),
      busy: false,
      committing: false,
      cancelTimer: () => {}
    }
    this.submissions.set(submission.id, submission)
    submission.work = this.options.playback
      .fromPages(
        async (append) => {
          submission.append = append
          ready()
          await complete
        },
        {
          selectedIndex: command.selectedIndex,
          position: command.position,
          play: command.play,
          ...(command.mode ? { mode: command.mode } : {})
        },
        controller.signal
      )
      .finally(() => {
        if (!submission.adopted && !submission.progressiveCommitting) this.cleanup(submission)
      })
    // Preparation failure must also release a caller waiting for begin.
    await Promise.race([started, submission.work])
    if (!submission.append) throw new Error('无法创建队列')
    void submission.work.catch(() => {})
    this.arm(submission)
    return this.reply(submission, 'building')
  }

  private cleanup(submission: Submission): void {
    submission.cancelTimer()
    if (this.submissions.get(submission.id) === submission) {
      this.submissions.delete(submission.id)
    }
  }
  private reply(
    submission: Submission,
    state: CoreQueueSubmitReply['state']
  ): CoreQueueSubmitReply {
    return { id: submission.id, state, sequence: submission.sequence, total: submission.total }
  }
  private arm(submission: Submission): void {
    submission.cancelTimer = this.options.schedule(() => {
      submission.controller.abort(new Error('队列提交已超时'))
      this.cleanup(submission)
    }, LIBRARY_QUEUE_BUILD_IDLE_MS)
  }
  async disconnect(clientId: string): Promise<void> {
    const work: Promise<void>[] = []
    for (const submission of [...this.submissions.values()]) {
      if (submission.clientId !== clientId || submission.committing) continue
      submission.controller.abort(new Error('队列提交窗口已断开'))
      this.cleanup(submission)
      work.push(submission.work)
    }
    await Promise.allSettled(work)
  }
  async shutdown(): Promise<void> {
    const submissions = [...this.submissions.values()]
    for (const submission of submissions) {
      submission.controller.abort(new Error('Core is shutting down'))
      this.cleanup(submission)
    }
    await Promise.allSettled(submissions.map((submission) => submission.work))
  }
}
