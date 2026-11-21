import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const ROOT = new URL('../', import.meta.url)

/** Загружает client.js в поддельном __ModuleLoader__ и возвращает фабрику модуля. */
async function loadClientModule() {
  const source = await readFile(new URL('client.js', ROOT), 'utf8')
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        loaded = options
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function(source)()
  assert.ok(loaded !== undefined, 'client.js должен вызвать __ModuleLoader__.load')
  return loaded
}

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useCallback: (factory) => factory,
  useSyncExternalStore: () => ({ status: 'ready', value: {}, subscribe: () => {}, getSnapshot: () => ({}) }),
  useMemo: (factory) => factory(),
}

/** require без примитивов: модуль должен уйти на запасную ветку. */
function fakeRequire() {
  return (name) => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected require(${name})`)
  }
}

/** require с примитивами: модуль должен использовать родные компоненты. */
function fakeRequireWithPrimitives() {
  return (name) => {
    if (name === 'react') return ReactStub
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      const Stub = () => null
      const ForwardRefStub = Object.freeze({ render: Stub, $$typeof: Symbol.for('react.forward_ref') })
      return {
        // Button и Input в сборке — forwardRef-объекты, а не функции.
        Button: ForwardRefStub, Input: ForwardRefStub,
        Switch: Stub, SegmentedControl: Stub, StateDot: Stub,
        SettingsValueField: Stub, SettingsSecretField: Stub,
      }
    }
    throw new Error(`unexpected require(${name})`)
  }
}
test('client.js объявляет модуль с id пакета', async () => {
  const module = await loadClientModule()
  assert.equal(module.id, 'dsh-telegram-connect')
  assert.equal(typeof module.factory, 'function')
})


test('apply регистрирует панель в боковой колонке и её иконку', async () => {
  const module = await loadClientModule()
  const plugin = module.factory(fakeRequire())
  assert.ok(plugin.inject.includes('remote.credentials'), 'нужен инжект remote.credentials')

  const registrations = []
  const slots = {
    inject(name, register) {
      register()
      assert.ok(name === 'main' || name === 'sidebar.panellist', `неожиданный слот ${name}`)
    },
    register(options) {
      registrations.push(options)
      return () => {}
    },
  }
  const ctx = {
    slots,
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    configForms: {
      get: (entryId) => {
        assert.equal(entryId, 'telegram')
        return {
          subscribe: () => () => {},
          getSnapshot: () => ({ status: 'ready', value: {} }),
          set: async () => true,
        }
      },
    },
    remote: { credentials: { describe: async () => ({}), set: async () => {} } },
    effect: (factory) => {
      factory()
      return () => {}
    },
  }

  plugin.apply(ctx)

  const panel = registrations.find((entry) => entry.name === 'main')
  const icon = registrations.find((entry) => entry.name === 'sidebar.panellist')
  assert.ok(panel !== undefined, 'main-панель не зарегистрирована')
  assert.equal(panel.key, 'telegram')
  assert.ok(icon !== undefined, 'строка боковой панели не зарегистрирована')
  assert.equal(icon.id, panel.key, 'id строки должен совпадать с ключом панели')
  assert.equal(typeof icon.order, 'number')
  assert.equal(typeof icon.label, 'function')
})

