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

  export function observe<
    R extends ChangeEvent<T[N]>,
    T extends Record<string, any> & Disposable = Disposable,
    N extends string = string
  >(target: T, name: N): Event<R>
  export function observe<R, T extends Record<string, any> & Disposable = Disposable, N extends string = string>(
    target: T,
    name: N,
    map: (evt: ChangeEvent<T[N]>) => R
  ): Event<R>
  export function observe(target: any, name: string, map?: (evt: ChangeEvent<any>) => any) {
    if (!target._store) {
      console.warn(new Error('Trying to observe a target which is not a Disposable instance').stack)
      return Event.None
    }
    if (target._store._isDisposed) {
      console.warn(
        new Error('Trying to observe a target that has already been disposed of. The event could be leaked').stack
      )
      return Event.None
    }

    const prop = capitalize(name)
    const emitterKey = `__on${prop}Changed`
    let emitter: Emitter<ChangeEvent<any>> | undefined = target[emitterKey]

    if (!emitter) {
      const e = new Emitter<ChangeEvent<any>>()
      let val = target[name]

      Object.defineProperties(target, {
        [emitterKey]: {
          value: target._register(emitter),
        },
        [name]: {
          get() {
            return val
          },
          set(current: any) {
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
