# ☕ 아침 시장 점검 (둘만의 대시보드)

매일 오전 7시(KST), 코스닥·미국 10년물 금리·VIX·환율을 자동으로 가져와
"계기판 경고등" 관점의 AI 해석과 함께 보여주는 비공개 웹앱.

> 철학: 지표는 미래를 맞히는 점쟁이가 아니라 운전 계기판입니다.
> "5% 넘으면 폭락" 같은 단정 대신, 금리의 **상승 속도**와 VIX **상태**를 차분히 점검합니다.

---

## 구조

```
매일 07:00 KST → GitHub Actions → scripts/fetch.mjs
   → Yahoo Finance에서 지표 조회 + Claude API로 해석 생성
   → public/daily.json 저장 & 커밋
        ↓
Vercel 정적 배포 → public/index.html 이 daily.json 읽어 대시보드 표시
   (비밀번호 한 겹으로 둘만 접근)
```

비용: GitHub Actions·Vercel 무료 범위 + Claude API 하루 1회(거의 무료).

---

## 배포 방법 (한 번만 세팅)

### 1) GitHub 저장소 만들기
이 폴더(`kosdaq-dashboard`)를 GitHub에 올립니다.

```bash
cd kosdaq-dashboard
git init
git add .
git commit -m "init: 아침 시장 점검 대시보드"
# GitHub에서 빈 저장소(예: kosdaq-dashboard) 생성 후:
git remote add origin https://github.com/<내아이디>/kosdaq-dashboard.git
git branch -M main
git push -u origin main
```

### 2) Claude API 키 등록 (AI 해석용)
GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret**
- 이름: `ANTHROPIC_API_KEY`
- 값: `sk-ant-...` (https://console.anthropic.com 에서 발급)

> 키를 안 넣어도 동작합니다. 그 경우 AI 해석 대신 지표 수치만 표시돼요.

### 3) 자동 갱신 켜기
GitHub 저장소 → **Actions** 탭 → 워크플로우 활성화 →
"매일 아침 시장 점검 갱신" 선택 → **Run workflow**로 한 번 수동 실행해 테스트.
이후 매일 07:00 KST에 자동 실행됩니다.

### 4) Vercel 배포
1. https://vercel.com 에 GitHub로 로그인
2. **Add New → Project → 이 저장소 import**
3. 설정 그대로 **Deploy** (vercel.json이 알아서 `public`을 서빙)
4. 나온 주소(`https://....vercel.app`)를 친구와 공유

---

## 암호 바꾸기
`public/index.html` 안의
```js
const PASSWORD = "kosdaq2026"; // ← 원하는 암호로 변경
```
이 줄을 원하는 값으로 바꾸고 다시 push 하세요.

> ⚠️ 정적 사이트라 이 암호는 "지인 차단용 약한 잠금"입니다.
> 소스를 뜯어보면 보이므로, 진짜 민감한 정보는 올리지 마세요.

---

## 로컬에서 미리 보기
Node.js 설치 후:
```bash
node scripts/fetch.mjs        # daily.json 생성/갱신 (선택)
npx serve public              # http://localhost:3000 에서 확인
```

## 지표 추가/변경
`scripts/fetch.mjs` 상단의 `SYMBOLS` 객체에 Yahoo Finance 심볼을 추가하면 됩니다.
(예: 나스닥 `^IXIC`, S&P500 `^GSPC`, 코스피 `^KS11`)
