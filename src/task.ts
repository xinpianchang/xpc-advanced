import { CancelablePromise, canceled, CancellationToken, Disposable, DisposableStore, Emitter, Event, IDisposable, isThenable, toDisposable } from '@newstudios/common'
import { normalizeCancelablePromiseWithToken, shortcutEvent } from './utils'

const shadowCompare = <T extends Record<string, any>>(prev: T, current: T) => {
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
  readonly onStatusChange: Event<Task.ChangeEvent<Task.Status>>
  readonly onStateChange: Event<Task.ChangeEvent<State>>
  readonly name: string
  readonly state: Readonly<State>
  readonly status: Task.Status
  readonly result?: Result
  readonly error?: any
  readonly pending: boolean
  readonly running: boolean
  readonly aborted: boolean
  readonly completed: boolean
  readonly destroyed: boolean
  start(resetState?: boolean): void
  abort(): void
  /**
   * @deprecated use dispose instead
   */
  destroy(): void
  dispatcher: Task.Dispatcher
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

  export function create<Result>(
    runnable: Runnable<Result, {}>,
  ): Task<Result, {}>
  export function create<Result, State extends Record<string, any>>(
    runnable: Runnable<Result, State>,
    initialState: State,
    dispatcher?: Dispatcher,
  ): Task<Result, State>
  export function create<Result, State extends Record<string, any>>(
    runnable: Runnable<Result, State>,
    initialState: State = {} as State,
    dispatcher?: Dispatcher,
  ) {
    return new InternalTask(runnable, initialState, dispatcher)
  }

  export interface ChangeEvent<S> {
    prev: S
    current: S
  }

  export interface Handler<S extends Record<string, any>> {
    readonly token: CancellationToken
    readonly state: Readonly<S>
    readonly setState: (state: Partial<S> | ((prev: S) => S)) => void
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
    start(task: Task<unknown, any>): void
    stop(task: Task<unknown, any>): void
  }

  export namespace Dispatcher {
    export const Default = null as any as Dispatcher

    export interface Options<T extends Task<any, any>> {
      push(task: T): void
      shift(): T | undefined
      highWaterMark(): boolean
      delete(task: T): T | undefined
      clear(): void
    }

  //   class InternalDispatcher extends Disposable implements Dispatcher {

  //     private readonly queued = new LinkedList<InternalTask>()
  //     private _disposed = false
  
  //     // constructor(options: Options) {
  //     //   super()
  //     // }
  
  //     private take(): InternalTask | undefined {
  //       return undefined
  //     }
  
  //     private highWaterMark() {
  //       return false
  //     }
  
  //     public start(task: InternalTask) {
  //       if (task.dispatcher !== this) {
  //         throw new Error('task does not belong to this dispatcher')
  //       }
  //       switch (task.status) {
  //         case Status.pending:
  //         case Status.running:
  //           return
  //         case Status.complete:
  //           console.warn('a completed task cannot be restarted')
  //           return
  //         case Status.error:
  //         case Status.abort:
  //         case Status.init:
  //           if (this.highWaterMark()) {
  //             // this.enqueue(task)
  //           } else {
  //             // this.run(task)
  //           }
  //           return
  //       }
  //     }
  
  //     public stop(task: InternalTask) {
  //       throw new Error('Method not implemented.')
  //     }
  
  //     public dispose() {
  //       if (!this._disposed) {
  //         this.queued.toArray().forEach(task => task.dispose())
  //         this.queued.clear()
  //         super.dispose()
  //         this._disposed = true
  //       }
  //     }
  //   }
  }

  export function isInStatus(src: Status, ...dest: Status[]) {
    for (let i = 0; i < dest.length; i++) {
      if (src === dest[i]) {
        return true
      }
    }
    return false
  }

  class InternalTask<Result = any, State = any> extends Disposable implements Task<Result, State> {
    private readonly _onComplete = this._register(new Emitter<void>())
    private readonly _runnable: Runnable<Result, State>
  
    private readonly _onStatusChange = this._register(new Emitter<ChangeEvent<Status>>())
    public readonly onStatusChange = this._onStatusChange.event
    public readonly onRestart = Event.signal(Event.filter(this.onStatusChange, ({prev, current}) => {
      return isInStatus(prev, Status.abort, Status.error) && isInStatus(current, Status.pending, Status.running)
    }))
    public readonly onStart = Event.signal(Event.filter(this.onStatusChange, ({prev, current}) => {
      return isInStatus(prev, Status.init) && isInStatus(current, Status.pending, Status.running)
    }))
    public readonly onPending = Event.signal(Event.filter(this.onStatusChange, ({current}) => {
      return isInStatus(current, Status.pending)
    }))
    public readonly onRunning = Event.signal(Event.filter(this.onStatusChange, ({current}) => {
      return isInStatus(current, Status.running)
    }))
    public readonly onAbort = Event.signal(Event.filter(this.onStatusChange, ({current}) => {
      return isInStatus(current, Status.abort)
    }))
    public readonly onError = Event.map(Event.filter(this.onStatusChange, ({current}) => {
      return isInStatus(current, Status.error)
    }), () => this._error)

    private readonly _onStateChange = this._register(new Emitter<ChangeEvent<State>>())
    public readonly onStateChange = this._onStateChange.event
  
    private _disposed = false
    private _state: State
    private _status: Status = Status.init
    private _dispatcher: Dispatcher
    private _stack: string

    private _result?: Result
    private _error?: any

    public readonly name: string
    private readonly _initState: State
  
    constructor(
      runnable: Runnable<Result, State>,
      initialState: State,
      dispatcher: Dispatcher = Dispatcher.Default,
    ) {
      super()
      this.name = runnable.name || 'anonymous'
      this._stack = new Error(`Task[${this.name}]`).stack!

      this._initState = initialState
      this._state = Object.assign({}, initialState)
      this._dispatcher = dispatcher
      this.onStatusChange(({current}) => {
        if (isInStatus(current, Status.complete)) {
          this._onComplete.fire()
        }
      })

      this._runnable = runnable
    }
  
    public set dispatcher(dispatcher: Dispatcher) {
      this.assertNotDisposed()
      if (this._dispatcher === dispatcher) {
        return
      }
      switch (this._status) {
        case 'running':
        case 'pending': {
          if (this._status === 'running') {
            this.abort()
          }
          this._dispatcher = dispatcher
          this.start()
          return
        }
      }
      this._dispatcher = dispatcher
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
        if (!shadowCompare(prev, current)) {
          this._onStateChange.fire({
            prev,
            current,
          })
        }
      }
    }

    public setStatus(current: Status) {
      this.assertNotDisposed()
      if (this._status !== current) {
        const prev = this._status
        if (prev === 'complete') {
          console.warn(`cannot set status other than complete if task[${this.name}] has been completed`)
          return
        }
        this._status = current
        if (current !== Status.error) {
          this._error = undefined
        }
        this._onStatusChange.fire({
          prev,
          current,
        })
      }
    }

    public setResult(result: Result) {
      this.assertNotDisposed()
      this.assertNotCompleted()
      this._result = result
    }

    public setError(error: any) {
      this.assertNotDisposed()
      this.assertNotCompleted()
      if (error instanceof Error) {
        let stack = error.stack || ''
        stack += '\n' + this.stack
        error.stack = stack
      }
      this._error = error
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
  
    public get onComplete() {
      if (this._disposed) {
        return Event.None
      } else if (this.completed) {
        return shortcutEvent
      }
      return this._onComplete.event
    }
  
    public start(resetState = false) {
      this.assertNotDisposed()
      this.assertNotCompleted()
      if (this.running || this.pending) {
        console.warn(`task[${this.name}] is already started`)
        return
      }
      this.dispatcher.start(this)
      if (resetState) {
        this.setState(this._initState)
      }
    }
  
    public abort() {
      this.assertNotDisposed()
      this.assertNotCompleted()
      this.dispatcher.stop(this)
    }
  
    public get stack() {
      return this._stack
    }
  
    private assertNotDisposed() {
      if (this._disposed) {
        throw new Error('task is disposed')
      }
    }

    private assertNotCompleted() {
      if (this.completed) {
        throw new Error('task is already completed')
      }
    }

    public destroy() {
      this.dispose()
    }

    public get destroyed() {
      return this._disposed
    }
  
    public dispose() {
      if (!this._disposed) {
        this.abort()
        super.dispose()
        this._disposed = true
      }
    }

    public run(token: CancellationToken): Promise<Result> {
      if (this.status !== Status.running) {
        return Promise.reject(new Error('task is not in running state'))
      }
      if (token.isCancellationRequested) {
        return Promise.reject(canceled())
      }

      // task is about to run
      const store = new DisposableStore()
      let running = true
      store.add(toDisposable(() => { running = false }))
      const onFinal = () => store.dispose()

      return new Promise<Result>((resolve, reject) => {
        // abort immediatelly because we need to 
        token.onCancellationRequested(() => reject(canceled()), null, store)

        const task = this
        const setState = (state: Partial<State> | ((prev: State) => State)) => {
          if (!running) {
            console.warn(`cannot set task state because task[${task.name}] is out of state`)
            return
          }
          let newState: State
          if (typeof state === 'function') {
            newState = state(task.state)
          } else {
            newState = Object.assign({}, task.state, state)
          }
          task.setState(newState)
        }
        const handler: Handler<State> = {
          get state() { return task.state },
          get token() { return token },
          get setState() { return setState },
        }
        
        // run task runnable now with state-safe handler
        const result = normalizeCancelablePromiseWithToken(this._runnable(handler), token)

        if (isThenable(result)) {
          result.then(resolve, reject)
        } else {
          resolve(result)
        }
      }).finally(onFinal)
    }
  }
}
