export const config = { runtime: 'edge', regions: ['icn1'] };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await request.json();
  const { notionToken, pageId, children } = body;

  if (!notionToken || !pageId || !children?.length) {
    return new Response(JSON.stringify({ error: 'missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const headers = {
    Authorization: `Bearer ${notionToken}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // Find last block in 📝 기록 section to insert after
  const pb = [];
  let cursor = null;
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : '?page_size=100';
    const pbRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children${qs}`, { headers });
    const pbData = await pbRes.json();
    pb.push(...(pbData.results || []));
    cursor = pbData.has_more ? pbData.next_cursor : null;
  } while (cursor);

  let afterBlockId = null;
  let inG = false;
  for (let bi = 0; bi < pb.length; bi++) {
    const b = pb[bi];
    if (!inG) {
      if (
        b.type === 'heading_4' &&
        !b.heading_4?.is_toggleable &&
        b.heading_4?.rich_text?.some((t) => t.plain_text?.includes('기록'))
      ) {
        afterBlockId = b.id;
        inG = true;
      }
    } else {
      const nx = pb[bi + 1];
      if (b.type === 'heading_4' && b.heading_4?.rich_text?.some((t) => t.plain_text?.includes('일기'))) break;
      if (
        b.type === 'divider' &&
        nx?.type === 'heading_4' &&
        nx?.heading_4?.rich_text?.some((t) => t.plain_text?.includes('일기'))
      )
        break;
      afterBlockId = b.id;
    }
  }

  const insertBody = afterBlockId ? { after: afterBlockId, children } : { children };
  const ar = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(insertBody),
  });

  const data = await ar.json();
  return new Response(JSON.stringify(data), {
    status: ar.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
