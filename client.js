/**
 * Client-часть: панель «Telegram» в боковой колонке DSH Desktop.
 *
 * Панель — React-компонент в слотах оболочки: `main` (страница центральной
 * колонки) и `sidebar.panellist` (строка-иконка слева).
 *
 * Контролы берутся из `@deepseek-ai/dsh-client-ui-primitives` — это seed-модуль
 * рантайм-таблицы, и первые стороны (например, settings-general) подключают его
 * ровно так же через `require`. Поэтому строки, переключатели, поля и кнопки —
 * те же компоненты, что на страницах Settings и Plugins. Если в сборке модуля
 * нет, остаётся запасной вариант на тех же токенах `--dsw-*`.
 *
 * @module dsh-telegram-connect/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-telegram-connect',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch {
      primitives = {}
    }
    const {
      Button, Switch, Input, SegmentedControl, StateDot, SettingsValueField, SettingsSecretField,
    } = primitives

    // forwardRef-компоненты — объекты, а не функции: проверять только typeof нельзя,
    // иначе родная кнопка подменяется запасной.
    const isComponent = (value) => value != null && (typeof value === 'function' || typeof value === 'object')
    const has = {
      Button: isComponent(Button),
      Switch: isComponent(Switch),
      Input: isComponent(Input),
      SegmentedControl: isComponent(SegmentedControl),
      StateDot: isComponent(StateDot),
      SettingsValueField: isComponent(SettingsValueField),
      SettingsSecretField: isComponent(SettingsSecretField),
    }

    const NS = 'telegram'
    const ENTRY_ID = 'telegram'
    const PANEL_ID = 'telegram'
    const TOKEN_REF = 'TELEGRAM_BOT_TOKEN'
    const MODES = ['off', 'quiet', 'normal', 'verbose']
    const POSTURES = ['ask', 'trusted', 'yolo']
    const LANGS = ['auto', 'ru', 'en']
    const COMMIT_DELAY_MS = 400

    const ru = {
      title: 'Telegram',
      subtitle: 'Бот @BotFather: уведомления о работе, поручения из чата и переключение между сессиями.',
      panel: 'Telegram',
      connection: 'Подключение',
      behaviour: 'Поведение',
      enabled: 'Бот включён',
      enabledHint: 'Опрашивать Telegram, пока запущен DSH',
      apiBase: 'Адрес Bot API',
      apiBaseHint: 'пусто — облачный Telegram',
      workspace: 'Workspace',
      workspaceHint: 'пусто — каталог последней активной сессии',
      ownerId: 'Владелец (user id)',
      ownerHint: 'Telegram user id владельца; без него бот не отвечает никому',
      ownerInvalid: 'нужно целое число больше нуля',
      notifyHint: 'Что присылать о работе, начатой вне чата',
      accessTitle: 'Доступ',
      notifyTitle: 'Уведомления',
      approvalsTitle: 'Подтверждения и вопросы',
      workspaceTitle: 'Рабочее пространство',
      allowNewHint: 'разрешать создавать сессии из чата',
      streamingHint: 'показывать карточку прогресса во время работы',
      lang_auto: 'auto',
      lang_ru: 'ru',
      lang_en: 'en',
      allowlist: 'Доступ (user id)',
      allowlistHint: 'через запятую; каждый получает свою сессию и уведомления',
      emptyPairing: 'Код не задан — /pair выключен. Впиши код, чтобы пускать людей без ручного id.',
      emptyBotOff: 'Бот выключен: сообщения из чата не обрабатываются, уведомления не приходят.',
      emptyWorkspace: 'Путь не задан — возьмётся каталог последней активной сессии.',
      pairingCode: 'Код подключения',
      pairingCodeHint: 'человек пишет боту /pair &lt;код&gt; и попадает в доступ; пусто — выключено',
      language: 'Язык бота',
      languageHint: 'auto — по языку клиента Telegram; ru или en',
      notify: 'Уведомления о работе не из чата',
      allowNew: 'Разрешить новые сессии из бота',
      streaming: 'Показывать ответ обновляемой карточкой',
      richMessages: 'Rich-сообщения',
      richHint: 'Нативные таблицы и форматирование; при отказе сервера — обычный HTML',
      richHeadings: 'Заголовки как заголовки',
      richHeadingsHint: 'Выключено — заголовки становятся жирной строкой',
      questions: 'Вопросы агента',
      questionsHint: 'Присылать вопросы в чат кнопками и принимать ответ текстом',
      approvals: 'Подтверждения',
      approvalsHint: 'Спрашивать разрешение на инструменты кнопками в чате',
      approvalsPosture: 'Политика подтверждений',
      approvalsPostureHint: 'ask — спрашивать всё; trusted — чтение без вопроса; yolo — разрешать всё',
      approvalsAllow: 'Разрешать без вопроса',
      approvalsAllowHint: 'имена инструментов через запятую; * — шаблон',
      approvalsDeny: 'Запрещать сразу',
      approvalsDenyHint: 'имена инструментов через запятую; отказ без вопроса',
      posture_ask: 'ask',
      posture_trusted: 'trusted',
      posture_yolo: 'yolo',
      modeHint_off: 'ничего не приходит',
      modeHint_quiet: 'только ошибки',
      modeHint_normal: 'финал задач и ошибки',
      modeHint_verbose: 'финал, ошибки и строки инструментов',
      token: 'Токен бота',
      tokenHint: 'Хранится в credential TELEGRAM_BOT_TOKEN, не в патче профиля',
      tokenConfigured: 'Токен сохранён',
      tokenMissing: 'Токен не задан',
      tokenPlaceholder: '123456789:AA…',
      saveToken: 'Сохранить',
      check: 'Проверить',
      test: 'Тест',
      overridden: 'изменено',
      reset: 'сбросить',
      testMessage: 'DeepSeek Harness: тестовое сообщение.',
      removeToken: 'Удалить токен',
      tokenRemoved: 'Токен удалён',
      tokenRemoveFailed: 'Не смог удалить токен',
      statusConnected: 'Подключён',
      statusNoToken: 'Токен не задан — бот не работает',
      saved: 'Сохранено',
      refused: 'Хост отклонил значение',
      loading: 'Загрузка…',
      unavailable: 'Хост не отдаёт пространство настроек telegram.',
      noOwner: 'Сначала укажи владельца (user id).',
      tokenSaved: 'Токен сохранён',
      tokenFailed: 'Не принял токен',
      tokenNotStored: 'Хост ответил, что токена нет — проверь права на ~/.dsh/.credentials.yaml',
      checkOk: 'Бот',
      checkFailed: 'Telegram ответил ошибкой',
      testSent: 'Тестовое сообщение отправлено',
      testFailed: 'Не смог отправить сообщение',
      mode_off: 'выключены',
      mode_quiet: 'только ошибки',
      mode_normal: 'финал задач',
      mode_verbose: 'финал и инструменты',
    }

    const en = {
      title: 'Telegram',
      subtitle: 'A @BotFather bot for work notifications, tasks from chat, and switching between sessions.',
      panel: 'Telegram',
      connection: 'Connection',
      behaviour: 'Behaviour',
      enabled: 'Bot enabled',
      enabledHint: 'Poll Telegram while DSH runs',
      apiBase: 'Bot API endpoint',
      apiBaseHint: 'empty — cloud Telegram',
      workspace: 'Workspace',
      workspaceHint: 'empty — the latest active session directory',
      ownerId: 'Owner (user id)',
      ownerHint: 'Owner Telegram user id; without it the bot answers nobody',
      ownerInvalid: 'must be a positive integer',
      notifyHint: 'What to send about work started outside chat',
      accessTitle: 'Access',
      notifyTitle: 'Notifications',
      approvalsTitle: 'Approvals and questions',
      workspaceTitle: 'Workspace',
      allowNewHint: 'allow creating sessions from chat',
      streamingHint: 'show a progress card while the agent works',
      lang_auto: 'auto',
      lang_ru: 'ru',
      lang_en: 'en',
      allowlist: 'Access (user ids)',
      allowlistHint: 'comma separated; each gets their own session and notifications',
      emptyPairing: 'No code set — /pair is off. Add a code to let people in without a manual id.',
      emptyBotOff: 'The bot is off: chat messages are not processed and notifications do not arrive.',
      emptyWorkspace: 'No path set — the directory of the latest active session is used.',
      pairingCode: 'Pairing code',
      pairingCodeHint: 'a person sends /pair &lt;code&gt; to the bot and gets access; empty — disabled',
      language: 'Bot language',
      languageHint: 'auto — follow the Telegram client language; ru or en',
      notify: 'Notifications about work started outside chat',
      allowNew: 'Allow creating sessions from chat',
      streaming: 'Stream the answer into one updated card',
      richMessages: 'Rich messages',
      richHint: 'Native tables and formatting; plain HTML when the server refuses',
      richHeadings: 'Headings as headings',
      richHeadingsHint: 'Off — headings become a bold line',
      questions: 'Agent questions',
      questionsHint: 'Send questions to the chat as buttons and accept text answers',
      approvals: 'Approvals',
      approvalsHint: 'Ask for tool permission with buttons in the chat',
      approvalsPosture: 'Approval policy',
      approvalsPostureHint: 'ask — ask everything; trusted — read-only without asking; yolo — allow all',
      approvalsAllow: 'Allow without asking',
      approvalsAllowHint: 'tool names, comma separated; * is a wildcard',
      approvalsDeny: 'Deny immediately',
      approvalsDenyHint: 'tool names, comma separated; reject without asking',
      posture_ask: 'ask',
      posture_trusted: 'trusted',
      posture_yolo: 'yolo',
      modeHint_off: 'nothing arrives',
      modeHint_quiet: 'errors only',
      modeHint_normal: 'task results and errors',
      modeHint_verbose: 'results, errors and tool lines',
      token: 'Bot token',
      tokenHint: 'Kept in the TELEGRAM_BOT_TOKEN credential, not in the profile patch',
      tokenConfigured: 'Token stored',
      tokenMissing: 'No token yet',
      tokenPlaceholder: '123456789:AA…',
      saveToken: 'Save',
      check: 'Check',
      test: 'Test',
      overridden: 'overridden',
      reset: 'reset',
      testMessage: 'DeepSeek Harness: test message.',
      removeToken: 'Remove token',
      tokenRemoved: 'Token removed',
      tokenRemoveFailed: 'Could not remove the token',
      statusConnected: 'Connected',
      statusNoToken: 'No token yet — the bot is idle',
      saved: 'Saved',
      refused: 'The Host refused this value',
      loading: 'Loading…',
      unavailable: 'The Host does not serve the telegram settings namespace.',
      noOwner: 'Set the owner user id first.',
      tokenSaved: 'Token stored',
      tokenFailed: 'Token rejected',
      tokenNotStored: 'The Host reports no token — check write access to ~/.dsh/.credentials.yaml',
      checkOk: 'Bot',
      checkFailed: 'Telegram returned an error',
      testSent: 'Test message sent',
      testFailed: 'Could not send the message',
      mode_off: 'off',
      mode_quiet: 'errors only',
      mode_normal: 'task results',
      mode_verbose: 'results and tools',
    }

    /** Стили: прозрачный фон страницы, контейнер и карточки как у родных страниц DSH. */
    const styles = `
.dsh-tg { box-sizing: border-box; height: 100%; overflow-y: auto; scrollbar-gutter: stable;
  background: transparent; color: var(--dsw-alias-label-primary, CanvasText);
  font-size: 14px; line-height: 1.6; }
.dsh-tg__inner { max-width: 960px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }
@container (max-width: 560px) {
  .dsh-tg__inner { padding: 0 16px 32px; }
  .dsh-tg__row { flex-direction: column; align-items: stretch; gap: 8px; }
  .dsh-tg__actions { width: 100%; }
  .dsh-tg__status-line { flex-wrap: wrap; }
}
@media (max-width: 560px) {
  .dsh-tg__inner { padding: 0 16px 32px; }
  .dsh-tg__row { flex-direction: column; align-items: stretch; gap: 8px; }
  .dsh-tg__actions { width: 100%; }
  .dsh-tg__status-line { flex-wrap: wrap; }
}
.dsh-tg__head { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); margin-bottom: 24px; }
.dsh-tg__title { margin: 0 0 6px; font-size: 20px; font-weight: 500; line-height: 28px; }
.dsh-tg__subtitle { margin: 0; font-size: 13px; line-height: 1.55;
  color: var(--dsw-alias-label-secondary, inherit); }
.dsh-tg__section { margin-top: 28px; padding: 0; background: transparent; }
.dsh-tg__card-title { margin: 0; padding: 14px 0 6px; font-size: 14px; font-weight: 500;
  line-height: 20px; color: var(--dsw-alias-label-primary, inherit); }
.dsh-tg__grid { display: block; }
.dsh-tg__row { display: flex; gap: 16px; align-items: center; justify-content: space-between;
  flex-wrap: wrap; padding: 12px 0; min-height: 40px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent)); }
.dsh-tg__card-title + .dsh-tg__row { border-top: none; }
.dsh-tg__row--column { flex-direction: column; align-items: stretch; gap: 10px; }
.dsh-tg__label { display: block; font-size: 13px; font-weight: 500; line-height: 1.5; }
.dsh-tg__hint { display: block; margin-top: 2px; font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, inherit); }
.dsh-tg__actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  gap: 6px 20px; padding: 4px 0 8px; }
.dsh-tg__mode { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px;
  color: var(--dsw-alias-label-tertiary, inherit); }
.dsh-tg__mode--active { color: var(--dsw-alias-label-primary, inherit); }
.dsh-tg__row > *, .dsh-tg__label, .dsh-tg__hint { min-width: 0; overflow-wrap: anywhere; }
.dsh-tg__status-line { display: flex; gap: 8px; align-items: center; font-size: 13px;
  min-width: 0; overflow-wrap: anywhere;
  padding: 5px 0 10px; }
.dsh-tg__dot { width: 8px; height: 8px; border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary, currentColor); }
.dsh-tg__dot--ongoing { background: var(--dsw-alias-state-success-primary, currentColor); }
.dsh-tg__dot--error { background: var(--dsw-alias-state-error-primary, currentColor); }
.dsh-tg__link { color: var(--dsw-alias-brand-primary, inherit); text-decoration: none; }
.dsh-tg__link:hover { text-decoration: underline; }
.dsh-tg__status { font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, inherit); }
.dsh-tg__status--error { color: var(--dsw-alias-state-error-primary, inherit); }
.dsh-tg__status--ok { color: var(--dsw-alias-state-success-primary, inherit); }
.dsh-tg__state { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary, inherit); }
.dsh-tg__mono { margin: 6px 0 0; font-family: var(--dsh-font-family-code-default, ui-monospace, monospace);
  font-size: 12.5px; line-height: 1.7; white-space: pre-wrap;
  color: var(--dsw-alias-label-secondary, inherit); }
.dsh-tg__input { font: inherit; color: inherit; min-width: 180px; padding: 6px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3, transparent);
  border: 0.5px solid var(--dsw-alias-border-l4, color-mix(in srgb, currentColor 28%, transparent)); }
.dsh-tg__input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid
  var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, currentColor)); outline-offset: 1px; }
.dsh-tg__switch { position: relative; width: 44px; height: 26px; padding: 0; cursor: pointer;
  border-radius: 999px; background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 28%, transparent)); }
.dsh-tg__switch[aria-checked="true"] { border-color: transparent;
  background: var(--dsw-alias-brand-primary, currentColor); }
.dsh-tg__switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid
  var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, currentColor)); outline-offset: 2px; }
.dsh-tg__thumb { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #fff); transition: transform 140ms ease; }
.dsh-tg__switch[aria-checked="true"] .dsh-tg__thumb { transform: translateX(18px); }
`

    /** Поле с локальным черновиком: в Host уходит после паузы, а не на каждый символ. */
    function useDraft(initial, commit) {
      const [text, setText] = React.useState(initial)
      const timer = React.useRef()
      const external = React.useRef(initial)
      React.useEffect(() => {
        if (external.current !== initial) {
          external.current = initial
          setText(initial)
        }
      }, [initial])
      React.useEffect(() => () => clearTimeout(timer.current), [])
      const update = (next) => {
        setText(next)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => { commit(next) }, COMMIT_DELAY_MS)
      }
      return [text, update]
    }

    function Row(props) {
      return h('div', { className: `dsh-tg__row${props.first ? ' dsh-tg__first' : ''}` },
        h('div', null,
          h('span', { className: 'dsh-tg__label' }, props.label),
          props.hint ? h('span', { className: 'dsh-tg__hint' }, props.hint) : null),
        props.children)
    }

    /**
     * Уведомление панели: успех и нейтральное исчезают сами, ошибка держится
     * до следующего действия и объявляется как alert.
     */
    function Notice(props) {
      const notice = props.notice ?? { text: '', kind: 'info' }
      React.useEffect(() => {
        if (notice.text === '' || notice.kind === 'error') return undefined
        const timer = setTimeout(() => props.onDone?.(), 6000)
        return () => clearTimeout(timer)
      }, [notice.text, notice.kind])

      if (notice.text === '') return h('span', { className: 'dsh-tg__status' }, '')
      const tone = notice.kind === 'error' ? ' dsh-tg__status--error' : notice.kind === 'ok' ? ' dsh-tg__status--ok' : ''
      return h('span', {
        role: notice.kind === 'error' ? 'alert' : 'status',
        className: `dsh-tg__status${tone}`,
      }, notice.text)
    }

    function FallbackSwitch(props) {
      const checked = props.checked === true
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': props.label,
        className: 'dsh-tg__switch', disabled: props.disabled,
        onClick: () => props.onChange(!checked),
      }, h('span', { className: 'dsh-tg__thumb' }))
    }

    function Toggle(props) {
      if (has.Switch) {
        return h(Switch, {
          checked: props.checked === true,
          disabled: props.disabled,
          label: props.label,
          onChange: props.onChange,
        })
      }
      return h(FallbackSwitch, props)
    }

    function FallbackInput(props) {
      return h('input', { ...props, className: 'dsh-tg__input' })
    }

    function TextField(props) {
      const [text, setText] = useDraft(props.value, (next) => props.onCommit(next))
      if (has.SettingsValueField) {
        return h(SettingsValueField, {
          id: props.id,
          label: props.label,
          hint: props.hint,
          numeric: props.numeric === true,
          disabled: props.disabled === true,
          text,
          value: props.value,
          overridden: props.overridden === true,
          overriddenLabel: props.overriddenLabel,
          resetLabel: props.resetLabel,
          invalid: props.invalid === true,
          invalidLabel: props.invalidLabel,
          onEdit: (next) => setText(next),
          onReset: props.onReset,
        })
      }
      const Field = has.Input ? Input : FallbackInput
      return h(Row, { label: props.label, hint: props.hint },
        h(Field, {
          type: props.numeric === true ? 'number' : 'text',
          value: text,
          'aria-label': props.label,
          onChange: (event) => setText(event.target.value),
        }))
    }

    function SecretField(props) {
      const text = props.text
      const setText = props.onChange
      if (has.SettingsSecretField) {
        return h(SettingsSecretField, {
          id: props.id,
          label: props.label,
          hint: props.hint,
          disabled: props.disabled === true,
          text,
          configured: props.configured === true,
          stateLabel: props.stateLabel ?? '',
          onEdit: (next) => setText(next),
        })
      }
      return h(Row, { label: props.label, hint: props.hint },
        h(FallbackInput, {
          type: 'password',
          value: text,
          placeholder: props.placeholder,
          'aria-label': props.label,
          onChange: (event) => setText(event.target.value),
        }))
    }

    function ModeField(props) {
      if (has.SegmentedControl) {
        return h(SegmentedControl, {
          id: props.id,
          label: props.label,
          value: props.value,
          options: MODES.map((mode) => ({ value: mode, label: props.labels?.[mode] ?? mode })),
          onChange: props.onChange,
        })
      }
      return h(Row, { label: props.label },
        h('select', {
          className: 'dsh-tg__input',
          value: props.value,
          'aria-label': props.label,
          onChange: (event) => props.onChange(event.target.value),
        }, MODES.map((mode) => h('option', { key: mode, value: mode }, mode))))
    }

    function ActionButton(props) {
      const label = props.label ?? (typeof props.children === 'string' ? props.children : undefined)
      if (has.Button) {
        return h(Button, {
          variant: props.primary ? 'primary' : 'outline',
          size: 'sm',
          disabled: props.disabled,
          onClick: props.onClick,
          'aria-label': label,
          children: props.children,
        })
      }
      return h('button', {
        type: 'button',
        className: 'dsh-tg__input',
        'aria-label': label,
        disabled: props.disabled,
        onClick: props.onClick,
        style: { cursor: 'pointer', minWidth: 0 },
      }, props.children)
    }

    function Section(props) {
      // aria-labelledby связывает секцию с заголовком: скринридер читает её как область.
      const id = `dsh-tg-section-${String(props.title).replace(/\s+/g, '-').toLowerCase()}`
      return h('section', { className: 'dsh-tg__section', 'aria-labelledby': id },
        h('h2', { className: 'dsh-tg__card-title', id }, props.title), props.children)
    }

    return {
      // remote.credentials — отдельный инжект: прокси ctx.remote не отдаёт
      // пространство credentials без объявления (как remote.settings у ui-settings).
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { ru, en }), 'telegram: dictionaries')
        const t = ctx.locale.bind(NS)

        let form
        try {
          form = ctx.configForms.get(ENTRY_ID)
        } catch {
          form = undefined
        }

        function Body() {
          if (form === undefined || typeof form.getSnapshot !== 'function') {
            return h('p', { className: 'dsh-tg__subtitle' }, t('unavailable'))
          }
          const subscribe = React.useCallback((listener) => form.subscribe(listener), [])
          const readSnapshot = React.useCallback(() => form.getSnapshot(), [])
          const snapshot = React.useSyncExternalStore(subscribe, readSnapshot)
          const value = snapshot.value ?? {}
          const user = snapshot.user ?? {}
          const [invalid, setInvalid] = React.useState({})
          const [token, setToken] = React.useState('')
          const [tokenInfo, setTokenInfo] = React.useState(undefined)
          const [notice, setNotice] = React.useState({ text: '', kind: 'info' })
          const [busy, setBusy] = React.useState(false)

          React.useEffect(() => {
            let alive = true
            const load = async () => {
              try {
                const response = await ctx.remote.credentials.describe([TOKEN_REF])
                if (alive) setTokenInfo(response?.[TOKEN_REF])
              } catch {
                // Remote ещё не подключён — покажем «токен не задан»
              }
            }
            void load()
            return () => { alive = false }
          }, [])

          const write = async (field, next) => {
            try {
              const ok = await form.set(field, next)
              setNotice({ text: ok ? t('saved') : t('refused'), kind: ok ? 'ok' : 'error' })
            } catch {
              setNotice({ text: t('refused'), kind: 'error' })
            }
          }

          const resetField = (field) => {
            void form.unset(field).then((ok) => {
              if (!ok) setNotice({ text: t('refused'), kind: 'error' })
            }).catch((error) => {
              setNotice({ text: `${t('refused')}: ${String(error?.message ?? error)}`, kind: 'error' })
            })
          }

          const saving = busy
          const tokenConfigured = tokenInfo?.configured === true
          const tokenState = tokenConfigured
            ? `${t('tokenConfigured')}${tokenInfo?.masked ? ` · ${tokenInfo.masked}` : ''}`
            : t('tokenMissing')

          const apiRoot = String(value.apiBase ?? '').trim() || 'https://api.telegram.org'
          const telegram = async (method, payload) => {
            const response = await fetch(`${apiRoot.replace(/\/+$/, '')}/bot${token.trim()}/${method}`, {
              method: payload === undefined ? 'GET' : 'POST',
              headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
              body: payload === undefined ? undefined : JSON.stringify(payload),
              signal: AbortSignal.timeout(10_000),
            })
            return response.json()
          }

          const saveToken = async (candidate) => {
            const next = String(candidate ?? '').trim()
            if (next === '') return
            setBusy(true)
            try {
              await ctx.remote.credentials.set(TOKEN_REF, next)
              setTokenInfo({ configured: true })
              setNotice({ text: t('tokenSaved'), kind: 'ok' })
              setToken('')
              const me = await telegram('getMe').catch(() => undefined)
              if (me?.ok) setTokenInfo({ configured: true, bot: me.result.username })
            } catch (error) {
              const message = String(error?.message ?? error)
              console.error('telegram: credentials.set failed', error)
              setNotice({ text: `${t('tokenFailed')}: ${message}`, kind: 'error' })
            } finally {
              setBusy(false)
            }
            try {
              const response = await ctx.remote.credentials.describe([TOKEN_REF])
              const info = response?.[TOKEN_REF]
              if (info?.configured !== true) {
                setNotice({ text: t('tokenNotStored'), kind: 'error' })
              }
            } catch {
              // describe мог не пройти — выше уже показали причину сохранения
            }
          }

          if (snapshot.status === 'unavailable') {
            return h('p', { className: 'dsh-tg__state', role: 'status' }, t('unavailable'))
          }
          if (snapshot.status === 'loading') {
            return h('p', { className: 'dsh-tg__state', role: 'status' }, t('loading'))
          }

          const botName = tokenInfo?.bot
          const state = {
            dot: tokenConfigured ? (notice.kind === 'error' ? 'error' : 'ongoing') : 'idle',
            text: notice.kind === 'error'
              ? notice.text
              : tokenConfigured
                ? `${t('statusConnected')}${botName ? `: @${botName}` : ''}`
                : t('statusNoToken'),
          }

          const tokenActions = h('div', { className: 'dsh-tg__actions' },
            h(ActionButton, { primary: true, disabled: saving || token.trim() === '', onClick: () => { void saveToken(token) } }, t('saveToken')),
            h(ActionButton, {
              disabled: saving || token.trim() === '',
              onClick: async () => {
                const candidate = token.trim()
                setBusy(true)
                try {
                  const me = await fetch(`${apiRoot.replace(/\/+$/, '')}/bot${candidate}/getMe`)
                    .then((response) => response.json())
                  if (me?.ok) setTokenInfo({ configured: true, bot: me.result.username })
                  setNotice(me?.ok
                    ? { text: `${t('checkOk')}: @${me.result.username}`, kind: 'ok' }
                    : { text: `${t('checkFailed')}: ${me?.description ?? 'HTTP'}`, kind: 'error' })
                } catch (error) {
                  setNotice({ text: `${t('checkFailed')}: ${String(error?.message ?? error)}`, kind: 'error' })
                } finally {
                  setBusy(false)
                }
              },
            }, t('check')),
            h(ActionButton, {
              disabled: saving || token.trim() === '' || Number(value.ownerId ?? 0) <= 0,
              onClick: async () => {
                const candidate = token.trim()
                const owner = Number(value.ownerId ?? 0)
                setBusy(true)
                try {
                  const response = await fetch(`${apiRoot.replace(/\/+$/, '')}/bot${candidate}/sendMessage`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ chat_id: owner, text: t('testMessage') }),
                    signal: AbortSignal.timeout(10_000),
                  }).then((result) => result.json())
                  setNotice(response?.ok
                    ? { text: t('testSent'), kind: 'ok' }
                    : { text: `${t('testFailed')}: ${response?.description ?? 'HTTP'}`, kind: 'error' })
                } catch (error) {
                  setNotice({ text: `${t('testFailed')}: ${String(error?.message ?? error)}`, kind: 'error' })
                } finally {
                  setBusy(false)
                }
              },
            }, t('test')),
            h(ActionButton, {
              disabled: saving || !tokenConfigured,
              onClick: async () => {
                setBusy(true)
                try {
                  await ctx.remote.credentials.unset(TOKEN_REF)
                  setTokenInfo({ configured: false })
                  setNotice({ text: t('tokenRemoved'), kind: 'ok' })
                } catch (error) {
                  setNotice({ text: `${t('tokenRemoveFailed')}: ${String(error?.message ?? error)}`, kind: 'error' })
                } finally {
                  setBusy(false)
                }
              },
            }, t('removeToken')))

          return h('div', null,
            h(Section, { title: t('connection') },
              h('div', { className: 'dsh-tg__row dsh-tg__first' },
                h('div', { className: 'dsh-tg__status-line', role: 'status' },
                  has.StateDot
                    ? h(StateDot, { state: state.dot })
                    : h('span', { className: `dsh-tg__dot${state.dot === 'error' ? ' dsh-tg__dot--error' : state.dot === 'ongoing' ? ' dsh-tg__dot--ongoing' : ''}` }),
                  h('span', null, state.text),
                  botName
                    ? h('a', {
                        className: 'dsh-tg__link',
                        href: `https://t.me/${botName}`,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                      }, `t.me/${botName}`)
                    : null)),

              h('div', { className: 'dsh-tg__row', style: { flexDirection: 'column', alignItems: 'stretch', gap: 10 } },
                h('div', { style: { minWidth: 0 } },
                  h(SecretField, {
                    id: 'dsh-telegram-token',
                    label: t('token'),
                    hint: t('tokenHint'),
                    stateLabel: tokenState,
                    configured: tokenConfigured,
                    disabled: saving,
                    text: token,
                    onChange: setToken,
                  })),
                tokenActions,
                h(Notice, {
                  notice,
                  onDone: () => setNotice({ text: '', kind: 'info' }),
                }),
              ),

              h('div', { className: 'dsh-tg__grid' },
                h(Row, { label: t('enabled'), hint: t('enabledHint') },
                  h(Toggle, {
                    checked: value.enabled === true,
                    label: t('enabled'),
                    'aria-checked': value.enabled === true,
                    onChange: (next) => { void write('enabled', next) },
                  })),

                h(TextField, {
                  id: 'dsh-telegram-owner',
                  label: t('ownerId'),
                  hint: t('ownerHint'),
                  numeric: true,
                  value: value.ownerId ? String(value.ownerId) : '',
                  overridden: Object.hasOwn(user, 'ownerId'),
                  overriddenLabel: t('overridden'),
                  resetLabel: t('reset'),
                  invalid: invalid.ownerId === true,
                  invalidLabel: t('ownerInvalid'),
                  onCommit: (text) => {
                    const trimmed = text.trim()
                    if (trimmed === '') {
                      setInvalid((prev) => ({ ...prev, ownerId: false }))
                      void form.unset('ownerId').catch(() => {})
                      return
                    }
                    const id = Number(trimmed)
                    if (!Number.isInteger(id) || id <= 0) {
                      setInvalid((prev) => ({ ...prev, ownerId: true }))
                      return
                    }
                    setInvalid((prev) => ({ ...prev, ownerId: false }))
                    void write('ownerId', id)
                  },
                  onReset: () => resetField('ownerId'),
                }),
              )),

            h(Section, { title: t('accessTitle') },
              String(value.pairingCode ?? '') === ''
                ? h('div', { className: 'dsh-tg__row dsh-tg__first' },
                    h('span', { className: 'dsh-tg__hint' }, t('emptyPairing')))
                : null,

              h('div', { className: 'dsh-tg__grid' },
                h(TextField, {
                  id: 'dsh-telegram-allowlist',
                  label: t('allowlist'),
                  hint: t('allowlistHint'),
                  value: String(value.allowedUsers ?? ''),
                  overridden: Object.hasOwn(user, 'allowedUsers'),
                  overriddenLabel: t('overridden'),
                  resetLabel: t('reset'),
                  onCommit: (text) => { void write('allowedUsers', text) },
                  onReset: () => resetField('allowedUsers'),
                }),

                h(TextField, {
                  id: 'dsh-telegram-pairing',
                  label: t('pairingCode'),
                  hint: t('pairingCodeHint'),
                  value: String(value.pairingCode ?? ''),
                  overridden: Object.hasOwn(user, 'pairingCode'),
                  overriddenLabel: t('overridden'),
                  resetLabel: t('reset'),
                  onCommit: (text) => { void write('pairingCode', text.trim()) },
                  onReset: () => resetField('pairingCode'),
                }),

                h(Row, { label: t('language'), hint: t('languageHint') },
                  h(SegmentedControl, {
                    value: LANGS.includes(value.language) ? value.language : 'auto',
                    options: LANGS.map((lang) => ({ value: lang, label: t(`lang_${lang}`) })),
                    onChange: (next) => { void write('language', next) },
                  })),
              )),

            h(Section, { title: t('notifyTitle') },
              value.enabled === false
                ? h('div', { className: 'dsh-tg__row dsh-tg__first' },
                    h('span', { className: 'dsh-tg__hint' }, t('emptyBotOff')))
                : null,

              h('div', { className: 'dsh-tg__grid' },
                h('div', { className: 'dsh-tg__row dsh-tg__row--full' },
                  h('span', null,
                    h('span', { className: 'dsh-tg__label' }, t('notify')),
                    h('span', { className: 'dsh-tg__hint' }, t('notifyHint'))),
                  h('div', { className: 'dsh-tg__actions' },
                    h(ModeField, {
                      id: 'dsh-telegram-notify',
                      label: t('notify'),
                      labels: { off: t('mode_off'), quiet: t('mode_quiet'), normal: t('mode_normal'), verbose: t('mode_verbose') },
                      value: MODES.includes(value.notifyMode) ? value.notifyMode : 'normal',
                      onChange: (next) => { void write('notifyMode', next) },
                    }))),

                h(Row, { label: t('allowNew'), hint: t('allowNewHint') },
                  h(Toggle, {
                    checked: value.allowNewSessions === true,
                    label: t('allowNew'),
                    'aria-checked': value.allowNewSessions === true,
                    onChange: (next) => { void write('allowNewSessions', next) },
                  })),

                h(Row, { label: t('streaming'), hint: t('streamingHint') },
                  h(Toggle, {
                    checked: value.streaming === true,
                    label: t('streaming'),
                    'aria-checked': value.streaming === true,
                    onChange: (next) => { void write('streaming', next) },
                  })),

                h(Row, { label: t('richMessages'), hint: t('richHint') },
                  h(Toggle, {
                    checked: value.richMessages !== false,
                    label: t('richMessages'),
                    'aria-checked': value.richMessages !== false,
                    onChange: (next) => { void write('richMessages', next) },
                  })),

                h(Row, { label: t('richHeadings'), hint: t('richHeadingsHint') },
                  h(Toggle, {
                    checked: value.richHeadings === true,
                    label: t('richHeadings'),
                    'aria-checked': value.richHeadings === true,
                    disabled: value.richMessages === false,
                    onChange: (next) => { void write('richHeadings', next) },
                  })),
              )),

            h(Section, { title: t('approvalsTitle') },
              h('div', { className: 'dsh-tg__grid' },
                h(Row, { label: t('approvals'), hint: t('approvalsHint') },
                  h(Toggle, {
                    checked: value.approvals !== false,
                    label: t('approvals'),
                    'aria-checked': value.approvals !== false,
                    onChange: (next) => { void write('approvals', next) },
                  })),

                h(Row, { label: t('approvalsPosture'), hint: t('approvalsPostureHint') },
                  h(SegmentedControl, {
                    value: POSTURES.includes(value.approvalsPosture) ? value.approvalsPosture : 'ask',
                    options: POSTURES.map((posture) => ({ value: posture, label: t(`posture_${posture}`) })),
                    onChange: (next) => { void write('approvalsPosture', next) },
                  })),

                h(Row, { label: t('questions'), hint: t('questionsHint') },
                  h(Toggle, {
                    checked: value.questions !== false,
                    label: t('questions'),
                    'aria-checked': value.questions !== false,
                    onChange: (next) => { void write('questions', next) },
                  })),
              )),

            h(Section, { title: t('workspaceTitle') },
              String(value.workspacePath ?? '') === ''
                ? h('div', { className: 'dsh-tg__row dsh-tg__first' },
                    h('span', { className: 'dsh-tg__hint' }, t('emptyWorkspace')))
                : null,

              h('div', { className: 'dsh-tg__grid' },
                h(TextField, {
                  id: 'dsh-telegram-workspace',
                  label: t('workspace'),
                  hint: t('workspaceHint'),
                  value: String(value.workspacePath ?? ''),
                  overridden: Object.hasOwn(user, 'workspacePath'),
                  overriddenLabel: t('overridden'),
                  resetLabel: t('reset'),
                  onCommit: (text) => { void write('workspacePath', text) },
                  onReset: () => resetField('workspacePath'),
                }),

                h(TextField, {
                  id: 'dsh-telegram-api-base',
                  label: t('apiBase'),
                  hint: t('apiBaseHint'),
                  value: String(value.apiBase ?? ''),
                  overridden: Object.hasOwn(user, 'apiBase'),
                  overriddenLabel: t('overridden'),
                  resetLabel: t('reset'),
                  onCommit: (text) => { void write('apiBase', text) },
                  onReset: () => resetField('apiBase'),
                }),
              ))
          )
        }

        function PanelPage() {
          return h('div', { className: 'dsh-tg' },
            h('style', null, styles),
            h('div', { className: 'dsh-tg__inner' },
              h('div', { className: 'dsh-tg__head' },
                h('h1', { className: 'dsh-tg__title' }, t('title'))),
              h(Body)))
        }

        // Форма одна и та же в сайдбаре и в карточке плагина; цвет не зависит
        // от активного состояния — иконка не меняется при нажатии.
        const ICON_PATH = 'M30.2 5.4a1.2 1.2 0 0 0-1.6-.9L3.9 15.2c-1.1.4-1.1 2 0 2.4l6.2 2.2 2.2 6.9c.3 1 1.5 1.2 2.2.5l3.6-3.7 5.6 4.1c.8.6 2 .2 2.2-.8l4.3-21.4Z'
        const ICON_LINE = 'm10.6 18.2 12.6-8.4-8.7 10.2'

        function PanelIcon(props) {
          const size = props.size ?? 16
          return h('svg', {
            width: size, height: size, viewBox: '0 0 36 36',
            'aria-hidden': true, focusable: false,
            style: { display: 'block' },
          },
          h('path', { d: ICON_PATH, fill: 'currentColor' }),
          h('path', { d: ICON_LINE, fill: 'none', stroke: 'var(--dsw-alias-bg-base, #fff)', strokeWidth: 1.6 }))
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, PanelPage))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel'),
        }, PanelIcon))
      },
    }
  },
})
