import { createCancelablePromise, Disposable, Emitter, Event, ITask } from '@newstudios/common'

/**
 * A task's lifecycle can be either one of 4 states which are initialized / queued(pending) / started / stopped(cancelled / stalled / finished).
 * A task can be cancelled upon whatever state before stopped, and can be started right upon initailized and queued state.
 * Once a task is stopped, it can never be reused(disposed) and it will no longer emit any events
 * 
 */
export class Task<T> extends Disposable {
  private readonly _onDone = this._register(new Emitter<T>())
  public readonly onDone = this._onDone.event

  private readonly _onError = this._register(new Emitter<unknown>())
  public readonly onError = this._onError.event

  public readonly onComplete = Event.signal(Event.any(this.onDone, this.onError))

  private readonly _onExecuting = this._register(new Emitter<void>())
  public readonly onExecuting = this._onExecuting.event

  private readonly _


  private _done = false
  private _result?: T
  private _error?: any

  constructor() {
    super()
  }

  private resolve(result: T) {
    if (this._done) {
      return
    }
    this._done = true
    this._result = result
    delete this._error
    this._onDone.fire(result)
  }

  private reject(error: any) {
    if (this._done) {
      return
    }
    this._done = true
    this._error = error
    delete this._result
    this._onError.fire(error)
  }

  public readonly onComplete: Event<void>
}

export namespace Task {
  export function run<T>(task: Task<T>) {

  }

  export interface Provider<T = any> {
    /**
     * timeout to take an object
     * @param timeout milliseconds to to wait
     * if timeout not provided, wait forever until there is an object
     */
    take(timeout?: number): Promise<T>
  }

  export interface Queue<T> extends Provider<T> {
    offer(task: T): void
  }

  
}

const task = Task.create(token => {})
const task2 = Task.create(async () => createCancelablePromise(token => {}))
const dispatcher = Task.Dispather.create({ max: 5 })

Task.dispatch(task2)
dispatcher.dispatch(task)

task.dispatcher === dispatcher
task.dispose()

const task = Task.create<T, S>(async handler => {
  handler.state
  handler.token
  handler.signal
  return s as T
}, initState as T | (() => T))

task.onRestart
task.onStart
task.onPending
task.onRunning
task.onAbort
task.onError
task.onComplete
task.onStateChange


task.dispatcher
task.state as S
task.result as T
task.status === 'pending' | 'running' | 'error' | 'abort' | 'complete'
task.pending
task.runnning
task.error
task.aborted
task.completed
task.started = task.status === 'pending' | 'running'
task.stopped = task.status === 'error' | 'abort' | 'complete'


task.start(): this
task.abort()
task.dispose() ?




