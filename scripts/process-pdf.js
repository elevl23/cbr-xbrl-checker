// scripts/process-pdf.js

const pdf = require('pdf-parse');
const axios = require('axios');

// Получаем ключи из переменных окружения
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Получаем входные данные из GitHub Actions
const NAME = process.env.INPUT_NAME;
const OLD_URL = process.env.INPUT_OLD_URL;
const NEW_URL = process.env.INPUT_NEW_URL;

// Проверка наличия обязательных переменных
if (!DIFY_API_KEY || DIFY_API_KEY.trim() === '') {
  console.error('❌ Ошибка: DIFY_API_KEY не задан или пуст');
  process.exit(1);
}

if (!GITHUB_TOKEN || GITHUB_TOKEN.trim() === '') {
  console.error('❌ Ошибка: GITHUB_TOKEN не задан или пуст');
  process.exit(1);
}

if (!NAME || !OLD_URL || !NEW_URL) {
  console.error('❌ Ошибка: Не заданы входные данные (NAME, OLD_URL, NEW_URL)');
  process.exit(1);
}

async function pdfToText(url) {
  try {
    console.log(`📥 Загрузка PDF: ${url}`);
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    console.log(`✅ PDF загружен: ${response.status}, размер: ${response.data.length} байт`);
    const data = await pdf(Buffer.from(response.data));
    console.log(`📝 Извлечено текста: ${data.text.length} символов`);
    return data.text;
  } catch (err) {
    console.error(`❌ Ошибка при обработке PDF (${url}):`, err.message);
    if (err.response) {
      console.error('   Статус:', err.response.status);
      console.error('   Данные:', err.response.data);
    }
    throw err;
  }
}

async function run() {
  try {
    console.log(`🚀 Старт сравнения: ${NAME}`);
    console.log(`📄 Старая версия: ${OLD_URL}`);
    console.log(`📄 Новая версия: ${NEW_URL}`);

    // Извлекаем текст
    const oldText = await pdfToText(OLD_URL);
    const newText = await pdfToText(NEW_URL);

    // Ограничиваем, если нужно
    const MAX_LEN = 80000;
    const transcript = `
### СТАРАЯ ВЕРСИЯ (${NAME})
${oldText.length > MAX_LEN ? oldText.substring(0, MAX_LEN) + '...' : oldText}

### НОВАЯ ВЕРСИЯ (${NAME})
${newText.length > MAX_LEN ? newText.substring(0, MAX_LEN) + '...' : newText}
    `.trim();

    console.log('📝 Подготовлен transcript:');
    console.log('   Длина:', transcript.length, 'символов');
    console.log('   Начало:', transcript.substring(0, 200), '...');

    // === ОТПРАВКА В DIFY (async) ===
    console.log('📤 Отправка в Dify (async)...');
    console.log('   Режим: async');
    console.log('   API URL: https://api.dify.ai/v1/workflows/run');

    try {
      const startRes = await axios.post(
        'https://api.dify.ai/v1/workflows/run',
        {
          inputs: { transcript },
          response_mode: 'async',
          user: 'github-action-user'
        },
        {
          headers: {
            'Authorization': `Bearer ${DIFY_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const taskId = startRes.data.task_id;
      const workflowRunId = startRes.data.workflow_run_id;

      console.log('✅ Задача отправлена:', taskId);
      console.log('   Ожидаем завершения...');

      // Ждём результата
      let result = null;
      let attempts = 0;
      const maxAttempts = 40; // ~4 минуты (40 * 6 сек)

      while (!result && attempts < maxAttempts) {
        console.log(`🔍 Проверка статуса... (попытка ${attempts + 1}/${maxAttempts})`);
        try {
          const statusRes = await axios.get(
            `https://api.dify.ai/v1/workflows/run/${taskId}`,
            {
              headers: {
                'Authorization': `Bearer ${DIFY_API_KEY}`,
              },
            }
          );

          if (statusRes.data.status === 'succeeded') {
            result = statusRes.data.data;
            console.log('✅ Задача завершена успешно');
          } else if (statusRes.data.status === 'failed') {
            console.error('❌ Задача завершилась с ошибкой:', statusRes.data.error);
            process.exit(1);
          } else {
            console.log('⏳ Статус:', statusRes.data.status);
          }
        } catch (err) {
          console.error('⚠️ Ошибка при проверке статуса:', err.message);
        }

        if (!result) {
          await new Promise(resolve => setTimeout(resolve, 6000)); // ждём 6 сек
          attempts++;
        }
      }

      if (!result) {
        console.error('❌ Время ожидания истекло');
        process.exit(1);
      }

      const summary = result.outputs?.text;
      if (!summary) {
        console.error('❌ В ответе от Dify нет поля outputs.text');
        process.exit(1);
      }

      console.log('✅ Ответ от Dify получен. Создаю Gist...');
      const gistRes = await axios.post(
        'https://api.github.com/gists',
        {
          description: `Сравнение PDF — ${NAME}`,
          public: true,
          files: {
            [`pdf-comparison-${Date.now()}.md`]: { content: summary },
          },
        },
        {
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log('🎉 Gist успешно создан:', gistRes.data.html_url);
    } catch (err) {
      console.error('❌ Ошибка при вызове Dify:');
      if (err.response) {
        console.error('   Статус:', err.response.status);
        if (err.response.status === 504) {
          console.error('   Cloudflare разорвал соединение — используйте async');
        }
        console.error('   Данные:', err.response.data);
      } else {
        console.error('   Ошибка:', err.message);
      }
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Критическая ошибка:', err.message);
    process.exit(1);
  }
}

// Запуск
run();
