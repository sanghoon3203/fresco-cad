# Jw Assistant 일본 건축·Jw_cad 지식 베이스 (Knowledge Base)

AI CAD 편집 어시스턴트가 자연어(일본어/한국어) 요청으로 Jw_cad(JWW) 도면을 편집할 때 컨텍스트로 로드하는 지식 베이스의 개요 문서. 대상은 **일본**(일본 주택·소규모 건축 실무, 建築基準法, Jw_cad 관행)이다.

- 작성/확인 기준일: **2026-10-01**
- 위치: `addons/jw-assistant/knowledge/`
- 본문 언어: 일본어(각 파일 상단에 한국어 한 줄 요약)

## 1. 구성

```
addons/jw-assistant/knowledge/
  catalog.json          # 기계 판독용 색인 [{id,file,title,topics[],appliesTo[],sources[]}]
  drafting-rules.json   # 기계 판독용 규칙 (122건) + sourceRegistry
  ja/
    jwcad-basics.md           # Jw_cad 기본: 레이어그룹16×16, 축척, 선색/선종/문자종, 점·치수·블록, 기준점, 실치수/도면치수
    layer-conventions.md      # 레이어/그룹 할당 전형 패턴과 편차 (공개 사례 요약)
    drafting-symbols.md       # JIS 제도, JIS A 0150 평면표시기호, 건구기호, 도면 종류, 실명 표기
    modules-dimensions.md     # 910/455/1000 모듈, 다다미·帖, 벽 두께, 문·창·샷시 호칭, 계단
    building-standards-law.md # 건축기준법 요점(채광·환기·천장고·계단·복도·방화피난·건폐율/용적률·사선·접도·천공률)
    rooms-planning.md         # 실 종류별 크기·배치 관계, 용도지역 개요
    glossary-ja-ko.md         # 일-한 건축·제도 용어 대역 (한국어 지시 → 일본 도면 용어)
```

`catalog.json`의 `appliesTo`:

| 값 | 의미 | 주로 로드할 파일 |
|---|---|---|
| `edit` | 편집 제안·실행 | jwcad-basics, modules-dimensions, rooms-planning, glossary-ja-ko, drafting-rules |
| `review` | 도면 검토 | building-standards-law, drafting-symbols, modules-dimensions, rooms-planning |
| `layer-check` | 레이어/선 속성 점검 | layer-conventions, jwcad-basics, drafting-rules(layer/linestyle) |
| `drawing-reading` | 도면 해석 | drafting-symbols, glossary-ja-ko, jwcad-basics, rooms-planning |

## 2. AI가 사용하는 방법

1. **입력 정규화**: 한국어 지시는 `glossary-ja-ko.md`로 일본어 용어로 변환(예: "거실 창문을 넓혀줘" → 居間(L/LDK)の窓(サッシ)の開口を広げる). 도면 내 문자는 일본어이므로 실명 검색은 일본어로 한다. 「거실」(리빙)과 「居室」(법적 거주실)은 다른 개념이다.
2. **도면이 우선**: 대상 JWW의 레이어명·축척·선색/선폭 설정·문자종 설정을 먼저 읽고 **사무소의 규칙을 따른다**. 본 지식 베이스의 값은 "기본값/제안"이다(`jwcad-basics.md` §7, `layer-conventions.md` §3).
3. **규칙 조회**: 코드/프롬프트는 `drafting-rules.json`에서 `category`/`id`로 규칙을 조회한다.
   - `confidence: law` → 법령값. **단정 금지**, "기준값 X와 비교하여 요확인" 형태로만 사용.
   - `confidence: standard` → JIS/업계 규격/협회 규칙.
   - `confidence: common-practice` → 관행. **제안에만 사용하고 강제하지 않는다**.
4. **편집 시 관계 검사**: `rooms-planning.md` §3의 표(창 확대·벽 이동·문 추가 등)로 구조(통り芯·내력벽)·인접 건구·채광·방화 영향을 확인 항목으로 제시한다.
5. **법적 판단 금지**: 적합/부적합을 최종 판단하지 않는다. 근거 조문 번호 + 기준값 + 도면 추정값 + "건축사/특정행정청 확인" 안내까지만 출력한다(`law.ai.no.final.judgement`).
6. **단위**: 선·위치는 실치수(mm), 문자·점·치수 화살표는 도면치수(용지 mm)가 기본. 실치수 = 도면치수 × 축척 분모.

### `drafting-rules.json` 스키마

```json
{
  "schemaVersion": 1,
  "sourceRegistry": { "<SOURCE_ID>": { "title": "", "url": "", "checked": "2026-10-01" } },
  "rules": [{
    "id": "stair.house.riser.max",
    "category": "stair",
    "statement_ja": "…",
    "value": 230,            // 또는 "range": {"min":..,"max":..}
    "unit": "mm",
    "applicability": "…",
    "legalBasis": "建築基準法施行令 第23条第1項",   // 법령이 아니면 null
    "confidence": "law|standard|common-practice",
    "sources": ["MLIT_STAIR", "EGOV_CO"]            // sourceRegistry 키
  }]
}
```

- `category`: grid, area, wall, opening, window, stair, corridor, ceiling, law, text, scale, jwcad, linestyle, layer, drawing, room.
- `sources`는 `sourceRegistry`의 키 배열(필요 시 코드에서 {title,url,checked}로 전개). `NO_PRIMARY`는 "일차 자료 없음(관행)"을 뜻한다.
- 현재 122규칙: law 33 / standard 36 / common-practice 53.

## 3. 출처 정책

- **일차 자료 우선**: 법령(e-Gov), 국토교통성 자료, 지자체 설계도서 작성 기준, JIS(공개 해설), 업계 단체(일본샷시협회).
- **저작권**: 법령은 저작권법 13조에 의해 저작권 대상이 아니나, 본 KB는 **요약/재서술**만 한다. 웹사이트·서적의 긴 구절을 복사하지 않는다(필요 시 짧은 문구 + 출처).
- **출처 기록**: 모든 URL에 접근일 **2026-10-01**을 기록(`catalog.json`, `drafting-rules.json`의 `sourceRegistry`, 각 md 말미).
- **불확실성 표기**: 각 파일에 [확인]/[관행]/[요확인] 등급을 표기. 일차 자료로 확인하지 못한 항목은 "Gaps" 절에 기재. 숫자를 만들어내지 않는다.
- **구분**: 법(law) / 규격·협회(standard) / 관행(common-practice)을 항상 구분한다.

## 4. 알려진 공백(Gaps) 및 주의

1. **e-Gov 법령검색이 2026-10-01 기준 점검 중이어서 조문 본문을 직접 취득하지 못했다.** 계단 치수(令23条)만 국토교통성 자료로 직접 확인했고, 나머지 법령값은 국토교통성/지자체 자료의 요약과 기존 조문 지식에 의존한다. 최종 사용 전 e-Gov 원문 대조가 필요한 항목: 採光補正係数 식(令20条), 令119条 복도 폭 적용 범위, 令24条 踊場 수치, 採光 1/10 완화의 시행 시기·조건(令19条3項), 延焼のおそれ(法2条6号).
2. **JIS 규격 본문(Z 8310~8317, A 0150, A 0151)은 유료/미열람**. 선 굵기 계열·문자 높이 계열은 공개 해설 기반이며 JIS 본문 대조가 필요하다.
3. **일본샷시협회 「標準規格寸法」 PDF 본문 미취득.** 샷시 호칭 읽는 법(幅3桁+高さ2桁)은 시장 해설 3건의 일치로 정리했고, 제조사(YKKAP/LIXIL/三協)별 세부 차이(외형 보정값)는 미수록.
4. **벽 두께·문/방 크기·실별 표준 치수는 관행 값**(일차 자료 없음). AI는 제안 참고에만 사용한다.
5. **레이어 규칙에는 표준이 없다.** 공개 사례는 교육/해설 사이트가 중심이고 출현 빈도 통계는 없다. 관청 영선(CAD 도면 작성 요령)의 SXF 레이어명은 미수록.
6. **Jw_cad 기본값**: 문자종 1~10의 Windows판 기본값, 선색 1~8의 기본 인쇄 선폭, JWW 바이너리의 선종 코드와의 대응은 미확인(대상 파일의 설정을 읽을 것). 선종 번호 순서(실선→점선1~3→일점쇄선1,2→이점쇄선1,2→보조선종)는 2개 해설 사이트의 일치에 기반한다.
7. **지역 차이**: 조례·지구계획·방화지정·일영규제·고도지구는 미수록. 용도지역은 도면에서 판독 불가이므로 사용자 입력이 필요하다.
8. **구조 규정**(壁量計算, 4号特例 축소 등 최근 개정)은 미수록.
9. 한일 용어는 1:1이 아닌 경우가 있다(거실/居室, 발코니, 확인신청 등). `glossary-ja-ko.md`의 "주의할 오역"을 참고.

## 5. 유지보수 규칙

- 값을 바꾸거나 추가할 때는 (1) `drafting-rules.json`의 해당 규칙 + `sourceRegistry`, (2) 해당 md의 본문과 "출처/Gaps", (3) `catalog.json`의 `sources`를 함께 갱신한다.
- 법령값은 개정(예: 建築基準法 令和4年·令和7年 개정)에 대해 연 1회 이상 e-Gov로 재확인한다. `checked` 날짜를 갱신한다.
- 새 규칙에는 `confidence`를 반드시 지정하고, 관행 값은 일차 자료로 승격하지 않는다.
- 각 md 파일은 ~25KB 미만, 주제별로 분리를 유지한다.

## 6. 파일 크기(참고)

| 파일 | 대략적 크기 |
|---|---|
| ja/jwcad-basics.md | ~11 KB |
| ja/layer-conventions.md | ~7 KB |
| ja/drafting-symbols.md | ~11 KB |
| ja/modules-dimensions.md | ~13 KB |
| ja/building-standards-law.md | ~15 KB |
| ja/rooms-planning.md | ~8 KB |
| ja/glossary-ja-ko.md | ~13 KB |
| drafting-rules.json | ~50 KB (기계 판독용) |
| catalog.json | ~9 KB |
