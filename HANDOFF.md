# HANDOFF — 다음 세션에서 이어서 하기 위한 인계 문서

마지막 갱신: 2026-09-25 / 현재 버전: **v0.38.1** (GitHub 태그 푸시 완료) / 작업 폴더: `C:\claude program\joplin-clipper`

## ★ 옵시디언 포크 (2026-09-25~)
- 옵시디언용 포크 **Obsidian Clipper Plus**: 레포 `iamtalker/obsidian-clipper-plus`, 로컬 `C:\claude program\obsidian-clipper-plus`. 사용자 볼트: `C:\MyData\Obsidian Scrapbook`(Local REST API with MCP 플러그인, HTTP 27123).
- 공통 파일(`content.js`, `core.js`, `toolbar.js`, `popup.js`, `lib/`)은 **이 레포에서만 수정** → `bash scripts/sync-to-obsidian.sh`로 복사. 버전은 **바뀐 쪽만** 올림: 공통 파일이 바뀌면 두 레포 모두, 한쪽 전용 파일만 바뀌면 그쪽만(각 README 변경 이력 + 태그 + 푸시). 두 레포 버전 번호는 달라도 됨(사용자 방침, 2026-09-25).
- 자세한 구조는 메모리 `project_obsidian_clipper.md`.

## 0. 먼저 읽을 것
- 프로젝트 메모리(자동 로드): `C:\Users\misti\.claude\projects\C--claude-program-joplin-clipper\memory\` (`project_joplin_clipper.md`, `feedback_versioning_workflow.md`) — 아키텍처, 함정, 삽질 이력이 상세히 있음.
- 사용자용 문서/변경 이력: `README.md`(맨 아래 "변경 이력"이 가장 최신 상태를 알려줌).

## 1. 작업 규칙 (사용자와 합의됨)
1. 코드(`content.js`/`background.js`/`popup.*`/`options.*`) 변경 시마다: `manifest.json` 버전 올림 → `README.md` 변경 이력 맨 위에 한글로 원인+해결 기록 → 커밋 → `git tag vX.Y.Z` → 푸시(커밋+태그). 문서만 바꾸면 버전 안 올려도 됨.
2. **`content.js` 수정 후 필수 체크**(IIFE 재주입 버그 방지): `node -e "global.window=global;global.document={createElement:()=>({})};const s=require('fs').readFileSync('content.js','utf8');eval(s);eval(s);console.log(typeof window.__jcpRunClip)"` → `function` 나와야 함.
3. 사이트 지원 추가 흐름: 실제 페이지를 브라우저 도구로 열어 제목/본문 컨테이너를 찾고(`.parentElement` 체인, 해시 클래스는 피하고 id/시맨틱 태그 우선) `SITE_CONTENT_SELECTORS`(+필요 시 `SITE_CLEANUP_SELECTORS`, CORS 막힌 이미지면 `SCREENSHOT_FALLBACK_HOSTS`)에 등록.
4. 크롬 웹 스토어는 **로컬 개발과 별개**: 로컬은 매 버전 갱신, 스토어는 가끔 묶어서 제출(사용자 방침). 스토어에 올려진 버전은 0.25(승인됨).

## 2. 이번 세션에서 한 것 (v0.30.1 → v0.35.1)
- 다모앙(v0.31.0), 더쿠(v0.32.0) 지원 / 트위터(X) 임베드를 링크로 보존(v0.31.1) / Selection 모드 선택 이미지가 흑백으로 나오던 문제 수정(v0.31.2)
- **웹툰 모드 신설**(v0.33~0.35.1): 팝업의 "📜 Webtoon (all big images)". 게시글의 큰 이미지를 순서대로 전부 저장. 이미지별 경로 ① 페이지 fetch → ② **백그라운드(서비스 워커) fetch로 원본 파일** → ③ CDP 스크린샷(최후 수단). 성공 메시지에 경로 표시.
- 핵심 교훈: 스크린샷 이어붙이기는 이음매 문제가 끝내 남았고, 사용자 제안("그냥 다운받아서 넣자")이 정답이었음. MV3에서 content script의 fetch는 페이지 CORS를 따르지만 **서비스 워커는 host_permissions가 있으면 CORS 무시**.

## 3. ⚠ 알아둘 것 / 미해결
- **권한 문제(스토어)**: 현재 `manifest.json`에 `debugger` 권한과 `host_permissions: <all_urls>`가 있음(웹툰 모드용). 둘 다 스토어 심사에서 민감 권한 → **스토어에 새 버전을 올리려면 정당화 문구를 쓰거나 웹툰 기능 권한을 optional로 돌리는 것을 상의할 것.** 로컬 사용은 무관. (스토어 승인본 0.25에는 둘 다 없음)
- 웹툰 모드는 "큰 이미지"(렌더링 폭≥300, 높이≥150)를 휴리스틱으로 고름. 광고 배너가 섞이는 사이트는 `SITE_CONTENT_SELECTORS`에 본문 영역 지정 필요.
- 더쿠(theqoo) 지원은 구조 분석만으로 적용(테스트 환경에서 이미지 로딩 안 돼 캡처 실검증 못 함) — 사용자 피드백 대기.
- 트위터 임베드는 링크만 남김. 실제 내용 캡처는 사용자가 "귀찮다"며 보류.

## 4. 다음에 할 만한 것 (사용자가 언급했던 것들)
1. ~~**Selection 모드 UX 개선**~~ → **v0.36.0에서 완료**(`toolbar.js` 플로팅 툴바, 팝업의 Selection 버튼이 선택 없을 때 띄움). 후속 후보: 툴바 안에서 노트북/제목 바꾸기. (원래 메모: 지금은 "먼저 선택 → 아이콘 → Selection → Clip" 순서(팝업이 페이지 클릭 시 닫히는 제약 때문). 사용자는 "모드 먼저 → 선택 → 저장" 순서를 원함 → 팝업 대신 **페이지에 삽입되는 플로팅 툴바(저장/취소)** 방식. 최소 버전(기본 노트북, 제목/태그 수정 없이 저장)부터 가볍게 시작하기로 얘기함. 저장은 여전히 background 경유(페이지 CSP 때문에 content script에서 Joplin API 직접 호출 금지).
2. FM코리아 등 다른 사이트 추가(사용자가 사이트를 알려줄 때).
3. 스토어 새 버전 제출 시 권한 정당화(위 3번).

## 5. 실제 크롬으로 확장 테스트하는 방법 (추측 전에 먼저 써볼 것)
- 스크래치 폴더에 `npm i puppeteer-core` + `npx @puppeteer/browsers install chrome@stable`(Chrome for Testing). 일반 Chrome 137+는 `--load-extension`을 무시하지만 Chrome for Testing는 지원.
- 확장 **사본**의 manifest에 `host_permissions:["<all_urls>"]`를 넣고(클릭 없이는 activeTab이 안 생기므로) headed로 실행 → `browser.waitForTarget(t=>t.type()==='service_worker')` → `.worker()` → `evaluate`로 `runClipOnTab(tabId,'webtoon')` 호출(Joplin 저장 없이 결과만 받음). `sw.on('console')`로 `[JCP-WEBTOON]` 로그 확인.
- 긴 이미지 중복/누락 검사: 250px 띠별 평균 밝기 시그니처 비교.

## 6. 지난 삽질에서 얻은 원칙
- 고쳐도 증상이 안 변하면 "튜닝"이 아니라 **전제(메커니즘 모델)를 의심**할 것. 스크롤/GPU 이론 5개가 전부 틀렸고 진짜 원인은 HTML 파싱(`<b>` 안에 `<div>`)이었음.
- 여러 AI가 같은 결론으로 수렴해도 검증된 증거는 아님. 실제 환경에서 재현·측정할 것.
- 우회 경로가 복잡해지면 **첫 단계가 정말 불가능했는지 다른 컨텍스트에서 재확인**할 것(이번엔 서비스 워커 fetch).
