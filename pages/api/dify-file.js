// pages/api/dify-file.js
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { markdown_output } = req.body;

    console.log('📥 Получено в markdown_output:', JSON.stringify(markdown_output, null, 2));

    const file = markdown_output?.files?.[0];
    if (!file) {
      return res.status(400).json({ error: 'Файл не найден в output' });
    }

    const file_url = file.url;
    if (!file_url) {
      return res.status(400).json({ error: 'URL файла отсутствует' });
    }

    // Скачиваем .md как текст
    const fileRes = await axios.get(file_url, {
      responseType: 'text',
      timeout: 30000,
    });

    const content = fileRes.data;
    const filename = file.filename || 'comparison.md';

    // Загружаем в Gist
    const gist = await axios.post(
      'https://api.github.com/gists',
      {
        description: `Сравнение PDF — ${markdown_output.workflow_id || 'unknown'}`,
        public: true,
        files: {
          [`pdf-comparison-${Date.now()}.md`]: {
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
      raw_url: gist.data.files[Object.keys(gist.data.files)[0]].raw_url,
      size: content.length,
      filename,
    });
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
