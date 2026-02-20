export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { markdown_output, file: fileFromDirect } = req.body;

    // Поддержка двух форматов
    const file = fileFromDirect || markdown_output?.files?.[0];

    if (!file) {
      console.error('❌ Файл не найден в теле:', req.body);
      return res.status(400).json({ error: 'Файл не найден в output' });
    }

    const file_url = file.url;
    if (!file_url) {
      return res.status(400).json({ error: 'URL файла отсутствует' });
    }

    const fileRes = await axios.get(file_url, {
      responseType: 'text',
      timeout: 30000,
    });

    const content = fileRes.data;
    const filename = file.filename || 'comparison.md';

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
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.status(200).json({
      success: true,
      gist_url: gist.data.html_url,
      size: content.length,
      filename
    });
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
