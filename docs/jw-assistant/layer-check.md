# 레이어 컨벤션 프로파일과 입력층 검사

2026-10-01. 구현: `addons/jw-assistant/core/layer-profile.mjs`(순수 모듈), `tools/extract-layer-profile.mjs`, `tools/check-layers.mjs`, 테스트 `tests/layer-profile.test.mjs`. 산출물: `knowledge/office-layer-profile.json`.

목적: (1) 기존 도면에서 사무소의 레이어 규칙을 **프로파일**로 추출하고, (2) 임의의 도면과 **AI가 제안한 편집(Patch v2)** 을 적용 전에 그 프로파일로 검사한다. 프로파일은 규칙의 *제안*이지 사무소 표준이 아니다. 근거(`evidence`)와 신뢰도(`confidence`)를 항상 함께 둔다.

## 1. 방법

### 관찰 (`observeDrawing(document|IR, {name, sourceHash})`)

`buildStructure`로 최상위 객체와 블록 전개 자식을 모두 센다. 블록 자식은 블록 배치 레이어(`effectiveLayerId`)로 귀속한다(자식의 원래 레이어가 아님). 레이어 `G:L`마다:

| 항목 | 내용 |
|---|---|
| 종류 수 | line/arc/point/text/dim/solid/block. `top`(최상위)과 `child`(블록 내부)를 분리 |
| 펜 | 색·선종(line/arc만)·선폭 히스토그램 |
| 문자 | 높이(용지 mm, 블록 배율 반영) 히스토그램, 문자종(`m_nMojiShu`), 평균 글자수, 짧은 문자 수, 실명 단어 적중 수, 샘플 ≤5개(24자 절단) |
| 선 | 수평/수직/사선 개수, 길이 구간 히스토그램(용지 mm), 평균·최대·중앙 구간, 장선(≥15mm)의 선종별 수 |
| 기타 | 레이어명·그룹명·축척·상태, 내용 바운딩박스(모델 mm) |

치수(`JwwSunpou`)는 1개로 세고 구성 선·문자는 중복 집계하지 않는다. 도면 유형(평면도·입면도·단면도·배치도·일영도·천공률·상세·전개·복도·설비)은 문자와 레이어명의 키워드로 **후보**만 낸다(`drawingType.candidate: true`, 근거 문자열 포함, 신뢰도 = score/(score+3)).

### 역할 부여 (`assignLayerRole`)

의미 역할 16종: 通り芯 grid, 壁 wall, 柱・梁・基礎 structure, 建具 opening, 仕上 finish, 階段 stair, 屋根・庇 roof, 寸法 dimension, 文字・室名 text, 設備 equipment, 家具 furniture, 敷地・外構 site, 補助線 auxiliary, 図枠・表題 frame, ハッチ・色塗 hatch, 立面・見付 elevation (+ `unknown`).

1. **레이어명 우선.** NFKC 정규화(반각 가타카나·전각 영숫자), 공백 제거, 소문자화 후 키워드 포함 검사. 구체 역할이 먼저(`壁仕上`→finish, `擁壁`→site, `インドア壁`의 `ドア`는 제외). 2자 이상 키워드 0.9, 1자(`壁`・`芯`・`窓`) 0.8. Jw_cad 기본명(`１-０ﾚｲﾔ`)은 이름 없음. 이름 없는 레이어의 그룹명은 약한 근거(0.45)로만 쓴다.
2. **내용 휴리스틱.** 치수 객체 ≥3이고 ≥50% → dimension(0.8); 장선 중 일점쇄선(선종 4·5)이 ≥3개·≥60%이고 ≥80%가 수평/수직 → grid(0.7); 문자 ≥3이고 ≥60% → text(0.6, 실명 적중 ≥2면 0.7); 솔리드 ≥60% → hatch(0.55).
3. **결합.** 이름과 내용이 일치하면 +0.07(`name+content`), 호환(예: 寸法 레이어의 문자)이면 유지, 충돌하면 −0.25와 근거 기록. 어느 쪽 근거도 없으면 `unknown`(신뢰도 0)으로 남긴다.

### 집계 (`buildProfile(observations, {minSupport=2, minShare=0.03, minEvidence=10, keepSamples=false})`)

- **레이어 단위(`layers["G:L"]`)**: 도면들에서 그 레이어 ID에 가장 많이 부여된 역할(근거 도면 수 `support`)을 대표 역할로 정한다. `confidence = 평균 부여 신뢰도 × (support / 그 레이어가 나타난 도면 수)` — 같은 ID가 도면마다 다른 용도면 낮아진다. `support < minSupport`(도면 수가 더 적으면 도면 수)는 `lowSupport`, 역할은 `unknown`으로 강등하고 `candidateRole`만 남긴다. 대표 역할이 부여된 도면들의 최상위 객체로 `allowed`(색·선종·선폭·문자 높이: 점유율 ≥ minShare인 값만)를 계산하며, 증거가 minEvidence(문자 높이는 5) 미만이면 `null`(판정 불가).
- **역할 단위(`roles[id]`)**: 레이어 ID가 도면마다 달라도 그 역할로 부여된 모든 레이어를 풀링한다(`support`, `confidence`, `layers`(주 역할 여부·lowSupport), 사용된 레이어명 상위 8개, 종류 수, `allowed`, 通り芯은 학습된 `gridStyles`). 새 도면의 레이어가 프로파일에 없어도 이름으로 역할을 정하면 이 풀을 쓴다.
- `usage.usedLayers`: 한 번이라도 내용이 있던 레이어. 도면 ≥3개일 때만 `usage.enabled`.

### 스키마 (`schemaVersion: 1`, `kind: "jw-office-layer-profile"`)

```jsonc
{ "schemaVersion": 1, "kind": "jw-office-layer-profile",
  "params": { "minSupport": 2, "effectiveMinSupport": 2, "minShare": 0.03, "minEvidence": 10 },
  "drawingCount": 21,
  "sourceDrawings": [ { "name": "kadai/研修.jww", "sha256": "…" } ],   // 해시와 상대 경로 이름만
  "drawingTypes": { "plan": 5, "shadow": 5, … },
  "roles": { "grid": { "ja": "通り芯", "ko": "통심(通り芯)", "support": 6, "confidence": 0.84,
      "layers": [ { "layerId": "0:0", "support": 3, "confidence": 0.9, "entityCount": 640, "names": [{ "name": "芯", "count": 3 }], "primary": false, "lowSupport": false } ],
      "names": [ … ], "primaryKinds": [ … ], "forbiddenKinds": [ … ], "count": 1971, "kinds": { … },
      "hist": { "colors": {…}, "styles": {…}, "widths": {…}, "textHeights": {…}, "mojiShu": {…} },
      "allowed": { "colors": [1,2], "styles": [1,2,5], "widths": [0], "textHeights": [2.5,3] }, "gridStyles": [1,2,5] } },
  "layers": { "0:3": { "role": "opening", "confidence": 0.15, "support": 2, "drawings": 13, "usedIn": 12, "names": [ … ], "scale": 100,
      "roles": [ { "role": "opening", "support": 2 }, … ], "evidence": [ … ], "kinds": {…}, "hist": {…}, "allowed": {…}, "entityCount": 761 } },
  "usage": { "enabled": true, "minDrawings": 3, "usedLayers": [ "0:0", … ] } }
```

프로파일에는 문자 내용이 없다(`samples`는 `--keep-samples`/`keepSamples: true`일 때만). 레이어명·그룹명은 포함된다. 같은 입력은 관찰 순서와 무관하게 같은 JSON을 낸다(테스트로 보장).

## 2. 검사

### `checkLayers(IR|document, profile, {gridMinLength=15, gridStyles})`

최상위 객체만 검사한다(블록 자식은 소속 블록으로). 레이어 문맥은 ① 프로파일 레이어(신뢰도 ≥0.5) ② 없으면 도면 자신의 레이어명에서 얻은 역할의 풀 순서로 정한다. 출력은 심각도→ruleId→레이어→id 순으로 정렬되며 `{id, ruleId, severity, entityIds, layerId, expected, actual, message_ja, message_ko, count}`.

| ruleId | 내용 | 심각도 |
|---|---|---|
| `layer.kind-unexpected` | 역할의 `forbidden` 종류(예: 壁에 치수·문자) / 주 종류가 아니고 점유율 <2%인 종류 | error(신뢰도≥0.8·근거≥2도면) 아니면 warning / 후자는 warning·info. 그 종류가 레이어의 ≥50%이면 용도 불일치로 보고 info |
| `layer.pen-color`, `layer.pen-style` | 레이어(없으면 역할) 허용 집합 밖의 펜 색·선종 | 프로파일 레이어+신뢰: warning, 그 외 info |
| `layer.pen-width` | 선폭 | info |
| `layer.text-height` | 문자 높이가 허용 크기(±0.05mm)에 없음 | warning/info |
| `grid.linetype` | 通り芯 레이어의 장선(≥15mm)이 허용 선종이 아님. 기본 허용은 학습된 `gridStyles`, 없으면 일점쇄선(4·5). `gridStyles: [4,5]`/`--grid-chain`으로 엄격화 | warning |
| `layer.role-mismatch` | 레이어명의 역할 ≠ 프로파일의 그 ID 역할 | warning |
| `layer.unused` | 프로파일(≥3도면)에서 한 번도 안 쓰인 레이어에 객체 | info |

### `checkPatchLayers(normalizedOps, ir, profile, {roleHint, roleHints})`

`validatePatchV2().ops`를 적용 전에 검사한다. 대상: `add`(종류·레이어·펜·문자 높이), `setLayer`(대상 객체 종류 vs 새 레이어, 앞선 add의 tempId 추적), `setPen`, `modify.height`. ruleId는 `patch.*`(`kind-unexpected`, `role-mismatch`, `pen-color`, `pen-style`, `text-height`…). 지시문에서 얻은 역할 힌트가 레이어 역할과 다르면 `patch.role-mismatch`(error). 반환:

- `suggestions[]`: add op마다 `suggestedLayer`·`suggestedRole`·`reason`(`role-hint` / `chain-line` / `kept` / `kind` / `popular-for-kind`)·`changed`. 힌트 → 장선+일점쇄선=grid → 현재 레이어가 종류를 허용하면 유지 → 문자=text → 종류별 최다 범용 역할(wall 등, grid·frame 제외) 순. 레이어는 프로파일 주 레이어 중 이 도면에 있고 이름이 모순되지 않는 것, 없으면 이 도면에서 그 역할 이름의 레이어.
- `corrections[]` + `applyLayerCorrections(ops, corrections)`: 레이어만 바꾸는 자동 교정(입력 비변경).
- `verdict`: `ok` / `correctable`(경고 이상이 모두 레이어 교정으로 해소) / `review`(교정 불가 경고) / `reject`(교정 불가 error). 호출측이 자동 교정·거부를 결정한다.

오류 코드: `E_LAYER_PROFILE_INPUT`(잘못된 입력·알 수 없는 roleHint), `E_LAYER_PROFILE_SCHEMA`(프로파일 형식), `E_LAYER_PROFILE_EMPTY`(관찰 없음).

## 3. 실행

```powershell
# 프로파일 추출 (재귀 최대 깊이 8, 기본 최대 500개, 자동저장·.BAK·동일 해시 제외)
node tools/extract-layer-profile.mjs C:/JWW knowledge/office-layer-profile.json --report ../../outputs/layer-profile
# 검사
node tools/check-layers.mjs check C:/JWW/kadai/研修.jww --profile knowledge/office-layer-profile.json [--grid-chain] [--fail-on error]
```

보고서(`layer-profile-report.md`, `observations.json`)는 샘플 문자를 포함하므로 미추적 `outputs/` 아래에만 쓴다. 커밋 대상 프로파일은 샘플이 없다. .jww 원본은 커밋하지 않는다.

## 4. 코퍼스 결과 (`C:/JWW`, 2026-10-01)

.jww 22개 중 자동저장 1개(`【自動保存】RC集合住宅.jw$.JWW`) 제외, **21개 도면** 처리(PowerShell reader 포함 약 55초). 프로파일: 역할 13종, 레이어 ID 73개, 사용 레이어 51개.

내용이 있는 레이어 165개의 역할 부여(최상위 객체 52,442개):

| 근거 | 레이어 | 객체 |
|---|---:|---:|
| 레이어명 | 80 | 34,277 |
| 이름+내용 일치 | 6 | 160 |
| 내용만 | 8 | 465 |
| 미분류(`unknown`) | 71 (43%) | 17,540 (33%) |

집계 역할 표(요약, 근거 도면 수 / 신뢰도):

| 역할 | 도면 | 신뢰도 | 주요 레이어명 | 허용 선종 |
|---|---:|---:|---|---|
| 通り芯 grid | 6 | 0.84 | 芯, Grid, 芯・ＦＬ | 실선·점선1·일점쇄선2 |
| 壁 wall | 6 | 0.84 | 躯体, インドア壁, 間仕切り | 실선 |
| 建具 opening | 5 | 0.89 | 建具, 南サッシ, 西サッシ | 실선·점선1 |
| 仕上 finish | 4 | 0.90 | 仕上 | 실선·점선1·일점쇄선2 |
| 文字・室名 text | 9 | 0.72 | 室名 | 실선 |
| 寸法 dimension | 2 | 0.90 | 寸法 | 실선 |
| 設備 equipment | 3 | 0.90 | 設備機器, 設備 | 실선·점선1 |
| 敷地・外構 site | 8 | 0.89 | 敷地, 斜路擁壁, 芝 | 실선 |
| 図枠・表題 frame | 6 | 0.90 | 方位, タイトル, 図名 | 실선·점선1 |
| 立面・見付 elevation | 3 | 0.90 | 南　面, 搭屋西面, アイソメ | 실선 |
| 柱・梁・基礎 / 階段 / 屋根・庇 | 2 / 2 / 4 | 0.68 / 0.90 / 0.85 | 玄関柱, 階段正面, 屋根 | — |

도면 유형 후보 분포: 평면 5, 일영 5, 입면 3, 단면 2, 설비 1, 배치 1, 천공률 1, 불명 3. 문자 높이는 문자 역할에서 2.5·3mm가 우세하고 실명 레이어(`室名`)는 3mm가 중심이다. 레이어 ID는 도면 간 일관성이 낮다(예: 壁 `0:1`의 레이어 단위 신뢰도 0.13, 建具 `0:3` 0.15). 2개 이상 도면이 같은 ID에 같은 역할을 준 레이어는 12개뿐(`1:0` 芯 0.80, `1:6` 室名 0.65 …). 그래서 점검은 대부분 역할 풀(레이어명 기반)로 동작한다.

프로파일로 21개 도면 자체를 검사한 결과(학습에 쓴 도면 포함, 최상위 객체 52,442개): error 9(Test7 7·Test6 1·腹部研修 1), warning 8(grid.linetype 5, pen-color 2, pen-style 1), info 122(펜 색 64·선종 47 등, 대부분 역할 풀 기준). Test7의 error는 일영도의 `南壁面`·`南壁日影` 등 壁 레이어에 놓인 문자 라벨(소수 비율)로, 이름 기반 역할과 실제 용도의 차이를 보여주는 오탐 가능 사례다. error가 없는 도면은 18개.

## 5. 한계

- **이 코퍼스는 한 사무소의 도면이 아니다.** Jw_cad 번들 샘플과 연습 과제의 모음이라 레이어 규칙이 도면마다 다르다. 표의 신뢰도·허용 집합은 "혼합 규칙"이며 일관된 사무소 표준이 아니다. 실제 회사 도면에서 재학습해야 한다.
- 레이어명 키워드 기반: 이름이 용도와 다르면(壁 레이어의 문자 라벨, `YKK_A1` 같은 제품명) 틀린다. 이름 없는 레이어는 내용 휴리스틱만 쓰며 43%가 미분류다.
- 선종 8·9의 의미는 미검증(번호만 표시). 펜 색은 번호만 쓴다(색 이름·RGB 아님). 색 10 솔리드의 `m_Color`는 보지 않는다.
- 블록 자식은 관찰 통계에 들어가지만 검사 대상이 아니다. 자식 문자 높이는 블록 배율만 반영하며 Jw_cad 실측 대조는 하지 않았다(structure와 동일한 한계). 치수 보조선은 reader가 제공하지 않는다.
- 선 길이·문자 높이는 용지 mm(축척 무관), 바운딩박스는 모델 mm. 축척이 무효(≤0)인 레이어의 객체는 종류·펜은 세지만 기하 통계는 빠진다.
- 도면 유형은 키워드 후보다. 검증 정답이 없다(예: Test6은 단면도 0.75 후보).
- `layer.unused`는 도면 ≥3개일 때만 켜지며 info다. 코퍼스에서 안 쓰였다고 잘못된 레이어는 아니다.
- 허용 집합은 점유율 ≥3%라 드문 정상 값이 경고될 수 있다. 역할 풀(레이어 이름 기반) 지적은 info로 낮췄다.
- `checkPatchLayers`는 레이어/펜/문자 크기만 본다. 의미적 정답(어느 벽을 옮기는가)이나 기하는 검증하지 않으며, 적용 엔진의 재파싱 검증과 별개다.

## 6. 회사 도면이 오면 재학습

1. 도면을 한 폴더(하위 폴더 가능)에 넣는다. 원본은 읽기 전용이며 커밋하지 않는다.
2. `node tools/extract-layer-profile.mjs <폴더> knowledge/office-layer-profile.json --report ../../outputs/layer-profile` — 동일 해시·자동저장은 자동 제외. 도면이 많으면 `--min-support`(기본 2)를 올려 우연한 규칙을 걸러낸다.
3. 보고서의 도면별 표에서 `unknown`·낮은 신뢰도 레이어를 확인한다. 이름 규칙이 있는 사무소라면 `ROLES[...].names`에 사내 용어를 추가한다(코드 한 곳).
4. `check-layers.mjs`로 대표 도면을 검사해 오탐을 확인한다. 通り芯을 엄격히 하려면 `--grid-chain`.
5. 프로파일을 검토 후 커밋한다(샘플 문자 없음, `sourceDrawings`는 이름+해시만).
