export const config = { regions: ['icn1'], api: { bodyParser: false } };

const DIARY_DB = '37451f4140c5808e9141c8804e892661';

export default async function handler(req, res) {
  const secret = req.query?.secret;
  if (secret !== process.env.AUTH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const overrideDate = req.query?.date || null;
    const result = await runBriefing(overrideDate);
    return res.status(200).json(result);
  } catch (error) {
    console.error('에러 발생:', error);
    return res.status(500).json({ error: String(error) });
  }
}

async function fetchGoogleNewsRSS() {
  try {
    const res = await fetch('https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null && items.length < 20) {
      const block = m[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]?.trim();
      const desc = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim();
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      if (title && link) items.push({ title, link, desc: desc || '', source: source || '' });
    }
    return items;
  } catch (e) {
    console.error('RSS fetch failed', e);
    return [];
  }
}

async function fetchDiary(token, yesterdayStr) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DIARY_DB}/query`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify({ filter: { property: '날짜', date: { equals: yesterdayStr } }, page_size: 1 }),
    });
    const data = await res.json();
    const page = data.results?.[0];
    if (!page) return { diarySummary: '', diarySuggest: '' };
    return {
      diarySummary: getRichText(page.properties['일기 요약']),
      diarySuggest: getRichText(page.properties['제언']),
    };
  } catch (e) {
    console.error('diary fetch failed', e);
    return { diarySummary: '', diarySuggest: '' };
  }
}

async function runBriefing(overrideDate = null) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY;
  const ICLOUD_CALENDAR_URLS = process.env.ICLOUD_CALENDAR_URLS;

  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = overrideDate || kstNow.toISOString().slice(0, 10);
  const yesterday = new Date(todayStr);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const [todaySchedule, diaryResult, newsItems] = await Promise.all([
    fetchTodayEvents(ICLOUD_CALENDAR_URLS, todayStr).catch(() => ''),
    fetchDiary(NOTION_TOKEN, yesterdayStr),
    fetchGoogleNewsRSS(),
  ]);

  const { diarySummary, diarySuggest } = diaryResult;

  const excludeSources = ['조선일보', '중앙일보', '동아일보', 'Chosun', 'JoongAng', 'Donga'];
  const newsText = newsItems
    .map((item, i) => `${i + 1}. [${item.source}] ${item.title}${item.desc ? ' / ' + item.desc : ''} / URL: ${item.link}`)
    .join('\n');

  const [y, mo, d] = todayStr.split('-').map(Number);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dow = new Date(y, mo - 1, d).getDay();
  const dayName = days[dow];

  const systemPrompt = `너는 민영의 아침 브리핑을 작성하는 비서야.

[출력 형식 - 절대 규칙]
- 반드시 순수 JSON 객체 하나만 출력한다. 그 외 어떤 텍스트도 금지.
- "검색하겠습니다", "~를 바탕으로 작성하겠습니다" 같은 사전 설명, 사고 과정, 검색 경과 보고를 절대 출력하지 않는다. 첫 글자부터 바로 { 로 시작한다.
- 마크다운 백틱(\`\`\`)도 금지.

[말투 규칙 - 절대 규칙]
- 전체 기조: 유능한 비서가 조용히 보고하는 말투. 친절하되 과도한 격식은 피한다.
- 극존칭 금지: 하셨어요, 하셨습니다, 하실 예정입니다, 하실 계획입니다, 하실, 이세요, 드셨어요, 보내셨네요 — 이 형태는 어느 섹션에서도 절대 쓰지 않는다.
  - "일정이 있으셨네요" → "일정이 있었어요"
  - "오늘 하실 일정은" → "오늘 일정은"
  - "재택근무를 하시는 날" → "재택근무 날"
- ~십시오/~것입니다 금지.
- 이모지/구어체 금지. 음성으로 읽히는 글이므로 괄호·기호 최소화 (URL 제외).
- 섹션별 말투:
  - weather: 기상캐스터식 ~ㅂ니다/~입니다 어미만 사용.
  - news: 기자처럼 ~ㅂ니다/~입니다 어미만 사용.
  - schedule, suggestion: 비서 말투, ~요/~입니다 자연스럽게 섞어 쓴다.
  - yesterday: 심리상담가처럼 ~요/~ㅂ니다를 적절히 섞어 부드럽고 따뜻하게 서술.

[섹션별 내용 규칙]
- weather: 250자 이내, 한 문단 3~4문장, 줄바꿈 없음. ~ㅂ니다/~입니다 어미만 사용. web_search로 오늘 서울 날씨 섭씨 기준 검색. 검색 출처나 검색 과정 언급 절대 금지 — 결과만 자연스럽게 서술. "서울은 오늘 최고기온 N도..." 형식으로 시작, 체감/생활 조언으로 마무리.
- schedule: 250자 이내. 시간순 자연스럽게. 일정이 1개뿐이거나 없으면 일기 요약 참고해서 활동 한 마디 추천.
- news: 정확히 2개 항목 배열. 각 {"summary": "...", "url": "..."}. summary는 300자 이내, 2~4문장, ~입니다로 종결, "OOO에 따르면" 같은 출처표기 금지. ${excludeSources.join('/')} 출처 기사는 제외.
- yesterday: 300자 이내, 한 문단 3~4문장, 줄바꿈 없음. 요약 + 격려.
- suggestion: 400자 이내. 행동제안 3~4문장 + 줄바꿈 + 인지전환 3~4문장. 일기/제언 참고해서 구체적으로.
- 평일(월~금)인데 일정이 없으면 쉬는 날 취급하지 말고, 출근 전 짧은 리프레시나 퇴근 후 소소한 일정을 제안.

[출력 JSON 스키마 - 이 형식 그대로]
{"weather":"...","schedule":"...","news":[{"summary":"...","url":"..."},{"summary":"...","url":"..."}],"yesterday":"...","suggestion":"..."}`;

  const userPrompt = `오늘(${todayStr}, ${dayName}요일) 일정: ${todaySchedule || '(없음)'}
어제(${yesterdayStr}) 일기 요약: ${diarySummary || '(없음)'}
어제 제언: ${diarySuggest || '(없음)'}

기사 목록:
${newsText || '(없음)'}

위 정보로 JSON 브리핑을 작성해줘.`;

  const briefingResult = await callClaude(ANTHROPIC_API_KEY, systemPrompt, userPrompt);

  let parsed;
  try {
    const raw = briefingResult.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (e) {
    parsed = {
      weather: '브리핑 생성에 실패했습니다.',
      schedule: '',
      news: [],
      yesterday: '',
      suggestion: '',
    };
  }

  const newBlocks = buildBriefingBlocksFromJSON(parsed);

  const diaryPageId = await findTodayDiaryPage(NOTION_TOKEN, todayStr);
  if (!diaryPageId) {
    return { ok: false, todayStr, error: 'no diary page found for today', briefing: parsed, debug: briefingResult.debug };
  }

  const toggleId = await findMorningBriefingToggle(NOTION_TOKEN, diaryPageId);
  if (!toggleId) {
    return { ok: false, todayStr, error: 'morning briefing toggle not found', briefing: parsed, debug: briefingResult.debug };
  }

  try {
    const childrenData = await (await fetch(
      `https://api.notion.com/v1/blocks/${toggleId}/children?page_size=100`,
      { headers: notionHeaders(NOTION_TOKEN) }
    )).json();
    for (const block of (childrenData.results || [])) {
      await fetch(`https://api.notion.com/v1/blocks/${block.id}`, { method: 'DELETE', headers: notionHeaders(NOTION_TOKEN) });
    }
  } catch (e) { console.error('toggle children cleanup failed', e); }

  const appendRes = await fetch(`https://api.notion.com/v1/blocks/${toggleId}/children`, {
    method: 'PATCH',
    headers: notionHeaders(NOTION_TOKEN),
    body: JSON.stringify({ children: newBlocks }),
  });
  const pageResult = { ok: appendRes.ok, mode: 'inserted', toggleId, diaryPageId };

  return { ok: pageResult.ok, todayStr, briefing: parsed, debug: briefingResult.debug, notion: pageResult };
}

async function findTodayDiaryPage(token, todayStr) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${DIARY_DB}/query`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify({ filter: { property: '날짜', date: { equals: todayStr } }, page_size: 1 }),
    });
    const data = await res.json();
    return data.results?.[0]?.id || null;
  } catch (e) {
    console.error('diary page search failed', e);
    return null;
  }
}

async function findMorningBriefingToggle(token, pageId) {
  try {
    const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
      headers: notionHeaders(token),
    });
    const data = await res.json();
    const toggle = (data.results || []).find(
      (b) => b.type === 'heading_4' && b.heading_4?.is_toggleable &&
        b.heading_4?.rich_text?.some((t) => t.plain_text?.includes('모닝브리핑'))
    );
    return toggle?.id || null;
  } catch (e) {
    console.error('toggle search failed', e);
    return null;
  }
}

async function callClaude(apiKey, systemPrompt, userPrompt) {
  try {
    const messages = [{ role: 'user', content: userPrompt }];
    let finalText = '';
    for (let turn = 0; turn < 3; turn++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2200,
          system: systemPrompt,
          messages,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) return { text: '', debug: { stage: 'claude_error', raw: data } };
      const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text);
      if (data.stop_reason !== 'tool_use') { finalText = textBlocks.join('\n').trim(); break; }
      messages.push({ role: 'assistant', content: data.content });
      messages.push({
        role: 'user',
        content: (data.content || [])
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: '(검색 완료, 결과 반영해서 JSON으로 응답)' }))
      });
    }
    return { text: finalText.trim(), debug: finalText ? null : { stage: 'no_final_text' } };
  } catch (error) {
    return { text: '', debug: { stage: 'claude_exception', error: String(error) } };
  }
}

function notionHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' };
}
function getRichText(prop) {
  if (!prop) return '';
  if (prop.rich_text) return prop.rich_text.map((t) => t.plain_text).join('');
  if (prop.title) return prop.title.map((t) => t.plain_text).join('');
  return '';
}
function dividerBlock() { return { object: 'block', type: 'divider', divider: {} }; }
function titleParagraph(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text }, annotations: { bold: true, underline: true } }] } };
}
function bodyParagraph(line) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: line } }] } };
}
function linkParagraph(text, url) {
  return {
    object: 'block', type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: text + ' ' } },
        { type: 'text', text: { content: '🔗', link: { url } } }
      ]
    }
  };
}

function buildBriefingBlocksFromJSON(data) {
  const sections = [
    { official: '오늘 날씨입니다.', body: data.weather },
    { official: '오늘 일정입니다.', body: data.schedule },
    { official: '오늘 뉴스입니다.', news: data.news },
    { official: '어제는 이런 하루를 보냈어요.', body: data.yesterday },
    { official: '오늘은 이렇게 해보는 게 어떨까요?', body: data.suggestion },
  ];
  const blocks = [];
  sections.forEach((s, i) => {
    if (i > 0) blocks.push(dividerBlock());
    blocks.push(titleParagraph(s.official));
    if (s.news && Array.isArray(s.news)) {
      s.news.forEach((n) => {
        if (n?.summary && n?.url) blocks.push(linkParagraph(n.summary.trim(), n.url));
        else if (n?.summary) blocks.push(bodyParagraph(n.summary.trim()));
      });
    } else if (s.body) {
      blocks.push(bodyParagraph(String(s.body).trim()));
    }
  });
  return blocks.slice(0, 100);
}

async function fetchTodayEvents(icsUrls, todayStr) {
  if (!icsUrls) return '';
  const events = [];
  for (const url of icsUrls.split(',').map((u) => u.trim()).filter(Boolean)) {
    try { events.push(...parseIcsForDate(await (await fetch(url)).text(), todayStr)); }
    catch (e) { console.error('calendar fetch failed:', url, e); }
  }
  events.sort((a, b) => {
    const [aK, aT] = a.split('|');
    const [bK, bT] = b.split('|');
    return aT !== bT ? aT.localeCompare(bT) : aK.localeCompare(bK);
  });
  return events.map((e) => e.split('|').slice(2).join('|')).join(', ');
}

function parseIcsForDate(icsText, todayStr) {
  const results = [], targetDate = parseYMD(todayStr);
  for (const rawBlock of icsText.split('BEGIN:VEVENT').slice(1)) {
    const block = rawBlock.split('END:VEVENT')[0];
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const dtStartMatch = block.match(/DTSTART(?:;[^:\r\n]*)?:(\d{8})(T(\d{6}))?(Z)?/);
    if (!summaryMatch || !dtStartMatch) continue;
    const summary = summaryMatch[1].trim();
    const dateStr = dtStartMatch[1], timeStr = dtStartMatch[3], isUTC = !!dtStartMatch[4];
    const eventStart = parseYMD(dateStr);
    const rruleMatch = block.match(/RRULE:(.+)/);
    const exdates = [...block.matchAll(/EXDATE(?:;[^:\r\n]*)?:(\d{8})/g)].map((m) => m[1]);
    const occurs = !rruleMatch
      ? dateStr === todayStr.replace(/-/g, '')
      : compareYMD(targetDate, eventStart) >= 0 && !exdates.includes(todayStr.replace(/-/g, '')) && matchesRRule(rruleMatch[1], eventStart, targetDate);
    if (!occurs) continue;
    let timeLabel = '하루 종일', sortKey = '00:00', dayInfo = '';
    if (timeStr) {
      let hour = parseInt(timeStr.slice(0, 2), 10);
      if (isUTC) hour = (hour + 9) % 24;
      timeLabel = sortKey = `${String(hour).padStart(2, '0')}:${timeStr.slice(2, 4)}`;
    } else {
      const dayNum = Math.round((toDate(targetDate) - toDate(eventStart)) / 86400000) + 1;
      if (dayNum >= 2) dayInfo = ` (${dayNum}일차)`;
    }
    results.push(`${sortKey}|${timeStr ? '1' : '0'}|${timeLabel} ${summary}${dayInfo}`);
  }
  return results;
}

function parseYMD(str) { const s = str.replace(/-/g, ''); return { y: +s.slice(0, 4), m: +s.slice(4, 6), d: +s.slice(6, 8) }; }
function compareYMD(a, b) { return a.y !== b.y ? a.y - b.y : a.m !== b.m ? a.m - b.m : a.d - b.d; }
function toDate(ymd) { return new Date(ymd.y, ymd.m - 1, ymd.d); }
function matchesRRule(rrule, start, target) {
  const parts = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=')));
  const interval = +(parts.INTERVAL || 1);
  if (parts.UNTIL && compareYMD(target, parseYMD(parts.UNTIL.slice(0, 8))) > 0) return false;
  const dayDiff = Math.round((toDate(target) - toDate(start)) / 86400000);
  if (dayDiff < 0) return false;
  switch (parts.FREQ) {
    case 'DAILY': return dayDiff % interval === 0;
    case 'WEEKLY': {
      const wd = Math.floor(dayDiff / 7);
      if (wd % interval !== 0) return false;
      return parts.BYDAY
        ? parts.BYDAY.split(',').includes(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][toDate(target).getDay()])
        : toDate(target).getDay() === toDate(start).getDay();
    }
    case 'MONTHLY': {
      if (target.d !== start.d) return false;
      const md = (target.y - start.y) * 12 + (target.m - start.m);
      return md >= 0 && md % interval === 0;
    }
    case 'YEARLY': {
      if (target.m !== start.m || target.d !== start.d) return false;
      const yd = target.y - start.y;
      return yd >= 0 && yd % interval === 0;
    }
    default: return false;
  }
}
