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
  console.error('   NAME:', NAME);
  console.error('   OLD_URL:', OLD_URL);
  console.error('   NEW_URL:', NEW_URL);
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

    // Ограничиваем размер (на всякий случай)
    const MAX_LEN = 10000;
    const transcript = `
### СТАРАЯ ВЕРСИЯ (${NAME})
${oldText.substring(0, MAX_LEN)}

### НОВАЯ ВЕРСИЯ (${NAME})
${newText.substring(0, MAX_LEN)}
    `.trim();

    console.log('📝 Подготовлен transcript:');
    console.log('   Длина:', transcript.length, 'символов');
    console.log('   Начало:', transcript.substring(0, 200), '...');

    // === ОТПРАВКА В DIFY ===
    console.log('📤 Отправка в Dify...');
    console.log('   API URL: https://api.dify.ai/v1/workflows/run');
    console.log('   Режим: blocking');
    console.log('   Заголовки: Authorization: Bearer *** (скрыто)');
    console.log('   Тело запроса: см. ниже');

    try {
      const response = await axios.post(
        'https://api.dify.ai/v1/workflows/run',
        {
          inputs: { transcript },
          response_mode: 'blocking',
        },
        {
          headers: {
            'Authorization': `Bearer ${DIFY_API_KEY}`,
            'Content-Type': 'application/json',
          },
          // Не бросать ошибку автоматически
          validateStatus: () => true,
        }
      );

      console.log('📨 Статус ответа:', response.status);
      console.log('📄 Тело ответа:', JSON.stringify(response.data, null, 2));

      if (response.status !== 200) {
        console.error('❌ Dify вернул ошибку');
        process.exit(1);
      }

      const summary = response.data.outputs?.text;
      if (!summary) {
        console.error('❌ В ответе от Dify нет поля outputs.text');
        console.error('Полный ответ:', JSON.stringify(response.data, null, 2));
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
        console.error('   Данные:', JSON.stringify(err.response.data, null, 2));
      } else if (err.request) {
        console.error('   Нет ответа от сервера — запрос отправлен, но ответа нет');
      } else {
        console.error('   Ошибка настройки запроса:', err.message);
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
