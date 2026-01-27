import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';

export default async function handler(req, res) {
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

    // Ищем все блоки с файлами
    $('.document-regular').each((i, element) => {
      const $el = $(element);
      const $link = $el.find('a[href]');
      const href = $link.attr('href');
      const text = $link.text().trim();

      if (!href || !href.includes('.zip')) return;

      // Полная ссылка
      const url = new URL(href, 'https://www.cbr.ru').href;

      // Ищем дату в .document-regular_date
      let date = null;
      const $dateEl = $el.find('.document-regular_date');
      if ($dateEl.length > 0) {
        const dateText = $dateEl.text().trim(); // формат: 07.07.2025
        const match = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (match) {
          date = `${match[3]}-${match[2]}-${match[1]}`; // 2025-07-07
        }
      }

      // Если даты нет — используем "unknown"
      if (!date) date = 'unknown';

      files.push({
        name: text || href.split('/').pop(),
        url,
        date
      });

      if (date !== 'unknown') dates.push(date);
    });

    if (files.length === 0) {
      return res.status(404).json({ error: 'Файлы не найдены' });
    }

    // Определяем последнюю дату
    let latest_release = 'unknown';
    if (dates.length > 0) {
      const latestDate = new Date(Math.max(...dates.map(d => new Date(d))));
      latest_release = latestDate.toISOString().split('T')[0];
    }

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
