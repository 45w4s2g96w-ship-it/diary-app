import { runDiaryAnalysis } from '../lib/core.js';

export const config = {
  runtime: 'edge',
  regions: ['icn1'],
};

export default async function handler(request) {
  const url = new URL(request.url);

  if (url.searchParams.get('secret') !== process.env.AUTH_SECRET) {
    return new Response('Unauthorized', { status: 401 });
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

  return runDiaryAnalysis(process.env, notionHeaders, yesterdayStr, null);
}
