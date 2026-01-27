import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  try {
    // 1. Парсим страницу ЦБ
    const response = await axios.get('https://www.cbr.ru/projects_xbrl/taxonomy_xbrl/xbrl-csv', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CBR-Checker/1.0)',
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const files = [];
    const versions = [];
    const dates = [];

    $('.document-regular').each((i, element) => {
      const $el = $(element);
      const $link = $el.find('a[href]');
      const href = $link.attr('href');
      const text = $link.text().trim();

      if (!href || !href.includes('.zip')) return;

      const url = new URL(href, 'https://www.cbr.ru').href;

      // Извлекаем версию: "версия 6.1.0.7"
      let version = null;
      const versionMatch = text.match(/версия\s*([\d.]+)/i);
      if (versionMatch) {
        version = versionMatch[1];
        versions.push(version);
      }

      // Извлекаем дату: 07.07.2025 → 2025-07-07
      let date = null;
      const $dateEl = $el.find('.document-regular_date');
      if ($dateEl.length > 0) {
        const dateText = $dateEl.text().trim();
        const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (dateMatch) {
          date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
          dates.push(date);
        }
      }

      files.push({ name: text, url, version, date });
    });

    if (files.length === 0) {
      return res.status(404).json({ error: 'Файлы не найдены' });
    }

    // Определяем последнюю версию и дату
    const latest_version = versions.length > 0 ? versions.sort().pop() : null;
    const latest_release = dates.length > 0
      ? new Date(Math.max(...dates.map(d => new Date(d)))).toISOString().split('T')[0]
      : 'unknown';

    // 2. Читаем предыдущее состояние
    let previous = null;
    try {
      const prevRes = await axios.get('https://raw.githubusercontent.com/elevl23/cbr-xbrl-checker/main/last-check.json');
      previous = prevRes.data;
    } catch (err) {
      console.log('last-check.json не найден');
    }

    let new_update_available = null;

    if (previous && latest_version && previous.latest_version) {
      const versionChanged = latest_version !== previous.latest_version;
      const releaseChanged = latest_release !== 'unknown' && latest_release !== previous.latest_release;
      new_update_available = versionChanged || releaseChanged;
    }

    // 3. Возвращаем результат
    res.status(200).json({
      latest_version,
      latest_release,
      files,
      new_update_available,
      last_updated: new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('Ошибка:', error.message);
    res.status(500).json({
      error: 'Не удалось получить данные',
      message: error.message
    });
  }
}
