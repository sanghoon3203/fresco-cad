# JWW 구조 JSON과 건축 스킬 프레임워크

2026-09-29. 구현 위치는 `addons/jw-assistant/native/jww-structure.mjs`, `ai/architecture-skills.mjs`, `skills/`다. 외부 스킬을 설치하거나 실행하지 않고 GitHub의 공개 설계 방식을 참고해 프로젝트 전용 지침을 작성했다.

## GitHub 조사와 채택한 부분

| 자료 | 실제 성격 | Fresco에 적용 | 그대로 적용하지 않는 부분 |
|---|---|---|---|
| [Autodesk Open Architecture Standards](https://github.com/autodesk-platform-services/open-architecture-standards-2d-floor-plans) | LLM용 2D 평면 JSON과 `.claude/skills` 6종. README가 산업 표준이 아닌 실험이라고 명시 | 실·벽·개구부 관계, 설계 요구와 확정 좌표 분리 | 자체 스키마로 JWW를 대체하거나 부동소수 좌표를 정수로 반올림하지 않음 |
| [OAS program skill](https://github.com/autodesk-platform-services/open-architecture-standards-2d-floor-plans/blob/main/.claude/skills/oas-program/SKILL.md) | 공간 프로그램과 인접 관계를 다루는 실제 스킬 | 목표 면적, 인접 요구, 필수/권장 조건을 projectBrief에 분리 | 요구사항을 이미 존재하는 도면 사실로 해석하지 않음 |
| [toolbank-autocad 공간 계획 방법](https://github.com/AI4CharityPL/toolbank-autocad/blob/main/docs/engineering-rules/73-space-planning-method.md) | AutoCAD 도구 프로젝트의 공간 계획 문서 | 프로그램·동선·가구 배치·벽의 관계를 검토 항목으로 사용 | AutoCAD 명령과 외국의 치수 기준을 JWW/일본 기준으로 전용하지 않음 |
| [domain-experts architectural-civil-drafter](https://github.com/wonsukchoi/domain-experts/blob/main/roles/architectural-civil-drafter/SKILL.md) | 제도 역할 스킬 | 치수·레이어·도면 간 정합을 분리해 검토 | 미국식 AIA/NCS·인치 기준을 기본값으로 넣지 않음 |
| [Revit BIM skill](https://github.com/Demolinator/revit-mcp-plugin/blob/main/revit-bim/skills/revit-bim/SKILL.md) | Revit API에 연결되는 BIM 스킬 | 층·그리드·구조·외피·문서화의 구분 | Revit의 BIM 객체가 2D JWW에 이미 존재한다고 가정하지 않음 |
| [buildingSMART IDS](https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/README.md) | IFC 정보 요구사항 명세. 자연어 스킬 아님 | 적용 대상과 필요한 정보의 구분 | IDS 통과를 건축법 적합 판정으로 사용하지 않음 |

가장 가까운 출발점은 OAS의 공간 관계와 프로그램 분리다. JWW의 실제 선·문자·블록을 보존하고, 벽·실·창호라는 해석은 근거 ID를 가진 별도 후보로 올린다. 제3자 스킬 코드나 지침 본문을 복사·번들하지 않았다. 이 문서의 비교는 2026-09-29에 확인한 공개 자료 기준이다.

## 파서 IR v2 계약

| 필드 | 내용 |
|---|---|
| sourceHash | 해당 입력 JWW의 SHA-256. 객체 ID는 이 입력에 한정 |
| entities | 최상위 객체, 원본 primitive 속성, 읽기용 geometry, 일반 선의 model-mm points와 editable |
| blockDefinitions | 블록 번호·이름·정의 ID·내부 객체 목록. 블록 하나가 여러 번 배치되어도 정의는 하나 |
| blockInstances | 배치 경로, 참조 정의, 회전·반전·축척·이동을 합성한 transformToModel, 해석 상태 |
| expandedEntities | 배치별 고유 경로, 원본/배치 레이어, 로컬 geometry와 모델 변환. 선은 modelPoints 제공 |
| diagnostics / coverage | 누락 참조·중복 정의·순환·확장 제한·유효하지 않은 수치와 현재 지원 범위 |
| imageMetadata | 이미지 이름·압축 크기. 픽셀·OCR 결과는 포함하지 않음 |

행렬 `[a,b,c,d,tx,ty]`는 `x'=a*x+c*y+tx`, `y'=b*x+d*y+ty`다. 블록 안의 블록은 부모 행렬과 합성하고 최상위 배치의 그룹 축척은 한 번 적용한다. 자식 레이어의 축척을 추가로 곱하지 않는다. 원호는 반전·비균일 축척을 잃지 않도록 로컬 타원호와 행렬로 제공한다. `geometry` 자체는 모델 mm가 아니므로 계산에는 `modelPoints` 또는 `transformToModel`을 사용한다.

치수는 core 선·문자 성분을 추출한다. 현재 JwwHelper 래퍼의 보조선 참조 결함 때문에 보조선은 누락 진단과 함께 제외한다. 솔리드는 원본 속성까지 제공하며 채움 종류의 의미 변환은 남아 있다. 알려지지 않은 클래스의 완전 추출, 블록 편집, 범용 JWW writer는 구현 완료로 보지 않는다.

## 애드온 스킬 5종

| ID | 입력과 역할 | 출력 |
|---|---|---|
| drawing-reading | 선·문자·블록·레이어에서 벽/창호/실 후보 읽기 | 관찰과 건축적 추론을 구분한 근거 ID 목록 |
| design-brief | 사용자 프로그램, 면적, 인접·동선 요구, 알려진 부지 조건 | 필수·권장·미확정 요구와 도면 비교 |
| drafting-review | 치수·문자·레이어·도면 표현, officeProfile | 제도 정합 검토와 추가로 필요한 객체 |
| change-planning | 명시적인 선택 선 이동 요청 | 실행 가능한 TranslateEntities 또는 patch=null과 미지원 작업 |
| japan-review-intake | 위치·용도·층수·구조·기준일·출처 | 검토에 필요한 입력과 미평가 항목. 법규 수치를 내장하지 않음 |

`prepareArchitectureSkill(ir, options)`는 선택한 최상위 객체 1~100개와 그 블록 자손만 문맥으로 만든다. 다른 도면 영역은 전달하지 않았다고 명시한다. 도면 전체를 읽었다고 답해서는 안 된다. 큰 선택은 문자 수 제한 오류를 반환하므로 작업 구역을 나눠 호출한다.

`projectBrief`는 설계 요구, `officeProfile`은 사무소 표현 규칙, `ruleSources`는 기준일과 적용 대상을 확인한 규정 출처를 받는다. 이 선택적 입력들의 진위나 법적 효력을 런타임이 검증하는 것은 아니다. 도면 문구와 메타데이터는 분석 자료로만 취급한다.

결과는 `{schemaVersion:1, sourceHash, skillId, findings, unknowns, patch}`다. findings는 `{kind,status,label,evidenceIds,rationale}`이며 status는 `observed`, `candidate`, `not-evaluated` 중 하나다. `validateArchitectureResult`는 입력 해시, 스킬, 근거 ID, 관찰의 근거 유무와 패치 범위를 검사한다. 건축적 판단의 정답까지 증명하는 검증기는 아니다.

실제 수정은 change-planning만 제안할 수 있으며 선택된 `editable:true` 최상위 일반 선의 이동만 허용한다. 블록 내부 path는 수정 ID로 받지 않는다. 응답 검증과 파일 적용은 분리되어 있고, 출력하려면 기존 `applyJwwPatch` 경로로 재파싱까지 수행한다.

## 사용 예

`addons/jw-assistant`에서 다음 options.json을 만든다. ID는 해당 파일의 inspect 결과를 사용한다.

```json
{
  "skillId": "drawing-reading",
  "entityIds": ["e14529"],
  "request": "이 블록 내부 구성과 건축적으로 추정 가능한 의미를 근거와 함께 설명해줘",
  "projectBrief": {"country": "JP", "buildingUse": "unknown"},
  "officeProfile": {},
  "ruleSources": []
}
```

```powershell
node tools/prepare-skill.mjs C:/JWW/kadai/腹部研修.JWW options.json packet.json
```

이 CLI는 로컬에서 스킬 지침·선택 문맥·응답 계약을 묶는다. 외부 AI를 호출하거나 비용을 발생시키지 않는다. 지금 구현된 것은 실행 가능한 문맥 생성기와 결과 검증기이며, 모델 호출·Studio UI 연결·건축 추론 품질 평가는 다음 통합 단계다.

## 이어서 할 일

현재 검증: 기존 테스트를 포함한 전체 90개 통과 후, 블록 실파일 회귀와 블록/이미지 변경 감지 회귀 2개를 추가해 관련 6개 테스트도 통과했다. 스킬 5개는 skill-creator의 quick_validate로 확인했다. `C:/JWW`의 22개 파일은 두 번 읽기 일치·원본 해시 유지, 구조 진단 0건이었다. `腹部研修.JWW`의 최상위 객체 21,730개, 블록 정의 5개/내부 객체 25개를 추출했다. 이는 현재 reader가 제공한 객체의 검사이며 미지원 클래스의 완전성이나 Jw_cad 화면 일치를 증명하지 않는다.

상위 작업 공간 `outputs/jww-audit-structure-2026-09-29/report.md`에 파일별 결과가 있고, `outputs/jww-pipeline-demo/blocks-ir-v2.json`과 `architecture-packet.json`에 실제 구조와 선택 블록 5개의 AI 입력 예제가 있다. 원본 도면과 생성 결과는 Git에 넣지 않는다.

재현 명령 (`addons/jw-assistant` 기준):

```powershell
node tools/audit-jww.mjs C:/JWW <새로운-보고서-폴더>
$env:FRESCO_JWW_FIXTURE = 'C:/JWW/Test1.jww'
$env:FRESCO_JWW_BLOCK_FIXTURE = 'C:/JWW/kadai/腹部研修.JWW'
node --test tests/jww-native.test.mjs tests/jww-pipeline.test.mjs tests/jww-structure.test.mjs tests/architecture-skills.test.mjs
```

통합 순서:

1. Studio의 파일 읽기를 IR v2로 연결하고 선택 블록의 내부 객체를 화면에서 확인한다.
2. 선택 구역과 스킬을 AI 호출에 전달하고 응답을 위 검증기로 검사한다.
3. 선 이동 제안을 전후 미리보기와 새 JWW 저장까지 연결한다.
4. 실제 Jw_cad 화면으로 블록 배치와 저장 결과를 대조한 뒤 문자·원호 편집을 넓힌다.

법규 데이터베이스, 벽/실 자동 확정, 구조 계산을 이번 스킬 틀에 억지로 포함시키지 않는다. 실파일 편집 흐름을 먼저 완성하고 실제 도면 사례를 바탕으로 스킬 판단을 보강한다.
