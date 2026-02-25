import axios from 'axios';

// Функция для отправки в Telegram
async function sendToTelegram(message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    console.log('✅ Telegram: сообщение отправлено');
  } catch (err) {
    console.error('❌ Telegram ошибка:', err.response?.data || err.message);
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { markdown_output, file: fileFromDirect } = req.body;

    console.log('🎯 Запрос получен');
    console.log('🔍 req.body:', JSON.stringify(req.body, null, 2));

    const file = fileFromDirect || markdown_output?.files?.[0];
    if (!file) {
      return res.status(400).json({ error: 'Файл не найден в output' });
    }

    const file_url = file.url;
    if (!file_url) {
      return res.status(400).json({ error: 'URL файла отсутствует' });
    }

    console.log('📥 Скачиваем:', file_url);
    const fileRes = await axios.get(file_url, {
      responseType: 'text',
      timeout: 30000,
    });

    const content = fileRes.data;
    const filename = file.filename || 'comparison.md';

    console.log('🔐 GH_TOKEN:', process.env.GH_TOKEN ? '✅ задан' : '❌ не задан');
    if (!process.env.GH_TOKEN) {
      return res.status(500).json({ error: 'GH_TOKEN не задан' });
    }

    console.log('📤 Отправляем в Gist...');
    const gist = await axios.post(
      'https://api.github.com/gists',
      {
        description: `Сравнение PDF — ${markdown_output?.workflow_id || 'unknown'}`,
        public: true,
        files: {
          [`comparison-${Date.now()}.md`]: { content }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const gist_url = gist.data.html_url;
    console.log('✅ Gist создан:', gist_url);

    // ✅ Отправляем в Telegram
    const message = `
✅ <b>Сравнение PDF завершено!</b>
📄 Файл: <code>${filename}</code>
🔗 <a href="${gist_url}">Gist</a>
📏 Размер: ${content.length} символов
⏱ Время: ${new Date().toLocaleString('ru-RU')}
    `.trim();

    await sendToTelegram(message);

    return res.status(200).json({
      success: true,
      gist_url,
      size: content.length,
      filename
    });
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    if (err.response) {
      console.error('🚨 Gist API:', err.response.status, err.response.data);
    }

    // Попробуем отправить ошибку в Telegram
    try {
      await sendToTelegram(`
❌ <b>Ошибка в dify-file</b>
📝 ${err.message}
⏱ ${new Date().toLocaleString('ru-RU')}
      `.trim());
    } catch (tErr) {
      console.error('❌ Не удалось отправить в Telegram:', tErr.message);
    }

    return res.status(500).json({ error: err.message });
  }
}
