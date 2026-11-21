# dsh-telegram

Telegram bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The agent runs on your machine; you read and reply from Telegram. Send tasks, get results, approve
tool calls with buttons, answer agent questions.

## Install

Requires Node 22+ and DSH 0.2.2-rc.1 or newer.

```bash
npx dsh-telegram-connect install          # add the bridge to the desktop profile
npx dsh-telegram-connect status           # profile, patch, secrets, log
npx dsh-telegram-connect uninstall        # remove it
```

Install straight from the repository while the npm package is not published:

```bash
npx github:fhfqndj/dsh-telegram install
```

Restart DSH, open the **Telegram** sidebar panel and paste the token from
[@BotFather](https://t.me/BotFather). Set your user id as the owner and press "Test" — the bot
sends you a message.

Check with `/doctor`, then `/status`.

## Commands

`/status` `/sessions` `/use` `/new` `/peek` `/unbind` `/stop` `/steer` `/mute` `/unmute` `/notify`
`/quiet` `/model` `/cost` `/doctor` `/log` `/lang` `/pair` `/help`

## Features

- Tasks from chat: text, photos as prompt images, documents to `<workspace>/.telegram-inbox/`.
- Rich replies: native tables, lists, code; a progress card shows what the agent is doing.
- Tool approvals as buttons; policy `ask` / `trusted` / `yolo`.
- Agent questions as buttons or free text.
- Files back to the chat via the `telegram_send` tool.
- Access: owner plus allowlist, pairing by code.

## Security

Private chats only; fail-closed without an owner; token in DSH credentials; logs without task texts;
incoming files `0600`.

## License

MIT. See [LICENSE](LICENSE).
