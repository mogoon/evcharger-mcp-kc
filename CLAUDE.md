# CLAUDE.md

이 파일은 Claude Code가 이 리포에서 작업할 때 참고하는 안내서다.

## Project Overview

한국 전기차 충전 요금을 카드별로 비교해 최저가를 찾아주는 **충전비교** 서비스의 MCP 서버. PlayMCP in KC(카카오클라우드) 배포용으로, stateless Streamable HTTP 모드로 동작해 세션을 발급하지 않는다. MCP TypeScript SDK v2 (2026-07-28 스펙) 기반이며, 신규(2026-07-28)와 구(2025) 클라이언트를 같은 `/mcp` 엔드포인트에서 모두 서빙한다.

## Tech Stack

- **런타임**: Node.js 22 (Alpine), TypeScript 5.7, ESM
- **MCP SDK**: `@modelcontextprotocol/server` v2, `@modelcontextprotocol/node` v2
- **HTTP**: Express 5
- **스키마 검증**: Zod 4
- **데이터**: `@supabase/supabase-js` v2 (Supabase 조회 전용)
- **외부 API**: Kakao REST API (지오코딩·주변 검색)
- **컨테이너**: Dockerfile (multi-stage), 8000 포트

## Development Commands

```bash
# 로컬 개발
npm install
npm run build                 # tsc → dist/
npm start                     # node dist/index.js
npm run dev                   # build + start

# Docker
docker build -t evcharger-mcp-kc .
docker run -p 8000:8000 \
  -e SUPABASE_URL=... -e SUPABASE_ANON_KEY=... -e KAKAO_API_KEY=... \
  evcharger-mcp-kc

# 확인
curl http://localhost:8000/health
curl -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Project Structure

- `index.ts` — 진입점 (루트에 있음, 실제 소스는 `src/`)
- `src/` — MCP 서버 구현 (툴 정의, Supabase/Kakao 클라이언트)
- `Dockerfile` — 저장소 루트, multi-stage 빌드 (build → runtime)
- `tsconfig.json` — TypeScript 설정
- `package.json` — 스크립트: build/start/dev

## Notes for Claude

- **Stateless 모드 유지**: PlayMCP in KC 환경에서 세션 미발급이 필수. 세션 스토리지, 상태 유지 코드 추가 금지.
- **엔드포인트**: `/mcp` POST 가 표준. 루트 `/` POST 도 동일 동작으로 서빙(신규/구 클라이언트 호환).
- **환경변수 로딩**: 콘솔에 환경변수가 설정되어 있지 않으면 컨테이너의 `/app/.env` 를 `process.loadEnvFile` 로 읽는다. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `KAKAO_API_KEY` 필수, `PORT` 기본 8000.
- **툴 7종**: `getProviders`, `getCards`, `getChargerTypes`, `calculatePrices`, `compareMyPrices`, `getCardCoverage`, `searchProvidersByAddress`. 툴 추가/변경 시 `tools/list` 응답 스키마 동기화 필요.
- **KC 배포 값 유지**: `container_port=8000`, Dockerfile 경로는 저장소 루트. 변경 시 KC 콘솔 재등록 필요.
- **MCP SDK v2 스펙**: 2026-07-28 스펙 기반이므로, SDK 다운그레이드 시 stateless 이중 서빙이 깨질 수 있음.
- **evchargers 리포와 동기화 필수**: 이 서버의 툴 스펙(입출력·설명)은 `evchargers` 리포의 Supabase 스키마에 종속. Supabase 테이블/RPC/컬럼 변경 시 여기 툴 정의·Zod 스키마·description을 함께 갱신해야 한다.
