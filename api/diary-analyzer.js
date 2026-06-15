import { runDiaryAnalysis } from '../lib/core.js';
import { sendWebResponse } from '../lib/adapter.js';

export const config = {
  regions: ['icn1'],
};

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);

  if (url.searchParams.get('secret') !== process.env.AUTH_SECRET) {
    res.status(401).send('Unauthorized');
    return;
  }

  const notionHeaders = {
    'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  const now = new Date(new Date().toLocaleString('en', { timeZone: 'Asia/Seoul' }));
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const defaultDate = yesterday.toISOString().split('T')[0];
  const yesterdayStr = url.searchParams.get('date') || defaultDate;

  const response = await runDiaryAnalysis(process.env, notionHeaders, yesterdayStr, null);
  await sendWebResponse(response, res);
}
