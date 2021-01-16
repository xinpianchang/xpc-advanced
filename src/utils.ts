import {
  CancelablePromise,
  CancellationToken,
  DisposableStore,
  Emitter,
  Event,
  IDisposable,
  isThenable,
} from '@newstudios/common'

export function isCancelablePromise<R>(promise: unknown): promise is CancelablePromise<R> {
  if (isThenable(promise) && typeof (promise as CancelablePromise<R>).cancel === 'function') {
    return true
  }
  return false
}

export const shortcutEvent: Event<void> = Object.freeze(function (callback, context) {
  const handle = setTimeout(callback.bind(context), 0)
  return {
    dispose() {
      clearTimeout(handle)
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
