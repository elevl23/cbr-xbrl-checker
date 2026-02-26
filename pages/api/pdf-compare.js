export default async function handler(req, res) {
  console.log('✅ Запуск: pdf-compare получил запрос');
  console.log('📥 Метод:', req.method);

  if (req.method !== 'POST') {
    console.log('❌ Метод не POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const contentType = req.headers['content-type'];
  console.log('📌 Content-Type:', contentType);

  if (!contentType || !contentType.includes('application/json')) {
    console.log('❌ Content-Type не JSON');
    return res.status(400).json({ error: 'Content-Type must be application/json' });
  }

  let body;
  try {
    body = await req.json();
    console.log('✅ req.json() — успешно');
  } catch (err) {
    // ❌ Никакого err.message, чтобы не сломать Vercel
    console.error('❌ req.json() не удалось');
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('📬 Тело запроса:', JSON.stringify(body, null, 2));

  const { updates } = body;
  if (!updates || !Array.isArray(updates)) {
    console.log('❌ Нет массива updates');
    return res.status(400).json({ error: 'Invalid updates' });
  }

  const orderUpdate = updates.find(u => u.file === 'order');
  if (!orderUpdate) {
    console.log('❌ Не найден order в updates');
    return res.status(400).json({ error: 'No order update' });
  }

  const { urls } = orderUpdate;
  if (!urls || !urls.old_url || !urls.new_url) {
    console.log('❌ Нет URL в urls:', urls);
    return res.status(400).json({ error: 'Missing URLs' });
  }

  console.log('✅ old_url:', urls.old_url);
  console.log('✅ new_url:', urls.new_url);

  // Пока просто отвечаем
  console.log('✅ pdf-compare: успешно обработан');
  res.status(200).json({ success: true });
}
