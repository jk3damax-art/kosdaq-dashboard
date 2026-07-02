// 매일 오전 7시(KST)에 실행되어 지표를 조회하고 AI 해석을 생성한 뒤
// public/daily.json 으로 저장한다. (GitHub Actions에서 구동)
//
// 데이터 소스: Yahoo Finance 차트 API + 구글 뉴스 RSS (무료, 키 불필요)
// AI 해석:     AWS Bedrock의 Claude (환경변수 AWS_BEARER_TOKEN_BEDROCK, 없으면 해석 건너뜀)

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../public/daily.json");

// Bedrock Claude 호출 공용 함수 ----------------------------------------------
// system + user 프롬프트를 받아 JSON 객체를 돌려준다. 실패 시 null.
//
// 인증: AWS_BEARER_TOKEN_BEDROCK (Bedrock API 키 토큰) — Bearer 헤더로 전달.
// 리전/모델은 환경변수로 바꿀 수 있게 둔다(기본: 서울 + Haiku 4.5 인퍼런스 프로파일).
const AWS_REGION = process.env.AWS_REGION || "ap-northeast-2";
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ||
  "global.anthropic.claude-sonnet-5";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// system + user 프롬프트로 Claude를 호출하고, 응답 텍스트에서 JSON 객체를 파싱해 돌려준다.
// 일시적 오류(429/500/503/529)는 잠깐 쉬었다 재시도.
async function callClaude(systemText, userText) {
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) return null;

  const endpoint =
    `https://bedrock-runtime.${AWS_REGION}.amazonaws.com/model/` +
    `${encodeURIComponent(BEDROCK_MODEL_ID)}/invoke`;
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 2500,
    system: systemText,
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
  };

  const RETRYABLE = new Set([429, 500, 503, 529]);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt * 8000); // 0s → 8s → 16s
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      const text = (json.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const parsed = parseLooseJson(text);
      if (parsed) return parsed;
      // 이번 응답이 JSON으로 안 풀리면(모델이 따옴표/개행을 흘린 경우) 재시도.
      lastErr = "응답 JSON 파싱 실패";
      continue;
    }
    lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`;
    if (!RETRYABLE.has(res.status)) break; // 재시도해도 소용없는 오류면 포기
  }
  throw new Error(`[bedrock:${BEDROCK_MODEL_ID}] ${lastErr}`);
}

// 모델 응답에서 JSON 객체를 최대한 견고하게 뽑아낸다. 실패하면 null.
// 1) 코드블록/여분 텍스트 제거 후 정식 JSON.parse 시도
// 2) 그래도 안 되면(문자열 안에 이스케이프 안 된 따옴표·개행이 섞인 경우)
//    필드별로 값만 관대하게 긁어온다.
function parseLooseJson(text) {
  if (!text) return null;
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  const body = s !== -1 && e > s ? text.slice(s, e + 1) : text;
  try {
    return JSON.parse(body);
  } catch {
    // 관대한 폴백: "키": "값" 패턴에서 값을 뽑되, 다음 키(," 또는 })까지를 값으로 본다.
    const out = {};
    // 문자열 필드
    for (const key of ["note", "reading", "mindset"]) {
      const m = body.match(
        new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"|}\\s*$|}\\s*[^"]*$)`)
      );
      if (m) out[key] = m[1].replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
    }
    // tags 배열
    const t = body.match(/"tags"\s*:\s*\[([\s\S]*?)\]/);
    if (t) {
      out.tags = (t[1].match(/"([^"]*)"/g) || []).map((x) => x.replace(/"/g, ""));
    }
    return Object.keys(out).length ? out : null;
  }
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
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    return "AI 코멘트 비활성화 (AWS_BEARER_TOKEN_BEDROCK 미설정). 아래 뉴스 제목을 직접 확인해줘.";
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
할 일: 위 사실(가격 위치 + 뉴스 제목)을 바탕으로, 친구에게 담담하게 상황을 알려주는 관찰 코멘트를 쓴다.
- 4~6문장으로 충분히 풀어서. 오늘 가격 움직임 → 52주 위치 맥락 → 뉴스에서 읽히는 이슈 → 지켜볼 포인트 순서로 자연스럽게.
- 각 뉴스를 나열만 하지 말고, 어떤 성격의 이슈인지(호재성 기대감인지·불확실성인지·단순 사실인지) 담담히 짚어준다.
- 끝 문장은 판단은 본인 몫이라는 차분한 뉘앙스로.
출력: JSON만. {"note":"4~6문장 관찰 코멘트","tags":["핵심 키워드 1~3개"]}`;

  try {
    const parsed = await callClaude(
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

// Claude로 '경계등 해석' 생성 ------------------------------------------------
async function aiInterpret(metrics, flow) {
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    return {
      ok: false,
      reading: "AI 해석 비활성화 (AWS_BEARER_TOKEN_BEDROCK 미설정). 지표 수치만 표시합니다.",
      mindset: "데이터는 점쟁이가 아니라 계기판이야. 오늘도 차분하게.",
    };
  }

  const k = metrics.kosdaq;
  const r = metrics.ust10y;
  const v = metrics.vix;
  const fx = metrics.usdkrw;
  const vel = rateVelocity(r.history);

  // 수급 한 줄 요약(네이버 값 단위 = 억원, 그대로 사용)
  const flowLine = (f, name) => {
    if (!f || !f.ok) return `${name} 수급: 확인필요`;
    const eok = (v) => (v == null ? "?" : v); // 억원
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
분량과 구성:
- reading은 4~6문장으로 충분히 풀어서. 코스피/코스닥 움직임과 수급 → 미국 시장 분위기(다우·나스닥) → 금리의 방향과 속도 → VIX·환율·유가 순으로 각 지표를 서로 연결지어 하나의 흐름으로 설명한다.
- 숫자를 그냥 나열하지 말고 "왜 그런 상태인지, 성장주/코스닥에 어떤 환경인지"를 담담히 해석한다(단정·예언은 여전히 금지).
출력 형식(JSON만, 다른 말 금지):
{"reading":"오늘 계기판 상태를 담담히 묘사한 4~6문장 (예언 아님, 상태 묘사)","mindset":"불안을 부추기지 않고 무리한 매매를 권하지 않는 따뜻한 1~2문장"}`;

  try {
    const parsed = await callClaude(
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
