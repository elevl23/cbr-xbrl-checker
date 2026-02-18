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

    console.log('📤 Отправка в Dify (streaming)...');

    const response = await axios({
      method: 'POST',
      url: 'https://api.dify.ai/v1/workflows/run',
      data: {
        inputs: { transcript },
        response_mode: 'streaming',
        user: 'github-action-user'
      },
      headers: {
        'Authorization': `Bearer ${DIFY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      responseType: 'stream',
    });

    // Собираем ответ
    let fullText = '';
    let buffer = '';

    return new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();

        let lines = buffer.split('\n');
        buffer = lines.pop(); // последняя — неполная

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              console.log('✅ Генерация завершена');
              resolve();
              return;
            }

            try {
              const json = JSON.parse(data);
              if (json.event === 'text' && json.data) {
                fullText += json.data;
              }
            } catch (e) {
              // Игнор
            }
          }
        }
      });

      response.data.on('end', () => {
        if (!fullText.trim()) {
          console.error('❌ Поток завершился, но текст пуст');
          reject(new Error('Empty response'));
        } else {
          console.log('✅ Поток завершён. Текст собран.');
          resolve();
        }
      });

      response.data.on('error', (err) => {
        console.error('❌ Ошибка потока:', err.message);
        reject(err);
      });
    });

    if (!fullText.trim()) {
      console.error('❌ Ответ от Dify пустой');
      process.exit(1);
    }

    console.log('✅ Ответ получен. Создаю Gist...');
    const gistRes = await axios.post(
      'https://api.github.com/gists',
      {
        description: `Сравнение PDF — ${NAME}`,
        public: true,
        files: {
          [`pdf-comparison-${Date.now()}.md`]: { content: fullText },
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('🎉 Gist создан:', gistRes.data.html_url);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
  }
}

run();
