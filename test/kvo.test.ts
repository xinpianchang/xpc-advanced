import { Disposable, disposableTimeout, Event } from '@newstudios/common'
import { getPropertyDescriptorRecursively, Kvo } from '..'

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
    Kvo.observe(instance, 'x', Kvo.mapNoop)
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

  test('kvo observe descriptor getter test', () => {
    expect.assertions(1)
    class M extends Disposable {
      private _a = 0
      public on = Kvo.observe(this, 'a')

      constructor(x: number) {
        super()
        this._a = x
      }

      get a() {
        return this._a
      }

      set a(a: number) {
        this._a = a
      }
    }

    const m = new M(3)
    expect(m.a).toBe(3)
  })

  test.only('kvo observable test', () => {
    const a = {
      m: 3,
      n: '2bc',
    }

    const fn = jest.fn()
    const fn2 = jest.fn()

    const [t1, d1] = getPropertyDescriptorRecursively(a, 'n')

    const observable = Kvo.from(a)
    const observable2 = Kvo.from(a)
    const event = observable.observe('m')
    const event2 = observable.observe('n')
    const [t2, d2] = getPropertyDescriptorRecursively(a, 'n')
    observable2.observe('n')

    event(fn)
    event2(fn2)

    a.m = 4
    a.n = '2bc'

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(0)
    observable.dispose()

    const [t3, d3] = getPropertyDescriptorRecursively(a, 'n')

    expect(t1).toStrictEqual(t2)
    expect(t1).toStrictEqual(t3)
    expect(d1).not.toBe(d2)
    expect(d2).toStrictEqual(d3)

    observable2.dispose()

    const [, d4] = getPropertyDescriptorRecursively(a, 'n')
    expect(d2).toStrictEqual(d4)

    const observable3 = Kvo.from(a)
    const fn3 = jest.fn()
    observable3.observe('n')(fn3)

    a.n = 'dsf'
    expect(fn3).toHaveBeenCalledTimes(1)

    a.m = 5
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
