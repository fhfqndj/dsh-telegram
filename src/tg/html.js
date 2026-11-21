/**
 * Разметка для Telegram: экранирование, markdown → HTML, разбиение длинного
 * сообщения с сохранением баланса тегов.
 *
 * Telegram принимает HTML и понимает только узкий набор тегов, а лимит в 4096
 * символов считается по видимому тексту. Поэтому сначала приводим markdown к
 * безопасному HTML, потом режем на куски, закрывая открытые теги в конце куска и
 * переоткрывая их в начале следующего.
 */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export const escapeHtml = (value) =>
  String(value).replace(/[&<>]/g, (char) => ESCAPE_MAP[char]);

/**
 * Кавычки для значения атрибута. Основное экранирование уже сделано выше
 * (текст прошёл escapeHtml), поэтому здесь только кавычки — иначе &amp;
 * превратился бы в &amp;amp;.
 */
export const escapeAttr = (value) =>
  String(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const VOID_TAGS = new Set(['br', 'hr']);

/**
 * markdown → HTML для ответов агента. Поддерживается ровно то, что реально
 * встречается: блоки кода, инлайн-код, жирный/курсив, заголовки, ссылки, списки.
 * Всё остальное остаётся текстом.
 */
/**
 * pipe-таблица GFM → моноширинный блок с выравниванием.
 * Telegram Bot API до 10.1 таблиц не знает; в rich-пути markdown уходит как есть.
 */
export function tableToPre(lines) {
  const rows = lines
    .filter((line) => !/^\s*\|?[\s:-]+\|[\s:|-]*$/.test(line))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
  if (rows.length === 0) return ''
  const columns = Math.max(...rows.map((row) => row.length))
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(...rows.map((row) => (row[index] ?? '').length)))
  const body = rows.map((row) => Array.from({ length: columns }, (_, index) =>
    (row[index] ?? '').padEnd(widths[index])).join(' │ ').trimEnd())
  return `<pre>${escapeHtml(body.join('\n'))}</pre>`
}


/**
 * Пустая строка между блоками: абзац, заголовок, список, таблица, код.
 *
 * Агент часто пишет блоки подряд через один перевод строки — в чате они
 * слипаются. Функция расставляет ровно одну пустую строку на границе блоков
 * и не трогает содержимое таблиц, списков и код-блоков.
 */
export function normalizeBlocks(markdown, separator = '') {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const kindOf = (line) => {
    if (/^\s*```/.test(line)) return 'fence'
    if (/^\s*\|.*\|\s*$/.test(line)) return 'table'
    if (/^#{1,6}\s/.test(line)) return 'heading'
    if (/^\s*([-*+]|\d+[.)])\s/.test(line)) return 'list'
    if (line.trim() === '') return 'blank'
    return 'text'
  }

  const out = []
  let inFence = false
  let previous = 'blank'
  for (const line of lines) {
    const kind = kindOf(line)
    if (kind === 'fence') {
      inFence = !inFence
      out.push(line)
      previous = 'blank'
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (kind === 'blank') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      previous = 'blank'
      continue
    }
    const boundary = previous !== 'blank'
      && previous !== kind
      && !(previous === 'list' && kind === 'list')
      && !(previous === 'table' && kind === 'table')
    // Пустая строка между жирной строкой и абзацем в rich схлопывается,
    // поэтому rich-путь вставляет невидимый разделитель (U+200B).
    if (boundary) out.push(separator)
    out.push(line)
    previous = kind
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * Каждая текстовая строка — с новой строки в чате.
 *
 * В markdown одиночный перевод строки — мягкий: Telegram схлопывает его в пробел,
 * и абзацы сливаются в один поток. Два пробела в конце строки — жёсткий перенос.
 * Таблицы, списки и код не трогаем: их разметка зависит от собственных переводов.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function hardLineBreaks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) { out.push(line); continue }
    const trimmed = line.trim()
    if (trimmed === '') { out.push(line); continue }
    if (/^\|.*\|$/.test(trimmed)) { out.push(line); continue }
    if (/^\s*([-*+]|\d+[.)])\s/.test(line)) { out.push(line); continue }
    out.push(`${line.trimEnd()}  `)
  }
  return out.join('\n')
}

/**
 * Заголовки markdown → жирная строка.
 *
 * Rich-сообщения рисуют `#` как настоящие заголовки, а в чате это выглядит
 * чужеродно; таблицы оставляем нативными, заголовки — обычным жирным.
 * Код-блоки не трогаем: внутри ``` строки с # остаются как есть.
 */
export function downgradeHeadings(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  let inFence = false
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    return heading === null ? line : `**${heading[2].trim()}**`
  }).join('\n')
}

/**
 * Таблицы → список строк: «• колонка: значение · колонка: значение».
 *
 * Код-блок с выравниванием в чате выглядит как код и на телефоне ломается,
 * поэтому по умолчанию таблицы без нативной поддержки идут списком.
 */
export function tablesToList(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let table = []
  const flush = () => {
    if (table.length === 0) return
    const rows = table
      .filter((line) => !/^\s*\|?[\s:-]+\|[\s:|-]*$/.test(line))
      .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
    if (rows.length > 0) {
      const header = rows[0]
      for (const row of rows.slice(1)) {
        const parts = row.map((cell, index) => {
          const label = header[index] ?? ''
          return label === '' ? cell : `**${label}:** ${cell}`
        }).filter((part) => part !== '')
        if (parts.length > 0) out.push(`• ${parts.join(' · ')}`)
      }
    }
    table = []
  }
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      table.push(line)
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return out.join('\n')
}

/**
 * Строки одной таблицы → строки списка (markdown, экранируется дальше).
 * @param {string[]} table
 */
function tableRowsToList(table) {
  const rows = table
    .filter((line) => !/^\s*\|?[\s:-]+\|[\s:|-]*$/.test(line))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
  if (rows.length === 0) return []
  const header = rows[0]
  return rows.slice(1).map((row) => {
    const parts = row.map((cell, index) => {
      const label = header[index] ?? ''
      return label === '' ? cell : `**${label}:** ${cell}`
    }).filter((part) => part !== '')
    return `• ${parts.join(' · ')}`
  })
}

/**
 * Таблицы → блок кода с выравниванием: запасной вариант, если список не подходит.
 */
export function tablesToFencedCode(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let table = []
  const flush = () => {
    if (table.length === 0) return
    const rows = table
      .filter((line) => !/^\s*\|?[\s:-]+\|[\s:|-]*$/.test(line))
      .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
    if (rows.length > 0) {
      const columns = Math.max(...rows.map((row) => row.length))
      const widths = Array.from({ length: columns }, (_, index) =>
        Math.max(...rows.map((row) => (row[index] ?? '').length)))
      out.push('```')
      for (const row of rows) {
        out.push(Array.from({ length: columns }, (_, index) =>
          (row[index] ?? '').padEnd(widths[index])).join(' | ').trimEnd())
      }
      out.push('```')
    }
    table = []
  }
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      table.push(line)
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return out.join('\n')
}

/** Находит блоки pipe-таблиц и заменяет их на <pre>. */
function replaceTables(lines) {
  const out = []
  let table = []
  let inFence = false
  const flush = () => {
    if (table.length > 0) {
      // Таблица → строки списка; код-блок на телефоне выглядит как код.
      out.push(...tableRowsToList(table))
      table = []
    }
  }
  for (const line of lines) {
    // Внутри фенса markdown не разбирается: таблица там — просто текст.
    if (/^\s*```/.test(line)) {
      flush()
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      table.push(line)
      continue
    }
    flush()
    out.push(line)
  }
  flush()
  return out
}

export function markdownToHtml(markdown) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = replaceTables(source.split('\n'));
  const out = [];
  let inFence = false;
  let fenceLang = '';
  let fenceLines = [];

  const flushFence = () => {
    const body = escapeHtml(fenceLines.join('\n'));
    const lang = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : '';
    out.push(`<pre><code${lang}>${body}</code></pre>`);
    fenceLines = [];
    fenceLang = '';
  };

  for (const line of lines) {
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (inFence) {
        flushFence();
        inFence = false;
      } else {
        if (inFence) flushFence();
        inFence = true;
        fenceLang = fence[1] ?? '';
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    if (line.startsWith('\u0001')) {
      out.push(line.slice(1))
      continue
    }
    out.push(inline(line));
  }
  if (inFence) flushFence();

  return out.join('\n');
}

function inline(line) {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return `<b>${inlineSpans(heading[2])}</b>`;

  const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `• ${inlineSpans(bullet[1])}`;

  const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
  if (ordered) return `${ordered[1]}. ${inlineSpans(ordered[2])}`;

  return inlineSpans(line);
}

/** Инлайн-разметка одной строки. Экранируем до подстановки тегов. */
export function inlineSpans(raw) {
  const codes = [];
  let text = String(raw).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_, label, href) => `<a href="${escapeAttr(href)}">${label}</a>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_]+)__/g, '<b>$1</b>');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  text = text.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>');

  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

/**
 * Режет HTML на куски не длиннее max, балансируя теги.
 * @param {string} html
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitHtml(html, max = 3800) {
  const text = String(html ?? '');
  if (!text) return [];

  const chunks = [];
  const tagRe = /<\/?([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi;
  /** @type {{ name: string, raw: string }[]} */
  const stack = [];
  let buffer = '';
  let cursor = 0;

  const opening = () => stack.map((entry) => entry.raw).join('');
  const closing = () =>
    [...stack].reverse().map((entry) => `</${entry.name}>`).join('');
  const flush = () => {
    if (buffer.length > opening().length) chunks.push(buffer + closing());
    buffer = opening();
  };

  while (cursor < text.length) {
    tagRe.lastIndex = cursor;
    const match = tagRe.exec(text);
    const end = match ? match.index : text.length;
    let segment = text.slice(cursor, end);

    while (segment.length > 0) {
      const room = max - buffer.length;
      if (segment.length <= room) {
        buffer += segment;
        break;
      }
      const cut = softCut(segment, room);
      buffer += segment.slice(0, cut);
      flush();
      segment = segment.slice(cut);
    }

    if (!match) break;

    const raw = match[0];
    const name = match[1].toLowerCase();
    if (raw.startsWith('</')) {
      buffer += raw;
      stack.pop();
    } else if (!raw.endsWith('/>') && !VOID_TAGS.has(name)) {
      buffer += raw;
      stack.push({ name, raw });
    } else {
      buffer += raw;
    }
    cursor = match.index + raw.length;
  }

  if (buffer.length > opening().length) chunks.push(buffer + closing());
  return chunks;
}

/** Куда резать: не в середине сущности, суррогатной пары и лучше по границе строки. */
function softCut(segment, room) {
  let cut = Math.min(room, segment.length);

  const amp = segment.lastIndexOf('&', cut - 1);
  if (amp !== -1) {
    const semi = segment.indexOf(';', amp);
    if (semi === -1 || semi >= cut) cut = amp;
  }

  if (cut > 0 && cut < segment.length) {
    const code = segment.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }

  if (cut <= 0) return Math.max(1, Math.min(room, segment.length));

  const head = segment.slice(0, cut);
  for (const separator of ['\n\n', '\n', ' ']) {
    const position = head.lastIndexOf(separator);
    if (position > cut * 0.5) return position + separator.length;
  }
  return cut;
}
