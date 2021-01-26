import { Disposable, Emitter, Event } from '@newstudios/common'
import nextTick from 'next-tick'

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
  >(target: T, name: N, async?: boolean): Event<R>
  export function observe<R, T extends Record<string, any> & Disposable = Disposable, N extends string = string>(
    target: T,
    name: N,
    map: (evt: ChangeEvent<T[N]>) => R,
    async?: boolean
  ): Event<R>
  export function observe(
    target: any,
    name: string,
    mapOrAsync?: ((evt: ChangeEvent<any>) => any) | boolean,
    async = false
  ) {
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
    const emitterKey = `__on${prop}Changed__`
    let emitter: Emitter<ChangeEvent<any>> | undefined = target[emitterKey]

    if (!emitter) {
      const e = new Emitter<ChangeEvent<any>>()
      let val = target[name]
      const oldDesc = Object.getOwnPropertyDescriptor(target, name)
      const newDesc: PropertyDescriptor = {
        // new descriptor cannot be configured any longer
        configurable: false,
        enumerable: true,
      }

      if (oldDesc) {
        if (oldDesc.configurable === false) {
          throw new Error(
            `The property '${name}' of ${target} cannot be watched, because the descriptor has been set not-configured`
          )
        }

        if (oldDesc.writable === false) {
          throw new Error(`The property '${name}' of ${target} cannot be watched, because it is non-writable`)
        }

        // new descriptor's enumerable is the same as old one's
        newDesc.enumerable = oldDesc.enumerable

        if (oldDesc.get) {
          if (!oldDesc.set) {
            throw new Error(`The property '${name}' of ${target} cannot be watched, because it is readonly`)
          }

          const oldGet = oldDesc.get
          newDesc.get = oldGet
          const oldSet = oldDesc.set
          newDesc.set = (newValue: any) => {
            const prev = oldGet.call(target)
            oldSet.call(target, newValue)
            const current = oldGet.call(target)
            if (prev !== current) {
              e.fire({ prev, current })
            }
          }
        }
      }

      if (!newDesc.get) {
        newDesc.get = () => val
        newDesc.set = (current: any) => {
          if (val !== current) {
            const prev = val
            val = current
            e.fire({ prev, current })
          }
        }
      }

      Object.defineProperties(target, {
        [emitterKey]: { value: target._register(e) },
        [name]: newDesc,
      })

      emitter = e
    }

    const map = typeof mapOrAsync === 'function' ? mapOrAsync : undefined
    async = typeof mapOrAsync === 'boolean' ? mapOrAsync : async

    const originEvent = emitter.event
    let newEvent = originEvent

    if (async) {
      newEvent = (listener, thisArg?, disposables?) => {
        return originEvent(evt => nextTick(() => listener.call(thisArg, evt)), null, disposables)
      }
    }

    if (map) {
      return Event.map(newEvent, map)
    }

    return newEvent
  }
}
