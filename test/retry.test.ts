import { CancellationTokenSource, createCancelablePromise, timeout } from '@newstudios/common'
import { Retry } from '..'

function createTask<T>(processTime: number, errCount: number, target: T) {
  let c = 0
  return async () => {
    await timeout(processTime)
    if (c++ < errCount) {
      throw new Error('fail')
    }
    return target
  }
}

describe('Retry module cases', () => {
  jest.setTimeout(20000)

  test('run async normal', async () => {
    expect.assertions(1)
    const value = await Retry.run(() => new Promise<number>(resolve => setTimeout(() => resolve(4), 2000)))
    expect(value).toBe(4)
  })

  test('run cancelable promise task', async () => {
    expect.assertions(1)
    const fn = jest.fn()

    const fac = () => createCancelablePromise(token => {
      const pp = new Promise<void>((resolve, reject) => {
        token.onCancellationRequested(reject)
        setTimeout(resolve, 20000)
      })
      pp.catch(fn)
      return pp
    })

    const p = Retry.run(fac)
    p.catch(fn)
    setTimeout(() => p.cancel(), 1000)
    await timeout(1200)
    expect(fn).toBeCalledTimes(2)
  })
  
  test('run async for twice', () => {
    expect.assertions(1)
    const task = createTask(500, 2, 'ok')
    return expect(Retry.run(task)).resolves.toBe('ok')
  })
  
  test('run async for 4 times', () => {
    expect.assertions(1)
    const task = createTask(500, 4, 'ok')
    return expect(Retry.run(task)).rejects.toThrow('fail')
  })
  
  test('factory with forever retry strategy', () => {
    expect.assertions(1)
    const retry = Retry.factory().strategy({ count: -1, delay: 0 })
    const task = createTask(15, 100, 'ok')
    return expect(retry.run(task)).resolves.toBe('ok')
  })
  
  test('factory with canceling', () => {
    expect.assertions(1)
    const task = createTask(1000, 100, 'ok')
    const p = Retry.factory().run(task)
    setTimeout(() => p.cancel(), 1000)
    return expect(p).rejects.toThrow('Canceled')
  })
  
  test('retry successful times', async () => {
    expect.assertions(1)
    const task = createTask(1000, 1, 'ok')
    const fn = jest.fn(task)
    
    await Retry.run(fn, Retry.Strategy.create(3, 0)).catch(() => {})
    expect(fn).toHaveBeenCalledTimes(2)
  })
  
  test('retry max times', async () => {
    expect.assertions(1)
    const task = createTask(1000, 100, 'ok')
    const fn = jest.fn(task)
    await Retry.run(fn, Retry.Strategy.create(1, 0)).catch(() => {})
    expect(fn).toHaveBeenCalledTimes(2)
  })
  
  test('retry token', () => {
    expect.assertions(1)
    const task = createTask(1000, 100, 'ok')
    const control = new CancellationTokenSource()
    setTimeout(() => control.cancel(), 1000)
    const p = Retry.runWithToken(task, control.token)
    return expect(p).rejects.toThrow('Canceled')
  })
  
  test('abort signal to cancel token', () => {
    expect.assertions(1)
    const task = createTask(1000, 100, 'ok')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 1000)
    const p = Retry.factory(controller.signal).run(task)
    return expect(p).rejects.toThrow('Canceled')
  })

})
