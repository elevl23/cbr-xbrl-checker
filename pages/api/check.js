import { NextResponse } from 'next/server';
import axios from 'axios';
import cheerio from 'cheerio';

export async function GET() {
  try {
    const response = await axios.get('https://www.cbr.ru/projects_xbrl/taxonomy_xbrl/xbrl-csv', {
      headers: {
        'User-Agent': 'CBR-Checker-Tool/1.0',
      },
    });

    const $ = cheerio.load(response.data);
    const files = [];
    const dates = [];

    // Ищем все ссылки на .zip
    $('a[href*=".zip"]').each((i, link) => {
      const href = $(link).attr('href');
      const text = $(link).text();
      const match = href.match(/xbrl-csv-taxonomy-(\d{4}-\d{2}-\d{2})\.zip/i);
      if (match) {
        const date = match[1];
        const url = new URL(href, 'https://www.cbr.ru').href;
        files.push({
          name: text.trim() || href.split('/').pop(),
          url,
          date
        });
        dates.push(date);
      }
    });

    if (dates.length === 0) {
      return NextResponse.json({ error: 'Файлы не найдены' }, { status: 404 });
    }

    // Находим самую свежую дату
    const latestDate = new Date(Math.max(...dates.map(d => new Date(d))));
    const latest_release = latestDate.toISOString().split('T')[0];

    return NextResponse.json({
      latest_release,
      files,
      last_updated: new Date().toISOString().split('T')[0],
      new_update_available: null
    });
  } catch (error) {
    console.error('Ошибка при запросе:', error.message);
    return NextResponse.json(
      { error: 'Не удалось получить данные', message: error.message },
      { status: 500 }
    );
  }
}