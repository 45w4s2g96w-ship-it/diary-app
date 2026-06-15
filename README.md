# diary-analyzer (Vercel)

Cloudflare Worker에서 Vercel(Seoul, icn1)로 이전한 버전입니다.

## 디렉토리 구조

```
api/
  diary-analyzer.js        → /api/diary-analyzer
  create-morning-page.js   → /api/create-morning-page
  save-sleep-and-analyze.js→ /api/save-sleep-and-analyze
lib/
  core.js                  → 공통 로직 (분석, 페이지 생성, 수면 저장)
vercel.json                → 서울 리전(icn1) 고정 설정
```

## 환경변수 (Vercel 프로젝트 Settings → Environment Variables)

다음 4개를 그대로 옮겨서 등록하세요 (Cloudflare Worker에서 쓰던 값과 동일):

- `AUTH_SECRET` — URL의 `?secret=` 파라미터와 비교하는 값
- `NOTION_TOKEN` — Notion Integration 토큰
- `NOTION_DB_ID` — 다이어리 DB ID
- `CLAUDE_API_KEY` — Anthropic API 키

## 배포

1. 이 폴더 전체를 GitHub 저장소에 push
2. Vercel 대시보드 → New Project → 해당 저장소 import
3. Environment Variables에 위 4개 값 입력
4. Deploy

배포 후 엔드포인트 URL:

```
https://<프로젝트명>.vercel.app/api/diary-analyzer?date=2026-06-15&secret=...
https://<프로젝트명>.vercel.app/api/create-morning-page?secret=...
https://<프로젝트명>.vercel.app/api/save-sleep-and-analyze?secret=...
```

## Shortcuts(단축어) 수정

기존 Cloudflare Worker URL:
```
https://diary-analyzer.aa01064822791.workers.dev/...
```

위 Vercel URL로 교체하면 됩니다. 본문 요청(body) 형식, JSON 모드 설정 등은
기존과 동일하게 동작합니다 (multipart/form-data 대응 로직 포함).

## 동작 차이점

- 모든 함수는 Edge Runtime + `icn1`(서울) 리전에 고정되어 실행됩니다.
- 기존 Cloudflare Worker에서 발생했던 홍콩 엣지 라우팅으로 인한
  Anthropic API `403` 에러가 해결될 것으로 예상됩니다.
- 로직(분석 프롬프트, Notion 페이지 생성, 수면 기록 처리)은 100% 동일합니다.
