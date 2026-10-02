# JWW 편집 검증 — 4단계

2026-10-02. 구현: `addons/jw-assistant/native/verify.mjs`(L1–L3), `native/jww-edit.mjs`(`applyPatchV2(..., { level })`), `native/jww-worker.mjs` + `native/Jww-Worker.ps1`(상주 DLL 워커), `tools/jw-regress.mjs`(L4).
테스트: `tests/verify.test.mjs`, `tests/jww-edit.test.mjs`. 엔진 API: [jww-edit.md](jww-edit.md).

목표는 두 가지다. 편집 제안은 **즉시 미리보기**할 수 있어야 하고, 파일은 코덱과 **독립된 판독기(JwwHelper DLL)**를 통과해야만 확정해야 한다.

| 단계 | 내용 | 측정 시간 (Test1 1.7k / 腹部研修 21k 엔티티) | 실행 시점 |
|---|---|---|---|
| L1 | `validatePatchV2` + 엔진 사전 검사 | 2–9 ms / 40–70 ms | 모든 제안 |
| L2 | 코덱 검사(아래 7개 항목) | 30–55 ms / 300–410 ms | 모든 제안 → 미리보기 |
| L3 | 출력 파일을 DLL로 독립 판독한 결과를 계획된 기대 상태와 비교 | 70–105 ms / 0.9–1.0 s (워커) | accept/저장. 통과해야만 파일을 기록 |
| L4 | 실제 Jw_cad로 열기(회귀 코퍼스) | 케이스당 약 40–60 s | 새 op/엔티티 종류가 처음 나올 때, 야간/CLI |

각 단계의 결과는 `{ level, ok, durationMs, checks: [{ id, ok, detail }] }` 형식이고, `receipt.verification`에 순서대로 쌓인다.
Studio(`tools/studio-server.mjs`)는 `edit`·`patch`·`fix-layers`를 `preview` 수준(L1+L2)으로, `accept`를 `save` 수준(L1+L2+L3)으로 실행한다.
응답에는 `verificationLevel`과 `verification: [{ level, ok, durationMs }]`가 들어간다. accept에서 L3가 실패하면 파일을 쓰지 않고 `400 { error: 'E_JWW_SAVE_VERIFY' }`를 반환한다.

## L1 — 스키마와 엔진 사전 검사

- 검사 항목: `patch-v2`(스키마·대상 id·레이어·한계), `ops-present`, `engine-plan`(코덱 뷰에서 `planNativeOps`). `engine-plan`은 미지원 엔티티, CP932로 표현할 수 없는 문자, 0 길이 선, 축척 등을 거부한다. DLL 작성기를 쓸 때는 `rewrite-safe`(정적 재작성 차단 요인)도 검사한다.
- **잡는 것**: 잘못된 형식, 존재하지 않는 id, stale hash, 인코딩할 수 없는 텍스트, 지원하지 않는 조합.
- **못 잡는 것**: 실제로 기록된 바이트에 관한 모든 것.

## L2 — 코덱 검사 (DLL 호출 없음)

`decode → applyOps → encode` 후 다음 항목을 검사한다.

| id | 검사 |
|---|---|
| `apply-encode` | 적용과 인코딩이 성공했는가 |
| `source-decode` / `output-decode` | 원본과 출력이 모두 완전히 디코드되는가(partial decode 아님) |
| `reencode-stable` | `encode(decode(output)) === output` |
| `class-tags` | 출력의 MFC 클래스 태그/PID가 레코드 클래스 순서에 대한 **정규 CArchive 시퀀스**와 바이트 단위로 같은가(원본 스키마, 0x7FFF 이상은 big-PID 형식) |
| `byte-exact-outside-edits` | 헤더 바이트, 건드리지 않은 모든 엔티티 레코드 본문, 엔티티 목록 이후 전체(블록 정의·이미지·trailer)가 원본과 동일한가. 클래스 태그만 예외(구조 변경 후 PID가 정당하게 재번호화되기 때문이며, 태그는 `class-tags`가 따로 검사함) |
| `semantic` | 출력의 코덱 뷰(`codecDocument`)를 계획(`expected`)과 비교. 건드린 엔티티는 1e-12 이내, 텍스트 끝점은 Jw_cad 규칙 범위, 원호 시작각은 2π 동치를 허용. 건드리지 않은 엔티티는 완전히 일치해야 함. 레이어·블록·이미지·진단·엔티티 수도 비교 |

- **잡는 것**(`tests/verify.test.mjs`로 확인): 편집한 엔티티의 잘못된 좌표(→ `semantic`), 편집 범위 밖의 바이트 변경(엔티티 또는 헤더 → `byte-exact-outside-edits`), 깨진 클래스 태그(→ `output-decode`/`class-tags`/`semantic`), 엔티티 누락·추가, 레이어 변경.
- **못 잡는 것**: L2 판독기는 쓰기에 쓴 코덱과 **같은 코드**다. 그래서 코덱이 필드를 일관되게 잘못 이해하는 경우(읽기와 쓰기가 같은 방향으로 틀린 경우)에는 디코드·재인코드·의미 비교가 모두 통과한다. `class-tags`도 같은 `Writer.beginObject` 규칙으로 기대값을 만든다. 따라서 이 검사는 후처리나 splice로 생긴 손상을 잡는 것이지 PID 규칙 자체의 오류를 잡는 것이 아니다. 이런 오류는 L3와 L4의 몫이다.

## L3 — 독립 DLL 판독 (저장 시)

1. DLL로 원본을 판독(`document`가 이미 있으면 재사용)하고 DLL 헤더를 읽는다. 그 결과로 `planNativeOps`를 **다시** 실행한다. 코덱 뷰가 아닌 DLL 뷰에서 계획하는 것이다.
2. 출력 바이트를 상주 워커가 판독한다. Node는 계획의 각 미변경 엔티티에 대한 정규 다이제스트(SHA-256 앞 64비트, 속성명 정렬, double은 IEEE 비트, -0은 0으로 정규화)를 보낸다. 워커는 C#으로 같은 다이제스트를 계산해 **불일치하는 엔티티와 변경·추가된 엔티티만** 반환한다. 블록은 다이제스트 하나로 비교한다. 그래서 2만 엔티티를 매번 JSON으로 보내지 않는다(일치하는 엔티티는 기대 레코드로 대체됨).
3. 기존 `verifyRewrite` 논리(codec 모드: 헤더 완전 일치, 버전 동일)로 비교한다.

- 검사 항목: `dll-reread`(판독 경로, 전송 수, 다이제스트 불일치 수), `dll-vs-plan`.
- **잡는 것**: 코덱의 읽기와 쓰기가 같은 방향으로 틀린 오류(DLL이 다르게 읽기 때문), MFC 직렬화에서 DLL이 거부하거나 다르게 해석하는 출력, 헤더 변조. 테스트에서는 출력의 미변경 선 좌표를 바꾸면 `dll-vs-plan`이 정확히 그 엔티티를 지목하는 것을 확인했다.
- **못 잡는 것**: DLL(JwwHelper)은 Jw_cad 본체가 아니다. Jw_cad만의 해석 차이(그리기 순서, 텍스트 폭 계산, 미지원 속성 무시)는 L4의 몫이다. DLL이 노출하지 않는 필드(치수 `JwwSunpou`의 보조선·점, 블록 정의의 `m_time` 등)는 L3에서 비교하지 않으며, 이 부분은 L2의 바이트 동일성에만 의존한다. 다이제스트는 64비트이므로 우연한 충돌 확률은 무시할 수 있지만 0은 아니다.
- **폴백**: 워커에 장애가 있으면 1회성 PowerShell 판독기를 쓴다(느리지만 같은 비교). 판독 경로는 `dll-reread` detail에 기록된다.

### 상주 DLL 워커

`Jww-Worker.ps1`은 PowerShell 프로세스 하나에 DLL을 한 번 로드하고 C# 헬퍼를 한 번 컴파일한다(시작 약 1.1–1.6 s). 이후 stdin/stdout으로 한 줄짜리 JSON 요청(`ping|read|header|verify|sleep|shutdown`)을 처리한다.
Node 측 `JwwWorker`의 동작은 다음과 같다.

- 요청 id를 붙이고, 한 번에 하나씩 전송하며, 요청마다 타임아웃(기본 120 s)을 건다.
- 대기열은 기본 16개로 제한한다.
- 타임아웃이나 크래시가 나면 프로세스를 종료하고, 다음 요청에서 자동으로 재시작한다.
- 60초 안에 재시작이 3회를 넘으면 60초 쿨다운에 들어간다(요청은 즉시 `E_JWW_WORKER_UNAVAILABLE`로 실패하고 호출자는 1회성 판독기로 폴백).
- 유휴 상태에서는 unref되어 Node 종료를 막지 않고, stdin이 닫히면 스스로 종료한다.

`read` 출력은 `Read-Jww.ps1`과, `header` 출력은 `Write-Jww.ps1 -Mode Header`(PowerShell 파이프라인의 2차원 배열 평탄화 포함)와 **코퍼스 22개 파일 전부에서 deep-equal**이었다.

### 측정 (이 PC, 2026-10-02)

| 작업 | 이전 (1회성) | 이후 |
|---|---|---|
| `readJww` Test1 (1,686) | 2.1–2.5 s | 57–70 ms (워커 warm) |
| `readJww` 腹部研修 (21,209) | 13.6–18.9 s | 0.61–0.66 s |
| `readHeader` | 1.4–2.1 s | 6–126 ms |
| `toIR` 腹部研修 | 19.6 s | 0.37 s (`patchLine` 레코드 색인 + 지연 복사) |
| 편집 1건, Test1: 미리보기(L1+L2) | — (이전에는 항상 DLL 2회 + 헤더 2회) | 0.13 s |
| 편집 1건, Test1: 저장(L1–L3) | 5.4 s | 0.24 s |
| 편집 1건, 腹部研修: 미리보기 | — | 0.9–1.1 s (그중 출력 IR 생성 약 0.4 s) |
| 편집 1건, 腹部研修: 저장, `document` 제공 | 35 s (+ toIR 20 s 포함) | 1.9 s |
| 같은 작업, 워커 비활성(`FRESCO_JWW_WORKER=0`) | — | 18.2 s |
| `tests/jww-edit.test.mjs` 전체 | 수 분, 1건 실패 | 13.7 s, 18/18 통과 |

## L4 — 실제 Jw_cad (회귀 코퍼스)

`node tools/jw-regress.mjs --block <블록이 있는 JWW>`. 상세는 `tests/fixtures-l4/README.md`, 결과는 `outputs/l4/report.{json,md}`(추적하지 않음).
각 케이스는 다음 순서로 판정한다.

1. 저장 수준(L1–L3) 편집 결과를 Jw_cad로 연다(`jw-visual.ps1 -Mode shot`, PrintWindow만 사용, 창은 화면 밖에 둠, `-WaitMs 15000 -StableFrames 4`).
2. 편집 전후 캡처의 **도면 영역** 차분을 구한다. 상태 표시줄은 같은 파일을 두 번 찍어도 바뀌므로 제외한다.
3. 자체 렌더러가 만든 변경 상자를 캡처에서 검출한 용지 테두리를 기준으로 Jw_cad 픽셀 좌표로 변환한다. 차분이 그 상자와 겹치는지(located), 국소적인지(도면 영역의 25% 미만)를 판정한다.

### L4 결과 (2026-10-02, 이 PC, `--wait 15000 --stable 4`, 전체 약 12분)

동일 파일 재캡처의 기준선: 창 전체에서 837 px가 달랐지만 모두 상태 표시줄이었고, 도면 영역에서는 **0 px**였다.

| 케이스 | L1–L3 | Jw_cad 도면 영역 변경 | 판정 |
|---|---|---|---|
| translate-line | ✓✓✓ | 370 px, 국소(4.5%) | **accepted** |
| delete-line | ✓✓✓ | 299 px (5.2%) | **accepted** |
| modify-line | ✓✓✓ | 258 px (1.6%) | **accepted** |
| setPen-line | ✓✓✓ | 188 px (0.03%) | **accepted** |
| setLayer-line (같은 축척) | ✓✓✓ | 0 px(보이는 변화 없음이 기대값) | **accepted** |
| translate-block (블록 정의가 있는 파일의 축소본) | ✓✓✓ | 국소 변경 | **accepted** |
| modify-text | ✓✓✓ | 0 px | not-visible-in-capture (미검증) |
| add-line / add-text / add-arc / add-point | ✓✓✓ | 0 px | not-visible-in-capture (미검증) |
| 생성 평면도 5종(`generator/examples/*.json`) | — | — | 5/5 **열림**(오류 없이 창이 뜨고 안정 프레임 도달) |

**Jw_cad 확인 op 종류**: translate·delete·modify(선), setPen, setLayer, 블록 translate. 모든 출력 파일은 Jw_cad에서 오류 없이 열렸다.

**정직한 한계**: 이 PC에서 Jw_cad의 PrintWindow 캡처에는 엔티티 목록의 **앞부분만** 그려진다. 195개 엔티티 중 약 120번째까지만 나타나고, 2,500개 이상인 평면도는 처음 수십 개만 나타난다.
대기 시간을 15 s에서 45 s로 늘려도 결과는 같았고, 반복 캡처도 동일했다. 즉 시간 부족이 아니라 결정적으로 잘리며, 캡처 방식(`RedrawWindow` + `PrintWindow`가 Jw_cad의 그리기를 중단시키는 것으로 추정)에 기인한다.
그래서 파일 끝에 붙는 add 계열과 목록 뒤쪽에 있는 텍스트·원호 엔티티는 캡처로 확인하지 못했다. 이 케이스들은 **실패가 아니라 미검증**이다. 증거는 `outputs/l4/<case>/jw-after.png`와 `render-after.png`에 있다.
용지 테두리 자동 검출도 이 캡처에서는 실패했다(점선 테두리의 픽셀 밀도가 낮음). 그래서 위치 판정(located)은 null이고, 판정은 "변경 있음 + 국소성"에만 근거한다.

권장 다음 단계는 다음과 같다.
1. 그리기를 중단시키지 않는 캡처를 쓴다. 예: 창을 화면 밖에 둔 채 `WM_PRINT` 없이 그리기가 끝날 때까지 기다린 뒤 창 DC를 BitBlt 한 번으로 캡처하는 방식. 단, 데스크톱 캡처는 금지다.
2. Jw_cad 자체의 출력(인쇄→이미지 파일, 또는 외부 변형으로 다른 이름 저장 후 DLL·코덱으로 비교)을 쓴다.
3. 그때까지 add 계열에는 L4 대신 "Jw_cad에서 다른 이름으로 저장한 파일을 다시 읽어 비교"하는 라운드트립을 수동 체크리스트로 운용한다.

## 남은 위험 (정확히)

1. **L2만 거친 미리보기는 독립 판독기를 거치지 않았다.** 미리보기 바이트는 저장 시 L3를 다시 통과해야만 파일이 된다(`finalizePatchV2`: 결정적으로 재생성한 뒤 바이트 동일성을 확인하고 L3 실행). 다른 경로로 preview 바이트를 디스크에 쓰는 코드는 이 보장을 받지 못한다.
2. **L3도 Jw_cad 자체가 아니다.** JwwHelper는 일부 double을 파일 비트와 1ulp 다르게 읽는다(腹部研修에서 4개 값: 코덱 `-46.340877840230704`, DLL `-46.3408778402307`). L3는 DLL 대 DLL로 비교하므로 오탐은 없다. 다만 DLL이 노출하지 않는 필드(치수 보조 요소, `m_time`)와 DLL의 손실 문자열(비 CP932 → `?`)은 L3의 맹점이다.
3. **L4는 편집마다 실행하지 않는다.** 새 op나 엔티티 종류가 들어오면 수동 또는 야간에 실행해야 한다. 캡처는 느린 PC에서 텍스트가 늦게 그려지는 문제 때문에 안정 프레임에 의존하며, 실패하면 `jw-capture-failed`로 정직하게 남긴다. 위치 판정(located)은 용지 테두리 검출과 "용지 중심 = 뷰 중심" 가정에 의존하는 근사이고, 테두리를 찾지 못하면 판정을 생략한다(null).
4. **다이제스트 축약**: L3의 미변경 엔티티 비교는 64비트 다이제스트 일치에 의존한다(우연 충돌 약 2⁻⁶⁴). -0과 0은 같은 값으로 본다(DLL 판독기의 기존 JSON 출력도 구분하지 않았음).
5. **워커 상태**: 같은 프로세스에서 DLL을 반복 사용하므로 DLL 내부의 누수나 전역 상태가 쌓일 수 있다. 코퍼스 22개 파일 연속 판독에서는 문제가 없었다. 크래시가 나면 자동으로 재시작하고, 반복되면 1회성 판독기로 폴백한다.
6. **코덱 뷰 IR**: 미리보기가 반환하는 IR은 코덱 뷰로 만든다. 그래서 v600 파일의 `formatVersion`이 DLL 기반 IR의 700이 아닌 600으로 표시되고, 비 CP932 문자열은 DLL처럼 `?`가 되지 않는다.
