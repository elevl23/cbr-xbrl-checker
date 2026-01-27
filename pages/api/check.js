import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';

export default async function handler(req, res) {
  // Только GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  try {
    const response = await axios.get('https://www.cbr.ru/projects_xbrl/taxonomy_xbrl/xbrl-csv', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CBR-Checker/1.0)',
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const files = [];
    const dates = [];

    $('a[href*=".zip"]').each((i, link) => {
      const href = $(link).attr('href');
      const match = href.match(/xbrl-csv-taxonomy-(\d{4}-\d{2}-\d{2})\.zip/i);
      if (match) {
        const date = match[1];
        const url = new URL(href, 'https://www.cbr.ru').href;
        files.push({
          name: href.split('/').pop(),
          url,
          date
        });
        dates.push(date);
      }
    });

    if (dates.length === 0) {
      return res.status(404).json({ error: 'Файлы не найдены' });
    }

    const latestDate = new Date(Math.max(...dates.map(d => new Date(d))));
    const latest_release = latestDate.toISOString().split('T')[0];

    res.status(200).json({
      latest_release,
      files,
      last_updated: new Date().toISOString().split('T')[0],
      new_update_available: null
    });
  } catch (error) {
    console.error('Ошибка в /api/check:', error.message);
    res.status(500).json({
      error: 'Не удалось получить данные',
      message: error.message
    });
  }
}
