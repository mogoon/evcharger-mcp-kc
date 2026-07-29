# 충전비교 MCP 서버

한국 전기차 충전 요금을 카드별로 비교하고 최저가를 찾아주는 **충전비교** 서비스의 MCP 서버입니다.
PlayMCP in KC(카카오클라우드) 배포용 — stateless Streamable HTTP, 세션 미발급.

> MCP TypeScript SDK **v2 (2026-07-28 스펙)** 기반. stateless 모드가 신규(2026-07-28)와
> 구(2025) 클라이언트를 같은 `/mcp` 엔드포인트에서 모두 서빙합니다 (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`).

## 툴 (7개)

- `getProviders` — 충전 사업자 목록
- `getCards` — 할인 카드 목록
- `getChargerTypes` — 충전기 종류 코드
- `calculatePrices` — 사업자·충전기 종류별 전체 카드 요금 비교
- `compareMyPrices` — 보유 카드(cardNames)만으로 요금 비교
- `getCardCoverage` — 카드별 지원 사업자 커버리지 분석
- `searchProvidersByAddress` — 주소/장소명 주변 충전 사업자 검색

## PlayMCP in KC 등록 값

| 항목 | 값 |
|---|---|
| Git URL | `https://github.com/mogoon/evcharger-mcp-kc.git` |
| 브랜치 / ref | `main` |
| Dockerfile 경로 | `Dockerfile` (저장소 루트) |
| PAT | 불필요 (public 저장소) |
| container_port | `8000` |
| MCP Endpoint | 배포 URL의 `/mcp` (POST, 루트 `/` POST도 동일 동작) |

## 환경변수 (필수)

- `SUPABASE_URL` — Supabase 프로젝트 URL
- `SUPABASE_ANON_KEY` — Supabase anon 키 (시크릿 권장)
- `KAKAO_API_KEY` — Kakao REST API 키 (시크릿 권장; 지오코딩·주변 검색용)
- `PORT` — 기본 8000

콘솔에 환경변수 설정이 없다면 컨테이너 `/app/.env` 파일도 읽는다 (`process.loadEnvFile`).

## 로컬 실행

```bash
npm install
npm run build
SUPABASE_URL=... SUPABASE_ANON_KEY=... KAKAO_API_KEY=... npm start
```

## Docker

```bash
docker build -t evcharger-mcp-kc .
docker run -p 8000:8000 -e SUPABASE_URL=... -e SUPABASE_ANON_KEY=... -e KAKAO_API_KEY=... evcharger-mcp-kc
```

## 확인

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
