import { NextResponse } from 'next/server';
import axios from 'axios';
import { parse } from 'pdf-parse';

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ===
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GITHUB_TOKEN = process.env.GH_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// === НАСТРОЙКИ ОГРАНИЧЕНИЙ ===
const MAX_CHARS = 40000; // Максимальный размер текста, отправляемого в Dify (суммарно)

// === ОТПРАВКА В TELEGRAM ===
async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('⚠️ Telegram не настроен — пропускаем');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    console.log('✅ Telegram: сообщение отправлено');
  } catch (err) {
    console.error('❌ Telegram ошибка:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
  }
}

// === ИЗВЛЕЧЕНИЕ ТЕКСТА ИЗ PDF ===
async function pdfToText(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    const data = await parse(Buffer.from(response.data));
    return data.text;
  } catch (err) {
    console.error('❌ Ошибка при чтении PDF:', url);
    throw err;
  }
}

// === ОЧИСТКА ТЕКСТА ОТ ШУМА ===
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

// === ПАРСИНГ РАЗДЕЛОВ ===
function parseSections(text) {
  const sections = {};
  const lines = text.split('\n');

  let currentKey = null;
  let currentContent = [];

  const patterns = [
    /^Глава\s+\d+\./,
    /^\d+(?:\.\d+){1,3}\./,
    /^\d+(?:\.\d+){1,3}\s*[\.\-]\s+/
  ];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    const isHeader = patterns.some(p => p.test(line));

    if (isHeader) {
      if (currentKey) {
        sections[currentKey] = {
          title: currentKey,
          content: currentContent.join('\n').trim()
        };
      }
      currentKey = line;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentKey) {
    sections[currentKey] = {
      title: currentKey,
      content: currentContent.join('\n').trim()
    };
  }

  return sections;
}

// === СРАВНЕНИЕ РАЗДЕЛОВ ===
function compareSections(oldSec, newSec) {
  const result = { added: [], removed: [], changed: [] };
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
        result.changed.push({ old, new: new_ });
      }
    }
  }

  return result;
}

// === НОРМАЛИЗАЦИЯ ДЛЯ СРАВНЕНИЯ ===
function normalize(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .toLowerCase()
    .trim();
}

// === ФОРМАТИРОВАНИЕ ДЛЯ LLM ===
function formatTranscript(diff, docName) {
  let output = '';

  if (diff.removed.length > 0) {
    output += `### УДАЛЁННЫЕ РАЗДЕЛЫ (${docName})\n\n`;
    diff.removed.forEach(sec => {
      output += `# ${sec.title}\n${sec.content}\n\n`;
    });
  }

  if (diff.added.length > 0) {
    output += `### НОВЫЕ РАЗДЕЛЫ (${docName})\n\n`;
    diff.added.forEach(sec => {
      output += `# ${sec.title}\n${sec.content}\n\n`;
    });
  }

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

  return output;
}

// === СПРАВЕДЛИВОЕ ОБРЕЗАНИЕ ===
function truncateFairly(oldText, newText, maxTotalChars) {
  const total = oldText.length + newText.length;
  if (total <= maxTotalChars) return oldText + '\n\n' + newText;

  const oldRatio = oldText.length / total;
  const newRatio = newText.length / total;

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
    const sum = oldShare + newShare;
    oldShare /= sum;
    newShare /= sum;
  }

  const oldLimit = Math.floor(maxTotalChars * oldShare);
  const newLimit = maxTotalChars - oldLimit;

  const truncatedOld = oldText.length > oldLimit ? truncateText(oldText, oldLimit) : oldText;
  const truncatedNew = newText.length > newLimit ? truncateText(newText, newLimit) : newText;

  return truncatedOld + '\n\n' + truncatedNew;
}

// === ОБРЕЗКА ПО СЛОВАМ ===
function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  let truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > 0) {
    truncated = truncated.slice(0, lastSpace);
  }
  return truncated + '\n\n[... обрезано до ' + maxChars + ' символов]';
}

// === ОСНОВНОЙ ОБРАБОТЧИК ===
export default async function handler(req, res) {
  console.log('🔄 Запуск api/pdf-compare...');
  console.log('📥 Метод:', req.method);

  if (req.method !== 'POST') {
    console.log('❌ Метод не POST');
    return NextResponse.json({ error: 'Метод не поддерживается' }, { status: 405 });
  }

  try {
    const { updates } = await req.json();
    console.log('📥 Получено обновлений:', JSON.stringify(updates, null, 2));

    const orderUpdate = updates.find(u => u.file === 'order');
    if (!orderUpdate) {
      console.log('❌ Не найден update для order');
      return NextResponse.json({ error: 'Нет данных для order' }, { status: 400 });
    }

    const { urls } = orderUpdate;
    const oldUrl = urls.old_url;
    const newUrl = urls.new_url;

    if (!oldUrl || !newUrl) {
      console.log('❌ Нет URL:', urls);
      return NextResponse.json({ error: 'Нет URL' }, { status: 400 });
    }

    console.log('✅ Старая версия:', oldUrl);
    console.log('✅ Новая версия:', newUrl);

    // === 1. Извлечение текста ===
    console.log('📄 Извлечение текста из старой версии...');
    const oldText = await pdfToText(oldUrl);
    console.log('📄 Извлечение текста из новой версии...');
    const newText = await pdfToText(newUrl);

    console.log(`✅ Извлечено: ${oldText.length} и ${newText.length} символов`);

    // === 2. Очистка ===
    const cleanOld = cleanText(oldText);
    const cleanNew = cleanText(newText);

    // === 3. Парсинг ===
    const sectionsOld = parseSections(cleanOld);
    const sectionsNew = parseSections(cleanNew);
    console.log(`✅ Разделы: ${Object.keys(sectionsOld).length} → ${Object.keys(sectionsNew).length}`);

    // === 4. Сравнение ===
    const diff = compareSections(sectionsOld, sectionsNew);

    // === 5. Формирование transcript ===
    const fullTranscript = formatTranscript(diff, 'Порядок');
    console.log(`📝 Полный размер: ${fullTranscript.length} символов`);

    // === 6. Обрезание ===
    let transcript;
    if (MAX_CHARS > 0 && fullTranscript.length > MAX_CHARS) {
      console.log(`✂️ Лимит ${MAX_CHARS} превышен — обрезаем...`);
      transcript = truncateFairly(cleanOld, cleanNew, MAX_CHARS);
      console.log(`✂️ Обрезано: ${transcript.length} символов`);
    } else {
      transcript = fullTranscript;
      console.log('✅ Без обрезания');
    }

    // === 7. Отправка в Dify ===
    console.log('📤 Отправка в Dify...');
    if (!DIFY_API_KEY) {
      console.log('❌ DIFY_API_KEY не задан');
      return NextResponse.json({ error: 'DIFY_API_KEY отсутствует' }, { status: 500 });
    }

    try {
      await axios.post(
        'https://api.dify.ai/v1/workflows/run',
        {
          inputs: { transcript },
          response_mode: 'blocking',
          user: 'cbr-compare-bot'
        },
        {
          headers: {
            'Authorization': `Bearer ${DIFY_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 120000
        }
      );
      console.log('✅ Dify: задача поставлена');
    } catch (err) {
      console.error('❌ Ошибка Dify:', err.message);
      if (err.response) {
        console.error('Status:', err.response.status);
        console.error('Data:', err.response.data);
      }
    }

    // === 8. Уведомление в Telegram ===
    await sendToTelegram(`
📊 <b>Анализ изменений завершён</b>

📄 <a href="${oldUrl}">Старая версия</a> → <a href="${newUrl}">Новая версия</a>

⏱ <i>${new Date().toLocaleString('ru-RU')}</i>
    `.trim());

    // === 9. Ответ ===
    console.log('✅ pdf-compare: успешно');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error.message);
    if (error.stack) {
      console.error('📋 Stack:', error.stack);
    }
    return NextResponse.json(
      { error: 'Внутренняя ошибка', message: error.message },
      { status: 500 }
    );
  }
}
