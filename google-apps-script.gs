// ─────────────────────────────────────────────────────────────
// 둘만의 메모장 - 구글 시트 연결 코드 (Google Apps Script)
//
// 사용법: 구글 시트 → 확장프로그램 → Apps Script 에 이 코드를 통째로
// 붙여넣고 '배포 → 새 배포 → 웹 앱'으로 배포하면, 앱에서 메모를
// 읽고 쓸 수 있는 주소(URL)가 나온다. 그 주소를 index.html의
// MEMO_API 에 넣으면 끝.
// ─────────────────────────────────────────────────────────────

const SHEET_NAME = "memos";
const MAX_RETURN = 200; // 화면에 돌려줄 최근 메모 최대 개수

// 메모 목록 읽기 (앱이 GET으로 호출)
function doGet(e) {
  const sheet = getSheet();
  const rows = sheet.getDataRange().getValues(); // [ts, name, text]
  const memos = rows
    .slice(1) // 헤더 제외
    .map((r) => ({ ts: r[0], name: r[1], text: r[2] }))
    .filter((m) => m.text)
    .slice(-MAX_RETURN);
  return json({ ok: true, memos });
}

// 메모 추가 / 삭제 (앱이 POST로 호출)
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = getSheet();

    if (data.action === "delete" && data.ts) {
      // ts(작성시각)로 해당 줄을 찾아 삭제
      const rows = sheet.getDataRange().getValues();
      for (let i = rows.length - 1; i >= 1; i--) {
        if (String(rows[i][0]) === String(data.ts)) {
          sheet.deleteRow(i + 1);
          break;
        }
      }
      return json({ ok: true });
    }

    // 기본: 추가
    const name = (data.name || "익명").toString().slice(0, 20);
    const text = (data.text || "").toString().slice(0, 500);
    if (!text.trim()) throw new Error("빈 메모");
    sheet.appendRow([new Date().toISOString(), name, text]);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["timestamp", "name", "text"]);
  }
  return sheet;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
