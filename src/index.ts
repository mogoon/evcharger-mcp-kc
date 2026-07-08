// 충전비교 MCP 서버 — PlayMCP in KC(카카오클라우드) 배포용.
// chatgpt-app/src/index.ts의 stateless /mcp 경로를 Node.js 독립 서버로 포팅한 것.
// 요청마다 McpServer/Transport를 새로 만들고 세션을 발급하지 않는다 (stateless Streamable HTTP).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import express from "express";

// KC 콘솔에 env var UI가 없는 경우를 대비해 컨테이너 내 .env 파일도 지원 (Node 20.12+)
try {
  process.loadEnvFile();
} catch {
  // .env 없으면 무시 — 환경변수로 주입된 값 사용
}

interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  KAKAO_API_KEY: string;
}

const env: Env = {
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
  KAKAO_API_KEY: process.env.KAKAO_API_KEY || "",
};

if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  process.exit(1);
}
if (!env.KAKAO_API_KEY) {
  console.warn("WARN: KAKAO_API_KEY not set — searchProvidersByAddress geocoding fallback will be unavailable");
}

// Geocoding result type
interface GeocodingResult {
  latitude: number;
  longitude: number;
  address: string;
}

// Charger type mapping
const CHARGER_TYPES: Record<string, string> = {
  DC_ULTRA: "DC 초급속 (100kW+)",
  DC_FAST: "DC 급속 (50-99kW)",
  DC_MEDIUM: "DC 중속 (8-49kW)",
  AC_SLOW: "AC 완속 (1-7kW)",
};

// Benefit type mapping
const BENEFIT_TYPES: Record<string, string> = {
  DISCOUNT: "즉시 할인",
  CASHBACK: "캐시백",
  POINTS: "포인트 적립",
};

// Benefit period mapping
const BENEFIT_PERIODS: Record<string, string> = {
  MONTHLY: "월별",
  YEARLY: "연간",
  PER_TRANSACTION: "건당",
};

// Helper function to format benefit conditions
function formatBenefitConditions(discount: {
  benefit_type?: string;
  benefit_rate?: number;
  min_monthly_spend?: number;
  max_benefit_amount?: number;
  max_benefit_period?: string;
  discount_rate?: number;
  roaming_fee?: number;
}): string {
  const parts: string[] = [];

  // 혜택 유형
  const benefitType = discount.benefit_type || "DISCOUNT";
  parts.push(BENEFIT_TYPES[benefitType] || "할인");

  // 전월 실적 조건
  if (discount.min_monthly_spend && discount.min_monthly_spend > 0) {
    const spend = discount.min_monthly_spend / 10000;
    parts.push(`전월 ${spend}만원↑`);
  } else {
    parts.push("조건 없음");
  }

  // 최대 혜택 한도
  if (discount.max_benefit_amount && discount.max_benefit_amount > 0) {
    const amount = discount.max_benefit_amount / 10000;
    const period = discount.max_benefit_period ? BENEFIT_PERIODS[discount.max_benefit_period] || "월별" : "월별";
    parts.push(`${period} 최대 ${amount}만원`);
  }

  return parts.join(" | ");
}

// Helper function to format payment benefit
function formatPaymentBenefit(paymentCard: {
  name: string;
  benefit_type?: string;
  benefit_rate?: number;
  min_monthly_spend?: number;
  max_benefit_amount?: number;
  max_benefit_period?: string;
}): string {
  const parts: string[] = [];

  const benefitType = paymentCard.benefit_type || "DISCOUNT";
  const benefitRate = paymentCard.benefit_rate || 0;

  if (benefitRate > 0) {
    parts.push(`${BENEFIT_TYPES[benefitType] || "혜택"} ${benefitRate}%`);
  }

  if (paymentCard.min_monthly_spend && paymentCard.min_monthly_spend > 0) {
    const spend = paymentCard.min_monthly_spend / 10000;
    parts.push(`전월 ${spend}만원↑`);
  }

  if (paymentCard.max_benefit_amount && paymentCard.max_benefit_amount > 0) {
    const amount = paymentCard.max_benefit_amount / 10000;
    const period = paymentCard.max_benefit_period ? BENEFIT_PERIODS[paymentCard.max_benefit_period] || "월별" : "월별";
    parts.push(`${period} 최대 ${amount}만원`);
  }

  return parts.length > 0 ? parts.join(" | ") : "무조건";
}

// App Store link
const APP_STORE_URL = "https://apps.apple.com/us/app/%EC%B6%A9%EC%A0%84%EB%B9%84%EA%B5%90/id6756303034";

// ---- In-memory TTL cache (process-wide, shared across requests) ----
// Pricing/card data changes rarely (admin updates a few times a day at most),
// so short TTLs cut Supabase round-trips without risking stale prices.
const CACHE_TTL = {
  PROVIDERS: 60 * 60 * 1000,     // 1h  — provider list is nearly static
  DATA: 10 * 60 * 1000,          // 10m — cards, pricing, discounts
  GEOCODE: 24 * 60 * 60 * 1000,  // 24h — addresses don't move
} as const;

const memCache = new Map<string, { value: unknown; expires: number }>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const value = await fn();
  // 실패(null/undefined) 결과는 캐시하지 않아 다음 호출에서 재시도
  if (value !== null && value !== undefined) {
    // 용량 제한 — 임의 입력으로 키가 무한 증식하지 않도록 오래된 항목부터 제거
    if (memCache.size >= 1000) {
      const firstKey = memCache.keys().next().value;
      if (firstKey !== undefined) memCache.delete(firstKey);
    }
    memCache.set(key, { value, expires: Date.now() + ttlMs });
  }
  return value;
}

// 데이터 조회/비즈니스 로직 서비스 계층. 요청마다 새로 생성 (stateless)
class EVChargerService {
  constructor(private env: Env) {}

  // 카드 저장소 — 요청 스코프 (compareMyPrices가 cardNames 매칭 결과를 임시 보관)
  private myChargingCardIds: number[] = [];
  private myPaymentCardIds: number[] = [];

  private hasSavedCards(): boolean {
    return this.myChargingCardIds.length > 0 || this.myPaymentCardIds.length > 0;
  }

  private _supabase?: SupabaseClient;
  private get supabase(): SupabaseClient {
    if (!this._supabase) {
      this._supabase = createClient(this.env.SUPABASE_URL, this.env.SUPABASE_ANON_KEY, {
        auth: {
          autoRefreshToken: false,  // 자동 토큰 갱신 비활성화
          persistSession: false,     // 세션 저장 비활성화
          detectSessionInUrl: false, // URL에서 세션 감지 비활성화
        },
      });
    }
    return this._supabase;
  }

  // ---- Cached Supabase lookups (shared across tools) ----

  private async getAllCards(): Promise<Array<{ id: number; name: string; issuer: string | null; card_category: string | null }> | null> {
    return cached("cards:all", CACHE_TTL.DATA, async () => {
      const { data } = await this.supabase
        .from("cards")
        .select("id, name, issuer, card_category")
        .eq("is_active", true)
        .order("name");
      return data;
    });
  }

  private async findProvider(name: string): Promise<{ id: number; name: string } | null> {
    // LIKE 와일드카드(%,_) 제거 — 사용자 입력이 패턴 전체를 확장하는 것 방지
    const sanitized = name.replace(/[%_]/g, "").trim().slice(0, 100);
    if (!sanitized) return null;
    return cached(`provider:${sanitized.toLowerCase()}`, CACHE_TTL.PROVIDERS, async () => {
      const { data } = await this.supabase
        .from("charging_providers")
        .select("id, name")
        .ilike("name", `%${sanitized}%`)
        .limit(1);
      return data?.[0] ?? null;
    });
  }

  private async getAllProviderNames(): Promise<string[] | null> {
    return cached("providers:names", CACHE_TTL.PROVIDERS, async () => {
      const { data } = await this.supabase.from("charging_providers").select("name");
      return data ? data.map((p: any) => p.name as string) : null;
    });
  }

  private async getPricing(providerId: number, chargerType: string): Promise<any | null> {
    return cached(`pricing:${providerId}:${chargerType}`, CACHE_TTL.DATA, async () => {
      const now = new Date().toISOString();
      const { data } = await this.supabase
        .from("pricing_info")
        .select("price_per_kwh, member_price, non_member_price, effective_from")
        .eq("provider_id", providerId)
        .eq("charger_type", chargerType)
        .lte("effective_from", now)
        .or(`effective_until.is.null,effective_until.gte.${now}`)
        .order("effective_from", { ascending: false })
        .limit(1)
        .single();
      return data;
    });
  }

  // 사업자별 전체 카드 할인 (카드 필터링은 메모리에서 수행)
  private async getProviderDiscounts(providerId: number, chargerType: string): Promise<any[] | null> {
    return cached(`discounts:${providerId}:${chargerType}`, CACHE_TTL.DATA, async () => {
      const now = new Date().toISOString();
      const { data } = await this.supabase
        .from("card_discounts")
        .select("card_id, discount_rate, roaming_fee, benefit_type, benefit_rate, min_monthly_spend, max_benefit_amount, max_benefit_period, cards!inner(id, name, is_active)")
        .eq("provider_id", providerId)
        .eq("charger_type", chargerType)
        .eq("cards.is_active", true)
        .lte("effective_from", now)
        .or(`effective_until.is.null,effective_until.gte.${now}`)
        .order("effective_from", { ascending: false });
      return data;
    });
  }

  // 결제카드 혜택 (사업자 무관, provider_id IS NULL)
  private async getPaymentBenefits(chargerType: string): Promise<any[] | null> {
    return cached(`paybenefits:${chargerType}`, CACHE_TTL.DATA, async () => {
      const now = new Date().toISOString();
      const { data } = await this.supabase
        .from("card_discounts")
        .select("card_id, benefit_type, benefit_rate, min_monthly_spend, max_benefit_amount, max_benefit_period, cards!inner(id, name, is_active)")
        .is("provider_id", null)
        .eq("charger_type", chargerType)
        .eq("cards.is_active", true)
        .lte("effective_from", now)
        .or(`effective_until.is.null,effective_until.gte.${now}`);
      return data;
    });
  }

  // Kakao API를 사용한 주소 → 좌표 변환
  private async geocodeAddress(address: string): Promise<GeocodingResult | null> {
    return cached(`geo:${address}`, CACHE_TTL.GEOCODE, async () => {
      const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `KakaoAK ${this.env.KAKAO_API_KEY}`,
        },
      });

      if (!response.ok) {
        console.error(`Kakao API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as any;

      if (!data.documents || data.documents.length === 0) {
        // 주소 검색 실패시 키워드 검색 시도
        return this.geocodeKeyword(address);
      }

      const doc = data.documents[0];
      return {
        latitude: parseFloat(doc.y),
        longitude: parseFloat(doc.x),
        address: doc.address_name || address,
      };
    });
  }

  // Kakao Places API로 전기차 충전소 검색 (사업자 필터가 있으면 해당 사업자명 포함)
  private async searchChargingStations(
    latitude: number,
    longitude: number,
    radius: number = 2000,
    providerFilter?: string
  ): Promise<Array<{
    name: string;
    address: string;
    distance: number;
    phone?: string;
  }>> {
    const query = providerFilter
      ? `${providerFilter} 전기차충전소`
      : "전기차충전소";
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&x=${longitude}&y=${latitude}&radius=${radius}&sort=distance`;

    const response = await fetch(url, {
      headers: {
        Authorization: `KakaoAK ${this.env.KAKAO_API_KEY}`,
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as any;

    if (!data.documents || data.documents.length === 0) {
      return [];
    }

    return data.documents.map((doc: any) => ({
      name: doc.place_name,
      address: doc.road_address_name || doc.address_name,
      distance: parseInt(doc.distance) || 0,
      phone: doc.phone || undefined,
    }));
  }

  // 키워드로 장소 검색 (주소가 아닌 경우)
  private async geocodeKeyword(keyword: string): Promise<GeocodingResult | null> {
    return cached(`geokw:${keyword}`, CACHE_TTL.GEOCODE, async () => {
      const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(keyword)}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `KakaoAK ${this.env.KAKAO_API_KEY}`,
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;

      if (!data.documents || data.documents.length === 0) {
        return null;
      }

      const doc = data.documents[0];
      return {
        latitude: parseFloat(doc.y),
        longitude: parseFloat(doc.x),
        address: doc.address_name || doc.place_name || keyword,
      };
    });
  }

  // MCP 툴 등록 — stateless 전용: 세션 의존 툴(saveMyCards/getMyCards) 없이
  // compareMyPrices가 카드 이름(cardNames)을 파라미터로 직접 받는다 (PlayMCP 권장: no session)
  registerTools(server: McpServer) {
    // Annotation definitions (ToolAnnotations type)
    // PlayMCP requires all of: title, readOnlyHint, destructiveHint, openWorldHint, idempotentHint
    const readOnlyAnnotations = {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    };

    const externalApiAnnotations = {
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
      idempotentHint: true,
    };

    // Tool: Get providers (read-only, no input)
    server.tool(
      "getProviders",
      "충전비교 서비스에서 한국 내 전기차 충전 사업자(CPO) 목록을 조회합니다. Retrieves the list of EV charging providers in Korea from 충전비교.",
      {},
      { ...readOnlyAnnotations, title: "충전 사업자 조회" },
      async () => {
        const data = await cached("providers:top30", CACHE_TTL.PROVIDERS, async () => {
          const { data } = await this.supabase
            .from("charging_providers")
            .select("id, name")
            .order("name")
            .limit(30);
          return data;
        });

        if (!data) {
          return { content: [{ type: "text" as const, text: "오류: 사업자 목록을 불러올 수 없습니다." }] };
        }

        const text = `충전 사업자 (최대 30개):\n${data.map((p: any) => `- ${p.name}`).join("\n")}`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // Tool: Get cards (read-only, no input)
    server.tool(
      "getCards",
      "충전비교 서비스에서 전기차 충전 할인 혜택이 있는 카드 목록을 발급사 정보와 함께 조회합니다. Retrieves EV charging discount cards from 충전비교.",
      {},
      { ...readOnlyAnnotations, title: "할인 카드 조회" },
      async () => {
        const cards = await this.getAllCards();

        if (!cards) {
          return { content: [{ type: "text" as const, text: "오류: 카드 목록을 불러올 수 없습니다." }] };
        }

        const text = `할인 카드 (최대 30개):\n${cards.slice(0, 30).map((c) => `- ${c.name} (${c.issuer || ""})`).join("\n")}`;
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // Tool: Get charger types (read-only, no input)
    server.tool(
      "getChargerTypes",
      "충전비교 서비스에서 사용하는 충전기 종류 코드를 조회합니다: DC_ULTRA(초급속), DC_FAST(급속), DC_MEDIUM(중속), AC_SLOW(완속) 등. Retrieves charger type codes used by 충전비교.",
      {},
      { ...readOnlyAnnotations, title: "충전기 종류 조회" },
      async () => {
        const text = Object.entries(CHARGER_TYPES)
          .map(([code, label]) => `- ${code}: ${label}`)
          .join("\n");
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // Tool: Calculate prices (read-only, with input)
    server.tool(
      "calculatePrices",
      "충전비교 서비스에서 특정 충전 사업자와 충전기 종류에 대해 모든 할인 카드의 충전 요금을 계산·비교합니다. 회원가, 할인율, 로밍 수수료를 반영해 최저가 카드를 찾아줍니다. Calculates and compares EV charging prices across discount cards using 충전비교.",
      {
        providerName: z.string().max(100).describe("Charging provider name in Korean (e.g. SK에너지, 대영채비, 차지비)"),
        chargerType: z.string().max(30).describe("Charger type code (DC_ULTRA, DC_FAST, DC_MEDIUM, AC_SLOW)"),
        kwh: z.number().min(0.1).max(1000).optional().default(10).describe("Charging amount in kWh (default 10)"),
        limit: z.number().int().min(1).max(50).optional().default(15).describe("Number of cards to show (default 15)"),
      },
      { ...readOnlyAnnotations, title: "충전 요금 비교" },
      async ({ providerName, chargerType, kwh, limit }) => {
        const result = await this.calculatePricesImpl(providerName, chargerType, kwh, limit);
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    // Tool: Compare my prices (stateless — 카드 이름을 파라미터로 직접 받아 비교)
    server.tool(
      "compareMyPrices",
      "충전비교 서비스에서 사용자가 지정한 보유 카드만으로 특정 충전 사업자의 충전 요금을 비교해 최저가 카드를 찾아줍니다. Compares EV charging prices with the user's own cards using 충전비교.",
      {
        providerName: z.string().max(100).describe("Charging provider name in Korean"),
        chargerType: z.string().max(30).describe("Charger type code (DC_ULTRA, DC_FAST, DC_MEDIUM, AC_SLOW)"),
        cardNames: z.string().max(500).describe("Comma-separated card names the user owns (e.g. 현대카드, 카카오모빌리티)"),
        kwh: z.number().min(0.1).max(1000).optional().default(10).describe("Charging amount in kWh (default 10)"),
        limit: z.number().int().min(1).max(50).optional().default(10).describe("Number of combinations to show (default 10)"),
      },
      { ...readOnlyAnnotations, title: "내 카드 요금 비교" },
      async ({ providerName, chargerType, cardNames, kwh, limit }) => {
        // 요청 스코프 인스턴스이므로 카드 매칭 결과를 임시 저장 후 비교
        await this.saveMyCardsImpl(cardNames);
        if (!this.hasSavedCards()) {
          return {
            content: [{
              type: "text" as const,
              text: `'${cardNames}'에 해당하는 카드를 찾을 수 없습니다. getCards로 카드 목록을 확인해주세요.`,
            }],
          };
        }
        const result = await this.compareMyPricesImpl(providerName, chargerType, kwh, limit);
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    // Tool: Get card coverage (read-only)
    server.tool(
      "getCardCoverage",
      "충전비교 서비스에서 각 카드가 지원하는 충전 사업자 수를 분석해, 가장 폭넓게 쓸 수 있는 할인 카드를 찾아줍니다. Analyzes card coverage across EV charging providers using 충전비교.",
      {
        chargerType: z.string().max(30).optional().describe("Charger type code (DC_ULTRA, DC_FAST, DC_MEDIUM, AC_SLOW). Omit for all types"),
        limit: z.number().int().min(1).max(50).optional().default(10).describe("Number of cards to show (default 10)"),
      },
      { ...readOnlyAnnotations, title: "카드 커버리지 분석" },
      async ({ chargerType, limit }) => {
        const result = await this.getCardCoverageImpl(chargerType, limit);
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    // Tool: Search providers by address (read-only, uses external Kakao API)
    server.tool(
      "searchProvidersByAddress",
      "충전비교 서비스에서 주소나 장소명 주변에서 운영 중인 전기차 충전 사업자를 검색합니다. Searches for EV charging providers near a given address using 충전비교.",
      {
        address: z.string().max(200).describe("Address or place name in Korean (e.g. '서울 강남구 역삼동', '코엑스', '부산역')"),
        radiusMeters: z.number().int().min(100).max(20000).optional().default(2000).describe("Search radius in meters, 100-20000 (default 2000)"),
      },
      { ...externalApiAnnotations, title: "지역 사업자 검색" },
      async ({ address, radiusMeters }) => {
        const result = await this.searchProvidersByAddressImpl(address, radiusMeters);
        return { content: [{ type: "text" as const, text: result }] };
      }
    );
  }

  private async calculatePricesImpl(
    providerName: string,
    chargerType: string,
    kwh: number = 10,
    limit: number = 15
  ): Promise<string> {
    const provider = await this.findProvider(providerName);

    if (!provider) {
      return `'${providerName}' 사업자를 찾을 수 없습니다. getProviders()로 사업자 목록을 확인해주세요.`;
    }

    // 요금과 할인 정보는 서로 독립적이므로 병렬 조회
    const [pricing, discounts] = await Promise.all([
      this.getPricing(provider.id, chargerType),
      this.getProviderDiscounts(provider.id, chargerType),
    ]);

    if (!pricing) {
      return `${provider.name}의 ${CHARGER_TYPES[chargerType] || chargerType} 요금 정보가 없습니다.`;
    }

    const memberPrice = pricing.member_price || pricing.price_per_kwh;
    const nonMemberPrice = pricing.non_member_price || pricing.price_per_kwh;
    const basePricePerKwh = memberPrice; // 카드 할인 계산은 회원가 기준
    const effectiveDate = pricing.effective_from;

    if (!discounts || discounts.length === 0) {
      return `${provider.name}에서 ${CHARGER_TYPES[chargerType] || chargerType}에 대한 카드 할인 정보가 없습니다.`;
    }

    const processedCardIds = new Set<number>();
    const cardPrices: any[] = [];

    for (const d of discounts) {
      if (!d.cards || processedCardIds.has(d.card_id)) continue;
      processedCardIds.add(d.card_id);

      const discountRate = d.discount_rate || 0;
      const roamingFee = d.roaming_fee || 0;

      let finalPrice: number;
      let priceType: string;

      if (roamingFee > 0) {
        finalPrice = roamingFee;
        priceType = "로밍";
      } else {
        finalPrice = basePricePerKwh * (1 - discountRate / 100);
        priceType = discountRate > 0 ? `${discountRate}% 할인` : "기본가";
      }

      // 할인 조건 포맷팅
      const conditions = formatBenefitConditions({
        benefit_type: d.benefit_type,
        benefit_rate: d.benefit_rate,
        min_monthly_spend: d.min_monthly_spend,
        max_benefit_amount: d.max_benefit_amount,
        max_benefit_period: d.max_benefit_period,
        discount_rate: d.discount_rate,
        roaming_fee: d.roaming_fee,
      });

      cardPrices.push({
        name: (d.cards as any).name,
        price: Math.round(finalPrice * 100) / 100,
        total: Math.round(finalPrice * kwh * 100) / 100,
        type: priceType,
        conditions,
      });
    }

    cardPrices.sort((a, b) => a.price - b.price);
    const limitedPrices = cardPrices.slice(0, limit);

    // 회원/비회원 가격 차이 표시
    const priceDiff = nonMemberPrice - memberPrice;
    const priceInfo = priceDiff > 0
      ? `회원가: ${memberPrice}원/kWh | 비회원가: ${nonMemberPrice}원/kWh (차이: ${priceDiff}원)`
      : `기본 요금: ${memberPrice}원/kWh`;

    return (
      `${provider.name} ${CHARGER_TYPES[chargerType] || chargerType} 요금 비교 (${kwh}kWh):\n\n` +
      `${priceInfo}\n` +
      `데이터 기준일: ${effectiveDate}\n\n` +
      `카드별 요금 (상위 ${limitedPrices.length}개):\n` +
      limitedPrices.map((c, i) => `${i + 1}. ${c.name}: ${c.price}원/kWh (${c.total}원)\n   └ ${c.conditions}`).join("\n") +
      `\n\n최저가: ${limitedPrices[0].name} (${limitedPrices[0].total}원)`
    );
  }

  private async saveMyCardsImpl(cardNames: string): Promise<string> {
    const names = cardNames.split(",").map((n) => n.trim());

    const cards = await this.getAllCards();

    if (!cards) return "카드 목록을 불러올 수 없습니다.";

    const matchedCharging: any[] = [];
    const matchedPayment: any[] = [];
    const notFound: string[] = [];

    for (const name of names) {
      const found = cards.find(
        (c: any) =>
          c.name.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(c.name.toLowerCase())
      );
      if (found) {
        const category = found.card_category || "CHARGING";
        if (category === "CHARGING" || category === "BOTH") {
          matchedCharging.push(found);
        }
        if (category === "PAYMENT" || category === "BOTH") {
          matchedPayment.push(found);
        }
      } else {
        notFound.push(name);
      }
    }

    // 저장 (요청 스코프)
    this.myChargingCardIds = matchedCharging.map((c) => c.id);
    this.myPaymentCardIds = matchedPayment.map((c) => c.id);

    let result = "";
    if (matchedCharging.length > 0) {
      result += `충전카드 ${matchedCharging.length}개 저장:\n${matchedCharging.map((c) => `- ${c.name}`).join("\n")}`;
    }
    if (matchedPayment.length > 0) {
      if (result) result += "\n\n";
      result += `결제카드 ${matchedPayment.length}개 저장:\n${matchedPayment.map((c) => `- ${c.name}`).join("\n")}`;
    }
    if (matchedCharging.length === 0 && matchedPayment.length === 0) {
      result = "저장된 카드가 없습니다.";
    }
    if (notFound.length > 0) {
      result += `\n\n찾을 수 없음:\n${notFound.map((n) => `- ${n}`).join("\n")}`;
    }

    return result;
  }

  private async compareMyPricesImpl(
    providerName: string,
    chargerType: string,
    kwh: number = 10,
    limit: number = 10
  ): Promise<string> {
    const chargingIds = this.myChargingCardIds;
    const paymentIds = this.myPaymentCardIds;
    const paymentCardOnly = chargingIds.length === 0 && paymentIds.length > 0;

    if (chargingIds.length === 0 && paymentIds.length === 0) {
      return "보유 카드가 지정되지 않았습니다. cardNames 파라미터로 카드 이름을 전달해주세요.";
    }

    const provider = await this.findProvider(providerName);

    if (!provider) {
      return `'${providerName}' 사업자를 찾을 수 없습니다.`;
    }

    const pricing = await this.getPricing(provider.id, chargerType);

    if (!pricing) {
      return `${provider.name}의 ${CHARGER_TYPES[chargerType] || chargerType} 요금 정보가 없습니다.`;
    }

    const memberPrice = pricing.member_price || pricing.price_per_kwh;
    const nonMemberPrice = pricing.non_member_price || pricing.price_per_kwh;
    const basePricePerKwh = memberPrice;
    const effectiveDate = pricing.effective_from;

    // 결제카드만 있는 경우: 비회원가 필요
    if (paymentCardOnly) {
      if (!nonMemberPrice) {
        return `${provider.name}의 ${CHARGER_TYPES[chargerType] || chargerType} 비회원가 정보가 없습니다.\n\n충전카드를 등록하시면 로밍가 비교가 가능합니다.`;
      }

      // 결제카드 혜택 조회 (캐시된 전체 목록에서 내 카드만 필터링)
      const paymentBenefits = ((await this.getPaymentBenefits(chargerType)) || [])
        .filter((pb: any) => paymentIds.includes(pb.card_id));

      if (paymentBenefits.length === 0) {
        return `저장된 결제카드 중 ${CHARGER_TYPES[chargerType] || chargerType} 충전에 적용 가능한 혜택이 없습니다.\n\n비회원가: ${nonMemberPrice}원/kWh (${Math.round(nonMemberPrice * kwh)}원)`;
      }

      // 결제카드별 가격 계산 (비회원가 기준)
      const combinations: any[] = [];
      const processedPaymentIds = new Set<number>();

      for (const pb of paymentBenefits) {
        if (processedPaymentIds.has(pb.card_id)) continue;
        processedPaymentIds.add(pb.card_id);

        const paymentCardName = (pb.cards as any).name;
        const benefitType = pb.benefit_type || "DISCOUNT";
        const benefitRate = pb.benefit_rate || 0;

        let paymentBenefitAmount = 0;
        let pointsAmount: number | null = null;

        if (benefitType === "DISCOUNT" || benefitType === "CASHBACK") {
          paymentBenefitAmount = nonMemberPrice * benefitRate / 100;
        } else if (benefitType === "POINTS") {
          pointsAmount = nonMemberPrice * benefitRate / 100;
        }

        const effectivePrice = nonMemberPrice - paymentBenefitAmount;

        combinations.push({
          name: `비회원 + ${paymentCardName}`,
          roamingPrice: nonMemberPrice,
          paymentBenefit: paymentBenefitAmount,
          effectivePrice,
          pointsAmount,
          conditions: formatPaymentBenefit({
            name: paymentCardName,
            benefit_type: benefitType,
            benefit_rate: benefitRate,
            min_monthly_spend: pb.min_monthly_spend,
            max_benefit_amount: pb.max_benefit_amount,
            max_benefit_period: pb.max_benefit_period,
          }),
          hasPaymentCard: true,
          benefitType,
        });
      }

      // 비회원가만 (혜택 없음) 추가
      combinations.push({
        name: "비회원 (혜택 없음)",
        roamingPrice: nonMemberPrice,
        paymentBenefit: 0,
        effectivePrice: nonMemberPrice,
        conditions: null,
        hasPaymentCard: false,
      });

      combinations.sort((a, b) => a.effectivePrice - b.effectivePrice);
      const limitedCombinations = combinations.slice(0, limit);

      const formatCombination = (c: any, i: number) => {
        let line = `${i + 1}. ${c.name}: ${Math.round(c.effectivePrice * 100) / 100}원/kWh (${Math.round(c.effectivePrice * kwh)}원)`;

        if (c.hasPaymentCard) {
          line += `\n   └ 비회원가 ${Math.round(c.roamingPrice * 10) / 10}원 - ${BENEFIT_TYPES[c.benefitType] || "혜택"} ${Math.round(c.paymentBenefit * 10) / 10}원`;
          if (c.pointsAmount) {
            line += `\n   └ +${Math.round(c.pointsAmount * 10) / 10}원 포인트 적립`;
          }
          line += `\n   └ ${c.conditions}`;
        }

        return line;
      };

      return (
        `${provider.name} ${CHARGER_TYPES[chargerType] || chargerType} - 결제카드 혜택 비교 (${kwh}kWh):\n` +
        `⚠️ 충전카드 없이 비회원가 기준으로 계산합니다.\n` +
        `비회원가: ${nonMemberPrice}원/kWh\n` +
        `데이터 기준일: ${effectiveDate}\n\n` +
        limitedCombinations.map(formatCombination).join("\n\n") +
        `\n\n최저가: ${limitedCombinations[0].name} (${Math.round(limitedCombinations[0].effectivePrice * kwh)}원)`
      );
    }

    // 충전카드가 있는 경우: 기존 로직
    // 1. 충전카드 할인 정보 조회 (캐시된 전체 목록에서 내 카드만 필터링)
    const chargingDiscounts = ((await this.getProviderDiscounts(provider.id, chargerType)) || [])
      .filter((cd: any) => chargingIds.includes(cd.card_id));

    if (chargingDiscounts.length === 0) {
      return `저장된 충전카드 중 ${provider.name}에서 사용 가능한 할인 정보가 없습니다.`;
    }

    // 2. 결제카드 혜택 조회 (provider_id = NULL)
    let paymentBenefits: any[] = [];
    if (paymentIds.length > 0) {
      paymentBenefits = ((await this.getPaymentBenefits(chargerType)) || [])
        .filter((pb: any) => paymentIds.includes(pb.card_id));
    }

    // 3. 조합별 가격 계산
    const combinations: any[] = [];
    const processedChargingIds = new Set<number>();

    for (const cd of chargingDiscounts) {
      if (processedChargingIds.has(cd.card_id)) continue;
      processedChargingIds.add(cd.card_id);

      const discountRate = cd.discount_rate || 0;
      const roamingFee = cd.roaming_fee || 0;
      const chargingCardName = (cd.cards as any).name;

      // 충전카드 로밍/할인가 계산
      const chargingPrice = roamingFee > 0 ? roamingFee : basePricePerKwh * (1 - discountRate / 100);

      // 충전카드만 사용 (결제카드 없음)
      combinations.push({
        name: chargingCardName,
        roamingPrice: chargingPrice,
        paymentBenefit: 0,
        effectivePrice: chargingPrice,
        conditions: null,
        hasPaymentCard: false,
      });

      // 각 결제카드와의 조합
      const processedPaymentIds = new Set<number>();
      for (const pb of paymentBenefits) {
        if (processedPaymentIds.has(pb.card_id)) continue;
        processedPaymentIds.add(pb.card_id);

        const paymentCardName = (pb.cards as any).name;
        const benefitType = pb.benefit_type || "DISCOUNT";
        const benefitRate = pb.benefit_rate || 0;

        let paymentBenefitAmount = 0;
        let pointsAmount: number | null = null;

        // DISCOUNT/CASHBACK은 실질가에 반영
        if (benefitType === "DISCOUNT" || benefitType === "CASHBACK") {
          paymentBenefitAmount = chargingPrice * benefitRate / 100;
        }
        // POINTS는 표시만
        else if (benefitType === "POINTS") {
          pointsAmount = chargingPrice * benefitRate / 100;
        }

        const effectivePrice = chargingPrice - paymentBenefitAmount;

        combinations.push({
          name: `${chargingCardName} + ${paymentCardName}`,
          roamingPrice: chargingPrice,
          paymentBenefit: paymentBenefitAmount,
          effectivePrice,
          pointsAmount,
          conditions: formatPaymentBenefit({
            name: paymentCardName,
            benefit_type: benefitType,
            benefit_rate: benefitRate,
            min_monthly_spend: pb.min_monthly_spend,
            max_benefit_amount: pb.max_benefit_amount,
            max_benefit_period: pb.max_benefit_period,
          }),
          hasPaymentCard: true,
          benefitType,
        });
      }
    }

    // 실질가 기준 정렬
    combinations.sort((a, b) => a.effectivePrice - b.effectivePrice);
    const limitedCombinations = combinations.slice(0, limit);

    // 회원/비회원 가격 차이 표시
    const priceDiff = nonMemberPrice - memberPrice;
    const priceInfo = priceDiff > 0
      ? `회원가: ${memberPrice}원/kWh | 비회원가: ${nonMemberPrice}원/kWh`
      : `기본 요금: ${memberPrice}원/kWh`;

    // 결과 포맷팅
    const formatCombination = (c: any, i: number) => {
      let line = `${i + 1}. ${c.name}: ${Math.round(c.effectivePrice * 100) / 100}원/kWh (${Math.round(c.effectivePrice * kwh)}원)`;

      if (c.hasPaymentCard) {
        line += `\n   └ 로밍가 ${Math.round(c.roamingPrice * 10) / 10}원 - ${BENEFIT_TYPES[c.benefitType] || "혜택"} ${Math.round(c.paymentBenefit * 10) / 10}원`;
        if (c.pointsAmount) {
          line += `\n   └ +${Math.round(c.pointsAmount * 10) / 10}원 포인트 적립`;
        }
        line += `\n   └ ${c.conditions}`;
      } else {
        line += `\n   └ 결제카드 미적용`;
      }

      return line;
    };

    return (
      `${provider.name} ${CHARGER_TYPES[chargerType] || chargerType} - 카드 조합별 요금 비교 (${kwh}kWh, 상위 ${limitedCombinations.length}개):\n` +
      `${priceInfo}\n` +
      `데이터 기준일: ${effectiveDate}\n\n` +
      limitedCombinations.map(formatCombination).join("\n\n") +
      `\n\n최저가: ${limitedCombinations[0].name} (${Math.round(limitedCombinations[0].effectivePrice * kwh)}원)`
    );
  }

  private async getCardCoverageImpl(
    chargerType?: string,
    limit: number = 10
  ): Promise<string> {
    // 전체 card_discounts 테이블을 페이지네이션으로 스캔하는 무거운 작업이라 결과 자체를 캐싱
    const result = await cached(
      `coverage:${chargerType || "all"}:${limit}`,
      CACHE_TTL.DATA,
      () => this.computeCardCoverage(chargerType, limit)
    );
    return result ?? "오류: 커버리지 정보를 불러올 수 없습니다.";
  }

  private async computeCardCoverage(
    chargerType?: string,
    limit: number = 10
  ): Promise<string | null> {
    // Get total provider count
    const { count: totalProviders } = await this.supabase
      .from("charging_providers")
      .select("*", { count: "exact", head: true });

    // Fetch all card discounts with pagination (Supabase default limit is 1000)
    const cardCoverage = new Map<number, { name: string; providers: Set<number> }>();
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      let query = this.supabase
        .from("card_discounts")
        .select("card_id, provider_id, cards!inner(id, name, is_active)")
        .eq("cards.is_active", true)
        .range(offset, offset + pageSize - 1);

      if (chargerType) {
        query = query.eq("charger_type", chargerType);
      }

      const { data: discounts, error } = await query;

      if (error) {
        console.error(`getCardCoverage error: ${error.message}`);
        return null; // 오류는 캐시하지 않고 다음 호출에서 재시도
      }

      if (!discounts || discounts.length === 0) {
        break;
      }

      // Process this batch
      for (const d of discounts) {
        if (!d.cards) continue;

        if (!cardCoverage.has(d.card_id)) {
          cardCoverage.set(d.card_id, {
            name: (d.cards as any).name,
            providers: new Set(),
          });
        }
        cardCoverage.get(d.card_id)!.providers.add(d.provider_id);
      }

      // If we got less than pageSize, we've reached the end
      if (discounts.length < pageSize) {
        break;
      }

      offset += pageSize;
    }

    if (cardCoverage.size === 0) {
      return "할인 정보가 없습니다.";
    }

    // Sort by coverage (descending)
    const sortedCards = Array.from(cardCoverage.entries())
      .map(([id, data]) => ({
        id,
        name: data.name,
        count: data.providers.size,
        percentage: Math.round((data.providers.size / (totalProviders || 1)) * 100),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    const chargerLabel = chargerType ? CHARGER_TYPES[chargerType] || chargerType : "전체 충전기";

    return (
      `카드별 충전 사업자 커버리지 (${chargerLabel}):\n` +
      `전체 사업자 수: ${totalProviders}개\n` +
      `분석 카드 수: ${cardCoverage.size}개\n\n` +
      sortedCards.map((c, i) => `${i + 1}. ${c.name}: ${c.count}개 사업자 (${c.percentage}%)`).join("\n") +
      `\n\n가장 범용적인 카드: ${sortedCards[0].name} (${sortedCards[0].count}개 사업자 지원)`
    );
  }

  private async searchProvidersByAddressImpl(
    address: string,
    radiusMeters: number = 2000
  ): Promise<string> {
    // 1. 주소를 좌표로 변환 (실패시 위치 부분만 추출해서 재시도)
    let location = await this.geocodeAddress(address);
    let filterProvider: string | null = null;

    if (!location) {
      // 사업자명이 포함된 경우 분리 시도 (예: "강남역 이카플러그" → "강남역" + "이카플러그")
      const providerNames = (await this.getAllProviderNames()) || [];

      for (const pName of providerNames) {
        if (address.includes(pName)) {
          filterProvider = pName;
          const locationPart = address.replace(pName, "").trim();
          location = await this.geocodeAddress(locationPart);
          if (location) break;
        }
      }
    }

    if (!location) {
      return `'${address}' 위치를 찾을 수 없습니다. 더 구체적인 주소나 장소명을 입력해주세요.\n\n예시: "강남역", "서울 역삼동", "코엑스"`;
    }

    // 2. DB에서 먼저 검색 (CSV 데이터 활용)
    const dbStations = await this.searchStationsFromDB(
      location.latitude,
      location.longitude,
      radiusMeters,
      filterProvider
    );

    // DB에 데이터가 있으면 DB 결과 사용
    if (dbStations.length > 0) {
      return this.formatDBStationResults(dbStations, location.address, radiusMeters, filterProvider);
    }

    // 3. DB에 데이터가 없으면 Kakao Places API fallback
    let stations = await this.searchChargingStations(
      location.latitude,
      location.longitude,
      radiusMeters,
      filterProvider || undefined
    );

    // 사업자 필터가 있는데 결과가 없으면, 전체 검색 후 필터링
    if (filterProvider && stations.length === 0) {
      const allStations = await this.searchChargingStations(
        location.latitude,
        location.longitude,
        radiusMeters
      );
      stations = allStations.filter(s =>
        s.name.toLowerCase().includes(filterProvider.toLowerCase())
      );
    }

    if (stations.length === 0) {
      const msg = filterProvider
        ? `📍 ${location.address} 근처에서 '${filterProvider}' 충전소를 찾을 수 없습니다.`
        : `📍 ${location.address} 근처에서 충전소를 찾을 수 없습니다.`;
      return msg + `\n\n검색 반경을 늘리거나 다른 위치를 검색해보세요.`;
    }

    // 4. 사업자명 추출 (충전소 이름에서) - 필터가 없을 때만 DB 조회
    let providerNames: string[] = [];
    if (!filterProvider) {
      providerNames = (await this.getAllProviderNames()) || [];
    }

    // 충전소 이름에서 사업자 매칭
    const stationsWithProvider = stations.map(station => {
      const matchedProvider = filterProvider || providerNames.find(pName =>
        station.name.includes(pName) || pName.includes(station.name.split(' ')[0])
      );
      return {
        ...station,
        provider: matchedProvider || null,
      };
    });

    const formatDistance = (m: number) => m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;

    const headerText = filterProvider
      ? `📍 ${location.address} 근처 '${filterProvider}' 충전소 (반경 ${radiusMeters / 1000}km):`
      : `📍 ${location.address} 근처 충전소 (반경 ${radiusMeters / 1000}km):`;

    return (
      `${headerText}\n\n` +
      `발견된 충전소: ${stations.length}개\n\n` +
      stationsWithProvider
        .slice(0, 15)
        .map((s, i) =>
          `${i + 1}. ${s.name}\n` +
          `   📍 ${s.address}\n` +
          `   📏 ${formatDistance(s.distance)}` +
          (s.provider && !filterProvider ? ` | 🏢 ${s.provider}` : "") +
          (s.phone ? ` | 📞 ${s.phone}` : "")
        )
        .join("\n\n") +
      (stations.length > 15 ? `\n\n... 외 ${stations.length - 15}개 충전소` : "") +
      (filterProvider
        ? `\n\n💡 '${filterProvider}' 요금을 확인하려면 calculatePrices("${filterProvider}", "DC_FAST")를 사용해주세요.`
        : `\n\n💡 특정 사업자의 요금을 확인하려면 calculatePrices 도구를 사용해주세요.`)
    );
  }

  // DB에서 충전소 검색 (PostGIS 활용)
  private async searchStationsFromDB(
    latitude: number,
    longitude: number,
    radiusMeters: number,
    filterProvider: string | null
  ): Promise<Array<{
    station_id: number;
    station_name: string;
    address: string;
    sido: string;
    gungu: string;
    distance_meters: number;
    mcp_provider_name: string | null;
    csv_provider_name: string;
    facility_type: string;
    charger_summary: any[];
  }>> {
    try {
      const { data, error } = await this.supabase.rpc("search_nearby_stations", {
        p_latitude: latitude,
        p_longitude: longitude,
        p_radius_meters: radiusMeters,
        p_limit: 30,
      });

      if (error) {
        console.error("DB search error:", error);
        return [];
      }

      if (!data || data.length === 0) {
        return [];
      }

      // 사업자 필터 적용
      let filtered = data;
      if (filterProvider) {
        filtered = data.filter((s: any) =>
          s.mcp_provider_name?.toLowerCase().includes(filterProvider.toLowerCase()) ||
          s.csv_provider_name?.toLowerCase().includes(filterProvider.toLowerCase()) ||
          s.station_name?.toLowerCase().includes(filterProvider.toLowerCase())
        );
      }

      return filtered;
    } catch (error) {
      console.error("DB search exception:", error);
      return [];
    }
  }

  // DB 검색 결과 포맷팅
  private formatDBStationResults(
    stations: Array<{
      station_id: number;
      station_name: string;
      address: string;
      sido: string;
      gungu: string;
      distance_meters: number;
      mcp_provider_name: string | null;
      csv_provider_name: string;
      facility_type: string;
      charger_summary: any[];
    }>,
    searchAddress: string,
    radiusMeters: number,
    filterProvider: string | null
  ): string {
    const formatDistance = (m: number) => m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;

    // 충전기 타입 요약
    const formatChargers = (chargers: any[] | null): string => {
      if (!chargers || chargers.length === 0) return "";

      const types = chargers.reduce((acc: Record<string, number>, c: any) => {
        const key = c.speed || c.speed_category || "기타";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      return Object.entries(types)
        .map(([type, count]) => `${type} ${count}대`)
        .join(", ");
    };

    // MCP 사업자명 또는 CSV 사업자명 사용
    const getProviderName = (s: any) => s.mcp_provider_name || s.csv_provider_name || "미확인";

    // 사업자별 통계
    const providerStats = new Map<string, number>();
    for (const s of stations) {
      const name = getProviderName(s);
      providerStats.set(name, (providerStats.get(name) || 0) + 1);
    }

    const headerText = filterProvider
      ? `📍 ${searchAddress} 근처 '${filterProvider}' 충전소 (반경 ${radiusMeters / 1000}km):`
      : `📍 ${searchAddress} 근처 충전소 (반경 ${radiusMeters / 1000}km):`;

    // 사업자 요약
    const providerSummary = Array.from(providerStats.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}: ${count}개`)
      .join(" | ");

    return (
      `${headerText}\n\n` +
      `발견된 충전소: ${stations.length}개\n` +
      `사업자: ${providerSummary}\n\n` +
      stations
        .slice(0, 15)
        .map((s, i) => {
          const chargerInfo = formatChargers(s.charger_summary);
          const provider = getProviderName(s);

          return (
            `${i + 1}. ${s.station_name}\n` +
            `   📍 ${s.address}\n` +
            `   📏 ${formatDistance(s.distance_meters)} | 🏢 ${provider}` +
            (s.facility_type ? ` | 🏛️ ${s.facility_type}` : "") +
            (chargerInfo ? `\n   ⚡ ${chargerInfo}` : "")
          );
        })
        .join("\n\n") +
      (stations.length > 15 ? `\n\n... 외 ${stations.length - 15}개 충전소` : "") +
      (filterProvider
        ? `\n\n💡 '${filterProvider}' 요금을 확인하려면 calculatePrices("${filterProvider}", "DC_FAST")를 사용해주세요.`
        : `\n\n💡 특정 사업자의 요금을 확인하려면 calculatePrices 도구를 사용해주세요.`)
    );
  }
}

// ---- HTTP 서버 (Express) ----

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS — 브라우저 기반 MCP 클라이언트(PlayMCP 콘솔 등) 대응
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204).end();
    return;
  }
  next();
});

// Stateless Streamable HTTP 핸들러 — 요청마다 서버/트랜스포트를 새로 만들고 세션 미발급
async function handleStatelessMcp(req: express.Request, res: express.Response) {
  // 스펙상 클라이언트는 Accept에 application/json과 text/event-stream을 모두
  // 보내야 하지만, 그렇지 않은 클라이언트도 관대하게 수용 (406 방지).
  // SDK의 Node 트랜스포트는 @hono/node-server로 웹 Request를 만들 때
  // req.headers가 아닌 req.rawHeaders를 읽으므로 둘 다 고쳐야 한다.
  const lenientAccept = "application/json, text/event-stream";
  const accept = req.headers.accept || "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    req.headers.accept = lenientAccept;
    let patched = false;
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === "accept") {
        req.rawHeaders[i + 1] = lenientAccept;
        patched = true;
      }
    }
    if (!patched) req.rawHeaders.push("Accept", lenientAccept);
  }

  try {
    const server = new McpServer({
      name: "충전비교",
      version: "1.0.0",
    });
    new EVChargerService(env).registerTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: 세션 미발급, Mcp-Session-Id 불필요
      enableJsonResponse: true,      // SSE 스트림 대신 단순 JSON 응답
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

// KC 콘솔의 엔드포인트 경로 설정과 무관하게 동작하도록 /mcp와 루트 모두에서 수신
app.post("/mcp", handleStatelessMcp);
app.post("/", handleStatelessMcp);

// Stateless 모드에서는 GET(SSE 스트림)/DELETE(세션 종료)를 지원하지 않음
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: "chungjeon-bigyo-mcp", version: "1.0.0" });
});

// Root - app info
app.get("/", (_req, res) => {
  res.json({
    app: {
      name: "충전비교",
      name_en: "EV Charger Price Compare",
      tagline: "전기차 충전 요금, 어떤 카드가 가장 저렴할까?",
      description: "한국 전기차 충전 요금을 카드별로 비교하고 최저가를 찾아주는 충전비교 서비스입니다. 30개 이상의 충전 사업자와 125개 이상의 할인 카드 정보를 제공합니다.",
      version: "1.0.0",
      author: "충전비교",
      ios_app: APP_STORE_URL,
    },
    mcp: {
      transport: "streamable-http",
      endpoint: "/mcp",
    },
    tools: [
      "getProviders - 충전 사업자 목록",
      "getCards - 할인 카드 목록",
      "getChargerTypes - 충전기 종류",
      "calculatePrices - 요금 비교",
      "compareMyPrices - 내 카드 요금 비교",
      "getCardCoverage - 카드별 사업자 커버리지 분석",
      "searchProvidersByAddress - 주소/장소명으로 근처 충전 사업자 검색",
    ],
  });
});

// KC(PlayMCP in KC) 콘솔의 container_port 기본값이 8000이라 이에 맞춘다
const port = Number(process.env.PORT) || 8000;
app.listen(port, () => {
  console.log(`충전비교 MCP server (stateless Streamable HTTP) listening on :${port}`);
});
