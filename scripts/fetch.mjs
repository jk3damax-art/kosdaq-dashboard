// 매일 오전 7시(KST)에 실행되어 지표를 조회하고 AI 해석을 생성한 뒤
// public/daily.json 으로 저장한다. (GitHub Actions에서 구동)
//
// 데이터 소스: Yahoo Finance 차트 API (무료, 키 불필요)
// AI 해석:     Claude API (환경변수 ANTHROPIC_API_KEY, 없으면 해석은 건너뜀)

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../public/daily.json");

// 조회할 시장 지표 정의 ------------------------------------------------------
const SYMBOLS = {
  kosdaq: { y: "^KQ11", label: "코스닥", unit: "pt" },
  ust10y: { y: "^TNX", label: "미국 10년물 금리", unit: "%" },
  vix: { y: "^VIX", label: "VIX(공포지수)", unit: "" },
  usdkrw: { y: "KRW=X", label: "원/달러 환율", unit: "원" },
};

// 친구가 보유한 종목 정의 ----------------------------------------------------
// query: 구글 뉴스에서 검색할 키워드 (정확도를 위해 종목명 사용)
const HOLDINGS = [
  { key: "clobot", y: "466100.KQ", label: "클로봇", code: "466100", unit: "원", query: "클로봇" },
  { key: "hlb", y: "028300.KQ", label: "HLB", code: "028300", unit: "원", query: "HLB 주가" },
];

// Yahoo Finance 차트 API 단건 조회 -----------------------------------------
async function fetchYahoo(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=1mo&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (kosdaq-dashboard)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(`no result for ${symbol}`);

  const meta = r.meta;
  const closes = (r.indicators?.quote?.[0]?.close || []).filter(
    (v) => v != null
  );
  const price = meta.regularMarketPrice ?? closes.at(-1);
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? closes.at(-2);
  const changePct =
    price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;

  // 최근 약 1개월 종가 (미니 차트용, 최대 22개)
  const history = closes.slice(-22).map((v) => Number(v.toFixed(3)));

  // 52주 최고/최저 (종목 카드에서 "지금 비싼 구간인지" 표시용)
  const hi52 = meta.fiftyTwoWeekHigh ?? null;
  const lo52 = meta.fiftyTwoWeekLow ?? null;
  const vol = meta.regularMarketVolume ?? null;

  return {
    price: price != null ? Number(price.toFixed(3)) : null,
    prevClose: prevClose != null ? Number(prevClose.toFixed(3)) : null,
    changePct: changePct != null ? Number(changePct.toFixed(2)) : null,
    history,
    hi52: hi52 != null ? Number(hi52.toFixed(2)) : null,
    lo52: lo52 != null ? Number(lo52.toFixed(2)) : null,
    volume: vol,
  };
}

// 구글 뉴스 RSS에서 종목 관련 최신 기사 제목 가져오기 (한국어, 키 불필요) -------
async function fetchNews(query, limit = 5) {
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
    `&hl=ko&gl=KR&ceid=KR:ko`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (kosdaq-dashboard)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    // <item> 블록별로 title/pubDate 추출
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) && items.length < limit) {
      const block = m[1];
      const titleRaw =
        (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) ||
          [])[1] || "";
      const date =
        (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
      // "제목 - 언론사" 형태에서 언론사 분리
      const title = titleRaw.replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
      if (title) items.push({ title, date });
    }
    return items;
  } catch (err) {
    console.error(`[news] '${query}' 실패:`, err.message);
    return [];
  }
}

// 모든 심볼 조회 (실패해도 전체가 죽지 않게 개별 try) ------------------------
async function fetchAll() {
  const out = {};
  for (const [key, def] of Object.entries(SYMBOLS)) {
    try {
      const data = await fetchYahoo(def.y);
      out[key] = { ...def, ...data, ok: true };
    } catch (err) {
      console.error(`[fetch] ${key} 실패:`, err.message);
      out[key] = { ...def, price: null, changePct: null, history: [], ok: false };
    }
  }
  return out;
}

// 금리 속도(최근 5거래일 변화폭, %p) 계산 -----------------------------------
function rateVelocity(hist) {
  if (!hist || hist.length < 6) return null;
  return Number((hist.at(-1) - hist.at(-6)).toFixed(2));
}

// 52주 범위 중 현재가 위치(0~100%). 100%=연중최고, 0%=연중최저 ----------------
function rangePct(price, lo, hi) {
  if (price == null || lo == null || hi == null || hi <= lo) return null;
  return Math.round(((price - lo) / (hi - lo)) * 100);
}

// 보유 종목 시세 + 뉴스 조회 -------------------------------------------------
async function fetchHoldings() {
  const out = [];
  for (const h of HOLDINGS) {
    let quote = { price: null, changePct: null, history: [], hi52: null, lo52: null };
    let ok = false;
    try {
      quote = await fetchYahoo(h.y);
      ok = true;
    } catch (err) {
      console.error(`[holding] ${h.label} 시세 실패:`, err.message);
    }
    const news = await fetchNews(h.query, 5);
    out.push({
      ...h,
      ...quote,
      ok,
      rangePct: rangePct(quote.price, quote.lo52, quote.hi52),
      news,
    });
  }
  return out;
}

// 보유 종목별 '관찰 일지' 한 줄 생성 (Claude) --------------------------------
// 핵심: 미래 예측·매매 권유 절대 금지. 그날의 사실(가격 위치 + 뉴스)만 차분히 요약.
async function aiHoldingNote(holding) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return "AI 코멘트 비활성화 (API 키 미설정). 아래 뉴스 제목을 직접 확인해줘.";
  }
  const headlines = (holding.news || [])
    .map((n, i) => `${i + 1}. ${n.title}`)
    .join("\n") || "(관련 뉴스 없음)";

  const facts =
    `종목: ${holding.label} (${holding.code})\n` +
    `현재가: ${holding.price ?? "확인필요"}원 (전일대비 ${holding.changePct ?? "?"}%)\n` +
    `52주 범위 중 위치: ${holding.rangePct ?? "?"}% (100=연중최고, 0=연중최저)\n` +
    `오늘 뉴스 제목들:\n${headlines}`;

  const system = `너는 한 개인 투자자를 위한 종목 '관찰 일지' 작성자다. 분석가가 아니라 관찰자다.
절대 원칙(어기면 안 됨):
- 미래 예측 금지: "오를 것/내릴 것", "지금이 기회", "목표가" 등 일절 금지.
- 매수/매도 권유 절대 금지.
- 뉴스를 과장 해석 금지. 특히 신약·FDA·임상 관련 뉴스는 기대감만으로 주가가 출렁이므로, "이 뉴스로 오른다"가 아니라 "이런 이슈가 있다(확인 필요)" 식 사실 전달만.
- 모르면 모른다고. 뉴스가 빈약하면 "특별한 뉴스는 안 보임"이라고만.
할 일: 위 사실(가격 위치 + 뉴스 제목)을 바탕으로, 친구에게 담담하게 상황을 알려주는 2~3문장. 끝에 판단은 본인 몫이라는 뉘앙스.
출력: JSON만. {"note":"2~3문장 관찰 코멘트","tags":["핵심 키워드 1~3개"]}`;

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system,
    messages: [{ role: "user", content: `${facts}\n\n위 원칙대로 JSON으로만 답해줘.` }],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const text = json.content?.[0]?.text?.trim() || "{}";
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    return parsed;
  } catch (err) {
    console.error(`[ai] ${holding.label} 코멘트 실패:`, err.message);
    return { note: "AI 코멘트 생성 실패. 아래 뉴스 제목을 직접 확인해줘.", tags: [] };
  }
}

// Claude API로 '경계등 해석' 생성 -------------------------------------------
async function aiInterpret(metrics) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      ok: false,
      reading: "AI 해석 비활성화 (ANTHROPIC_API_KEY 미설정). 지표 수치만 표시합니다.",
      mindset: "데이터는 점쟁이가 아니라 계기판이야. 오늘도 차분하게.",
    };
  }

  const k = metrics.kosdaq;
  const r = metrics.ust10y;
  const v = metrics.vix;
  const fx = metrics.usdkrw;
  const vel = rateVelocity(r.history);

  const facts = [
    `코스닥: ${k.price ?? "확인필요"} (${k.changePct ?? "?"}%)`,
    `미국 10년물 금리: ${r.price ?? "확인필요"}% (최근 5거래일 변화 ${vel ?? "?"}%p)`,
    `VIX: ${v.price ?? "확인필요"}`,
    `원/달러: ${fx.price ?? "확인필요"}원`,
  ].join("\n");

  const system = `너는 코스닥 종목에 투자 중인 한 사람을 위한 '아침 시장 점검' 작성자다.
가장 중요한 철학:
- 목적은 '오늘 시장이 오른다/무너진다'를 예언하는 게 아니다. 지표는 점쟁이가 아니라 운전 계기판의 경고등이다.
- 친구가 불안에 휩쓸려 충동 매매하지 않고 차분히 자기 종목을 보게 돕는 게 목적이다.
해석 원칙:
- 미국 10년물 금리는 '5% 넘으면 폭락'식 단정 금지. 절대 수치보다 '상승 속도'와 '왜 오르는지(경기호조 vs 인플레 우려)'를 더 비중 있게 봐라. 급등 중이면 "성장주·코스닥에 부담되는 환경" 정도의 경계로만 표현.
- VIX는 후행 지표다. 'VIX 높음=지금 사라'식 금지. 20 이하 평온 / 20~30 경계 / 30 이상 시장이 이미 겁먹은 상태(이미 많이 반영됐을 수 있다는 뉘앙스).
- "오늘 무너진다 / 이제 안전하다" 같은 단정 표현 금지.
출력 형식(JSON만, 다른 말 금지):
{"reading":"오늘 계기판 상태를 담담히 묘사한 2~3문장 (예언 아님, 상태 묘사)","mindset":"불안을 부추기지 않고 무리한 매매를 권하지 않는 따뜻한 1문장"}`;

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    system,
    messages: [
      { role: "user", content: `오늘의 지표:\n${facts}\n\n위 원칙대로 JSON으로만 답해줘.` },
    ],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const text = json.content?.[0]?.text?.trim() || "{}";
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    return { ok: true, ...parsed };
  } catch (err) {
    console.error("[ai] 해석 실패:", err.message);
    return {
      ok: false,
      reading: "AI 해석 생성에 실패했어. 아래 수치를 직접 확인해줘.",
      mindset: "데이터는 계기판일 뿐. 오늘도 차분하게.",
    };
  }
}

// 실행 ---------------------------------------------------------------------
async function main() {
  const metrics = await fetchAll();
  const ai = await aiInterpret(metrics);

  // 보유 종목 시세·뉴스 조회 후, 종목별 관찰 코멘트 생성
  const holdings = await fetchHoldings();
  for (const h of holdings) {
    const note = await aiHoldingNote(h);
    h.ai = typeof note === "string" ? { note, tags: [] } : note;
  }

  // KST 기준 날짜/시각 스탬프
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const stamp = kst.toISOString().replace("T", " ").slice(0, 16) + " (KST)";

  const payload = {
    updatedAt: stamp,
    rateVelocity: rateVelocity(metrics.ust10y.history),
    metrics,
    ai,
    holdings,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`[done] ${OUT} 저장 완료 @ ${stamp}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
