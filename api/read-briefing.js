export const config = { runtime: 'edge', regions: ['icn1'] };

const DIARY_DB = '37451f4140c5808e9141c8804e892661';

export default async function handler(request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');
  if (secret !== process.env.AUTH_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const overrideDate = url.searchParams.get('date');
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = overrideDate || kstNow.toISOString().slice(0, 10);

  const headers = {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // 오늘 다이어리 페이지 찾기
  const dbRes = await fetch(`https://api.notion.com/v1/databases/${DIARY_DB}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ filter: { property: '날짜', date: { equals: todayStr } }, page_size: 1 }),
  });
  const dbData = await dbRes.json();
  const pageId = dbData.results?.[0]?.id;
  if (!pageId) {
    return json({ ok: false, error: 'no diary page found', date: todayStr });
  }

  // 모닝브리핑 토글 찾기
  const pageBlocksRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers });
  const pageBlocks = await pageBlocksRes.json();
  const toggle = (pageBlocks.results || []).find(
    (b) => b.type === 'heading_4' && b.heading_4?.is_toggleable &&
      b.heading_4?.rich_text?.some((t) => t.plain_text?.includes('모닝브리핑'))
  );
  if (!toggle) {
    return json({ ok: false, error: 'morning briefing toggle not found', date: todayStr });
  }

  // 토글 자식 블록 읽기
  const toggleBlocksRes = await fetch(`https://api.notion.com/v1/blocks/${toggle.id}/children?page_size=100`, { headers });
  const toggleBlocks = await toggleBlocksRes.json();

  const lines = [];
  for (const block of (toggleBlocks.results || [])) {
    const type = block.type;
    const content = block[type];
    if (!content?.rich_text) continue;
    const text = content.rich_text.map((t) => t.plain_text).join('').trim();
    if (text) lines.push(text);
  }

  return json({ ok: true, date: todayStr, text: lines.join('\n\n'), lines });
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}
