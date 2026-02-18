// scripts/process-pdf.js

const pdf = require('pdf-parse');
const axios = require('axios');

// Получаем ключи
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Входные данные
const NAME = process.env.INPUT_NAME;
const OLD_URL = process.env.INPUT_OLD_URL;
const NEW_URL = process.env.INPUT_NEW_URL;

// Проверки
if (!DIFY_API_KEY || !GITHUB_TOKEN || !NAME || !OLD_URL || !NEW_URL) {
  console.error('❌ Не хватает переменных');
  process.exit(1);
}

async function pdfToText(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const data = await pdf(Buffer.from(response.data));
  return data.text;
}

async function run() {
  try {
    console.log(`🚀 Сравнение: ${NAME}`);
    const oldText = await pdfToText(OLD_URL);
    const newText = await pdfToText(NEW_URL);

    const MAX_LEN = 80000;
    const transcript = `
### СТАРАЯ ВЕРСИЯ (${NAME})
${oldText.length > MAX_LEN ? oldText.substring(0, MAX_LEN) + '...' : oldText}

### НОВАЯ ВЕРСИЯ (${NAME})
${newText.length > MAX_LEN ? newText.substring(0, MAX_LEN) + '...' : newText}
    `.trim();

    console.log('📤 Отправка в Dify (blocking) — ожидаем 504...');

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
          timeout: 120000 // 2 минуты
        }
      );
    } catch (err) {
      if (err.response?.status === 504) {
        console.log('✅ 504 — это ожидаемо. Dify обрабатывает в фоне.');
      } else {
        console.error('❌ Неожиданная ошибка:', err.message);
        process.exit(1);
      }
    }

    // Ждём 90 секунд — пусть Dify обработает
    console.log('⏳ Начинаем ожидание 90 секунд...');
    for (let i = 0; i < 90; i++) {
      console.log(`⏱️  ${i + 1}/90...`);
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('✅ Ожидание завершено');

    // Проверим, есть ли Gist
    console.log('🔍 Проверяем, появился ли Gist...');
    const gistList = await axios.get('https://api.github.com/gists', {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      }
    });

    const recent = gistList.data.find(g =>
      g.description.includes('Сравнение PDF — Правила формирования') &&
      new Date(g.created_at) > new Date(Date.now() - 120000)
    );

    if (recent) {
      console.log('🎉 Gist найден:', recent.html_url);
      console.log('✅ Успешно!');
    } else {
      console.error('❌ Gist не найден');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
  }
}

run();
