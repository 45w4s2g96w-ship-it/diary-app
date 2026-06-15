import { handleSaveSleepAndAnalyze } from '../lib/core.js';

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

  return handleSaveSleepAndAnalyze(request, process.env, notionHeaders);
}
