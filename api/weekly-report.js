import { handleWeeklyReport } from '../lib/core.js';
import { toWebRequest, sendWebResponse } from '../lib/adapter.js';

export const config = {
  regions: ['icn1'],
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  try {
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
    const response = await handleWeeklyReport(webRequest, process.env, notionHeaders);
    await sendWebResponse(response, res);
  } catch (e) {
    res.status(500).json({ error: '서버 오류', detail: String(e), stack: e?.stack?.split('\n').slice(0, 5).join('\n') });
  }
}
