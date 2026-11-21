import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { dictionaries, translate } from '../src/i18n.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Эмодзи и символьная типографика, которых в текстах быть не должно. */
const FORBIDDEN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{03A3}\u{2191}\u{2193}\u{2713}\u{2714}]/u
test('в словарях нет эмодзи и символьной типографики', () => {
  for (const [lang, dictionary] of Object.entries(dictionaries)) {
    for (const [key, value] of Object.entries(dictionary)) {
      const text = Array.isArray(value) ? value.join('\n') : String(value)
      const found = text.match(FORBIDDEN)
      assert.equal(found, null, `${lang}.${key} содержит запрещённый символ ${found?.[0] ?? ''}`)
    }
  }
})

