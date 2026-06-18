// ============================================
// 일기 분석 핵심 로직 (재사용 가능한 함수)
// sleepInfo: { sleep_start, sleep_end } 또는 null
// ============================================
export async function runDiaryAnalysis(env, notionHeaders, yesterdayStr, sleepInfo) {
    // ---- 디버그/안정성용: Notion fetch 실패(429 등) 캡처 + 자동 재시도 ----
    const fetchErrors = [];
    async function safeNotionFetch(url, retries = 2) {
      for (let i = 0; i <= retries; i++) {
        const res = await fetch(url, { headers: notionHeaders });
        if (res.ok) return res.json();
        if (res.status === 429 && i < retries) {
          await new Promise(r => setTimeout(r, 400 * (i + 1)));
          continue;
        }
        const body = await res.text().catch(() => '');
        fetchErrors.push({ url, status: res.status, body: body.slice(0, 200) });
        return { results: [] };
      }
      return { results: [] };
    }

    function parseRichText(text) {
      if (!text) return [{ type: 'text', text: { content: '' } }];
      const lines = text.split('\n');
      const parts = [];
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          parts.push({ type: 'text', text: { content: '\n' } });
        }
        const line = lines[i];
        const regex = /\*\*([^*]+)\*\*/g;
        let last = 0, m;
        while ((m = regex.exec(line)) !== null) {
          if (m.index > last) {
            parts.push({ type: 'text', text: { content: line.slice(last, m.index) } });
          }
          parts.push({ type: 'text', text: { content: m[1] }, annotations: { bold: true } });
          last = m.index + m[0].length;
        }
        if (last < line.length) {
          parts.push({ type: 'text', text: { content: line.slice(last) } });
        }
      }
      return parts.length ? parts : [{ type: 'text', text: { content: text } }];
    }

    const targetDate = new Date(yesterdayStr);
    const weekBefore = new Date(targetDate);
    weekBefore.setDate(weekBefore.getDate() - 7);
    const weekBeforeStr = weekBefore.toISOString().split('T')[0];

    const dbRes = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_DB_ID}/query`,
      {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({
          filter: {
            and: [
              { property: '날짜', date: { on_or_after: weekBeforeStr } },
              { property: '날짜', date: { on_or_before: yesterdayStr } }
            ]
          },
          sorts: [{ property: '날짜', direction: 'ascending' }]
        })
      }
    );
    const dbData = await dbRes.json();
    const pages = dbData.results || [];

    let yesterdayPageId = null;
    for (const page of pages) {
      if (page.properties['날짜']?.date?.start === yesterdayStr) {
        yesterdayPageId = page.id;
        break;
      }
    }
    if (!yesterdayPageId) {
      return new Response(JSON.stringify({ error: '페이지 없음', date: yesterdayStr }), { status: 404 });
    }

    function getRichText(blockData) {
      if (!blockData?.rich_text?.length) return '';
      return blockData.rich_text.map(t => t.plain_text || '').join('').trim();
    }

    // rich_text 배열에서 취소선 여부 확인
    function isStrikethrough(blockData) {
      if (!blockData?.rich_text?.length) return false;
      return blockData.rich_text.every(t => t.annotations?.strikethrough === true);
    }

    const SKIP_TYPES = new Set([
      'image', 'file', 'video', 'pdf', 'bookmark', 'embed',
      'divider', 'table_of_contents', 'breadcrumb', 'unsupported',
      'child_page', 'child_database'
    ]);

    function extractBlockText(block, isGoalColumn = false) {
      const type = block.type;
      if (SKIP_TYPES.has(type)) return '';
      const blockData = block[type];
      if (!blockData) return '';
      const text = getRichText(blockData);
      if (['heading_1', 'heading_2', 'heading_3', 'heading_4'].includes(type)) {
        return text ? `[${text}]\n` : '';
      }
      if (type === 'table_row') {
        const cells = blockData.cells || [];
        const row = cells.map(cell => cell.map(t => t.plain_text || '').join('')).join(' | ');
        return row ? row + '\n' : '';
      }
      if (!text) return '';

      // Goal 컬럼: 취소선 여부로 완료/미완료 마킹
      if (isGoalColumn) {
        const done = isStrikethrough(blockData);
        return done ? `[완료] ${text}\n` : `[미완료] ${text}\n`;
      }
      return text + '\n';
    }

    // column_list 처리: Plan/Goal 컬럼 구분
    async function extractColumnList(blockId, depth, fetchCount, maxFetch) {
      if (fetchCount.n >= maxFetch) return '';
      fetchCount.n++;

      const data = await safeNotionFetch(
        `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`
      );
      const columns = data.results || [];

      let planText = '';
      let goalText = '';

      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (col.type !== 'column') continue;
        if (fetchCount.n >= maxFetch) break;
        fetchCount.n++;

        const colData = await safeNotionFetch(
          `https://api.notion.com/v1/blocks/${col.id}/children?page_size=100`
        );
        const colBlocks = colData.results || [];

        // 첫 번째 컬럼 = Plan, 두 번째 = Goal
        const isGoal = i === 1;
        let colText = '';

        for (const block of colBlocks) {
          colText += extractBlockText(block, isGoal);
          if (block.has_children && !SKIP_TYPES.has(block.type) && fetchCount.n < maxFetch) {
            colText += await extractChildText(block.id, depth + 1, fetchCount, maxFetch, isGoal);
          }
        }

        if (isGoal) goalText = colText;
        else planText = colText;
      }

      let result = '';
      if (planText) result += `[Today's Plan]\n${planText}`;
      if (goalText) result += `[Today's Goal - 실제 실행 결과]\n${goalText}`;
      return result;
    }

    // 일반 children 재귀 (isGoal 플래그 전달)
    async function extractChildText(blockId, depth, fetchCount, maxFetch, isGoal = false) {
      if (depth > 5 || fetchCount.n >= maxFetch) return '';
      fetchCount.n++;

      const data = await safeNotionFetch(
        `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`
      );
      let text = '';

      for (const block of data.results || []) {
        text += extractBlockText(block, isGoal);
        if (block.has_children && !SKIP_TYPES.has(block.type) && fetchCount.n < maxFetch) {
          text += await extractChildText(block.id, depth + 1, fetchCount, maxFetch, isGoal);
        }
      }
      return text;
    }

    async function extractText(blockId, depth, fetchCount, maxFetch) {
      if (depth > 5 || fetchCount.n >= maxFetch) return '';
      fetchCount.n++;

      const data = await safeNotionFetch(
        `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`
      );
      let text = '';

      for (const block of data.results || []) {
        const type = block.type;

        // column_list: Plan/Goal 구분 추출
        if (type === 'column_list') {
          if (fetchCount.n < maxFetch) {
            text += await extractColumnList(block.id, depth + 1, fetchCount, maxFetch);
          }
          continue;
        }

        if (type === 'column') {
          if (block.has_children && fetchCount.n < maxFetch) {
            text += await extractChildText(block.id, depth + 1, fetchCount, maxFetch);
          }
          continue;
        }

        text += extractBlockText(block);

        if (block.has_children && !SKIP_TYPES.has(type) && fetchCount.n < maxFetch) {
          text += await extractText(block.id, depth + 1, fetchCount, maxFetch);
        }
      }

      return text;
    }

    // ============================================
    // 핵심 수정: 과거 날짜는 블록을 더 이상 fetch하지 않음 (속성만 읽음)
    // → 타겟(어제) 날짜의 fetch 예산을 과거 날짜가 갉아먹는 문제 해결
    // ============================================
    const globalFetchCount = { n: 1 };

    let pastSummary = '';
    let targetText = '';

    for (const page of pages) {
      const pageDate = page.properties['날짜']?.date?.start || '';
      const isTarget = pageDate === yesterdayStr;

      if (isTarget) {
        targetText += `\n\n[날짜: ${pageDate} (분석 대상)]\n`;
        targetText += await extractText(page.id, 0, globalFetchCount, 30);
      } else {
        // 일기 요약 없으면 기록 없는 날 → 스킵 (블록 fetch 안 함)
        const summary = page.properties['일기 요약']?.rich_text?.map(t => t.plain_text || '').join('').trim() || '';
        if (!summary) continue;

        const energy = page.properties['에너지 레벨']?.select?.name || '';
        const encourage = page.properties['격려']?.rich_text?.map(t => t.plain_text || '').join('').trim() || '';
        const advice = page.properties['제언']?.rich_text?.map(t => t.plain_text || '').join('').trim() || '';

        pastSummary += `\n[${pageDate}]`;
        if (energy) pastSummary += ` 에너지: ${energy}`;
        pastSummary += `\n요약: ${summary}`;
        if (encourage) pastSummary += `\n격려: ${encourage}`;
        if (advice) pastSummary += `\n제언: ${advice}`;
        pastSummary += '\n';
      }
    }

    let allText = (pastSummary ? `[최근 일주일 요약]\n${pastSummary}\n` : '') + targetText;

    const TEXT_CAP = 20000;
    if (allText.length > TEXT_CAP) {
      const markerIdx = allText.indexOf('(분석 대상)');
      if (markerIdx > 0 && allText.length - markerIdx < TEXT_CAP) {
        allText = '...(이전 기록 생략)...\n' + allText.slice(allText.length - TEXT_CAP);
      } else {
        allText = allText.slice(0, TEXT_CAP) + '\n...(이하 생략)...';
      }
    }

    const hasContent = targetText.includes('(분석 대상)') &&
      targetText.split('(분석 대상)')[1]?.trim().length > 10;

    const sleepText = sleepInfo
      ? `취침: ${sleepInfo.sleep_start}, 기상: ${sleepInfo.sleep_end}`
      : '기록 없음';

    const prompt = hasContent
      ? `당신은 민영의 심리상담사입니다. 따뜻하되 과하지 않게, 간결하고 진실되게 말해주세요.

참고 사실: 민영은 불안과 우울로 정신과 치료를 받고 있어요. 분석할 때 이 맥락을 염두에 두되, 병리적 해석보다는 일상의 흐름 안에서 자연스럽게 읽어주세요. 증상을 강조하거나 진단처럼 말하지 말고, 있는 그대로 따뜻하게 봐주세요.

아래는 최근 일기 내용입니다. [분석 대상] 표시된 날짜가 오늘 분석할 일기예요.

${allText}

[분석 대상] 일기를 중심으로 분석해주세요. 이전 기록은 흐름 참고용이에요.

[분석 대상 날짜의 수면 기록 (캘린더 기준)]
${sleepText}

일기 구조 안내:
- 일기는 크게 네 섹션으로 나뉘어요: [Today's Plan], [Today's Goal - 실제 실행 결과], [오늘 생각], [감사 일기]
- [Today's Plan]은 하루 시작 전에 세운 계획이에요.
- [Today's Goal - 실제 실행 결과]는 하루가 끝난 후 실제로 어떻게 됐는지를 기록한 거예요.
  - [완료] 표시: 취소선이 그어진 항목 = 실제로 완료한 것
  - [미완료] 표시: 취소선 없는 항목 = 완료하지 못한 것
  - Goal에 시간 범위(예: 09:00~09:30)가 적혀 있으면 Plan의 예정 시간(예: 09:30)과 비교해서 빠르게 했는지 늦게 했는지 파악할 수 있어요.
- [감사 일기] 섹션에 내용이 있으면 그것을 독립적인 긍정 신호로 읽어주세요.
- 각 섹션의 분위기 차이도 심리 상태의 단서로 봐주세요.

시도&결과 루프 작성 규칙:
- Plan vs Goal을 비교해서 오늘 하루의 실행 패턴을 분석해주세요.
- 완료율(몇 개 중 몇 개 완료)을 간략히 언급하세요.
- 시간 정보가 있으면: 예정보다 빨리 한 항목, 늦게 한 항목을 구분해서 언급하세요.
- "일찍 처리한 일이 있네요", "예정보다 조금 밀렸지만 해냈네요" 같은 따뜻한 관찰 톤으로요.
- Plan/Goal 컬럼 자체가 없거나 비어 있는 날은 이 항목을 빈 문자열로 두세요.

분량과 기록 유무 해석:
- 며칠 만에 썼는지, 일기의 분량이 많고 적음, 아예 기록이 없는 날도 모두 심리 상태의 중요한 단서로 봐주세요.
- 오랜 공백 이후 다시 기록을 시작한 날이라면, 그 사실 자체를 격려에서 한 번 인정해주세요. 매일 꾸준히 쓰고 있는 경우에는 언급하지 않아도 됩니다.

수면 정보 해석:
- 위 [분석 대상 날짜의 수면 기록]을 참고해서 에너지 레벨 판단에 반영하세요. "기록 없음"이면 수면 정보 없이 다른 단서로만 판단하세요.
- 수면 시간이 짧거나(예: 5시간 이하) 기상이 매우 늦은 경우(예: 오전 10시 이후) 에너지 레벨과 감정 상태에 직접 연결해서 해석해주세요.
- 수면 기록과 일기 내용에 적힌 컨디션 묘사가 일치하는지/괴리가 있는지도 가볍게 참고하세요.

혼자 있는 시간 해석:
- 혼자 보낸 시간이 충전이었는지 고립감이었는지를 일기 내용에서 읽어내주세요.
- 둘은 겉으로 비슷해 보여도 심리적으로 완전히 다른 신호예요.

번아웃 선행 지표:
- 운동, 정리, 요리, 산책 같은 자기돌봄 행동이 일기에서 줄어들거나 사라지는 패턴이 보이면 언급해주세요.
- 단정하지 말고, "요즘 자기를 챙기는 행동이 줄어든 것 같아요"처럼 가볍게 짚어주세요.

감정과 행동의 괴리 감지:
- 감정 서술("힘들었다", "지쳤다")과 행동 기술("열심히 했다", "다 처리했다")이 반대 방향을 가리킬 때, 그 괴리 자체를 인지 단서로 읽어주세요.

사라진 주제 감지:
- 최근 일기에서 반복적으로 등장하던 주제나 행동이 어느 순간부터 언급되지 않는다면 가볍게 짚어주세요.
- 단정하거나 해석을 강요하지 말고, 가볍게 물어보는 톤으로요.

이전 일기 참조 규칙:
- 이전 기록은 반복되는 사고 패턴이나 행동이 감지될 때만 언급하세요.
- 날짜를 나열하며 비교하지 마세요. 날짜 나열은 어떤 항목에서도 하지 마세요.

자기비판 패턴 처리:
- 자기비판이 반복되거나 하루가 자기비판으로 시작해서 끝나는 패턴이 보이면, 설교하거나 무겁게 다루지 마세요.
- "오늘도 자신에게 꽤 엄했네요." 정도면 충분해요.

형식 규칙:
- 한 항목에 두 가지 이상의 내용을 쓸 때는 줄바꿈(\n)으로 구분하고 각 줄 앞에 ▪️를 붙여주세요.

제언 작성 규칙:
- **행동**: 신체적 행동 한 가지, **사고**: 생각·인지적인 것 한 가지로 나눠서 작성하세요.
- 형식: "▪️ **행동**: (근거 포함 한 줄)\n▪️ **사고**: (근거 포함 한 줄)"
- 이전에 했던 제언과 같은 내용을 다시 쓸 경우, 반드시 이번 일기에서 그 제언이 다시 필요한 이유를 구체적으로 설명하세요.

인지오류 작성 규칙:
- 최대 2개까지만 작성하세요. 2개일 경우 줄바꿈(\n)으로 구분하고 각 줄 앞에 ▪️를 붙여주세요.
- 없으면 빈 문자열로 두세요.

사고흐름은 감정이나 사건의 흐름을 → 화살표로 연결해서 작성하세요.

모든 항목에서 중요한 단어나 핵심 문장은 **텍스트** 형식으로 강조하세요.

다음 JSON 형식으로만 응답하세요:
{"에너지레벨":"높음/보통/낮음","사고흐름":"A → B → C 형식으로","의미점화단어":"키워드 — 왜 그렇게 읽혔는지 한 줄","자기대화톤":"격려형/명령형/비판형 등 + 한 줄","시도결과루프":"Plan vs Goal 비교 + 완료율 + 시간 빠름/늦음","격려":"","제언":"▪️ **행동**: (근거 포함 한 줄)\n▪️ **사고**: (근거 포함 한 줄)","인지오류":"▪️ 첫 번째\n▪️ 두 번째 또는 빈 문자열","일기요약":""}`
      : `당신은 민영의 심리상담사입니다. 어제 일기에 기록된 내용이 없어요. 최근 기록 흐름을 참고해서 따뜻하고 간결한 격려 한 마디만 써주세요.

${allText}

JSON만 응답 (격려 외 나머지는 빈 문자열): {"에너지레벨":"","사고흐름":"","의미점화단어":"","자기대화톤":"","시도결과루프":"","격려":"","제언":"","인지오류":"","일기요약":""}`;

    async function callClaude() {
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: 'You must respond with pure JSON only. No markdown formatting except **text** for bold emphasis. No backticks. No explanation. Start directly with { and end with }.',
          messages: [{ role: 'user', content: prompt }]
        })
      });
    }

    let claudeRes = await callClaude();
    let claudeData = await claudeRes.json();

    for (let attempt = 0; attempt < 2 && !claudeRes.ok; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      claudeRes = await callClaude();
      claudeData = await claudeRes.json();
    }

    if (!claudeRes.ok) {
      return new Response(
        JSON.stringify({ error: 'Claude API 실패', status: claudeRes.status, detail: claudeData }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let analysisText = claudeData.content?.[0]?.text || '{}';
    const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    analysisText = jsonMatch ? jsonMatch[0] : '{}';

    let analysis = {};
    try {
      analysis = JSON.parse(analysisText);
    } catch(e) {
      return new Response(JSON.stringify({ error: 'JSON 파싱 실패', raw: analysisText }), { status: 500 });
    }

    const props = {
      '사고 흐름': { rich_text: parseRichText(analysis['사고흐름'] || '') },
      '의미 점화 단어': { rich_text: parseRichText(analysis['의미점화단어'] || '') },
      '자기대화 톤': { rich_text: parseRichText(analysis['자기대화톤'] || '') },
      '시도&결과 루프': { rich_text: parseRichText(analysis['시도결과루프'] || '') },
      '인지 오류': { rich_text: parseRichText(analysis['인지오류'] || '') },
      '격려': { rich_text: parseRichText(analysis['격려'] || '') },
      '제언': { rich_text: parseRichText(analysis['제언'] || '') },
      '일기 요약': { rich_text: parseRichText(analysis['일기요약'] || '') },
      '분석 완료': { checkbox: true }
    };

    if (analysis['에너지레벨'] && ['높음', '보통', '낮음'].includes(analysis['에너지레벨'])) {
      props['에너지 레벨'] = { select: { name: analysis['에너지레벨'] } };
    }

    const patchRes = await fetch(`https://api.notion.com/v1/pages/${yesterdayPageId}`, {
      method: 'PATCH',
      headers: notionHeaders,
      body: JSON.stringify({ properties: props })
    });
    const patchData = await patchRes.json();

    if (!patchRes.ok) {
      return new Response(
        JSON.stringify({ error: 'Notion PATCH 실패', status: patchRes.status, detail: patchData }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ---- 디버그용 필드 포함. 정상 작동 확인되면 targetText/fetchErrors는 빼도 됨 ----
    return new Response(
      JSON.stringify({
        success: true,
        date: yesterdayStr,
        hasContent,
        fetchCount: globalFetchCount.n,
        fetchErrors,
        targetText,
        analysis
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
}

// ============================================
// 공통 헬퍼: JSON 문자열 내부 실제 줄바꿈 이스케이프
// ============================================
export function sanitizeJsonText(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

// ============================================
// 공통 헬퍼: 요청 body를 JSON으로 파싱
// ============================================
export async function parseRequestJsonBody(request) {
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

// ============================================
// /create-morning-page 핸들러
// ============================================
export async function handleCreateMorningPage(request, notionHeaders) {
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
  if (!Array.isArray(schedules)) {
    schedules = [];
  }

  if (!title_date || !iso_date) {
    return new Response(
      JSON.stringify({ error: 'title_date, iso_date are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const TODO_DB_ID = '37651f4140c5805e875cdc92a5715d21';

  const todoRes = await fetch(`https://api.notion.com/v1/databases/${TODO_DB_ID}/query`, {
    method: 'POST',
    headers: notionHeaders,
    body: JSON.stringify({
      filter: {
        property: '마감일',
        date: { equals: iso_date }
      },
      sorts: [{ property: '마감일', direction: 'ascending' }]
    })
  });

  const todoData = await todoRes.json();
  const todoPages = todoData.results || [];

  const withTime = [];
  const withoutTime = [];

  for (const page of todoPages) {
    const title = page.properties?.['이름']?.title?.[0]?.plain_text || '';
    const dueStart = page.properties?.['마감일']?.date?.start || '';
    if (dueStart.includes('T')) {
      const time = new Date(dueStart).toLocaleTimeString('ko-KR', {
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Seoul'
      });
      withTime.push({ sortKey: dueStart, text: `${time} ${title}` });
    } else {
      withoutTime.push(title);
    }
  }

  withTime.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const todos = [...withTime.map(t => t.text), ...withoutTime];

  function toTextBlock(items, emptyText) {
    if (!items || items.length === 0) {
      return {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: emptyText }, annotations: { color: 'gray' } }
          ]
        }
      };
    }
    const content = items.map((item) => `▪️ ${item}`).join('\n');
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content } }]
      }
    };
  }

  function buildColumnChildren(headingText, headingColor) {
    return [
      {
        object: 'block',
        type: 'heading_4',
        heading_4: {
          rich_text: [{ type: 'text', text: { content: headingText } }],
          color: headingColor
        }
      },
      toTextBlock(todos, '오늘 할일이 없습니다'),
      { object: 'block', type: 'divider', divider: {} },
      toTextBlock(schedules, '오늘 일정이 없습니다')
    ];
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
        type: 'column_list',
        column_list: {
          children: [
            {
              object: 'block',
              type: 'column',
              column: { children: buildColumnChildren("📋 Today's Plan", 'gray_background') }
            },
            {
              object: 'block',
              type: 'column',
              column: { children: buildColumnChildren("🎯 Today's Goal", 'yellow_background') }
            }
          ]
        }
      },
      { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } },
      {
        object: 'block',
        type: 'heading_4',
        heading_4: { rich_text: [{ text: { content: '◾️ 오늘 생각' } }], color: 'gray_background' }
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: '00:00' }, annotations: { italic: true, color: 'gray' } },
            { type: 'text', text: { content: '\n내용' } }
          ]
        }
      },
      { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } },
      {
        object: 'block',
        type: 'heading_4',
        heading_4: { rich_text: [{ text: { content: '◾️ 감사 일기' } }], color: 'gray_background' }
      },
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [{ type: 'text', text: { content: '감사한 일' }, annotations: { bold: true } }],
          icon: { type: 'emoji', emoji: '🙂' },
          color: 'default',
          children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }]
        }
      },
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [{ type: 'text', text: { content: '칭찬' }, annotations: { bold: true } }],
          icon: { type: 'emoji', emoji: '🤩' },
          color: 'default',
          children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }]
        }
      },
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [{ type: 'text', text: { content: '나를 위해 한 일' }, annotations: { bold: true } }],
          icon: { type: 'emoji', emoji: '😉' },
          color: 'default',
          children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }]
        }
      },
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [{ type: 'text', text: { content: '가장 노력한 일' }, annotations: { bold: true } }],
          icon: { type: 'emoji', emoji: '🤗' },
          color: 'default',
          children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }]
        }
      },
      { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } },
      {
        object: 'block',
        type: 'heading_4',
        heading_4: { rich_text: [{ text: { content: '◾️ 틈틈이 기록' } }], color: 'gray_background' }
      },
      { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }
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

// ============================================
// /save-sleep-and-analyze 핸들러
// ============================================
export async function handleSaveSleepAndAnalyze(request, env, notionHeaders) {
  let payload;
  try {
    payload = await parseRequestJsonBody(request);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json body', detail: String(e) }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { iso_date, sleep_start, sleep_end } = payload;

  if (!iso_date) {
    return new Response(
      JSON.stringify({ error: 'iso_date is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const dbRes = await fetch(
    `https://api.notion.com/v1/databases/${env.NOTION_DB_ID}/query`,
    {
      method: 'POST',
      headers: notionHeaders,
      body: JSON.stringify({
        filter: { property: '날짜', date: { equals: iso_date } }
      })
    }
  );
  const dbData = await dbRes.json();
  const pages = dbData.results || [];

  if (pages.length === 0) {
    return new Response(
      JSON.stringify({ error: '페이지 없음', date: iso_date }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const pageId = pages[0].id;

  const sleepStartText = sleep_start || '기록 없음';
  const sleepEndText = sleep_end || '기록 없음';

  const patchRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders,
    body: JSON.stringify({
      properties: {
        '취침': { rich_text: [{ text: { content: sleepStartText } }] },
        '기상': { rich_text: [{ text: { content: sleepEndText } }] }
      }
    })
  });
  const patchData = await patchRes.json();

  if (!patchRes.ok) {
    return new Response(
      JSON.stringify({ error: '취침/기상 속성 PATCH 실패', detail: patchData }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const sleepInfo = (sleep_start && sleep_end && sleep_start !== '기록 없음' && sleep_end !== '기록 없음')
    ? { sleep_start, sleep_end }
    : null;

  return runDiaryAnalysis(env, notionHeaders, iso_date, sleepInfo);
}
