import { NextResponse } from 'next/server';
import axios from 'axios';
import * as cheerio from 'cheerio';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_TOKEN = process.env.GH_TOKEN;

async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

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

export default async function handler(req, res) {
  if (req.method !== 'GET') return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });

  try {
    const response = await axios.get('https://www.cbr.ru/projects_xbrl/taxonomy_xbrl/xbrl-csv', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CBR-Checker/1.0)' },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const allOrderLinks = [];

    $('.document-regular').each((i, element) => {
      const $el = $(element);
      const $link = $el.find('a[href]');
      const href = $link.attr('href');
      const text = $link.text().trim();

      if (!href || !href.includes('.pdf')) return;

      const url = new URL(href, 'https://www.cbr.ru').href;
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
        allOrderLinks.push({ name: text, url });
      }
    });

    let history = {};
    try {
      const prevRes = await axios.get('https://raw.githubusercontent.com/elevl23/cbr-xbrl-checker/main/last-check.json');
      history = prevRes.data.files || {};
    } catch (err) {
      console.log('⚠️ last-check.json не найден');
    }

    const knownOrderUrls = new Set();
    if (Array.isArray(history.all_order_urls)) {
      history.all_order_urls.forEach(url => knownOrderUrls.add(url));
    } else if (history.order?.url) {
      knownOrderUrls.add(history.order.url);
    }

    const newOrderUpdates = allOrderLinks
      .filter(link => !knownOrderUrls.has(link.url))
      .map(link => ({
        type: 'updated',
        file: 'order',
        name: link.name,
        url: link.url,
        urls: {
          old_url: Array.from(knownOrderUrls).pop() || null,
          new_url: link.url
        }
      }));

    const new_update_available = newOrderUpdates.length > 0;

    if (new_update_available) {
      const updateText = newOrderUpdates.map(u => {
        return `🆕 <b>Новый документ "Порядок"</b>\n📄 ${u.name}\n🔗 <a href="${u.url}">Скачать</a>`;
      }).join('\n\n');

      await sendToTelegram(`
🚨 <b>Обнаружено новое издание "Порядка"</b>

${updateText}
⏱ <i>${new Date().toLocaleString('ru-RU')}</i>
      `.trim());

      // Запуск GitHub Action
      const orderUpdate = newOrderUpdates[0];
      const GITHUB_REPO = 'elevl23/cbr-xbrl-checker';
      const DISPATCH_URL = `https://api.github.com/repos/${GITHUB_REPO}/dispatches`;

      try {
        await axios.post(
          DISPATCH_URL,
          {
            event_type: 'process-pdf-update',
            client_payload: {
              name: orderUpdate.name,
              old_url: orderUpdate.urls.old_url,
              new_url: orderUpdate.urls.new_url
            }
          },
          {
            headers: {
              Authorization: `Bearer ${GITHUB_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log('✅ GitHub Action process-pdf.yml запущен');
      } catch (err) {
        console.error('❌ Ошибка при запуске GitHub Action:', err.message);
      }

      // Обновление last-check.json
      if (GITHUB_TOKEN) {
        const newAllUrls = Array.from(knownOrderUrls);
        newOrderUpdates.forEach(u => {
          if (!newAllUrls.includes(u.url)) {
            newAllUrls.push(u.url);
          }
        });

        const updatedFiles = {
          all_order_urls: newAllUrls,
          order: {
            name: orderUpdate.name,
            url: orderUpdate.url
          }
        };

        try {
          const repo = 'elevl23/cbr-xbrl-checker';
          const path = 'last-check.json';
          const url = `https://api.github.com/repos/${repo}/contents/${path}`;

          const getRes = await axios.get(url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } });
          const sha = getRes.data.sha;

          await axios.put(
            url,
            {
              message: `✅ Автообновление: найден новый "Порядок" ${new Date().toISOString()}`,
              content: Buffer.from(JSON.stringify({ files: updatedFiles }, null, 2)).toString('base64'),
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
    }

    return NextResponse.json({ new_update_available });
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
