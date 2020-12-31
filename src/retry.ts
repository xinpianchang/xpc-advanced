import { asPromise, CancelablePromise, canceled, CancellationToken, CancellationTokenSource, createCancelablePromise, Event, isPromiseCanceledError, ITask, timeout } from '@newstudios/common'
import Debug from 'debug'

const debug = Debug('xpc-advanced:retry')

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
  }

  export type Runnable = (token: CancellationToken) => any
  type PromiseReturnType<T extends Function> = T extends (...args: any[]) => infer R ? R extends Promise<infer RR> ? RR : R : never

  export namespace Strategy {

    export const Default = {
      count: 3,
      delay: 1000,
    } as const

    export const Forever = {
      count: -1,
      delay: 1000,
    } as const

    /**
     * A general implementation for retry strategy
     * @param maxRetryCount the max retry count, 0 means no retry, -1 means retry forever
     * @param retryDelay the delay in milliseconds to start a new retry
     */
    export function create(
      maxRetryCount = 3,
      retryDelay: number | Promise<number> | ((count: number, token: CancellationToken) => (number | Promise<number>)) = 1000,
    ): Callback {
      return (err, count, token) => asPromise(() => {
        if (maxRetryCount >= 0 && count >= maxRetryCount || isPromiseCanceledError(err)) {
          throw err
        }

        debug('prepare to start a retrying [count=%d] for %s', count + 1, err)

        const now = Date.now()
        const delayTask = () => typeof retryDelay === 'function' ? retryDelay(count, token) : retryDelay
        const timeoutTask = (delay: number) => timeout(delay - Date.now() + now, token)
        return asPromise(delayTask).then(timeoutTask)
      })
    }

    export function from({ count, delay }: Strategy = Strategy.Default) {
      return create(count, delay)
    }
  }

  abstract class AbstractFactory {
    protected s: Strategy | Callback = Strategy.Default
    public strategy(strategy: Strategy | Callback) {
      this.s = strategy
      return this
    }

    protected runInternal<T extends Runnable>(fn: T, token: CancellationToken): Promise<PromiseReturnType<T>> {
      // get retry callback
      const callback = typeof this.s === 'object' ? Strategy.from(this.s) : this.s
      const task = fn.bind(null, token)

      function run(count = 0): Promise<PromiseReturnType<T>> {
        if (token.isCancellationRequested) {
          return Promise.reject(canceled())
        }
        const next = () => run(count + 1)
        const retry = (err: unknown) => asPromise(() => callback(err, count, token)).then(next)
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
      return this.token(signalToToken(signal))
    }

    public clone(): FactoryWithoutToken {
      const c = new FactoryWithoutToken()
      c.strategy(this.s)
      return c
    }

    public run<T extends Runnable>(fn: T): CancelablePromise<PromiseReturnType<T>> {
      const callback = this.runInternal.bind(this, fn)
      return createCancelablePromise(callback)
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
      return this.token(signalToToken(signal))
    }

    public clone(): FactoryWithToken {
      const c = new FactoryWithToken(this.t)
      c.strategy(this.s)
      return c
    }

    public run<T extends Runnable>(fn: T): Promise<PromiseReturnType<T>> {
      return this.runInternal(fn, this.t)
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
      token = signalToToken(tokenOrSignal)
    } else {
      token = tokenOrSignal
    }
    return new FactoryWithToken(token)
  }

  export function run<T extends Runnable>(fn: T, strategy: Strategy | Callback = Strategy.Default) {
    return factory().strategy(strategy).run(fn)
  }

  export function runWithToken<T extends Runnable>(fn: T, token: CancellationToken | AbortSignal, strategy: Strategy | Callback = Strategy.Default) {
    return factory(token).strategy(strategy).run(fn)
  }

  export function signalToToken(signal: AbortSignal) {
    const tokenSource = new CancellationTokenSource()
    const onAbort = Event.fromDOMEventEmitter<globalThis.Event>(signal, 'abort')
    const d = onAbort(() => tokenSource.cancel())
    tokenSource.token.onCancellationRequested(d.dispose, d)
    return tokenSource.token
  }
}
