export const config = { maxDuration: 300 };

const DIARY_DB = '37451f4140c5808e9141c8804e892661';
const MORNING_BRIEFING_DB = '37d51f4140c580dca4d5cbec7e5534e3';

export default async function handler(req, res) {
  const secret = req.query?.secret;
  if (secret !== process.env.AUTH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const headers = {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // MORNING_BRIEFING_DB 전체 페이지 조회 (페이지네이션)
  const briefingPages = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${MORNING_BRIEFING_DB}/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const data = await r.json();
    briefingPages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  const results = [];

  for (const bPage of briefingPages) {
    const dateStr = bPage.properties['날짜']?.date?.start;
    if (!dateStr) { results.push({ page: bPage.id, skip: 'no date' }); continue; }

    // 날짜에 맞는 다이어리 페이지 찾기
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${DIARY_DB}/query`, {
      method: 'POST', headers,
      body: JSON.stringify({ filter: { property: '날짜', date: { equals: dateStr } }, page_size: 1 }),
    });
    const diaryPageId = (await dbRes.json()).results?.[0]?.id;
    if (!diaryPageId) { results.push({ date: dateStr, skip: 'no diary page' }); continue; }

    // 모닝브리핑 토글 찾기
    const pageBlocksRes = await fetch(`https://api.notion.com/v1/blocks/${diaryPageId}/children?page_size=100`, { headers });
    const toggle = (await pageBlocksRes.json()).results?.find(
      (b) => b.type === 'heading_4' && b.heading_4?.is_toggleable &&
        b.heading_4?.rich_text?.some((t) => t.plain_text?.includes('모닝브리핑'))
    );

    // 브리핑 DB 페이지의 블록 읽기
    const srcRes = await fetch(`https://api.notion.com/v1/blocks/${bPage.id}/children?page_size=100`, { headers });
    const srcBlocks = (await srcRes.json()).results || [];

    const newBlocks = srcBlocks.map(stripBlock).filter(Boolean);
    if (!newBlocks.length) { results.push({ date: dateStr, skip: 'empty source' }); continue; }

    let ok;
    if (toggle) {
      // 기존 토글 자식 삭제 후 삽입
      const existingRes = await fetch(`https://api.notion.com/v1/blocks/${toggle.id}/children?page_size=100`, { headers });
      for (const b of (await existingRes.json()).results || []) {
        await fetch(`https://api.notion.com/v1/blocks/${b.id}`, { method: 'DELETE', headers });
      }
      const appendRes = await fetch(`https://api.notion.com/v1/blocks/${toggle.id}/children`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ children: newBlocks }),
      });
      ok = appendRes.ok;
    } else {
      // 토글이 없으면 1단계: 토글 블록만 먼저 생성
      const createRes = await fetch(`https://api.notion.com/v1/blocks/${diaryPageId}/children`, {
        method: 'PATCH', headers,
        body: JSON.stringify({
          children: [{
            object: 'block',
            type: 'heading_4',
            heading_4: {
              rich_text: [{ type: 'text', text: { content: '☀️ 모닝브리핑' } }],
              is_toggleable: true,
              color: 'default',
            },
          }],
        }),
      });
      const createData = await createRes.json();
      const newToggleId = createData.results?.[0]?.id;
      if (!newToggleId) { results.push({ date: dateStr, skip: 'toggle creation failed', detail: createData }); continue; }

      // 2단계: 새 토글에 브리핑 블록 삽입
      const appendRes = await fetch(`https://api.notion.com/v1/blocks/${newToggleId}/children`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ children: newBlocks }),
      });
      ok = appendRes.ok;
    }

    // 브리핑 DB 페이지 아카이브
    if (ok) {
      await fetch(`https://api.notion.com/v1/pages/${bPage.id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ archived: true }),
      });
    }

    results.push({ date: dateStr, ok, blocks: newBlocks.length });
  }

  return res.status(200).json({ total: briefingPages.length, results });
}

function stripBlock(block) {
  const type = block.type;
  if (!block[type]) return null;
  const content = block[type];
  // 읽기전용 필드 제거 후 필요한 필드만 추출
  const stripped = { object: 'block', type };
  if (type === 'paragraph') {
    stripped.paragraph = { rich_text: content.rich_text || [], color: content.color || 'default' };
  } else if (type === 'divider') {
    stripped.divider = {};
  } else if (type === 'heading_1' || type === 'heading_2' || type === 'heading_3' || type === 'heading_4') {
    stripped[type] = { rich_text: content.rich_text || [], color: content.color || 'default' };
  } else if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
    stripped[type] = { rich_text: content.rich_text || [], color: content.color || 'default' };
  } else if (type === 'quote') {
    stripped[type] = { rich_text: content.rich_text || [], color: content.color || 'default' };
  } else {
    return null;
  }
  return stripped;
}
