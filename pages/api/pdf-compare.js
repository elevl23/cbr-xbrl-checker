import { NextResponse } from 'next/server';
import axios from 'axios';

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ===
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const GITHUB_TOKEN = process.env.GH_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// === ОТПРАВКА В TELEGRAM ===
async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    console.log('✅ Telegram: результат отправлен');
  } catch (err) {
    console.error('❌ Telegram ошибка:', err.message);
  }
}

// === ОСНОВНОЙ ОБРАБОТЧИК ===
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Метод не поддерживается' }, { status: 405 });
  }

  try {
    const { updates } = await req.json();
    const orderUpdate = updates.find(u => u.file === 'order');
    if (!orderUpdate) {
      return NextResponse.json({ error: 'Нет данных для сравнения' }, { status: 400 });
    }

    const { urls } = orderUpdate;
    const oldUrl = urls.old_url;
    const newUrl = urls.new_url;

    console.log('🔄 Сравнение PDF:', oldUrl, '→', newUrl);

    // Здесь должен быть код сравнения
    // Сейчас упрощённо — просто отправим в Dify

    const transcript = `Сравнение PDF:\n\nСтарая версия: ${oldUrl}\nНовая версия: ${newUrl}\n\n[Это заглушка. Вставьте сюда логику из process-pdf.js]`;

    // Отправка в Dify
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
    } catch (err) {
      console.error('❌ Ошибка Dify:', err.message);
    }

    // Отправка в Telegram
    await sendToTelegram(`
📊 <b>Анализ изменений завершён</b>

📄 <a href="${oldUrl}">Старая версия</a> → <a href="${newUrl}">Новая версия</a>

⏱ <i>${new Date().toLocaleString('ru-RU')}</i>
    `.trim());

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('❌ Ошибка pdf-compare:', error.message);
    return NextResponse.json({ error: 'Ошибка обработки' }, { status: 500 });
  }
}
