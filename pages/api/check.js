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
      taxonomy: null,        // Финальная таксономия
      order: null,           // Порядок составления...
      materials: null,       // Сопроводительные материалы
      guidelines: null       // Методические рекомендации
    };

    $('.document-regular').each((i, element) => {
      const $el = $(element);
      const $link = $el.find('a[href]');
      const href = $link.attr('href');
      const text = $link.text().trim();

      if (!href || !href.includes('.zip') && !href.includes('.pdf')) return;

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
     
