export const config = { runtime: 'edge', regions: ['icn1'] };

export default async function handler(request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');
  if (secret !== process.env.AUTH_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const notionHeaders = {
    'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  let payload;
  try {
    payload = await parseRequestJsonBody(request);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json body', detail: String(e) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { title_date, iso_date } = payload;

  if (!title_date || !iso_date) {
    return new Response(
      JSON.stringify({ error: 'title_date, iso_date are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const pageBody = {
    parent: { database_id: '37451f4140c5808e9141c8804e892661' },
    properties: {
      '이름': { title: [{ text: { content: title_date } }] },
      '날짜': { date: { start: iso_date } }
    },
    children: [
      {
        object: 'block',
        type: 'heading_4',
        heading_4: {
          rich_text: [{ type: 'text', text: { content: '☀️ 모닝브리핑' } }],
          is_toggleable: true,
          color: 'default'
        }
      },
      { object: 'block', type: 'divider', divider: {} },
      {
        object: 'block',
        type: 'heading_4',
        heading_4: {
          rich_text: [{ type: 'text', text: { content: '📝 기록' } }],
          color: 'default'
        }
      },
      { object: 'block', type: 'divider', divider: {} },
      {
        object: 'block',
        type: 'heading_4',
        heading_4: {
          rich_text: [{ type: 'text', text: { content: '🌙 일기' } }],
          color: 'default'
        }
      },
      {
        object: 'block',
        type: 'quote',
        quote: {
          rich_text: [{ type: 'text', text: { content: '감사한 일\n' } }],
          color: 'default'
        }
      },
      {
        object: 'block',
        type: 'quote',
        quote: {
          rich_text: [{ type: 'text', text: { content: '노력한 일\n' } }],
          color: 'default'
        }
      }
    ]
  };

  const notionRes = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: notionHeaders,
    body: JSON.stringify(pageBody)
  });

  const notionData = await notionRes.json();

  return new Response(JSON.stringify(notionData), {
    status: notionRes.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── 헬퍼: JSON body 파싱 (multipart 대응) ──
function sanitizeJsonText(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\') { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

async function parseRequestJsonBody(request) {
  const rawBody = await request.text();
  const contentType = request.headers.get('content-type') || '';
  let jsonText;
  if (contentType.includes('application/json')) {
    jsonText = rawBody;
  } else {
    const match = rawBody.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json object found in body');
    jsonText = match[0];
  }
  return JSON.parse(sanitizeJsonText(jsonText));
}
