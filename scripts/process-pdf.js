const pdf = require('pdf-parse');
const axios = require('axios');
const path = require('path');

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ===
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const NAME = process.env.INPUT_NAME;
const OLD_URL = process.env.INPUT_OLD_URL;
const NEW_URL = process.env.INPUT_NEW_URL;

if (!DIFY_API_KEY || !GITHUB_TOKEN || !NAME || !OLD_URL || !NEW_URL) {
  console.error('❌ Не хватает переменных окружения');
  process.exit(1);
}

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
    const sectionsNew = parseSections(cleanNew);

    console.log(`✅ Разделы: ${Object.keys(sectionsOld).length} → ${Object.keys(sectionsNew).length}`);

    // 3. Сравнение разделов
    const diff = compareSections(sectionsOld, sectionsNew);

    // 4. Формирование финального transcript
    const transcript = formatTranscript(diff, NAME);

    // 5. Отправка в Dify
    console.log('📤 Отправка в Dify...');
    await callDify(transcript);

    // 6. Ожидание Gist (как у вас)
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

  // Удаление оглавления (по ключевым словам)
  cleaned = cleaned.replace(/Оглавление[\s\S]*?(?=1\.|Глава\s*\d|ВВЕДЕНИЕ)/i, '');

  // Удаление лишних пробелов и переносов
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]+/g, ' ');

  // Удаление URL, дат, версий (нормализация)
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '[URL]');
  cleaned = cleaned.replace(/\d{2}\.\d{2}\.\d{4}/g, 'DD.MM.YYYY');
  cleaned = cleaned.replace(/версия\s*[\d.]+/gi, 'версия X.X.X');
  cleaned = cleaned.replace(/от\s+DD\.MM\.YYYY/gi, 'от DD.MM.YYYY');

  // Удаление пустых строк в начале/конце
  return cleaned.trim();
}

// === 3. ПАРСИНГ НА РАЗДЕЛЫ ===
function parseSections(text) {
  const sections = {};

  // Паттерны заголовков
  const patterns = [
    // Порядок: "Глава 1. Общие положения"
    { regex: /^Глава\s+(\d+)\.\s+(.+?)(?=\n\s*Глава\s+\d+|$)/gims, key: 'chapter-$1' },
    // Порядок: "1.1", "2.2.3"
    { regex: /^(\d+(?:\.\d+){0,3})\.\s+(.+?)(?=\n\s*\d+(?:\.\d+){0,3}\.\s+|$)/gims, key: 'section-$1' },
    // Правила: "2.2.3.", "3.1"
    { regex: /^(\d+(?:\.\d+)+)\s*[\.\-]\s+(.+?)(?=\n\s*\d+(?:\.\d+)+\s*[\.\-]|$)/gims, key: 'rule-$1' },
    // Правила: "Приложение 1", "Приложение 2"
    { regex: /^(Приложение\s+\d+)[\s\S]*?(?=Приложение\s+\d+|$)/gi, key: 'appendix-$1' },
  ];

  for (const { regex, key } of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const fullMatch = match[0].trim();
      const header = match[1] || match[2];
      const sectionKey = key.replace('$1', header);

      // Сохраняем чистый заголовок + содержимое
      const content = fullMatch.replace(/^[^\n]+\n/, '').trim();
      const title = fullMatch.split('\n')[0].trim();

      sections[sectionKey] = { title, content, raw: fullMatch };
    }
  }

  // Если ничего не найдено — возвращаем весь текст как один блок
  if (Object.keys(sections).length === 0) {
    sections['full'] = { title: 'Полный текст', content: text, raw: text };
  }

  return sections;
}

// === 4. СРАВНЕНИЕ РАЗДЕЛОВ ===
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
      // Сравнение по содержимому (игнорируем пробелы/переносы)
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

// === 5. НОРМАЛИЗАЦИЯ ТЕКСТА ===
function normalize(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .toLowerCase()
    .trim();
}

// === 6. ФОРМАТИРОВАНИЕ ДЛЯ LLM ===
function formatTranscript(diff, docName) {
  let output = '';

  // Добавленные
  if (diff.added.length > 0) {
    output += '### НОВЫЕ РАЗДЕЛЫ\n\n';
    diff.added.forEach(sec => {
      output += `# ${sec.title}\n${sec.content}\n\n`;
    });
  }

  // Удалённые
  if (diff.removed.length > 0) {
    output += '### УДАЛЁННЫЕ РАЗДЕЛЫ\n\n';
    diff.removed.forEach(sec => {
      output += `# ${sec.title}\n${sec.content}\n\n`;
    });
  }

  // Изменённые
  if (diff.changed.length > 0) {
    output += '### ИЗМЕНЁННЫЕ РАЗДЕЛЫ\n\n';
    diff.changed.forEach(change => {
      output += `# ${change.old.title}\n\n`;
      output += `**СТАРАЯ ВЕРСИЯ**\n${change.old.content}\n\n`;
      output += `**НОВАЯ ВЕРСИЯ**\n${change.new.content}\n\n`;
    });
  }

  if (output === '') {
    output = `# НИКАКИХ ИЗМЕНЕНИЙ В ДОКУМЕНТЕ "${docName}" НЕ ОБНАРУЖЕНО`;
  }

  return `### СТАРАЯ ВЕРСИЯ (${docName})\n\n${diff.removed.length === 0 && diff.changed.length === 0 ? 'Нет изменений' : ''}\n\n${diff.changed.map(c => `# ${c.old.title}\n${c.old.content}`).join('\n\n')}\n\n${diff.removed.map(r => `# ${r.title}\n${r.content}`).join('\n\n')}\n\n### НОВАЯ ВЕРСИЯ (${docName})\n\n${diff.added.length === 0 && diff.changed.length === 0 ? 'Нет изменений' : ''}\n\n${diff.changed.map(c => `# ${c.new.title}\n${c.new.content}`).join('\n\n')}\n\n${diff.added.map(a => `# ${a.title}\n${a.content}`).join('\n\n')}`;
}

// === 7. ВЫЗОВ DIFY ===
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

// === 8. ОЖИДАНИЕ GIST (как у вас) ===
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
