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
    console.log('❌ Метод не GET — завершаем');
    return NextResponse.json({ error: 'Метод не поддерживается' }, { status: 405 });
  }

  try {
    console.log('🔍 Этап 1: Запуск проверки обновлений ЦБ...');

    // 1. Парсим страницу ЦБ
    console.log('🔄 Этап 2: Запрос к cbr.ru...');
    const response = await axios.get('https://www.cbr.ru/projects_xbrl/taxonomy_xbrl/xbrl-csv', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CBR-Checker/1.0)' },
      timeout: 10000,
    });
    console.log('✅ Этап 2: Ответ от cbr.ru получен, длина:', response.data.length);

    const $ = cheerio.load(response.data);
    console.log('✅ Этап 3: Страница распаршена');

    // 2. Собираем ВСЕ "Порядки"
    const allOrderLinks = [];
    const allTaxonomies = [];
    const allMaterials = [];
    const allGuidelines = [];

    console.log('🔄 Этап 4: Поиск всех PDF-документов...');

    $('.document-regular').each((i, element) => {
      const $el = $(element);
      const $link = $el.find('a[href]');
      const href = $link.attr('href');
      const text = $link.text().trim();

      if (!href || !href.includes('.pdf')) return;

      const url = new URL(href, 'https://www.cbr.ru').href;

      let version = null;
      const versionMatch = text.match(/версия\s*([\d.]+)/i);
      if (versionMatch) version = versionMatch[1];

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
        allOrderLinks.push({ name: text, url, version, date });
      } else if (text.includes('Финальная таксономия')) {
        allTaxonomies.push({ name: text, url, version, date });
      } else if (text.includes('Сопроводительные материалы')) {
        allMaterials.push({ name: text, url, version, date });
      } else if (text.includes('Методические рекомендации')) {
        allGuidelines.push({ name: text, url, version, date });
      }
    });

    console.log('✅ Этап 4: Найдено PDF:', {
      orders: allOrderLinks.length,
      taxonomies: allTaxonomies.length,
      materials: allMaterials.length,
      guidelines: allGuidelines.length
    });

    // 3. Читаем историю
    let history = {};
    try {
      console.log('🔄 Этап 5: Загрузка last-check.json...');
      const prevRes = await axios.get('https://raw.githubusercontent.com/elevl23/cbr-xbrl-checker/main/last-check.json', {
        timeout: 10000
      });
      history = prevRes.data.files || {};
    } catch (err) {
      console.log('⚠️ Этап 5: last-check.json не найден — первая проверка');
    }

    // Извлекаем все старые URL "Порядка"
    const knownOrderUrls = new Set();
    if (Array.isArray(history.all_order_urls)) {
      history.all_order_urls.forEach(url => knownOrderUrls.add(url));
    } else if (history.order && history.order.url) {
      knownOrderUrls.add(history.order.url);
    }

    console.log('📊 Известные URL "Порядка":', Array.from(knownOrderUrls));

    // 4. Ищем новые
    const newOrderUpdates = allOrderLinks
      .filter(link => !knownOrderUrls.has(link.url))
      .map(link => ({
        type: 'updated',
        file: 'order',
        name: link.name,
        url: link.url,
        version: null,
        date: link.date,
        urls: {
          old_url: Array.from(knownOrderUrls).pop() || null,
          new_url: link.url
        }
      }));

    console.log('✅ Этап 6: Найдено новых "Порядков":', newOrderUpdates.length);

    const updates = newOrderUpdates;
    const new_update_available = updates.length > 0;

    if (new_update_available) {
      console.log('🎉 Этап 7: Есть обновления! Отправляем в Telegram...');

      const updateText = updates.map(u => {
        return `🆕 <b>Новый документ "Порядок"</b>\n📄 ${u.name}\n🔗 <a href="${u.url}">Скачать</a>`;
      }).join('\n\n');

      await sendToTelegram(`
🚨 <b>Обнаружено новое издание "Порядка"</b>

${updateText}
⏱ <i>${new Date().toLocaleString('ru-RU')}</i>
      `.trim());

      // === ЗАПУСК GitHub Action process-pdf.yml ===
      console.log('🔄 Этап 8: Запуск GitHub Action process-pdf.yml...');
      const orderUpdate = updates[0];

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
              'Content-Type': 'application/json',
              Accept: 'application/vnd.github.v3+json'
            }
          }
        );
        console.log('✅ GitHub Action process-pdf.yml запущен');
      } catch (err) {
        console.error('❌ Ошибка при запуске GitHub Action:', err.message);
        if (err.response) {
          console.error('Status:', err.response.status);
          console.error('Data:', err.response.data);
        }
      }
    }

    // 5. Обновляем last-check.json
    if (new_update_available && GITHUB_TOKEN) {
      console.log('🔄 Этап 9: Обновление last-check.json...');

      const newAllUrls = Array.from(knownOrderUrls);
      newOrderUpdates.forEach(u => {
        if (!newAllUrls.includes(u.url)) {
          newAllUrls.push(u.url);
        }
      });

      const updatedFiles = {
        all_order_urls: newAllUrls,
        order: {
          name: newOrderUpdates[0].name,
          url: newOrderUpdates[0].url,
          date: newOrderUpdates[0].date
        },
        taxonomies: allTaxonomies,
        materials: allMaterials,
        guidelines: allGuidelines
      };

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

        console.log('✅ Этап 9: last-check.json обновлён');
      } catch (err) {
        console.error('❌ Ошибка при обновлении last-check.json:', err.message);
      }
    }

    console.log('✅ Этап 10: Проверка завершена.');

    return NextResponse.json({
      files: {
        orders: allOrderLinks,
        taxonomies: allTaxonomies,
        materials: allMaterials,
        guidelines: allGuidelines
      },
      updates,
      new_update_available,
      last_updated: new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', error.message);
    console.error('📋 Стек:', error.stack);
    return NextResponse.json(
      { error: 'Не удалось получить данные', message: error.message },
      { status: 500 }
    );
  }
}
