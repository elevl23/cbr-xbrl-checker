import { NextResponse } from 'next/server';
import axios from 'axios';

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ===
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GITHUB_TOKEN = process.env.GH_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// === ОТПРАВКА В TELEGRAM ===
async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('⚠️ Telegram не настроен — пропускаем');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    console.log('✅ Telegram: сообщение отправлено', response.status);
  } catch (err) {
    console.error('❌ Telegram: ошибка при отправке');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    } else {
      console.error('Network error:', err.message);
    }
  }
}

// === ОСНОВНОЙ ОБРАБОТЧИК ===
export default async function handler(req, res) {
  console.log('🔄 Запуск api/pdf-compare...');

  if (req.method !== 'POST') {
    console.log('❌ Метод не POST:', req.method);
    return NextResponse.json({ error: 'Метод не поддерживается' }, { status: 405 });
  }

  try {
    console.log('🔍 Получаю тело запроса...');
    const body = await req.json();
    console.log('📥 Тело запроса:', JSON.stringify(body, null, 2));

    const { updates } = body;
    if (!updates || !Array.isArray(updates)) {
      console.log('❌ Нет массива updates');
      return NextResponse.json({ error: 'Нет данных' }, { status: 400 });
    }

    const orderUpdate = updates.find(u => u.file === 'order');
    if (!orderUpdate) {
      console.log('❌ Не найден update для "order"');
      return NextResponse.json({ error: 'Нет данных для order' }, { status: 400 });
    }

    const { urls } = orderUpdate;
    if (!urls || !urls.old_url || !urls.new_url) {
      console.log('❌ Нет URL в urls:', urls);
      return NextResponse.json({ error: 'Нет URL' }, { status: 400 });
    }

    const { old_url: oldUrl, new_url: newUrl } = urls;
    console.log('✅ Старая версия:', oldUrl);
    console.log('✅ Новая версия:', newUrl);

    // === ТЕПЕРЬ ТУТ БУДЕТ ЛОГИКА СРАВНЕНИЯ ===
    console.log('📝 Генерация transcript...');
    const transcript = `
### СРАВНЕНИЕ PDF

**Старая версия:** ${oldUrl}
**Новая версия:** ${newUrl}

[⚠️ Это заглушка. Вставьте сюда логику из process-pdf.js]

- Извлечение текста из PDF
- Очистка
- Сравнение разделов
- Формирование diff
- Форматирование для LLM
    `.trim();

    // === ОТПРАВКА В DIFY ===
    console.log('📤 Отправка в Dify...');
    if (!DIFY_API_KEY) {
      console.log('❌ DIFY_API_KEY не задан');
      return NextResponse.json({ error: 'DIFY_API_KEY отсутствует' }, { status: 500 });
    }

    try {
      const difyRes = await axios.post(
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
      console.log('✅ Dify: задача поставлена', difyRes.status);
    } catch (err) {
      console.error('❌ Ошибка при вызове Dify');
      if (err.response) {
        console.error('Status:', err.response.status);
        console.error('Data:', err.response.data);
      } else {
        console.error('Network error:', err.message);
      }
    }

    // === ОТПРАВКА В TELEGRAM ===
    console.log('📤 Отправка результата в Telegram...');
    await sendToTelegram(`
📊 <b>Анализ изменений запущен</b>

📄 <a href="${oldUrl}">Старая версия</a> → <a href="${newUrl}">Новая версия</a>

🔍 <b>Анализ в процессе</b> — результат появится в Gist

⏱ <i>${new Date().toLocaleString('ru-RU')}</i>
    `.trim());

    // === ОТВЕТ ===
    console.log('✅ pdf-compare: успешно завершён');
    return NextResponse.json({
      success: true,
      message: 'Сравнение запущено'
    });
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА в pdf-compare:', error.message);
    if (error.stack) {
      console.error('📋 Stack:', error.stack);
    }
    return NextResponse.json(
      { error: 'Внутренняя ошибка', message: error.message },
      { status: 500 }
    );
  }
}
