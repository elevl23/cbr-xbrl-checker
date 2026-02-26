import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';

// === TELEGRAM ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// === GITHUB ===
const GITHUB_TOKEN = process.env.GH_TOKEN;

// === ОТПРАВКА В TELEGRAM ===
async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('⚠️ Telegram не настроен — пропускаем уведомление');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    console.log('✅ Telegram: уведомление отправлено');
  } catch (err) {
    console.error('❌ Telegram ошибка:', err.message);
  }
}

// === ОСНОВНОЙ ОБРАБОТЧИК ===
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return NextResponse.json({ error: 'Метод не поддерживается' }, { status: 405 });
  }

  try {
    console.log('🔍 Запуск проверки обновлений ЦБ...');

    const response = await axios.get('https://www.cbr.ru/projects_xbrl/taxonomy_xbrl/xbrl-csv', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CBR-Checker/1.0)' },
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

      if (!href || !href.includes('.pdf')) return;

      const url = new URL(href, 'https://www.cbr.ru').href;

      let version = null;
      const versionMatch = text.match(/версия\s*([\d.]+)/i);
      if (versionMatch) {
        version = versionMatch[1];
      }

      let date = null;
      const $dateEl = $el.find('.document-regular_date');
      if ($dateEl.length > 0) {
        const dateText = $dateEl.text().trim();
        const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if (dateMatch) {
          date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
        }
      }

      const lowerText = text.toLowerCase();
      const lowerUrl = url.toLowerCase();

      const isOrder =
        lowerText.includes('порядок составления и представления') ||
        lowerText.includes('порядок составления') ||
        lowerText.includes('порядок') ||
        lowerUrl.includes('inf_note') ||
        lowerUrl.includes('poryadok') ||
        lowerUrl.includes('order');

      if (isOrder) {
        current.order = { name: text, url, version, date };
      } else if (text.includes('Финальная таксономия')) {
        current.taxonomy = { name: text, url, version, date };
      } else if (text.includes('Сопроводительные материалы')) {
        current.materials = { name: text, url, version, date };
      } else if (text.includes('Методические рекомендации')) {
        current.guidelines = { name: text, url, version, date };
      }
    });

    let previous = {};
    try {
      const prevRes = await axios.get('https://raw.githubusercontent.com/elevl23/cbr-xbrl-checker/main/last-check.json');
      previous = prevRes.data.files || {};
    } catch (err) {
      console.log('⚠️ last-check.json не найден — первая проверка');
    }

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
            date: { from: prev.date, to: curr.date },
            urls: {
              old_url: prev.url,
              new_url: curr.url
            }
          });
        }
      }
    };

    if (current.order) checkUpdate('order', current, previous);
    if (current.taxonomy) checkUpdate('taxonomy', current, previous);
    if (current.materials) checkUpdate('materials', current, previous);
    if (current.guidelines) checkUpdate('guidelines', current, previous);

    const new_update_available = updates.length > 0;

    if (new_update_available) {
      console.log(`🎉 Найдено обновлений: ${updates.length}`);

      const updateText = updates.map(u => {
        if (u.type === 'new') {
          return `🆕 <b>Новый документ</b>: ${u.name}\n🔗 <a href="${u.url}">Скачать</a>`;
        } else {
          return `🔄 <b>Обновлён</b>: ${u.name}\n${u.version ? `🔖 ${u.version.from} → ${u.version.to}` : ''}\n📅 ${u.date?.from} → ${u.date?.to}\n🔗 <a href="${u.url}">Скачать</a>`;
        }
      }).join('\n\n');

      await sendToTelegram(`
🚨 <b>Обнаружено обновление на сайте ЦБ</b>

${updateText}
⏱ <i>${new Date().toLocaleString('ru-RU')}</i>
      `.trim());

      // === ЗАПУСК PDF-COMPARE В ФОНЕ ===
      const orderUpdate = updates.find(u => u.file === 'order' && u.type === 'updated');
      if (orderUpdate) {
        console.log('🔄 Запуск pdf-compare в фоне...');
        // Не ждём — просто отправляем
        fetch('/api/pdf-compare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [orderUpdate] })
        }).catch(err => {
          console.error('⚠️ Не удалось запустить pdf-compare:', err.message);
        });
      }
    }

    // === ОБНОВЛЕНИЕ last-check.json ===
    if (new_update_available && GITHUB_TOKEN) {
      try {
        const repo = 'elevl23/cbr-xbrl-checker';
        const path = 'last-check.json';
        const url = `https://api.github.com/repos/${repo}/contents/${path}`;

        const getRes = await axios.get(url, {
          headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
        });
        const sha = getRes.data.sha;

        await axios.put(
          url,
          {
            message: `🤖 Автообновление: обнаружены изменения ${new Date().toISOString()}`,
            content: Buffer.from(JSON.stringify({ files: current }, null, 2)).toString('base64'),
            sha,
            branch: 'main'
          },
          {
            headers: {
              Authorization: `Bearer ${GITHUB_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log('✅ last-check.json обновлён');
      } catch (err) {
        console.error('❌ Ошибка при обновлении last-check.json:', err.message);
      }
    }

    return NextResponse.json({
      files: current,
      updates,
      new_update_available,
      last_updated: new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    return NextResponse.json(
      { error: 'Не удалось получить данные', message: error.message },
      { status: 500 }
    );
  }
}
