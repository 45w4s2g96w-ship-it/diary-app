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

  let { title_date, iso_date, schedules = [] } = payload;

  if (typeof schedules === 'string') {
    schedules = schedules.split('\n').map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(schedules)) schedules = [];

  if (!title_date || !iso_date) {
    return new Response(
      JSON.stringify({ error: 'title_date, iso_date are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ── Todo DB에서 오늘 마감인 항목 전체 조회 ──
  const TODO_DB_ID = '37651f4140c5805e875cdc92a5715d21';

  const todoRes = await fetch(`https://api.notion.com/v1/databases/${TODO_DB_ID}/query`, {
    method: 'POST',
    headers: notionHeaders,
    body: JSON.stringify({
      filter: {
        and: [
          { property: '마감일', date: { equals: iso_date } },
          { property: '완료', checkbox: { equals: false } }
        ]
      },
      sorts: [{ property: '마감일', direction: 'ascending' }]
    })
  });

  const todoData = await todoRes.json();
  const todoPages = todoData.results || [];

  // ── 상위/하위 분류 ──
  // 상위 항목 relation이 비어있으면 부모(또는 단독), 있으면 자식
  const parents = [];   // { id, title, dueStart, children: [] }
  const children = [];  // { id, title, parentId }
  const pageMap = {};   // id → 위 객체

  for (const page of todoPages) {
    const id = page.id;
    const title = page.properties?.['이름']?.title?.[0]?.plain_text || '(제목 없음)';
    const dueStart = page.properties?.['마감일']?.date?.start || '';
    const parentRelation = page.properties?.['상위 항목']?.relation || [];

    const obj = { id, title, dueStart, parentId: parentRelation[0]?.id || null, children: [] };
    pageMap[id] = obj;

    if (!obj.parentId) {
      parents.push(obj);
    } else {
      children.push(obj);
    }
  }

  // ── 자식을 부모에 붙이기 ──
  // 부모가 오늘 마감 목록에 없을 수도 있으므로, 없는 경우 별도 처리
  const orphanChildren = []; // 부모는 목록에 없는 자식

  for (const child of children) {
    if (pageMap[child.parentId]) {
      pageMap[child.parentId].children.push(child);
    } else {
      orphanChildren.push(child); // 부모는 오늘 마감 아니지만 자식은 오늘 마감인 경우
    }
  }

  // ── 시간 포맷 헬퍼 ──
  function formatTime(dueStart) {
    if (!dueStart.includes('T')) return null;
    return new Date(dueStart).toLocaleTimeString('ko-KR', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Asia/Seoul'
    });
  }

  // ── Todo 텍스트 블록 생성 ──
  // 출력 형태:
  //   ▪️ 부모 할일 (HH:mm 있으면 앞에)
  //      └ 자식1
  //      └ 자식2
  function buildTodoRichText(parents, orphans) {
    if (parents.length === 0 && orphans.length === 0) return null; // 없음 처리는 caller에서

    const parts = [];

    const allItems = [
      ...parents.sort((a, b) => (a.dueStart > b.dueStart ? 1 : -1)),
      ...orphans
    ];

    allItems.forEach((item, idx) => {
      if (idx > 0) parts.push({ type: 'text', text: { content: '\n' } });

      const time = formatTime(item.dueStart);
      const prefix = time ? `${time} ` : '';
      parts.push({ type: 'text', text: { content: `▪️ ${prefix}${item.title}` } });

      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          parts.push({ type: 'text', text: { content: `\n   └ ${child.title}`, }, annotations: { color: 'gray' } });
        }
      }
    });

    return parts;
  }

  function toTextBlock(richTextParts, emptyText) {
    if (!richTextParts) {
      return {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: emptyText }, annotations: { color: 'gray' } }]
        }
      };
    }
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richTextParts }
    };
  }

  function toScheduleBlock(schedules, emptyText) {
    if (!schedules || schedules.length === 0) {
      return {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: emptyText }, annotations: { color: 'gray' } }]
        }
      };
    }
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: schedules.map(s => `▪️ ${s}`).join('\n') } }]
      }
    };
  }

  const todoRichText = buildTodoRichText(parents, orphanChildren);

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
          is_toggleable: true,
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

  // ☀️ 모닝브리핑 토글 안에 할일/일정 추가
  if (notionRes.ok && notionData.id) {
    const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${notionData.id}/children`, {
      headers: notionHeaders
    });
    const blocksData = await blocksRes.json();
    const morningToggle = (blocksData.results || []).find(b =>
      b.type === 'heading_4' &&
      (b.heading_4?.rich_text || []).some(t => (t.plain_text || t.text?.content || '').includes('모닝브리핑'))
    );
    if (morningToggle) {
      await fetch(`https://api.notion.com/v1/blocks/${morningToggle.id}/children`, {
        method: 'PATCH',
        headers: notionHeaders,
        body: JSON.stringify({
          children: [
            toTextBlock(todoRichText, '오늘 할일이 없습니다'),
            { object: 'block', type: 'divider', divider: {} },
            toScheduleBlock(schedules, '오늘 일정이 없습니다')
          ]
        })
      });
    }
  }

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
