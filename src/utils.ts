import {
  CancelablePromise,
  CancellationToken,
  DisposableStore,
  Emitter,
  Event,
  IDisposable,
  isThenable,
} from '@newstudios/common'
import nextTick from 'next-tick'

export function isCancelablePromise<R>(promise: unknown): promise is CancelablePromise<R> {
  if (isThenable(promise) && typeof (promise as CancelablePromise<R>).cancel === 'function') {
    return true
  }
  return false
}

export const shortcutEvent: Event<void> = Object.freeze(function (callback, context) {
  let disposed = false
  nextTick(() => disposed || callback.call(context))
  return {
    dispose() {
      disposed = true
    },
  }
})

export function normalizeCancelablePromiseWithToken<T>(
  result: T | Promise<T> | CancelablePromise<T>,
  token: CancellationToken
) {
  if (isCancelablePromise(result)) {
    const d = token.onCancellationRequested(result.cancel, result)
    return result.finally(() => d.dispose())
  }
  return result
}

export function abortSignalToCancellationToken(signal: AbortSignal) {
  const onAbort = Event.fromDOMEventEmitter<globalThis.Event>(signal, 'abort')
  let d: IDisposable | undefined = undefined

  const emitter = new Emitter<void>({
    onFirstListenerAdd() {
      if (!signal.aborted) {
        d = onAbort(() => emitter.fire())
      }
    },
    onLastListenerRemove() {
      if (d) {
        d.dispose()
        d = undefined
      }
    },
  })

  const token: CancellationToken = Object.freeze({
    onCancellationRequested(listener: () => any, thisArgs?: any, disposables?: IDisposable[] | DisposableStore) {
      const event = signal.aborted ? shortcutEvent : emitter.event
      return event(listener, thisArgs, disposables)
    },
    get isCancellationRequested() {
      return signal.aborted
    },
  })

  return token
}

/**
 * A promise `Canceled Error` is created by canceled() with Canceled error name
 * and a `cancelled Error` is created by just setting the cancelled property to be true
 */
export function isCanceledError(err: unknown): err is Error & ({ name: 'Canceled' } | { cancelled: true }) {
  if (err instanceof Error) {
    if (err.name === 'Canceled' || (err as any).cancelled === true) {
      return true
    }
  }
  return false
}

/**
 * An AbortError is thrown by aborting a fetching process with name `AbortError`
 */
export function isAbortError(err: unknown): err is Error & { name: 'AbortError' } {
  return err instanceof Error && err.name === 'AbortError'
}
