import test from 'node:test';
import assert from 'node:assert/strict';

import {
  downgradeHeadings, escapeHtml, hardLineBreaks, markdownToHtml, normalizeBlocks, splitHtml,
  tablesToFencedCode,
} from '../src/tg/html.js';
test('normalizeBlocks: rich-путь ставит невидимый разделитель между блоками', () => {
  const source = '## Заголовок\nПервый абзац.'
  const result = downgradeHeadings(normalizeBlocks(source, '\u200b'))
  assert.match(result, /\*\*Заголовок\*\*\n\u200b\nПервый абзац\./)
})


test('normalizeBlocks: пустая строка между блоками, внутри таблицы и списка — нет', () => {
  const source = '# Итог\nтекст\n- пункт\n- пункт\n| a | b |\n|---|---|\n| 1 | 2 |\nпосле'
  const result = normalizeBlocks(source)
  assert.match(result, /# Итог\n\nтекст/)
  assert.match(result, /текст\n\n- пункт\n- пункт/)
  assert.match(result, /\| 1 \| 2 \|\n\nпосле/)
  assert.ok(!result.includes('\n\n\n'))
})


test('downgradeHeadings: заголовки становятся жирным, таблицы и код не трогаются', () => {
  const markdown = '# Заголовок\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n# не заголовок\n```'
  const result = downgradeHeadings(markdown)
  assert.match(result, /^\*\*Заголовок\*\*/)
  assert.match(result, /\| a \| b \|/)
  assert.match(result, /```\n# не заголовок\n```/)
})


test('markdownToHtml: pipe-таблица становится строками списка, а не кодом', () => {
  const html = markdownToHtml('| Метрика | Значение |\n|---|---|\n| скорость | 42 |')
  assert.ok(!html.includes('<pre>'), 'таблица не должна превращаться в код-блок')
  assert.match(html, /• <b>Метрика:<\/b> скорость · <b>Значение:<\/b> 42/)
})


test('splitHtml: короткое сообщение не режется', () => {
  assert.deepEqual(splitHtml('<b>привет</b>', 3800), ['<b>привет</b>']);
});


test('splitHtml: каждый кусок сбалансирован по тегам', () => {
  const long = `<b>${'жирный текст '.repeat(400)}</b>`;
  const chunks = splitHtml(long, 300);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const opened = (chunk.match(/<b>/g) ?? []).length;
    const closed = (chunk.match(/<\/b>/g) ?? []).length;
    assert.equal(opened, closed, `несбалансирован <b> в куске: ${chunk.slice(0, 40)}…`);
    assert.ok(chunk.length <= 300, `кусок длиннее лимита: ${chunk.length}`);
  }
});


test('splitHtml: видимый текст склеивается в исходный', () => {
  const text = 'Строка про кота. '.repeat(200);
  const chunks = splitHtml(escapeHtml(text), 500);
  const visible = chunks.join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  assert.equal(visible, text);
});


test('splitHtml: не рвёт эмодзи и сущности', () => {
  const text = '😀'.repeat(300) + ' &amp; ' + 'x'.repeat(300);
  const chunks = splitHtml(escapeHtml(text), 120);
  for (const chunk of chunks) {
    assert.ok(!/&(?:amp|lt|gt|#\d*)$/.test(chunk), 'кусок оборван на сущности');
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), 'кусок оборван на суррогатной паре');
  }
});


test('hardLineBreaks: текст — с новой строки, таблица, список и код не тронуты', () => {
  const source = [
    'Первый абзац.',
    'Вторая строка.',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '- пункт',
    '',
    '```',
    'x = 1',
    '```',
  ].join('\n')
  const result = hardLineBreaks(source)

  assert.match(result, /^Первый абзац\. {2}\nВторая строка\. {2}$/m)
  assert.match(result, /^\| A \| B \|$/m, 'строка таблицы без хвостовых пробелов')
  assert.match(result, /^- пункт$/m, 'пункт списка без переноса')
  assert.match(result, /^x = 1$/m, 'содержимое кода без переноса')
})

