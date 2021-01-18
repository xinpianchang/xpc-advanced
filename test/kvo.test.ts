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
})
