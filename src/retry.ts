import { asPromise, canceled, CancellationToken, createCancelablePromise, timeout } from '@newstudios/common'
import {
  abortSignalToCancellationToken,
  isAbortError,
  isCanceledError,
  normalizeCancelablePromiseWithToken,
} from './utils'
import type { Task } from './task'

export namespace Retry {
  /**
   * Retry callback delegation
   * @err the error which is caught by this library
   * @count the times error is caught, first-time caught is 0, and then incremented each time caught
   * @token the cancellation token for this retry
   */
  export type Callback = (err: unknown, count: number, token: CancellationToken) => void | Promise<void>

  export interface Strategy {
    /**
     * retry count
     * ```
     * -1: retry forever upon error
     * 0: no retry
     * 1: retry once error
     * 2: retry twice error
     * ...
     * ```
     * @default 3
     */
    count: number
    /**
     * milliseconds to delay for retry
     * @params retry the retry counter
     * @default delay 1000 ms
     */
    delay: number
    /**
     * the delay factor
     * @default 2
     */
    factor: number
    /**
     * the max delay time in milliseconds
     * @default 20000
     */
    max?: number
  }

  export type Runnable = (token: CancellationToken) => any
  export type PromiseReturnType<T extends Function> = T extends (...args: any[]) => infer R ? Awaited<R> : never
  export type TaskType<T extends Function | Task<unknown, unknown>> = T extends (...args: any[]) => infer R
    ? Awaited<R>
    : T extends Task<infer R, unknown>
    ? R
    : never

  export namespace Strategy {
    export const Default = {
      count: 3,
      delay: 1000,
      factor: 2,
    } as const

    export const Forever = {
      count: -1,
      delay: 1000,
      factor: 2,
      max: 20000,
    } as const

    /**
     * A general implementation for retry strategy
     * @param maxRetryCount the max retry count, 0 means no retry, -1 means retry forever
     * @param retryDelay the delay in milliseconds to start a new retry
     */
    export function create(
      maxRetryCount: number,
      retryDelay: number,
      retryFactor?: number,
      maxRetryDelay?: number
    ): Callback
    export function create(
      maxRetryCount: number,
      retryDelay: Promise<number> | ((count: number, token: CancellationToken) => number | Promise<number>)
    ): Callback
    export function create(
      maxRetryCount = 3,
      retryDelay:
        | number
        | Promise<number>
        | ((count: number, token: CancellationToken) => number | Promise<number>) = 1000,
      retryFactor = 2,
      maxRetryDelay = 20000
    ): Callback {
      return (err, count, token) =>
        asPromise(() => {
          if (maxRetryCount >= 0 && count >= maxRetryCount) {
            throw err
          }

          // console.debug('prepare to start a retrying [count=%d] for %s', count + 1, err)
          const now = Date.now()

          if (typeof retryDelay === 'number' && maxRetryDelay > retryDelay) {
            if (retryFactor < 1) {
              retryFactor = 1
              console.warn('retryFactor should be larger than or equal to 1, the default factor is 2')
            }
            retryDelay = retryDelay * Math.pow(retryFactor, count)
            retryDelay = Math.min(retryDelay, maxRetryDelay)
          }

          const delayTask = () => (typeof retryDelay === 'function' ? retryDelay(count, token) : retryDelay)
          const timeoutTask = (delay: number) => timeout(delay - Date.now() + now, token)
          return asPromise(delayTask).then(timeoutTask)
        })
    }

    export function from({ count, delay, factor, max = 20000 }: Strategy = Strategy.Default) {
      return create(count, delay, factor, max)
    }
  }

  abstract class AbstractFactory {
    protected s: Strategy | Callback = Strategy.Default
    public strategy(strategy: Partial<Strategy> | Callback) {
      if (typeof strategy === 'function') {
        this.s = strategy
      } else {
        this.s = Object.assign({}, Strategy.Default, strategy)
      }
      return this
    }

    protected runInternal<T extends Runnable | Task>(fnOrTask: T, token: CancellationToken): Promise<TaskType<T>> {
      // get retry callback
      const callback = typeof this.s === 'object' ? Strategy.from(this.s) : this.s

      const fn: (token: CancellationToken) => any =
        typeof fnOrTask === 'function' ? fnOrTask : fnOrTask.toRunnable(true)

      const task = () => normalizeCancelablePromiseWithToken(fn(token), token)

      function run(count = 0): Promise<TaskType<T>> {
        if (token.isCancellationRequested) {
          return Promise.reject(canceled())
        }
        const next = () => run(count + 1)
        const retry = (err: unknown) =>
          asPromise(() => {
            if (isCanceledError(err) || isAbortError(err)) {
              throw err
            }
            return callback(err, count, token)
          }).then(next)
        return asPromise(task).catch(retry)
      }

      return run()
    }

    public abstract clone(): AbstractFactory
  }

  class FactoryWithoutToken extends AbstractFactory {
    public token(token: CancellationToken): FactoryWithToken {
      const f = new FactoryWithToken(token)
      f.strategy(this.s)
      return f
    }

    public signal(signal: AbortSignal): FactoryWithToken {
      return this.token(abortSignalToCancellationToken(signal))
    }

    public clone(): FactoryWithoutToken {
      const c = new FactoryWithoutToken()
      c.strategy(this.s)
      return c
    }

    public run<T extends Runnable | Task>(fnOrTask: T) {
      return createCancelablePromise(token => this.runInternal(fnOrTask, token))
    }
  }

  class FactoryWithToken extends AbstractFactory {
    constructor(private t: CancellationToken) {
      super()
    }

    public token(token: CancellationToken): this
    public token(token: null): FactoryWithoutToken
    public token(token: CancellationToken | null) {
      if (token) {
        this.t = token
        return this
      }
      const f = new FactoryWithoutToken()
      f.strategy(this.s)
      return f
    }

    public signal(signal: AbortSignal): this {
      return this.token(abortSignalToCancellationToken(signal))
    }

    public clone(): FactoryWithToken {
      const c = new FactoryWithToken(this.t)
      c.strategy(this.s)
      return c
    }

    public run<T extends Runnable | Task>(fnOrTask: T) {
      return this.runInternal(fnOrTask, this.t)
    }
  }

  export function factory(): FactoryWithoutToken
  export function factory(tokenOrSignal: CancellationToken | AbortSignal): FactoryWithToken
  export function factory(tokenOrSignal?: CancellationToken | AbortSignal) {
    if (!tokenOrSignal) {
      return new FactoryWithoutToken()
    }
    let token: CancellationToken
    if ('addEventListener' in tokenOrSignal) {
      token = abortSignalToCancellationToken(tokenOrSignal)
    } else {
      token = tokenOrSignal
    }
    return new FactoryWithToken(token)
  }

  export function run<T extends Runnable | Task>(f: T, strategy: Strategy | Callback = Strategy.Default) {
    return factory().strategy(strategy).run(f)
  }

  export function runWithToken<T extends Runnable | Task>(
    f: T,
    token: CancellationToken | AbortSignal,
    strategy: Strategy | Callback = Strategy.Default
  ) {
    return factory(token).strategy(strategy).run(f)
  }
}
