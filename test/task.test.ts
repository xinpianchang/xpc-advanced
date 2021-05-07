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

  test('task id', () => {
    expect.assertions(3)
    const t = Task.create(() => {})
    expect(t.id).toMatch(/Task-\d+/)
    const t1 = Task.create(() => {}, { _id: 'abc' })
    expect(t1.id).toEqual('abc')
    Task.create(h => expect(h.id).toEqual('abcd'), { _id: 'abcd' }).start()
  })

  test('task name setter', () => {
    expect.assertions(4)
    const task = Task.create(function abcd() {
      return 4
    })
    expect(task.name).toBe('abcd')
    task.name = 'abc'
    expect(task.name).toBe('abc')
    expect(task.tag).toBe('Task[abc]')
    const t = Task.create(h => expect(h.name).toEqual('ddd'))
    t.name = 'ddd'
    t.start()
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
    await expect(task.asPromise()).rejects.toThrow('Task[anonymous] is already disposed')
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

  test('task restart on error', async () => {
    expect.assertions(7)
    const task = Task.create(
      async handler => {
        if (handler.restart) {
          await timeout(1000, handler.token)
          handler.setState({ progress: 100 })
          return 'ok'
        }
        handler.setState({ progress: 10 })
        await timeout(1000, handler.token)
        handler.setState({ progress: 50 })
        throw new Error('error')
      },
      { progress: 0 }
    )
    expect(task.state.progress).toBe(0)
    task.start()
    expect(task.state.progress).toBe(10)
    await expect(task.asPromise()).rejects.toThrow('error')
    expect(task.error.message).toBe('error')
    await timeout(100)
    task.start()
    expect(task.running).toBe(true)
    expect(task.state.progress).toBe(50)
    await timeout(1100)
    expect(task.result).toBe('ok')
  })

  test('task state set and reset', async () => {
    expect.assertions(2)
    const t = Task.create(() => timeout(100), { a: 5 })
    t.start()
    await timeout(10)
    t.setState({ a: 10 })
    expect(t.state.a).toBe(10)
    await timeout(10)
    t.resetState()
    expect(t.state.a).toBe(5)
  })

  test('task join', async () => {
    expect.assertions(3)
    type Load = {
      loaded: number
      total: number
    }

    const tasks: Task<void, Load>[] = []
    for (let i = 1; i <= 5; i++) {
      const t = i * 500
      const task = Task.create(
        async h => {
          await timeout(t / 2)
          h.setState({ loaded: t / 2 + ~~((Math.random() - 0.5) * 500) })
          await timeout(t / 2)
          h.setState({ loaded: t })
        },
        { loaded: 0, total: t }
      )
      // task.onResult(() => console.log(t))
      tasks.push(task)
    }

    const total = tasks.reduce((sum, t) => sum + t.state.total, 0)
    const t = Task.join(tasks, {
      maxParallel: 1,
      initState: { total, loaded: 0 } as Load,
      onTaskStarted(task, _, h, disposables) {
        task.onStateChange(
          ({ prev, current }) => {
            h.setState(state => {
              return {
                ...state,
                loaded: state.loaded + current.loaded - prev.loaded,
              }
            })
          },
          null,
          disposables
        )
      },
    })
    const fn = jest.fn()
    t.onStateChange(fn)
    t.start()
    await expect(t.asPromise()).resolves.toHaveLength(5)
    expect(fn).toBeCalledTimes(10)
    expect(t.state.loaded).toBe(t.state.total)
  })
})
