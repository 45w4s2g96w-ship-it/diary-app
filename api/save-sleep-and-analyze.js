import { handleSaveSleepAndAnalyze } from '../lib/core.js';
import { toWebRequest, sendWebResponse } from '../lib/adapter.js';

// Vercel 함수 최대 실행 시간을 300초(5분)로 연장
export const maxDuration = 300;

export const config = {
  regions: ['icn1'],
  api: {
    bodyParser: false,
  },
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

  const webRequest = toWebRequest(req);
  const response = await handleSaveSleepAndAnalyze(webRequest, process.env, notionHeaders);
  await sendWebResponse(response, res);
}
