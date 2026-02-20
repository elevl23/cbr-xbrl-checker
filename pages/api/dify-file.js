// pages/api/dify-file.js
import { NextResponse } from 'next/server';
import axios from 'axios';

export default async function handler(req, res) {
  // Обработка OPTIONS (CORS preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).json({});
  }

  // Разрешаем только POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не разрешён' });
  }

  try {
    const { markdown_output } = req.body;

    // === 1. Извлекаем file_url из sys ===
    const file = markdown_output?.files?.[0];
    if (!file) {
      return res.status(400).json({ error: 'Файл не найден в output' });
    }

    const file_url = file.url;
    const filename = file.filename || 'comparison.md';

    if (!file_url) {
      return res.status(400).json({ error: 'URL файла отсутствует' });
    }

    // === 2. Скачиваем содержимое файла ===
    const fileRes = await axios.get(file_url, {
      responseType: 'text',
      timeout: 30000,
    });

    const content = fileRes.data;

    // === 3. Сохраняем в Gist ===
    const gist = await axios.post(
      'https://api.github.com/gists',
      {
        description: `Сравнение PDF — ${markdown_output.workflow_id}`,
        public: true,
        files: {
          [`pdf-comparison-${markdown_output.timestamp}.md`]: {
            content,
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return res.status(200).json({
      success: true,
      gist_url: gist.data.html_url,
      size: content.length,
      filename,
    });
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
