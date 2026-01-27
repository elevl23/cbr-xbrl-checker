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

    const current = {
      taxonomy: null,
      order: null,
      materials: null,
      guidelines: null
    };

    $('.document-regular').each((i, element) => {
      const $el = $(element);
      const $link = $el.find('a[href]');
      const href = $link.attr('href');
      const text = $link.text().trim();

      if (!href || (!href.includes('.zip') && !href.includes('.pdf'))) return;

      const url = new URL(href, 'https://www.cbr.ru').href;

      // Извлекаем версию
      let version = null;
      const versionMatch = text.match(/версия\s*([\d.]+)/i);
      if (versionMatch) {
        version = versionMatch[1];
      }

      // Извлекаем дату
      let date = null;
      const $dateEl = $el.find('.document-regular_date');
      if ($dateEl.length > 0) {
        const dateText = $dateEl.text().trim();
        const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (dateMatch) {
          date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
        }
      }

      // Классифицируем по названию
      if (text.includes('Финальная таксономия')) {
        current.taxonomy = { name: text, url, version, date };
      } else if (text.includes('Порядок составления и представления')) {
        current.order = { name: text, url, date };
      } else if (text.includes('Сопроводительные материалы')) {
        current.materials = { name: text, url, version, date };
      } else if (text.includes('Методические рекомендации')) {
        current.guidelines = { name: text, url, version, date };
      }
    });

    // 2. Читаем предыдущее состояние
    let previous = {};
    try {
      const prevRes = await axios.get('https://raw.githubusercontent.com/elevl23/cbr-xbrl-checker/main/last-check.json');
      previous = prevRes.data.files || {};
    } catch (err) {
      console.log('last-check.json не найден — первая проверка');
    }

    // 3. Сравниваем
    const updates = [];

    const checkUpdate = (key, current, previous) => {
      const curr = current[key];
      const prev = previous[key];

      if (!prev && curr) {
        updates.push({
          type: 'new',
          file: key,
          name: curr.name,
          url: curr.url,
          version: curr.version,
          date: curr.date
        });
      } else if (prev && curr) {
        const versionChanged = curr.version && prev.version && curr.version !== prev.version;
        const dateChanged = curr.date && prev.date && curr.date !== prev.date;

        if (versionChanged || dateChanged) {
          updates.push({
            type: 'updated',
            file: key,
            name: curr.name,
            url: curr.url,
            version: { from: prev.version, to: curr.version },
            date: { from: prev.date, to: curr.date }
          });
        }
      }
    };

    if (current.taxonomy) checkUpdate('taxonomy', current, previous);
    if (current.order) checkUpdate('order', current, previous);
    if (current.materials) checkUpdate('materials', current, previous);
    if (current.guidelines) checkUpdate('guidelines', current, previous);

    const new_update_available = updates.length > 0;

    // 4. Возвращаем результат
    res.status(200).json({
      files: current,
      updates,
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
