import {
  CancelablePromise,
  canceled,
  CancellationToken,
  CancellationTokenSource,
  createCancelablePromise,
  Disposable,
  dispose,
  Emitter,
  Event,
  IDisposable,
  isDisposable,
  isThenable,
  markTracked,
  toDisposable,
} from '@newstudios/common'
import { Kvo } from './kvo'
import { isAbortError, isCanceledError, normalizeCancelablePromiseWithToken, shortcutEvent } from './utils'

const shallowCompare = <T extends Record<string, any>>(prev: T, current: T) => {
  const keys = Object.keys(prev)
  const keys2 = Object.keys(current)
  if (keys.length !== keys2.length) {
    return false
  }
  for (let i = 0; i < keys.length; i++) {
    if (prev[keys[i]] !== current[keys[i]]) {
      return false
    }
  }
  return true
}

let _taskId = 1

export interface Task<Result = any, State = {}, Err = unknown> extends IDisposable {
  readonly onRestart: Event<void>
  readonly onStart: Event<void>
  readonly onPending: Event<void>
  readonly onRunning: Event<void>
  readonly onAbort: Event<void>
  readonly onComplete: Event<void>
  readonly onError: Event<Err>
  readonly onResult: Event<Result>
  readonly onStatusChange: Event<Task.ChangeEvent<Task.Status>>
  readonly onStateChange: Event<Task.ChangeEvent<State>>
  readonly state: Readonly<State>
  readonly status: Task.Status
  readonly result?: Result
  readonly error?: any
  readonly pending: boolean
  readonly running: boolean
  readonly aborted: boolean
  readonly started: boolean
  readonly completed: boolean
  readonly destroyed: boolean
  readonly id: string
  start(resetState?: boolean): void
  abort(): void
  setState(state: Readonly<State>): void
  resetState(): void
  destroy(): void
  asPromise(): CancelablePromise<Result>
  toRunnable(): (token: CancellationToken) => Promise<Result>
  clone(taskId?: string): Task<Result, State>
  dispatcher: Task.Dispatcher
  name: string
  /** some useful info when debugging */
  readonly tag: string
  readonly stack: string
}

const _STATUS = {
  init: 'init',
  pending: 'pending',
  running: 'running',
  error: 'error',
  abort: 'abort',
  complete: 'complete',
} as const

/**
 * A task's lifecycle can be either one of 6 statuses which are ```init | pending | running | error | abort | complete```.
 *
 * Tasks can be aborted upon init, pending or running status, and can be restarted right upon error and abort status.
 *
 * Once a task is completed, it will no longer emit any other events.
 * Special case when it is completed but not disposed, it can still handle onComplete event, it will emit it immediately
 * each time you subscribe, until disposed.
 *
 */
export namespace Task {
  type StateWithId<S> = S & { _id?: string }

  /**
   * Task creator
   * @param runnable task runnable factory
   * @param initialState task init state, can be undefined or null, default to be `{}`, use `_id` to determinate the customed task.id
   * @param dispatcher a task dispatcher, default to be `Task.Dispatcher.Default` with no limit
   */
  export function create<Result, Err = unknown>(
    runnable: Runnable<Result, {}>,
    initialState?: null,
    dispatcher?: Dispatcher
  ): Task<Result, {}, Err>
  export function create<Result, State extends Record<string, any>, Err = unknown>(
    runnable: Runnable<Result, State>,
    initialState: StateWithId<State>,
    dispatcher?: Dispatcher
  ): Task<Result, State, Err>
  export function create<Result, State extends Record<string, any>, Err = unknown>(
    runnable: Runnable<Result, State>,
    initialState?: StateWithId<State> | null,
    dispatcher?: Dispatcher
  ) {
    return new InternalTask(runnable, (initialState || {}) as State, dispatcher)
  }

  export type ChangeEvent<S> = Kvo.ChangeEvent<S>

  export interface Handler<S extends Record<string, any>> {
    /**
     * Cancellation token for abort control
     */
    readonly token: CancellationToken
    /**
     * Readonly restart count, first time it is 0
     */
    readonly restart: number
    /**
     * Readonly task state delegation
     */
    readonly state: Readonly<S>
    /**
     * Readonly task id delegation
     */
    readonly id: string
    /**
     * Readonly task name delegation
     */
    readonly name: string
    /**
     * A state setter for the current task,
     * works like react class component's `setState`
     * @returns true if setState works, sometimes it is out of running state
     * so that it returns false instead
     */
    readonly setState: (state: Partial<S> | ((prev: S) => S)) => boolean
    /**
     * Reset the task state to the init state
     * @returns true if setState works, sometimes it is out of running state
     * so that it returns false instead
     */
    readonly resetState: () => boolean
  }

  /** Task Runnable function which takes one handler argument and sync/async returns a final result */
  export type Runnable<R, S> = (handler: Handler<S>) => R | Promise<R> | CancelablePromise<R>

  /** Status map */
  export const Status = Object.freeze ? Object.freeze(_STATUS) : _STATUS

  export type Status = keyof typeof Status

  export interface Dispatcher {
    /**
     * This will enqueue a task into the dispatcher, after that
     * current dispatcher take over the task management.
     * Implementer should notice that task can be start mutiple times.
     * @param task the target task
     */
    onStart<Result, Err = any>(task: Dispatcher.ITask<Result, Err>): void
    /**
     * This will dequeue the task from the current dispatcher.
     * Implementor should completely remove the task from dispatcher.
     * @param task the target task
     */
    onStop<Result, Err = any>(task: Dispatcher.ITask<Result, Err>): void
  }

  export namespace Dispatcher {
    export interface ITask<Result = any, Err = any> {
      /**
       * Call this to make task running.
       * Should provide a cancellation token for the task.
       * Moreover, the process will invoke `setResult` / `setError` internally when needed
       * @param token the cancellation token
       */
      run(token: CancellationToken): Promise<Result>
      /**
       * Set the final successful result of the task.
       * @param result the final result
       */
      setResult(result: Result): void
      /**
       * Set the error state of the task.
       * Typically set `Canceled` error when you need to abort the task
       * @param error the error you need to notify task with
       */
      setError(error: Err): void
    }

    class InternalDefaultDispatcher extends Disposable implements Dispatcher {
      private readonly runningSet = new Map<ITask, CancellationTokenSource>()
      private readonly queue = [] as ITask[]
      private readonly tokenSource = new CancellationTokenSource()
      private _disposed = false

      constructor(private readonly maxParallel = 1) {
        super()
        markTracked(this)
      }

      private get runningCount() {
        return this.runningSet.size
      }

      onStart<Result, Err = any>(task: ITask<Result, Err>) {
        if (this._disposed) {
          task.setError(new Error('task dispatcher is already disposed'))
          return
        }
        if (this.queue.indexOf(task) >= 0) {
          return
        }

        this.queue.push(task)
        this.check()
      }

      onStop<T>(task: ITask<T>) {
        const source = this.runningSet.get(task)
        if (source) {
          this.runningSet.delete(task)
          source.dispose(true)
          task.setError(canceled())
          this.check()
        } else {
          const idx = this.queue.indexOf(task)
          if (idx >= 0) {
            this.queue.splice(idx, 1)
            task.setError(canceled())
          }
        }
      }

      private run<T>(task: ITask<T>) {
        const runningSet = this.runningSet
        const oldSource = runningSet.get(task)

        if (this._disposed) {
          task.setError(new Error('task dispatcher is already disposed'))
          if (oldSource) {
            runningSet.delete(task)
            oldSource.dispose()
          }
          // recursively empty the task queue
          this.check()
          return
        }

        if (this.runningCount >= this.maxParallel) {
          // reach the max parallel runnint count
          return
        }

        const source = new CancellationTokenSource(this.tokenSource.token)
        runningSet.set(task, source)

        const finalize = () => {
          if (runningSet.get(task) === source) {
            runningSet.delete(task)
            source.dispose()
            this.check()
          }
        }

        const setResult = (result: T) => {
          if (runningSet.get(task) === source) {
            task.setResult(result)
          }
        }

        const setError = (err: unknown) => {
          if (runningSet.get(task) === source) {
            task.setError(err)
          }
        }

        task.run(source.token).then(setResult, setError).finally(finalize)

        if (oldSource) {
          oldSource.dispose(true)
          this.check()
        }
      }

      private check() {
        if (this.runningCount < this.maxParallel) {
          const task = this.queue.shift()
          if (task) {
            this.run(task)
          }
        }
      }

      dispose() {
        if (!this._disposed) {
          this._disposed = true
          this.tokenSource.dispose(true)
          super.dispose()
        }
      }
    }

    /**
     * A default task dispatcher without any parallel limit.
     * When creating a task with no dispatcher specified,
     * this default one will be used.
     */
    export const Default: Dispatcher = create(Infinity)

    /**
     * A task dispatcher which can run tasks one by one
     * in starting order.
     */
    export const SingleThread: Dispatcher = create(1)

    /**
     * Create a task dispatcher with a max parallel running limit.
     * Tasks more than max limit will be queued in starting order.
     * @param maxParallel the limit to run task parallelly.
     */
    export function create(maxParallel: number): Dispatcher & IDisposable {
      if (maxParallel < 1) {
        throw new Error('Parameter maxParallel should be lager than 0')
      }
      return new InternalDefaultDispatcher(maxParallel)
    }
  }

  export function isInStatus(src: Status, ...dest: Status[]) {
    for (let i = 0; i < dest.length; i++) {
      if (src === dest[i]) {
        return true
      }
    }
    return false
  }

  export interface JoinOptions<Result, State, S = {}> {
    maxParallel?: number
    dispatcher?: Dispatcher
    onTaskStarted?: (
      task: Task<Result, State>,
      index: number,
      parentHandler: Handler<S>,
      disposables: IDisposable[]
    ) => void | IDisposable
    initState?: StateWithId<S>
  }

  /**
   * Join tasks as a unique task
   * @param tasks tasks to be join
   * @param options.maxParallel max runnning count for these tasks, default is 1
   * @param options.dispatcher the new joint task dispatcher
   * @param options.onTaskStarted the callback when sub task started
   * @param options.initState the new joint task init state
   * @returns
   */
  export function join<Result, State, S = {}>(
    tasks: readonly Task<Result, State>[],
    options: JoinOptions<Result, State, S> = {}
  ) {
    const taskList = tasks.slice()
    taskList.forEach(t => isInStatus(t.status, Status.pending, Status.running) && t.abort())
    const { maxParallel = 1, dispatcher, onTaskStarted, initState = {} as StateWithId<S> } = options

    return Task.create(
      h => {
        const dispatcher = Dispatcher.create(maxParallel)
        const disposables = [dispatcher] as IDisposable[]
        return Promise.all(
          taskList.map((t, index) => {
            if (t.destroyed) {
              return Promise.reject(new Error(`${t.tag} is already destroyed`))
            }
            if (t.completed) {
              return Promise.resolve(t.result as Result)
            }
            t.dispatcher = dispatcher
            h.token.onCancellationRequested(t.abort, t, disposables)
            t.start()
            if (t.started && onTaskStarted) {
              const d = onTaskStarted(t, index, h, disposables)
              if (d && isDisposable(d)) {
                disposables.push(d)
              }
            }
            return t.asPromise()
          })
        ).finally(() => dispose(disposables))
      },
      initState,
      dispatcher
    )
  }

  class InternalTask<Result = any, State = any, Err = unknown>
    extends Disposable
    implements Task<Result, State, Err>, Dispatcher.ITask<Result, Err> {
    private readonly _runnable: Runnable<Result, State>

    private _status: Status = Status.init
    public readonly onStatusChange = Kvo.observe(this, '_status')

    public readonly onRestart = Event.signal(
      Event.filter(this.onStatusChange, ({ prev, current }) => {
        return isInStatus(prev, Status.abort, Status.error) && isInStatus(current, Status.pending, Status.running)
      })
    )
    public readonly onStart = Event.signal(
      Event.filter(this.onStatusChange, ({ prev, current }) => {
        return (
          isInStatus(prev, Status.init, Status.abort, Status.error) &&
          isInStatus(current, Status.pending, Status.running)
        )
      })
    )
    public readonly onPending = Event.signal(
      Event.filter(this.onStatusChange, ({ current }) => {
        return isInStatus(current, Status.pending)
      })
    )
    public readonly onRunning = Event.signal(
      Event.filter(this.onStatusChange, ({ current }) => {
        return isInStatus(current, Status.running)
      })
    )
    public readonly onAbort = Event.signal(
      Event.filter(this.onStatusChange, ({ current }) => {
        return isInStatus(current, Status.abort)
      })
    )
    public readonly onError = Event.map(
      Event.filter(this.onStatusChange, ({ current }) => {
        return isInStatus(current, Status.error)
      }),
      () => this._error
    )
    public readonly onResult = Event.map(
      Event.filter(this.onStatusChange, ({ current }) => {
        return isInStatus(current, Status.complete) && this._done
      }),
      () => this._result as Result
    )

    private readonly _onComplete = this._register(new Emitter<void>())
    public readonly onComplete: Event<void> = (listener, thisArgs?, disposables?) => {
      const event = this._disposed ? Event.None : this.completed ? shortcutEvent : this._onComplete.event
      return event(listener, thisArgs, disposables)
    }

    private _state: State
    public readonly onStateChange = Kvo.observe(this, '_state')

    private _disposing = false
    private _disposed = false
    private _dispatcher: Dispatcher
    private _stack: string

    private _done = false
    private _result?: Result
    private _error?: any
    private _restart = 0

    public name: string
    public readonly onNameChange = Kvo.observe(this, 'name')

    private readonly _initState: State
    private readonly _id: string
    private internal = false

    constructor(
      runnable: Runnable<Result, State>,
      initialState: StateWithId<State>,
      dispatcher: Dispatcher = Dispatcher.Default
    ) {
      super()
      // no need to track Task
      markTracked(this)

      const { _id = `Task-${_taskId++}`, ...initState } = initialState
      this.name = runnable.name || 'anonymous'
      this._stack = new Error(this.tag).stack!
      this.onNameChange(() => (this._stack = this._stack.replace(/Error: .*\n/m, `Error: ${this.tag}\n`)))

      this._id = _id
      this._initState = initState as State
      this._state = Object.assign({}, this._initState)
      this._dispatcher = dispatcher
      this._runnable = runnable

      // register status change handler
      this.onStatusChange(({ current }) => current === Status.complete && this._onComplete.fire())

      // register restart counter handler
      this.onRestart(() => this._restart++)
    }

    public get tag() {
      return `Task[${this.name}]`
    }

    public get id() {
      return this._id
    }

    private warn(message: any, ...args: any[]) {
      !this.internal && console.warn(`${this.tag}:`, message, ...args)
    }

    private callWithoutWarn<T>(block: () => T): T {
      let internal = this.internal
      this.internal = true
      const r = block()
      this.internal = internal
      return r
    }

    public set dispatcher(dispatcher: Dispatcher) {
      if (this.destroyed) {
        this.warn('Set dispatcher failed since task is destroyed')
        return
      }
      if (this._dispatcher === dispatcher) {
        return
      }
      this.callWithoutWarn(() => {
        if (this.running || this.pending) {
          this.abort()
          this._dispatcher = dispatcher
          this.start()
        } else {
          this._dispatcher = dispatcher
        }
      })
    }

    public get dispatcher() {
      return this._dispatcher
    }

    public get state() {
      return this._state
    }

    public get status() {
      return this._status
    }

    public setState(current: Readonly<State>) {
      if (this.destroyed) {
        this.warn('task is already destroyed, so it could not be started')
        return
      }

      if (this.completed) {
        this.warn('task is alrady completed, so its state cannot be changed / reset')
        return
      }

      if (!shallowCompare(this._state, current)) {
        this._state = current
      }
    }

    public resetState() {
      this.setState(this._initState)
    }

    private setStatus(current: Status) {
      if (this._status !== current) {
        const prev = this._status
        if (prev === Status.complete || this.destroyed) {
          this.warn('cannot set status any more if task has completed or being destroyed')
          return
        }
        if (prev === Status.error) {
          this._error = undefined
        }
        this._status = current
      }
    }

    public setResult(result: Result) {
      if (this._done || this.completed) {
        return
      }
      this._result = result
      this._done = true
      this.setStatus(Status.complete)
    }

    public setError(error: unknown) {
      if (!this.running || this.completed) {
        return
      }
      if (isCanceledError(error) || isAbortError(error)) {
        this.setStatus(Status.abort)
        return
      }
      if (error instanceof Error) {
        let stack = error.stack || ''
        stack += '\n' + this.stack
        error.stack = stack
      }
      this._error = error
      this.setStatus(Status.error)
    }

    public get started() {
      return this._status === Status.pending || this._status === Status.running
    }

    public get pending() {
      return this._status === Status.pending
    }

    public get running() {
      return this._status === Status.running
    }

    public get aborted() {
      return this._status === Status.abort
    }

    public get completed() {
      return this._status === Status.complete
    }

    public get error() {
      return this._status === Status.error ? this._error : undefined
    }

    public get result() {
      return this._result
    }

    public start(resetState = false) {
      if (this.destroyed) {
        this.warn('task is already destroyed, so it could not be started')
        return
      }

      if (this.completed) {
        this.warn('task is alrady completed, so it could not be restarted')
        return
      }

      if (this.started) {
        this.warn('task is started already')
        return
      }

      // FIXME set before or after starting, and emit onReset or not
      if (resetState) {
        this.setState(this._initState)
      }

      this.dispatcher.onStart(this)

      if (!this.running) {
        this.setStatus(Status.pending)
      }
    }

    public abort() {
      if (this._disposed) {
        this.warn('task is disposed already')
        return
      }
      if (this.completed) {
        console.warn('task is completed or distroyed')
        return
      }
      this.dispatcher.onStop(this)
      this.setStatus(Status.abort)
    }

    public get stack() {
      return this._stack
    }

    public destroy() {
      this.dispose()
    }

    public get destroyed() {
      return this._disposed
    }

    public clone(taskId?: string) {
      const initState = typeof taskId === 'undefined' ? this._initState : { _id: taskId, ...this._initState }
      return Task.create(this._runnable, initState, this.dispatcher)
    }

    public dispose() {
      if (!this._disposed && !this._disposing) {
        this.callWithoutWarn(() => {
          this._disposing = true
          this.abort()
          this.setStatus(Status.complete)
          super.dispose()
          this._disposed = true
          this._disposing = false
        })
      }
    }

    public asPromise() {
      return createCancelablePromise(this.toRunnable())
    }

    public toRunnable() {
      return (token: CancellationToken) => {
        const disposables: IDisposable[] = []
        return new Promise<Result>((resolve, reject) => {
          if (this._disposed) {
            reject(new Error(`${this.tag} is already disposed`))
            return
          }
          if (this._done) {
            resolve(this._result as Result)
            return
          }
          if (this._error) {
            reject(this._error)
            return
          }
          if (this.aborted) {
            reject(canceled())
            return
          }

          token.onCancellationRequested(this.abort, this, disposables)
          this.onResult(resolve, null, disposables)
          this.onError(reject, null, disposables)
          this.onAbort(() => reject(canceled()), null, disposables)
        }).finally(() => dispose(disposables))
      }
    }

    public run(token: CancellationToken): Promise<Result> {
      if (this.destroyed) {
        return Promise.reject(new Error('cannot run task for it is disposed'))
      }
      if (this.completed) {
        return Promise.reject(new Error('cannot run task for it is completed already'))
      }
      if (this.running) {
        return Promise.reject(new Error("cannot run task for it's been running now"))
      }
      if (token.isCancellationRequested) {
        return Promise.reject(canceled())
      }

      this.setStatus(Status.running)

      // task is about to run
      const disposables: IDisposable[] = []
      let running = true
      const restart = this._restart

      disposables.push(
        toDisposable(() => {
          running = false
        })
      )

      return new Promise<Result>((resolve, reject) => {
        // abort immediatelly because we need to
        token.onCancellationRequested(() => reject(canceled()), null, disposables)

        const task = this
        const setState = (state: Partial<State> | ((prev: State) => State)) => {
          if (!running) {
            return false
          }
          let newState: State
          if (typeof state === 'function') {
            newState = state(task.state)
          } else {
            newState = Object.assign({}, task.state, state)
          }
          task.setState(newState)
          return true
        }
        const resetState = () => {
          if (!running) {
            return false
          }
          task.setState(task._initState)
          return true
        }
        const handler: Handler<State> = {
          get state() {
            return task.state
          },
          get id() {
            return task.id
          },
          get name() {
            return task.name
          },
          get token() {
            return token
          },
          get restart() {
            return restart
          },
          get setState() {
            return setState
          },
          get resetState() {
            return resetState
          },
        }

        // run task runnable now with state-safe handler
        const result = normalizeCancelablePromiseWithToken(this._runnable(handler), token)

        if (isThenable(result)) {
          result.then(resolve, reject)
        } else {
          resolve(result)
        }
      }).finally(() => dispose(disposables))
    }
  }
}
