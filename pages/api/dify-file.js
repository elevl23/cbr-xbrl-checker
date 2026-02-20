import { NextResponse } from 'next/server';
import axios from 'axios';

export async function POST(request) {
  try {
    const { markdown_output } = await request.json();

    // === 1. Извлекаем file_url из sys ===
    const file = markdown_output?.files?.[0];
    if (!file) {
      return NextResponse.json({ error: 'Файл не найден в output' }, { status: 400 });
    }

    const file_url = file.url;
    const filename = file.filename || 'comparison.md';
    const size = file.size;

    if (!file_url) {
      return NextResponse.json({ error: 'URL файла отсутствует' }, { status: 400 });
    }

    // === 2. Скачиваем содержимое файла ===
    const fileRes = await axios.get(file_url, {
      responseType: 'text',
      timeout: 30000
    });

    const content = fileRes.data;

    // === 3. Сохраняем в Gist ===
    const gist = await axios.post('https://api.github.com/gists', {
      description: `Сравнение PDF — ${markdown_output.workflow_id}`,
      public: true,
      files: {
        [`pdf-comparison-${markdown_output.timestamp}.md`]: {
          content
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return NextResponse.json({
      success: true,
      gist_url: gist.data.html_url,
      size: content.length,
      filename
    });
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
