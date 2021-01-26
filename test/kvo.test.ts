import { Disposable, disposableTimeout, Event } from '@newstudios/common'
import { Kvo } from '..'

const createClass = () => {
  return class A extends Disposable {
    public x = 0
  }
}

describe('Kvo module cases', () => {
  jest.setTimeout(20000)

  test('kvo observe', () => {
    expect.assertions(1)
    const Class = createClass()
    const instance = new Class()
    const event = Kvo.observe(instance, 'x')
    const promise = Event.toPromise(event)
    setTimeout(() => (instance.x = 4), 100)
    return expect(promise).resolves.toEqual({ prev: 0, current: 4 })
  })

  test('kvo observe with map', () => {
    expect.assertions(1)
    const Class = createClass()
    const instance = new Class()
    const event = Kvo.observe(instance, 'x', Kvo.mapCurrent)
    const promise = Event.toPromise(event)
    setTimeout(() => (instance.x = 4), 100)
    return expect(promise).resolves.toBe(4)
  })

  test('kvo observe within class', () => {
    expect.assertions(1)
    class B extends Disposable {
      public x?: number
      public onXChanged = Kvo.observe(this, 'x')
    }
    const instance = new B()
    const promise = Event.toPromise(instance.onXChanged)
    setTimeout(() => (instance.x = 4), 100)
    return expect(promise).resolves.toEqual({ prev: undefined, current: 4 })
  })

  test('kvo observe private property', () => {
    expect.assertions(1)
    class B extends Disposable {
      private x?: number
      public onXChanged = Kvo.observe(this, 'x', Kvo.mapCurrent)
      constructor() {
        super()
        this._register(disposableTimeout(() => (this.x = 5), 100))
      }
    }
    const instance = new B()
    const promise = Event.toPromise(instance.onXChanged)
    return expect(promise).resolves.toEqual(5)
  })

  test('kvo observe async', async () => {
    expect.assertions(2)
    const Class = createClass()
    const instance = new Class()
    const event = Kvo.observe(instance, 'x', true)
    const event2 = Kvo.observe(instance, 'x')
    const fn = jest.fn()
    event(fn)
    event2(fn)
    const promise = Event.toPromise(event)
    instance.x = 5
    expect(fn).toHaveBeenCalledTimes(1)
    await promise
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('kvo observe descriptor enumable clone', () => {
    expect.assertions(1)
    class B extends Disposable {
      public x = 0
      constructor() {
        super()
        Object.defineProperty(this, 'x', {
          value: 0,
          enumerable: false,
        })
      }
    }

    const instance = new B()
    Kvo.observe(instance, 'x')
    let a = [] as string[]
    for (let k in instance) {
      a.push(k)
    }
    // only `Disposable#_store`
    expect(a.length).toBe(1)
  })

  test("kvo observe descriptor preserves descriptor's getter and setter", () => {
    expect.assertions(2)
    class B extends Disposable {
      public x = 0
      private _b = 0
      constructor() {
        super()
        Object.defineProperty(this, 'x', {
          get: () => {
            return this._b
          },
          set: (b: number) => {
            this._b = b + 1
          },
        })
      }
    }

    const instance = new B()
    const event = Kvo.observe(instance, 'x')
    event(evt => expect(evt.current).toBe(2))
    instance.x = 1
    expect(instance.x).toBe(2)
  })
})
