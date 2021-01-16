import { raceCancellation } from '@newstudios/common'
import { Task } from '..'

describe('Task module cases', () => {
  jest.setTimeout(20000)

  test('task api test', () => {
    expect.assertions(1)
    const t = Task.create(
      handler => {
        handler.setState({
          progress: 10,
        })
        const promise = new Promise<string>(resolve => setTimeout(resolve, 2000, 'ok'))
        promise.then(() => {
          handler.setState({
            progress: 100,
          })
        })
        return raceCancellation(promise, handler.token, 'cancelled')
      },
      {
        progress: 0,
      }
    )
    t.name = 'test 1'

    t.onStateChange(ev => console.log('prev state:', ev.prev, 'current:', ev.current))
    const log = (msg: string) => () => console.log(`on${msg}`)
    t.onRestart(log('Restart'))
    t.onAbort(log('Abort'))
    t.onComplete(() => console.log('onComplete'))
    t.onError(err => console.warn(err))
    t.onPending(log('Pending'))
    t.onRunning(log('Running'))
    t.onResult(result => console.log('onResult:', result))
    t.start()

    t.dispatcher = Task.Dispatcher.create(5)

    return expect(t.asPromise()).resolves.toBe('ok')
  })
})
