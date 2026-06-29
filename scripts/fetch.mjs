// 매일 오전 7시(KST)에 실행되어 지표를 조회하고 AI 해석을 생성한 뒤
// public/daily.json 으로 저장한다. (GitHub Actions에서 구동)
//
// 데이터 소스: Yahoo Finance 차트 API + 구글 뉴스 RSS (무료, 키 불필요)
// AI 해석:     Google Gemini API (환경변수 GEMINI_API_KEY, 무료 등급, 없으면 해석 건너뜀)

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../public/daily.json");

// Gemini 호출 공용 함수 -------------------------------------------------------
// system + user 프롬프트를 받아 JSON 객체를 돌려준다. 실패 시 null.
const GEMINI_MODEL = "gemini-flash-latest"; // 무료 등급에서 쓸 수 있는 빠른 모델(최신)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(systemText, userText) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` +
    `?key=${key}`;
  const body = {
    // system 지시 + 사용자 입력을 합쳐 전달, JSON으로만 답하도록 강제
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
  };

  // 일시적 오류는 재시도로 넘긴다:
  //   429 = 무료 등급 사용량 초과, 503 = 서버 과부하(high demand), 500 = 일시 서버 오류
  // 이런 코드는 잠깐 기다렸다 다시 부르면 대개 성공한다. 최대 4번까지 점점 길게 대기.
  const RETRYABLE = new Set([429, 500, 503]);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(attempt * 15000); // 0s → 15s → 30s → 45s 대기
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      const text =
        json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "{}";
      return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    }
    lastErr = `Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    if (!RETRYABLE.has(res.status)) break; // 재시도해도 소용없는 오류면 즉시 중단
  }
  throw new Error(lastErr);
}

// 조회할 시장 지표 정의 ------------------------------------------------------
const SYMBOLS = {
  kospi: { y: "^KS11", label: "코스피", unit: "pt" },
  kosdaq: { y: "^KQ11", label: "코스닥", unit: "pt" },
  ust10y: { y: "^TNX", label: "미국 10년물 금리", unit: "%" },
  vix: { y: "^VIX", label: "VIX(공포지수)", unit: "" },
  usdkrw: { y: "KRW=X", label: "원/달러 환율", unit: "원" },
  dow: { y: "^DJI", label: "다우", unit: "pt" },
  nasdaq: { y: "^IXIC", label: "나스닥", unit: "pt" },
  oil: { y: "CL=F", label: "국제유가(WTI)", unit: "$" },
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
  // '전일 대비'는 바로 직전 거래일 종가로 계산해야 한다.
  // (range=1mo의 chartPreviousClose는 한 달 전 값이라 등락률이 왜곡됨)
  const prevClose = closes.length >= 2 ? closes.at(-2) : meta.chartPreviousClose ?? null;
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

// 코스피/코스닥 투자자별 수급(외국인·기관·개인) 조회 -------------------------
// 네이버 모바일 API 사용(키 불필요). 단위는 백만원, "+12,345" 같은 문자열로 옴.
// 해외 IP(GitHub Actions)에서 막힐 수 있으므로 실패해도 null 반환(전체는 안 죽음).
async function fetchFlow(market) {
  // market: "KOSPI" | "KOSDAQ"
  const url = `https://m.stock.naver.com/api/index/${market}/trend`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Referer: "https://m.stock.naver.com/",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    // "+45,975" / "-77,332" → 숫자(백만원)로 변환
    const num = (s) =>
      s == null ? null : Number(String(s).replace(/[+,\s]/g, "")) || 0;
    return {
      ok: true,
      bizdate: j.bizdate ?? null,
      foreign: num(j.foreignValue), // 외국인 순매수(백만원)
      institution: num(j.institutionalValue), // 기관 순매수
      individual: num(j.personalValue), // 개인 순매수
    };
  } catch (err) {
    console.error(`[flow] ${market} 수급 실패:`, err.message);
    return { ok: false, foreign: null, institution: null, individual: null };
  }
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
  if (!process.env.GEMINI_API_KEY) {
    return "AI 코멘트 비활성화 (GEMINI_API_KEY 미설정). 아래 뉴스 제목을 직접 확인해줘.";
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

  try {
    const parsed = await callGemini(
      system,
      `${facts}\n\n위 원칙대로 JSON으로만 답해줘.`
    );
    return parsed || { note: "AI 코멘트 생성 실패. 아래 뉴스 제목을 직접 확인해줘.", tags: [] };
  } catch (err) {
    console.error(`[ai] ${holding.label} 코멘트 실패:`, err.message);
    return {
      note: "AI 코멘트 생성 실패. 아래 뉴스 제목을 직접 확인해줘.",
      tags: [],
      debugError: String(err.message).slice(0, 300), // 진단용 (원인 파악되면 제거)
    };
  }
}

// Gemini로 '경계등 해석' 생성 ------------------------------------------------
async function aiInterpret(metrics, flow) {
  if (!process.env.GEMINI_API_KEY) {
    return {
      ok: false,
      reading: "AI 해석 비활성화 (GEMINI_API_KEY 미설정). 지표 수치만 표시합니다.",
      mindset: "데이터는 점쟁이가 아니라 계기판이야. 오늘도 차분하게.",
    };
  }

  const k = metrics.kosdaq;
  const r = metrics.ust10y;
  const v = metrics.vix;
  const fx = metrics.usdkrw;
  const vel = rateVelocity(r.history);

  // 수급 한 줄 요약(백만원 → 억원으로 환산해 읽기 쉽게)
  const flowLine = (f, name) => {
    if (!f || !f.ok) return `${name} 수급: 확인필요`;
    const eok = (v) => (v == null ? "?" : (v / 100).toFixed(0)); // 백만원→억원
    return `${name} 수급(억원): 외국인 ${eok(f.foreign)}, 기관 ${eok(f.institution)}, 개인 ${eok(f.individual)}`;
  };

  const facts = [
    `코스피: ${metrics.kospi?.price ?? "확인필요"} (${metrics.kospi?.changePct ?? "?"}%)`,
    `코스닥: ${k.price ?? "확인필요"} (${k.changePct ?? "?"}%)`,
    flowLine(flow?.kospi, "코스피"),
    flowLine(flow?.kosdaq, "코스닥"),
    `미국 10년물 금리: ${r.price ?? "확인필요"}% (최근 5거래일 변화 ${vel ?? "?"}%p)`,
    `VIX: ${v.price ?? "확인필요"}`,
    `다우: ${metrics.dow?.price ?? "확인필요"} (${metrics.dow?.changePct ?? "?"}%), 나스닥: ${metrics.nasdaq?.price ?? "확인필요"} (${metrics.nasdaq?.changePct ?? "?"}%)`,
    `국제유가(WTI): ${metrics.oil?.price ?? "확인필요"}달러`,
    `원/달러: ${fx.price ?? "확인필요"}원`,
  ].join("\n");

  const system = `너는 코스닥 종목에 투자 중인 한 사람을 위한 '아침 시장 점검' 작성자다.
가장 중요한 철학:
- 목적은 '오늘 시장이 오른다/무너진다'를 예언하는 게 아니다. 지표는 점쟁이가 아니라 운전 계기판의 경고등이다.
- 친구가 불안에 휩쓸려 충동 매매하지 않고 차분히 자기 종목을 보게 돕는 게 목적이다.
해석 원칙:
- 미국 10년물 금리는 '5% 넘으면 폭락'식 단정 금지. 절대 수치보다 '상승 속도'와 '왜 오르는지(경기호조 vs 인플레 우려)'를 더 비중 있게 봐라. 급등 중이면 "성장주·코스닥에 부담되는 환경" 정도의 경계로만 표현.
- VIX는 후행 지표다. 'VIX 높음=지금 사라'식 금지. 20 이하 평온 / 20~30 경계 / 30 이상 시장이 이미 겁먹은 상태(이미 많이 반영됐을 수 있다는 뉘앙스).
- 수급(외국인·기관·개인 순매수)은 '오늘 누가 샀나/팔았나'라는 사실일 뿐. 외국인이 팔았다고 "내일 빠진다"는 식의 예측 금지. 특히 코스닥은 외국인·기관 수급 방향만 담담히 언급.
- 다우·나스닥은 '간밤 미국 시장 분위기'로만. 나스닥이 빠졌으면 "성장주 분위기가 약했다" 정도. 유가는 급등 시 인플레·항공/정유 영향 정도로만, 단정 금지.
- "오늘 무너진다 / 이제 안전하다" 같은 단정 표현 금지.
출력 형식(JSON만, 다른 말 금지):
{"reading":"오늘 계기판 상태를 담담히 묘사한 2~3문장 (예언 아님, 상태 묘사)","mindset":"불안을 부추기지 않고 무리한 매매를 권하지 않는 따뜻한 1문장"}`;

  try {
    const parsed = await callGemini(
      system,
      `오늘의 지표:\n${facts}\n\n위 원칙대로 JSON으로만 답해줘.`
    );
    return { ok: true, ...parsed };
  } catch (err) {
    console.error("[ai] 해석 실패:", err.message);
    return {
      ok: false,
      reading: "AI 해석 생성에 실패했어. 아래 수치를 직접 확인해줘.",
      mindset: "데이터는 계기판일 뿐. 오늘도 차분하게.",
      debugError: String(err.message).slice(0, 300), // 진단용 (원인 파악되면 제거)
    };
  }
}

// 실행 ---------------------------------------------------------------------
async function main() {
  const metrics = await fetchAll();

  // 코스피·코스닥 투자자별 수급(외국인·기관·개인)
  const flow = {
    kospi: await fetchFlow("KOSPI"),
    kosdaq: await fetchFlow("KOSDAQ"),
  };

  const ai = await aiInterpret(metrics, flow);

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
    flow,
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
