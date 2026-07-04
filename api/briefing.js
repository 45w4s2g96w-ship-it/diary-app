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

const WMO_KO = {
  0: '맑음', 1: '대체로 맑음', 2: '부분 흐림', 3: '흐림',
  45: '안개', 48: '착빙 안개',
  51: '가벼운 이슬비', 53: '이슬비', 55: '짙은 이슬비',
  61: '가벼운 비', 63: '비', 65: '강한 비',
  71: '가벼운 눈', 73: '눈', 75: '강한 눈',
  80: '소나기', 81: '강한 소나기', 82: '매우 강한 소나기',
  95: '천둥번개', 96: '우박 동반 천둥번개', 99: '심한 우박 동반 천둥번개',
};

const SKY_KO = { '1': '맑음', '3': '구름많음', '4': '흐림' };
const PTY_KO = { '1': '비', '2': '비/눈', '3': '눈', '4': '소나기' };

async function fetchKmaSkyStatus(apiKey) {
  if (!apiKey) return '';
  try {
    const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    let baseDate = kstNow;
    let baseHour = kstNow.getUTCHours();
    if (kstNow.getUTCMinutes() < 45) {
      baseDate = new Date(kstNow.getTime() - 60 * 60 * 1000);
      baseHour = baseDate.getUTCHours();
    }
    const baseDateStr = baseDate.toISOString().slice(0, 10).replace(/-/g, '');
    const baseTime = `${String(baseHour).padStart(2, '0')}30`;

    const url = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtFcst'
      + `?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=60&pageNo=1&dataType=JSON`
      + `&base_date=${baseDateStr}&base_time=${baseTime}&nx=60&ny=127`;
    const res = await fetch(url);
    const data = await res.json();
    const items = data?.response?.body?.items?.item;
    if (!Array.isArray(items) || items.length === 0) return '';

    const firstTime = items.find((it) => it.category === 'SKY')?.fcstTime;
    const sky = items.find((it) => it.category === 'SKY' && it.fcstTime === firstTime)?.fcstValue;
    const pty = items.find((it) => it.category === 'PTY' && it.fcstTime === firstTime)?.fcstValue;

    if (pty && pty !== '0') return PTY_KO[pty] ?? '';
    return SKY_KO[sky] ?? '';
  } catch (e) {
    console.error('KMA sky fetch failed', e);
    return '';
  }
}

async function fetchSeoulWeather(kmaApiKey) {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=37.5665&longitude=126.9780'
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m'
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum'
      + '&timezone=Asia%2FSeoul&forecast_days=1';
    const [res, kmaSky] = await Promise.all([
      fetch(url),
      fetchKmaSkyStatus(kmaApiKey).catch(() => ''),
    ]);
    const data = await res.json();
    const cur = data.current;
    const daily = data.daily;
    if (!cur) return '';
    const desc = kmaSky || (WMO_KO[cur.weather_code] ?? `코드 ${cur.weather_code}`);
    return [
      `현재기온: ${cur.temperature_2m}°C (체감 ${cur.apparent_temperature}°C)`,
      `최고: ${daily.temperature_2m_max[0]}°C / 최저: ${daily.temperature_2m_min[0]}°C`,
      `날씨(이 표현 그대로 사용, 변경 금지): ${desc}`,
      `습도: ${cur.relative_humidity_2m}%`,
      `풍속: ${cur.wind_speed_10m}km/h`,
      `현재강수: ${cur.precipitation}mm`,
    ].join(', ');
  } catch (e) {
    console.error('weather fetch failed', e);
    return '';
  }
}

async function fetchKoreanHolidays(year) {
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/KR`);
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set(data.map((h) => h.date));
  } catch (e) {
    console.error('holiday fetch failed', e);
    return new Set();
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
  const KMA_API_KEY = process.env.KMA_API_KEY;

  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = overrideDate || kstNow.toISOString().slice(0, 10);
  const yesterday = new Date(todayStr);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const [y, mo, d] = todayStr.split('-').map(Number);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dow = new Date(y, mo - 1, d).getDay();
  const dayName = days[dow];

  const [todaySchedule, diaryResult, newsItems, seoulWeather, holidaySet] = await Promise.all([
    fetchTodayEvents(ICLOUD_CALENDAR_URLS, todayStr).catch(() => ''),
    fetchDiary(NOTION_TOKEN, yesterdayStr),
    fetchGoogleNewsRSS(),
    fetchSeoulWeather(KMA_API_KEY).catch(() => ''),
    fetchKoreanHolidays(y).catch(() => new Set()),
  ]);

  const { diarySummary, diarySuggest } = diaryResult;
  const hasDiarySummary = !!diarySummary;

  const excludeSources = ['조선일보', '중앙일보', '동아일보', 'Chosun', 'JoongAng', 'Donga'];
  const newsText = newsItems
    .filter((item) => !excludeSources.some((src) => item.source.includes(src)))
    .slice(0, 8)
    .map((item, i) => {
      const desc = item.desc.length > 200 ? item.desc.slice(0, 200) + '…' : item.desc;
      return `${i + 1}. [${item.source}] ${item.title}${desc ? ' / ' + desc : ''} / URL: ${item.link}`;
    })
    .join('\n');

  const isHoliday = holidaySet.has(todayStr);
  const hasOff = /\[Off\]/.test(todaySchedule);
  const hasWFH = /재택/.test(todaySchedule);
  let workStatusNote;
  if (dow === 0 || dow === 6) {
    workStatusNote = '오늘은 주말이다. 9~18시 회사 출근 가정을 적용하지 않는다.';
  } else if (isHoliday) {
    workStatusNote = '오늘은 평일이지만 한국 공휴일이다. 9~18시 회사 출근 가정을 적용하지 않는다.';
  } else if (hasOff) {
    workStatusNote = '오늘은 평일이지만 [Off] 일정이 있다. 9~18시 회사 출근 가정을 적용하지 않고, 그 Off 일정 종류(연차/오전반차/오후반차/반반차)의 정의에 따라 하루를 묘사한다.';
  } else if (hasWFH) {
    workStatusNote = '오늘은 평일이고 재택근무 일정이 있다. 9~18시 회사 출근 가정을 적용하지 않는다.';
  } else if (todaySchedule) {
    workStatusNote = '오늘은 평일이고 [Off]/재택 일정이 없다. 9~18시는 회사 근무 시간으로 간주하고, 이는 당연한 전제이므로 "9시부터 18시까지 회사에 출근해 있으면 되고" 같은 문장으로 굳이 설명하지 않는다. 대신 아래 일정 목록에 있는 항목을 퇴근 후(18시 이후) 일정으로 자연스럽게 이어서 서술한다. 낮 시간(9~18시)에 카페·산책 등 평일 낮 활동은 제안하지 않는다.';
  } else {
    workStatusNote = '오늘은 평일이고 [Off]/재택 일정도 그 외 다른 일정도 전혀 없다. 9~18시가 회사 근무 시간이라는 건 당연한 전제이므로 "9시부터 18시까지 회사에 출근해 있으면 되고" 같은 기계적인 설명 문장을 쓰지 않는다. 대신 곧바로 퇴근 후(18시 이후)에 할 만한 구체적인 활동이나 계획을 날씨와 계절에 맞게 추천한다. 낮 시간(9~18시)에 카페·산책 등 평일 낮 활동은 제안하지 않는다.';
  }

  const systemPrompt = `너는 민영의 아침 브리핑을 작성하는 비서야.

[출력 형식 - 절대 규칙]
- 반드시 순수 JSON 객체 하나만 출력한다. 그 외 어떤 텍스트도 금지.
- "검색하겠습니다", "~를 바탕으로 작성하겠습니다" 같은 사전 설명, 사고 과정, 검색 경과 보고를 절대 출력하지 않는다. 첫 글자부터 바로 { 로 시작한다.
- 마크다운 백틱(\`\`\`)도 금지.

[말투 규칙 - 절대 규칙]
- 전체 기조: 유능한 비서가 조용히 보고하는 말투. 친절하되 과도한 격식은 피한다.
- 극존칭 금지(절대 규칙): 아래 형태는 어느 섹션에서도 절대 쓰지 않는다.
  금지 형태: ~하셨어요, ~하셨습니다, ~하실, ~이세요, ~드셨어요, ~보내셨네요, ~챙겨두시면, ~보내시다가, ~참고해 주세요, ~챙기시면, ~하시면 — 동사 어간에 "시"가 붙는 모든 형태.
  - "일정이 있으셨네요" → "일정이 있어요"
  - "오늘 하실 일정은" → "오늘 일정은"
  - "재택근무를 하시는 날" → "재택근무 날"
  - "보내시다가" → "보내다가"
  - "챙겨두시면" → "챙겨두면" 또는 "챙겨두는 게 좋아요"
  - "참고해 주세요" → "참고하면 좋겠어요"
- 호칭: 사람 이름 뒤에는 반드시 "님"을 붙인다. "분" 호칭은 절대 금지. ("소언 분" → "소언 님")
- 자유시간 표현: "자유롭게 쓸 수 있습니다" 같은 뜬구름 잡는 표현 금지. 반드시 그 뒤에 오는 일정 또는 상황과 연결해서 구체적으로 묘사한다.
  - 자유시간 이후 일정이 있으면: "N시 약속 전에 가볍게 준비할 수 있어요", "이동 시간을 고려해서 미리 나서면 좋겠어요" 등 다음 일정과 연결해서 서술.
  - 자유시간 이후 일정이 없으면: 날씨나 맥락에 맞는 구체적인 활동 제안 ("날이 맑으니 가볍게 산책하기 좋겠어요" 등).
- ~십시오/~것입니다 금지.
- 이모지/구어체 금지. 음성으로 읽히는 글이므로 괄호·기호 최소화 (URL 제외).
- 섹션별 말투 (어미 비율을 반드시 지킬 것):
  - weather: ~ㅂ니다/~입니다 100%. ~요 금지.
  - schedule: ~ㅂ니다/~입니다 70%, ~요 30% 비율로 섞어 쓴다.
  - news: ~ㅂ니다/~입니다 100%. ~요 금지.
  - yesterday: ~ㅂ니다/~입니다 50%, ~요 50% 비율로 섞어 심리상담가처럼 부드럽게 서술.

[섹션별 내용 규칙]
- weather: 210자 이내, 한 문단 3~4문장, 줄바꿈 없음. ~ㅂ니다/~입니다 어미만 사용. 아래 user 메시지에 제공된 서울 날씨 데이터를 바탕으로 서술. 검색 출처나 검색 과정 언급 절대 금지 — 결과만 자연스럽게 서술. 반드시 다음 순서로 구성한다:
  (0) 절대 규칙: 기상 상태(맑음/흐림/비 등) 표현은 제공된 날씨 데이터의 "날씨(...)" 필드 값을 그대로 사용한다. 데이터에 없는 상태를 임의로 추측하거나 다른 표현으로 바꾸지 않는다 — 예: 데이터가 "흐림"이면 반드시 "흐림"으로 쓰고 "맑음"으로 바꿔 쓰지 않는다.
  (1) 오늘 날씨 상태와 기온 요약 — "서울은 오늘 최고기온 N도, 최저기온 N도..." 형식으로 시작하고, 기상 상태(맑음/흐림/비 등)와 현재기온·체감온도를 언급.
  (2) 옷차림 추천 — 종일 기온 변화(최저~최고)와 온도 폭을 함께 고려해서 현실적으로 추천한다.
    - 기본 기준(최고기온 기준): 28도 이상이면 반팔/민소매, 23~27도면 반팔이나 얇은 셔츠, 18~22도면 얇은 긴팔이나 가벼운 가디건, 17도 이하면 자켓/아우터 필수.
    - 온도 폭이 10도 이상이면(아침 저녁 쌀쌀한데 낮엔 더운 경우) 레이어링을 권장한다 — 예: "낮엔 반팔이지만 아침저녁으론 얇은 겉옷을 챙기세요", "출근할 땐 가볍게 걸치고 낮에 벗을 수 있는 옷차림이 좋습니다".
    - 온도 폭이 작으면(7도 미만) 단순하게 하나로 추천.
    - 강수가 예보되면 우산을 챙기라는 말을 추가.
  (3) 마지막 한 문장은 그날 날씨 분위기에 어울리는 짧은 화이팅 한마디로 마무리 (예: 맑고 더운 날엔 "더위에 지치지 않게 수분 잘 챙기며 힘내시길 바랍니다", 비 오는 날엔 "비에 마음까지 가라앉지 않게 활기차게 보내시길 바랍니다", 맑고 선선한 날엔 "기분 좋은 날씨처럼 가볍게 힘내는 하루 보내시길 바랍니다" 등 — 옷차림 추천과 중복되지 않는 응원 문장).
- schedule: 175자 이내. 비서가 하루 일정을 사람에게 직접 말해주듯 자연스럽게 서술. 시간과 내용을 단순 나열하지 말고 맥락과 흐름을 담아 문장으로 연결.
  - 절대 규칙: 아래 user 메시지의 "근무 상태 판단"은 이미 코드로 확정 계산된 값이다. 평일 여부나 [Off]/재택 일정 유무를 스스로 다시 판단하거나 이 결론과 다르게 서술하지 않는다 — 그 문장에 명시된 가정을 그대로 따른다.
  - [Off] 일정이 있는 경우, 아래 정의에 따라 하루를 묘사한다:
    - 연차: 하루 종일 자유
    - 오전반차: 오전이 자유(쉬는 시간), 오후에 출근. "오전반차"는 오전에 쉬고 오후에 일하는 것 — 절대로 오전에 일하고 오후에 쉬는 것으로 잘못 이해하지 말 것.
    - 오후반차: 오전 출근, 오후가 자유(퇴근).
    - 반반차(2시간): 이벤트 시각 기준으로 앞뒤 2시간이 자유. 나머지 시간은 회사.
  - 일정이 아예 없고 9-6 가정도 적용되지 않는 날(주말, 휴가 등)이면 날씨를 참고해서 오늘 하루에 어울리는 활동을 구체적으로 제안.
  - "오늘은 평일이고 특별한 일정이 없습니다" 같은 상황 설명으로 문장을 시작하지 않는다. 곧바로 추천 내용이나 일정으로 들어간다.
- news: 정확히 2개 항목 배열. 각 {"summary": "...", "url": "..."}. summary는 210자 이내, 2~3문장, ~입니다로 종결, "OOO에 따르면" 같은 출처표기 금지. ${excludeSources.join('/')} 출처 기사는 제외. summary에는 한자(漢字)를 절대 쓰지 않는다 — 기사 제목에 民主黨, 與, 野, 法司委 같은 한자나 한자 약칭이 있어도 모두 한글(민주당, 여당, 야당, 법사위 등)로 풀어서 쓴다.
- yesterday: ${hasDiarySummary ? '210자 이내, 한 문단 2~3문장, 줄바꿈 없음. 요약 + 격려.' : '어제 일기 기록이 없으므로 반드시 빈 문자열("")로 두세요.'}
- suggestion: ${hasDiarySummary ? '반드시 한 문단으로만 작성한다(줄바꿈 금지). 280자 이내, 2~3문장. 행동제안과 인지전환을 한 문단 안에 자연스럽게 녹여서 압축적으로 서술 — 별도 문단으로 나누지 않는다. 일기/제언 참고해서 구체적으로.' : '아래 user 메시지의 "어제 제언"을 한 문단으로 압축해 자연스러운 비서 말투로 재서술. 반드시 한 문단(줄바꿈 없음), 280자 이내. 핵심만 남기고 내용 추가는 금지.'} 일정에 등장하는 인물과 일기에 등장하는 인물 사이의 관계를 임의로 가정하지 말 것 — 서로 모르는 사이일 수 있으므로 두 인물을 연결하는 제안 절대 금지.

[출력 JSON 스키마 - 이 형식 그대로]
{"weather":"...","schedule":"...","news":[{"summary":"...","url":"..."},{"summary":"...","url":"..."}],"yesterday":"...","suggestion":"..."}`;

  const userPrompt = `오늘(${todayStr}, ${dayName}요일) 일정: ${todaySchedule || '(없음)'}
근무 상태 판단(이미 확정됨, 그대로 따를 것): ${workStatusNote}
어제(${yesterdayStr}) 일기 요약: ${diarySummary || '(없음)'}
어제 제언: ${diarySuggest || '(없음)'}

서울 날씨 데이터:
${seoulWeather || '(없음)'}

기사 목록:
${newsText || '(없음)'}

위 정보로 JSON 브리핑을 작성해줘.`;

  const briefingResult = await callClaude(ANTHROPIC_API_KEY, systemPrompt, userPrompt);

  let parsed;
  let parseDebug = null;
  try {
    const raw = briefingResult.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (e) {
    parseDebug = { stage: 'json_parse_failed', error: String(e), raw: briefingResult.text };
    parsed = {
      weather: '브리핑 생성에 실패했습니다.',
      schedule: '',
      news: [],
      yesterday: '',
      suggestion: '',
    };
  }

  const finalDebug = parseDebug || briefingResult.debug;
  const newBlocks = buildBriefingBlocksFromJSON(parsed);

  const diaryPageId = await findTodayDiaryPage(NOTION_TOKEN, todayStr);
  if (!diaryPageId) {
    return { ok: false, todayStr, error: 'no diary page found for today', briefing: parsed, debug: finalDebug };
  }

  const toggleId = await findMorningBriefingToggle(NOTION_TOKEN, diaryPageId);
  if (!toggleId) {
    return { ok: false, todayStr, error: 'morning briefing toggle not found', briefing: parsed, debug: finalDebug };
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

  return { ok: pageResult.ok, todayStr, briefing: parsed, debug: finalDebug, notion: pageResult };
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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 3000,
        thinking: { type: 'disabled' },
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) return { text: '', debug: { stage: 'claude_error', raw: data } };
    const finalText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text: finalText, debug: finalText ? null : { stage: 'no_final_text' } };
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
  const allSections = [
    { official: '오늘 날씨입니다.', body: data.weather },
    { official: '오늘 일정입니다.', body: data.schedule },
    { official: '오늘 뉴스입니다.', news: data.news },
    { official: '어제는 이런 하루를 보냈어요.', body: data.yesterday },
    { official: '오늘은 이렇게 해보는 게 어떨까요?', body: data.suggestion },
  ];
  const sections = allSections.filter((s) =>
    s.news ? Array.isArray(s.news) && s.news.length > 0 : !!String(s.body || '').trim()
  );
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
    try {
      const icsText = await (await fetch(url)).text();
      const calNameMatch = icsText.match(/X-WR-CALNAME:([^\r\n]+)/);
      const calName = calNameMatch ? calNameMatch[1].trim() : '';
      const parsed = parseIcsForDate(icsText, todayStr);
      if (calName) {
        events.push(...parsed.map((e) => {
          const secondPipe = e.indexOf('|', e.indexOf('|') + 1);
          return e.slice(0, secondPipe + 1) + `[${calName}] ` + e.slice(secondPipe + 1);
        }));
      } else {
        events.push(...parsed);
      }
    }
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
