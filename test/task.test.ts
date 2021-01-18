import { raceCancellation, timeout } from '@newstudios/common'
import { Task } from '..'

describe('Task module cases', () => {
  jest.setTimeout(20000)

  test('task api sanity test', () => {
    expect.assertions(6)
    const fn = jest.fn(() => ({
      progress: 10,
    }))

    const t = Task.create(
      handler => {
        if (handler.state.progress < 10) {
          handler.setState(fn)
        }
        const promise = new Promise<string>(resolve => setTimeout(resolve, 2000, 'ok'))
        promise.then(() => {
          if (!handler.token.isCancellationRequested) {
            expect(handler.restart).toBe(1)
          }
          const success = handler.setState({
            progress: 100,
          })
          expect(success).toBe(!handler.token.isCancellationRequested)
        })
        return raceCancellation(promise, handler.token, 'cancelled')
      },
      {
        progress: 0,
      }
    )
    t.name = 'test 1'
    t.start()

    t.dispatcher = Task.Dispatcher.create(5)

    t.onComplete(() => {
      expect(fn).toBeCalledTimes(1)
      expect(t.result).toBe('ok')
    })

    return expect(t.asPromise()).resolves.toBe('ok')
  })

  test('task name setter', () => {
    const task = Task.create(function abcd() {
      return 4
    })
    expect(task.name).toBe('abcd')
    task.name = 'abc'
    expect(task.name).toBe('abc')
  })

  test('task error handler', () => {
    expect.assertions(1)
    const task = Task.create(() => {
      throw new Error('abc')
    })

    task.start()

    return expect(task.asPromise()).rejects.toThrow('abc')
  })

  test('task asPromise test 1', () => {
    expect.assertions(1)
    const task = Task.create(() => timeout(2000))
    task.abort()

    return expect(task.asPromise()).rejects.toThrow('Canceled')
  })

  test('task asPromise test 2', () => {
    expect.assertions(1)
    const task = Task.create(() => timeout(2000))
    task.start()

    return expect(task.asPromise()).resolves.toBe(undefined)
  })

  test('task asPromise test 3', async () => {
    expect.assertions(2)
    const task = Task.create(() => timeout(2000))
    setTimeout(() => task.dispose(), 100)
    task.start()

    await expect(task.asPromise()).rejects.toThrow('Canceled')
    await expect(task.asPromise()).rejects.toThrow('task[anonymous] is already disposed')
  })

  test('task asPromise test 4', async () => {
    expect.assertions(1)
    const task = Task.create(() => timeout(2000))
    const promise = task.asPromise()
    task.start()
    setTimeout(() => promise.cancel(), 100)

    await expect(promise).rejects.toThrow('Canceled')
  })

  test('task abort test', async () => {
    expect.assertions(3)
    const task = Task.create(() => timeout(2000))
    task.dispatcher = Task.Dispatcher.SingleThread
    task.start()
    const task2 = Task.create(async () => {
      await timeout(2000)
      return 'ok'
    })
    task2.dispatcher = Task.Dispatcher.SingleThread
    task2.start()
    setTimeout(() => task.abort(), 800)
    await timeout(2500)
    expect(task.status).toBe(Task.Status.abort)
    expect(task2.result).toBe(undefined)
    await timeout(500)
    expect(task2.result).toBe('ok')
  })

  test('task dispatcher parallel', async () => {
    const dispatcher = Task.Dispatcher.create(2)
    const pendingFn = jest.fn()
    const completeFn = jest.fn()
    const createTask = () => {
      const task = Task.create(() => timeout(2000), null, dispatcher)
      task.onPending(pendingFn)
      task.onResult(completeFn)
      return task
    }
    const task1 = createTask()
    const task2 = createTask()
    const task3 = createTask()

    task1.start()
    task2.start()
    task3.start()

    await timeout(1000)
    expect(pendingFn).toBeCalledTimes(1)
    expect(completeFn).toBeCalledTimes(0)

    await timeout(1100)
    expect(pendingFn).toBeCalledTimes(1)
    expect(completeFn).toBeCalledTimes(2)

    await timeout(2100)
    expect(pendingFn).toBeCalledTimes(1)
    expect(completeFn).toBeCalledTimes(3)

    dispatcher.dispose()
  })

  // test('task restart on error', () => {
  //   const task = Task.create(
  //     async handler => {
  //       if (handler.restart) {
  //         await timeout(1000, handler.token)
  //         handler.setState({ progress: 100 })
  //         return 'ok'
  //       }
  //       handler.setState({ progress: 10 })
  //       await timeout(1000, handler.token)
  //       handler.setState({ progress: 50 })
  //       throw new Error('error')
  //     },
  //     { progress: 0 }
  //   )
  // })
})
