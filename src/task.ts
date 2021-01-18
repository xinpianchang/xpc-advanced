import {
  CancelablePromise,
  canceled,
  CancellationToken,
  CancellationTokenSource,
  createCancelablePromise,
  Disposable,
  DisposableStore,
  Emitter,
  Event,
  IDisposable,
  isThenable,
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

export interface Task<Result, State> extends IDisposable {
  readonly onRestart: Event<void>
  readonly onStart: Event<void>
  readonly onPending: Event<void>
  readonly onRunning: Event<void>
  readonly onAbort: Event<void>
  readonly onComplete: Event<void>
  readonly onError: Event<unknown>
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
  start(resetState?: boolean): void
  abort(): void
  /**
   * @deprecated use dispose instead
   */
  destroy(): void
  asPromise(): CancelablePromise<Result>
  dispatcher: Task.Dispatcher
  name: string
}

/**
 * A task's lifecycle can be either one of 6 states which are ```init | pending | running | error | abort | complete```.
 *
 * Tasks can be aborted upon init, pending or running state, and can be restarted right upon error and abort state.
 *
 * Once a task is completed, it will no longer emit any other events.
 * Special case when it is completed but not disposed, it can still handle onComplete event since it will emit it each time you subscribe.
 *
 */
export namespace Task {
  /**
   * Task creator
   * @param runnable task runnable factory
   * @param initialState task init state, can be undefined or null, default to be `{}`
   * @param dispatcher a task dispatcher, default to be `Task.Dispatcher.Default` with no limit
   */
  export function create<Result>(
    runnable: Runnable<Result, {}>,
    initialState?: null,
    dispatcher?: Dispatcher
  ): Task<Result, {}>
  export function create<Result, State extends Record<string, any>>(
    runnable: Runnable<Result, State>,
    initialState: State,
    dispatcher?: Dispatcher
  ): Task<Result, State>
  export function create<Result, State extends Record<string, any>>(
    runnable: Runnable<Result, State>,
    initialState?: State | null,
    dispatcher?: Dispatcher
  ) {
    return new InternalTask(runnable, (initialState || {}) as State, dispatcher)
  }

  export interface ChangeEvent<S> {
    prev: S
    current: S
  }

  export interface Handler<S extends Record<string, any>> {
    /**
     * Cancellation token for abort control
     */
    readonly token: CancellationToken
    /**
     * Readonly latest task state
     */
    readonly state: Readonly<S>
    /**
     * Readonly restart count, first time it is 0
     */
    readonly restart: number
    /**
     * A state setter for the current task,
     * works like react class component's `setState`
     * @returns true if setState works, sometimes it is out of running state
     * so that it returns false instead
     */
    readonly setState: (state: Partial<S> | ((prev: S) => S)) => boolean
  }

  export type Runnable<R, S> = (handler: Handler<S>) => R | Promise<R> | CancelablePromise<R>

  export const Status = {
    init: 'init',
    pending: 'pending',
    running: 'running',
    error: 'error',
    abort: 'abort',
    complete: 'complete',
  } as const

  export type Status = keyof typeof Status

  export interface Dispatcher {
    /**
     * This will enqueue a task into the dispatcher, after that
     * current dispatcher take over the task management.
     * Implementer should notice that task can be start mutiple times.
     * @param task the target task
     */
    start<T>(task: Dispatcher.ITask<T>): void
    /**
     * This will dequeue the task from the current dispatcher.
     * Implementor should completely remove the task from dispatcher.
     * @param task the target task
     */
    stop<T>(task: Dispatcher.ITask<T>): void
  }

  export namespace Dispatcher {
    export interface ITask<T> {
      /**
       * Call this to make task running.
       * Should provide a cancellation token for the task.
       * Moreover, the process will invoke `setResult` / `setError` internally when needed
       * @param token the cancellation token
       */
      run(token: CancellationToken): Promise<T>
      /**
       * Set the final successful result of the task.
       * @param result the final result
       */
      setResult(result: T): void
      /**
       * Set the error state of the task.
       * Typically set `Canceled` error when you need to abort the task
       * @param error the error you need to notify task with
       */
      setError(error: any): void
    }

    class InternalDefaultDispatcher extends Disposable implements Dispatcher {
      private readonly runningSet = new Map<ITask<any>, CancellationTokenSource>()
      private readonly queue = [] as ITask<any>[]
      private readonly tokenSource = new CancellationTokenSource()
      private _disposed = false

      constructor(private readonly maxParallel = 1) {
        super()
      }

      private get runningCount() {
        return this.runningSet.size
      }

      start<T>(task: ITask<T>) {
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

      stop<T>(task: ITask<T>) {
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
        this._disposed = true
        this.tokenSource.dispose(true)
        super.dispose()
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

  class InternalTask<Result = any, State = any>
    extends Disposable
    implements Task<Result, State>, Dispatcher.ITask<Result> {
    private readonly _runnable: Runnable<Result, State>

    private _status: Status = Status.init
    public readonly onStatusChange = Kvo.observe<ChangeEvent<Status>>(this, '_status')

    public readonly onRestart = Event.signal(
      Event.filter(this.onStatusChange, ({ prev, current }) => {
        return isInStatus(prev, Status.abort, Status.error) && isInStatus(current, Status.pending, Status.running)
      })
    )
    public readonly onStart = Event.signal(
      Event.filter(this.onStatusChange, ({ prev, current }) => {
        return isInStatus(prev, Status.init) && isInStatus(current, Status.pending, Status.running)
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

    private readonly _onStateChange = this._register(new Emitter<ChangeEvent<State>>())
    public readonly onStateChange = this._onStateChange.event

    private readonly _onComplete = this._register(new Emitter<void>())
    public readonly onComplete: Event<void> = (listener, thisArgs?, disposables?) => {
      const event = this._disposed ? Event.None : this.completed ? shortcutEvent : this._onComplete.event
      return event(listener, thisArgs, disposables)
    }

    private _disposed = false
    private _state: State
    private _dispatcher: Dispatcher
    private _stack: string

    private _done = false
    private _result?: Result
    private _error?: any
    private _restart = 0

    public name: string
    private readonly _initState: State
    private internal = false

    constructor(runnable: Runnable<Result, State>, initialState: State, dispatcher: Dispatcher = Dispatcher.Default) {
      super()
      this.name = runnable.name || 'anonymous'
      this._stack = new Error(`Task[${this.name}]`).stack!

      this._initState = initialState
      this._state = Object.assign({}, initialState)
      this._dispatcher = dispatcher

      // register status change handler
      this._register(
        Event.filter(this.onStatusChange, ({ current }) => current === Status.complete)(() => this._onComplete.fire())
      )

      // register restart counter handler
      this.onRestart(() => this._restart++)

      this._runnable = runnable
    }

    private warn(message: any, ...args: any[]) {
      !this.internal && console.warn(`Task[${this.name}]:`, message, ...args)
    }

    private callWithoutWarn(block: () => void) {
      let internal = this.internal
      this.internal = true
      block()
      this.internal = internal
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

    public setState(current: State) {
      if (this._state !== current) {
        const prev = this._state
        this._state = current

        // FIXME?
        if (!shallowCompare(prev, current)) {
          this._onStateChange.fire({
            prev,
            current,
          })
        }
      }
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

      // FIXME set before or after starting
      if (resetState) {
        this.setState(this._initState)
      }

      this.dispatcher.start(this)

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
      this.dispatcher.stop(this)
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

    public dispose() {
      if (!this._disposed) {
        this.callWithoutWarn(() => {
          this.abort()
          this.setStatus(Status.complete)
          super.dispose()
          this._disposed = true
        })
      }
    }

    public asPromise() {
      return createCancelablePromise(token => {
        return new Promise<Result>((resolve, reject) => {
          if (this._disposed) {
            reject(new Error(`task[${this.name}] is already disposed`))
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
          if (this.status === Status.abort) {
            reject(canceled())
            return
          }

          token.onCancellationRequested(this.abort, this)

          Event.toPromise(this.onResult).then(resolve)
          Event.toPromise(this.onError).then(reject)
          Event.toPromise(this.onAbort).then(() => reject(canceled()))
        })
      })
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
      const store = new DisposableStore()
      let running = true
      const restart = this._restart

      store.add(
        toDisposable(() => {
          running = false
        })
      )
      const finalize = store.dispose.bind(store)

      return new Promise<Result>((resolve, reject) => {
        // abort immediatelly because we need to
        token.onCancellationRequested(() => reject(canceled()), null, store)

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
        const handler: Handler<State> = {
          get state() {
            return task.state
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
        }

        // run task runnable now with state-safe handler
        const result = normalizeCancelablePromiseWithToken(this._runnable(handler), token)

        if (isThenable(result)) {
          result.then(resolve, reject)
        } else {
          resolve(result)
        }
      }).finally(finalize)
    }
  }
}
