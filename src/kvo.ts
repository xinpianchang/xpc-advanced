import { Disposable, Emitter, Event } from '@newstudios/common'

export function capitalize<T extends string>(str: T): Capitalize<T> {
  return `${str[0].toLocaleUpperCase()}${str.slice(1)}` as Capitalize<T>
}

export namespace Kvo {
  export type ChangeEvent<T> = {
    prev: T
    current: T
  }

  export function mapCurrent<T>({ current }: ChangeEvent<T>) {
    return current
  }

  export function mapPrevious<T>({ prev }: ChangeEvent<T>) {
    return prev
  }

  export function observe<N extends string, T extends { [k in N]: unknown } & Disposable>(
    target: T,
    name: N
  ): Event<ChangeEvent<T[N]>>
  export function observe<N extends string, T extends { [k in N]: unknown } & Disposable, R>(
    target: T,
    name: N,
    map: (evt: ChangeEvent<T[N]>) => R
  ): Event<R>
  export function observe<N extends string, T extends { [k in N]?: unknown } & Disposable>(
    target: T,
    name: N
  ): Event<ChangeEvent<T[N] | undefined>>
  export function observe<N extends string, T extends { [k in N]?: unknown } & Disposable, R>(
    target: T,
    name: N,
    map: (evt: ChangeEvent<T[N] | undefined>) => R
  ): Event<R>
  export function observe<R>(target: Disposable, name: string, map?: (evt: ChangeEvent<any>) => R): Event<R>
  export function observe<N extends string, T extends { [k in N]?: unknown } & Disposable, R>(
    target: T,
    name: N,
    map?: (evt: ChangeEvent<T[N] | undefined>) => R
  ) {
    const t = target as any
    if (t._store._isDisposed) {
      console.warn(
        new Error('Trying to observe a target that has already been disposed of. The event could be leaked!').stack
      )
      return Event.None
    }

    const prop = capitalize(name)
    const emitterKey = `__on${prop}Changed`
    let emitter: Emitter<ChangeEvent<T[N]>> | undefined = t[emitterKey]

    if (!emitter) {
      const e = new Emitter<ChangeEvent<T[N]>>()
      let val = target[name]

      Object.defineProperties(target, {
        [emitterKey]: {
          value: t._register(emitter),
        },
        [name]: {
          get() {
            return val
          },
          set(current: T[N]) {
            if (val !== current) {
              const prev = val
              val = current
              e.fire({ prev, current })
            }
          },
          enumerable: true,
        },
      })

      emitter = e
    }

    if (map) {
      return Event.map(emitter.event, map)
    }

    return emitter.event
  }
}
