// scripts/process-pdf.js

const pdf = require('pdf-parse');
const axios = require('axios');

// Получаем из переменных окружения (от GitHub Actions)
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Получаем из inputs
const NAME = process.env.INPUT_NAME;
const OLD_URL = process.env.INPUT_OLD_URL;
const NEW_URL = process.env.INPUT_NEW_URL;

if (!DIFY_API_KEY || !GITHUB_TOKEN) {
  console.error('❌ Не заданы DIFY_API_KEY или GITHUB_TOKEN');
  process.exit(1);
}

if (!NAME || !OLD_URL || !NEW_URL) {
  console.error('❌ Не заданы входные данные: NAME, OLD_URL, NEW_URL');
  process.exit(1);
}

async function pdfToText(url) {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const data = await pdf(Buffer.from(response.data));
    return data.text;
  } catch (err) {
    console.error('❌ Ошибка при извлечении текста:', err.message);
    throw err;
  }
}

async function run() {
  try {
    console.log(`🚀 Сравнение: ${NAME}`);
    console.log(`📄 Старый: ${OLD_URL}`);
    console.log(`📄 Новый: ${NEW_URL}`);

    const oldText = await pdfToText(OLD_URL);
    const newText = await pdfToText(NEW_URL);

    const transcript = `
### СТАРАЯ ВЕРСИЯ (${NAME})
${oldText.substring(0, 10000)}

### НОВАЯ ВЕРСИЯ (${NAME})
${newText.substring(0, 10000)}
    `.trim();

    console.log('📤 Отправка в Dify...');
    const difyRes = await axios.post('https://api.dify.ai/v1/workflows/run', {
      inputs: { transcript },
      response_mode: 'blocking',
    }, {
      headers: {
        'Authorization': `Bearer ${DIFY_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const summary = difyRes.data.outputs?.text;
    if (!summary) {
      console.error('❌ Нет ответа от Dify');
      process.exit(1);
    }

    console.log('✅ Ответ получен. Сохраняю в Gist...');
    const gistRes = await axios.post('https://api.github.com/gists', {
      description: `Сравнение PDF — ${NAME}`,
      public: true,
      files: {
        [`pdf-comparison-${Date.now()}.md`]: { content: summary },
      },
    }, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('🎉 Gist создан:', gistRes.data.html_url);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
  }
}

run();