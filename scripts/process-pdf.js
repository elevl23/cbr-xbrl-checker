const pdf = require('pdf-parse');
const axios = require('axios');
const path = require('path');

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ===
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GITHUB_TOKEN = process.env.GH_TOKEN;

const NAME = process.env.INPUT_NAME;
const OLD_URL = process.env.INPUT_OLD_URL;
const NEW_URL = process.env.INPUT_NEW_URL;

if (!DIFY_API_KEY || !GITHUB_TOKEN || !NAME || !OLD_URL || !NEW_URL) {
  console.error('❌ Не хватает переменных окружения');
  process.exit(1);
}

// === НАСТРОЙКИ ОГРАНИЧЕНИЙ ===
// 🔧 Настрой максимальное количество символов, отправляемых в Dify (суммарно для старой + новой)
//
// Варианты:
//   MAX_CHARS = 10000   → обе версии вместе не более 10 000 символов
//   MAX_CHARS = 0       → без ограничений
//   MAX_CHARS = 32768   → максимум для GPT-4-turbo и аналогов
//
// ⚠️ Внимание: обрезка справедливая — каждая версия получает часть лимита пропорционально своему размеру
const MAX_CHARS = 40000; // ⚙️ Меняй здесь

// === ОСНОВНОЙ СКРИПТ ===
async function run() {
  try {
    console.log(`🚀 Сравнение: ${NAME}`);
    console.log(`📄 Старая версия: ${OLD_URL}`);
    console.log(`📄 Новая версия: ${NEW_URL}`);

    const oldText = await pdfToText(OLD_URL);
    const newText = await pdfToText(NEW_URL);

    console.log(`✅ Извлечено: ${oldText.length} и ${newText.length} символов`);

    // 1. Очистка текста
    const cleanOld = cleanText(oldText);
    const cleanNew = cleanText(newText);

    // 2. Парсинг на разделы
    const sectionsOld = parseSections(cleanOld);
    const sectionsNew = parseNewSections(cleanNew);

    console.log(`✅ Разделы: ${Object.keys(sectionsOld).length} → ${Object.keys(sectionsNew).length}`);

    // 3. Сравнение
    const diff = compareSections(sectionsOld, sectionsNew);

    // 4. Формирование полного transcript
    const fullTranscript = formatTranscript(diff, NAME);
    console.log(`📝 Полный размер transcript: ${fullTranscript.length} символов`);

    // 5. Применяем справедливое обрезание, если нужно
    let transcript;
    if (MAX_CHARS > 0 && fullTranscript.length > MAX_CHARS) {
      console.log(`✂️  Общий лимит ${MAX_CHARS} превышен — применяю справедливое обрезание...`);
      transcript = truncateFairly(cleanOld, cleanNew, MAX_CHARS);
      console.log(`✂️  Обрезано: ${transcript.length} символов (суммарно)`);
    } else {
      transcript = fullTranscript;
      console.log(`✅ Без обрезания — размер в пределах лимита`);
    }

    // 6. Отправка в Dify
    console.log('📤 Отправка в Dify...');
    await callDify(transcript);

    // 7. Ожидание Gist
    await waitForGist();

    console.log('✅ Готово!');

  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
  }
}

// === 1. ИЗВЛЕЧЕНИЕ ТЕКСТА ИЗ PDF ===
async function pdfToText(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const data = await pdf(Buffer.from(response.data));
  return data.text;
}

// === 2. ОЧИСТКА ТЕКСТА ОТ ШУМА ===
function cleanText(text) {
  let cleaned = text;

  // Удаление номеров страниц (отдельные цифры)
  cleaned = cleaned.replace(/^\s*\d+\s*$/gm, '');

  // Удаление оглавления
  cleaned = cleaned.replace(/Оглавление[\s\S]*?(?=1\.|Глава\s*\d|ВВЕДЕНИЕ)/i, '');

  // Удаление лишних пробелов и переносов
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]+/g, ' ');

  // Нормализация URL, дат, версий
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '[URL]');
  cleaned = cleaned.replace(/\d{2}\.\d{2}\.\d{4}/g, 'DD.MM.YYYY');
  cleaned = cleaned.replace(/версия\s*[\d.]+/gi, 'версия X.X.X');

  return cleaned.trim();
}

// === 3. ПАРСИНГ РАЗДЕЛОВ (Старая версия) ===
function parseSections(text) {
  const sections = {};
  const lines = text.split('\n');

  let currentKey = null;
  let currentContent = [];

  // Паттерны заголовков
  const patterns = [
    /^Глава\s+\d+\./,
    /^\d+(?:\.\d+){1,3}\./,
    /^\d+(?:\.\d+){1,3}\s*[\.\-]\s+/
  ];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Проверяем, не начался ли новый раздел
    const isHeader = patterns.some(p => p.test(line));

    if (isHeader) {
      // Сохраняем предыдущий раздел
      if (currentKey) {
        sections[currentKey] = {
          title: currentKey,
          content: currentContent.join('\n').trim()
        };
      }
      // Начинаем новый
      currentKey = line;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Сохраняем последний
  if (currentKey) {
    sections[currentKey] = {
      title: currentKey,
      content: currentContent.join('\n').trim()
    };
  }

  return sections;
}

// === 4. ПАРСИНГ РАЗДЕЛОВ (Новая версия) ===
function parseNewSections(text) {
  return parseSections(text);
}

// === 5. СРАВНЕНИЕ РАЗДЕЛОВ ===
function compareSections(oldSec, newSec) {
  const result = {
    added: [],
    removed: [],
    changed: []
  };

  const allKeys = new Set([...Object.keys(oldSec), ...Object.keys(newSec)]);

  for (const key of allKeys) {
    const old = oldSec[key];
    const new_ = newSec[key];

    if (!old && new_) {
      result.added.push(new_);
    } else if (old && !new_) {
      result.removed.push(old);
    } else {
      const cleanOld = normalize(old.content);
      const cleanNew = normalize(new_.content);

      if (cleanOld !== cleanNew) {
        result.changed.push({
          old: old,
          new: new_
        });
      }
    }
  }

  return result;
}

// === 6. НОРМАЛИЗАЦИЯ ДЛЯ СРАВНЕНИЯ ===
function normalize(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .toLowerCase()
    .trim();
}

// === 7. ФОРМАТИРОВАНИЕ ДЛЯ LLM ===
function formatTranscript(diff, docName) {
  let output = '';

  // Удалённые
  if (diff.removed.length > 0) {
    output += `### УДАЛЁННЫЕ РАЗДЕЛЫ (${docName})\n\n`;
    diff.removed.forEach(sec => {
      output += `# ${sec.title}\n${sec.content}\n\n`;
    });
  }

  // Добавленные
  if (diff.added.length > 0) {
    output += `### НОВЫЕ РАЗДЕЛЫ (${docName})\n\n`;
    diff.added.forEach(sec => {
      output += `# ${sec.title}\n${sec.content}\n\n`;
    });
  }

  // Изменённые
  if (diff.changed.length > 0) {
    output += `### ИЗМЕНЁННЫЕ РАЗДЕЛЫ (${docName})\n\n`;
    diff.changed.forEach(change => {
      output += `# ${change.old.title}\n\n`;
      output += `**СТАРАЯ ВЕРСИЯ**\n${change.old.content}\n\n`;
      output += `**НОВАЯ ВЕРСИЯ**\n${change.new.content}\n\n`;
    });
  }

  if (!output) {
    output = `### НИКАКИХ ИЗМЕНЕНИЙ В ДОКУМЕНТЕ "${docName}" НЕ ОБНАРУЖЕНО`;
  }

  return `### СТАРАЯ ВЕРСИЯ (${docName})\n\n${diff.removed.map(r => `# ${r.title}\n${r.content}`).join('\n\n')}\n\n### НОВАЯ ВЕРСИЯ (${docName})\n\n${diff.added.map(a => `# ${a.title}\n${a.content}`).join('\n\n')}\n\n${diff.changed.map(c => `# ${c.new.title}\n${c.new.content}`).join('\n\n')}`;
}

// === 8. СПРАВЕДЛИВОЕ ОБРЕЗАНИЕ ДВУХ ТЕКСТОВ ===
function truncateFairly(oldText, newText, maxTotalChars) {
  const total = oldText.length + newText.length;
  if (total <= maxTotalChars) return oldText + '\n\n' + newText;

  // Рассчитываем долю каждой версии
  const oldRatio = oldText.length / total;
  const newRatio = newText.length / total;

  // Минимум 10% каждой версии, если она не пустая
  const minShare = 0.1;
  let oldShare, newShare;

  if (oldText.length === 0) {
    oldShare = 0;
    newShare = 1;
  } else if (newText.length === 0) {
    oldShare = 1;
    newShare = 0;
  } else {
    oldShare = Math.max(oldRatio, minShare);
    newShare = Math.max(newRatio, minShare);
    // Нормализуем
    const sum = oldShare + newShare;
    oldShare = oldShare / sum;
    newShare = newShare / sum;
  }

  // Вычисляем лимиты
  const oldLimit = Math.floor(maxTotalChars * oldShare);
  const newLimit = maxTotalChars - oldLimit; // чтобы точно не превысить

  // Обрезаем по словам
  const truncatedOld = oldText.length > oldLimit ? truncateText(oldText, oldLimit) : oldText;
  const truncatedNew = newText.length > newLimit ? truncateText(newText, newLimit) : newText;

  return truncatedOld + '\n\n' + truncatedNew;
}

// === 9. ОБРЕЗКА ТЕКСТА ПО СЛОВАМ ===
function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  let truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 0) {
    truncated = truncated.slice(0, lastSpace);
  }
  return truncated + '\n\n[... обрезано до ' + maxChars + ' символов]';
}

// === 10. ВЫЗОВ DIFY ===
async function callDify(transcript) {
  try {
    await axios.post(
      'https://api.dify.ai/v1/workflows/run',
      {
        inputs: { transcript },
        response_mode: 'blocking',
        user: 'github-action-user'
      },
      {
        headers: {
          'Authorization': `Bearer ${DIFY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000
      }
    );
  } catch (err) {
    if (err.response?.status === 504) {
      console.log('✅ 504 — Dify обрабатывает в фоне');
    } else {
      console.error('❌ Ошибка Dify:', err.message);
      process.exit(1);
    }
  }
}

// === 11. ОЖИДАНИЕ GIST ===
async function waitForGist() {
  console.log('⏳ Ожидание Gist...');
  for (let i = 0; i < 90; i++) {
    console.log(`⏱️  ${i + 1}/90...`);
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('🔍 Проверка Gist...');
  try {
    const gistList = await axios.get('https://api.github.com/gists', {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` }
    });

    const recent = gistList.data.find(g =>
      g.description.includes('Сравнение PDF —') &&
      new Date(g.created_at) > new Date(Date.now() - 120000)
    );

    if (recent) {
      console.log('🎉 Gist найден:', recent.html_url);
    } else {
      console.error('❌ Gist не найден');
    }
  } catch (err) {
    console.error('❌ Ошибка при проверке Gist:', err.message);
  }
}

// === ЗАПУСК ===
run();
