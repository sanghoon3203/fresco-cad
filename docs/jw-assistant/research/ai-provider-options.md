# Jw Assistant AI 공급자 연결 조사 및 설계안

조사 기준일: 2026-09-23. **이 문서는 구현 계획이다.** 현재 reference engine은 외부 API를 호출하지 않으며, 아래 공급자 계정·모델 접근·요금·성능은 이 저장소에서 실측하지 않았다. [기존 아키텍처](../architecture.md)의 `AI/JEV Adapter` 경계를 구체화한다. 외부 모델은 설명·의도 분류·유한 후보 순위에만 참여한다. 기하 계산, 법규 판정, CAD 쓰기 권한은 로컬 결정론 코어와 명시적 사용자 승인에 남긴다.

## 권장 기본값과 연결 순서

1. 설치 직후 `local-only`: 네트워크 AI 비활성, 결정론 순위와 로컬 설명 템플릿 사용. 앱 기동·도면 열기·검사·preview에 공급자 계정이 필요 없어야 한다.
2. 회사 관리자가 프로젝트별 클라우드 정책을 만들고, 작업자가 **이번 요청의 전송 미리보기**에서 범위·수신 공급자·예상 토큰/상한을 확인한 뒤 명시적으로 실행한다. 연결 설정만으로 자동 전송하지 않는다.
3. 최소 구현 순서는 `FakeProvider`와 계약 검증 → 한 공급자 BYOK 파일럿 → OpenAI/Anthropic/Gemini 어댑터를 같은 계약에 추가 → 사용량·성능 평가 후 선택적 회사 gateway. 공급자 우선순위는 검증된 계정 조건과 일본어 도면 설명 평가로 정한다.
4. `JEV`는 2026-09-28 TypeSafe AI의 공개 문서/API를 확인했다. [최신 도입 판단](jev-assessment-2026-09-28.md)을 따른다. 계정 접근·비용·실무 성능은 미검증이며 `RankCandidates` 포트와 placeholder만 둔다. GPT-6 Sol/Luna **개발 에이전트 선택**을 제품 API 이용권 또는 자동 기본 모델로 해석하지 않는다. 제품 모델 ID는 관리자가 입력하고 capability probe 및 시험 fixture 통과 뒤 활성화한다.
5. 수정 지시 메모를 다루는 `ExtractRevisionTasks`는 사용자 제공 일본어 원문을 근거 범위와 함께 **검토용 작업 초안**으로 바꾼다. 사람이 승인하기 전에는 작업으로 확정하지 않으며 CAD 변경으로 연결하지 않는다.

이 선택은 소규모 설계사무소의 기밀 도면, 사용량 예측, 인터넷 장애에 맞춘 제품 정책이다. 법적·계약상 보존 조건을 대신 판단하지 않으며 고객 계약에 맞춰 프로젝트 설정을 잠근다.

## 공급자별 검증된 API 경계

| 공급자 | API·형식 경계 | 제품 어댑터 결정 |
|---|---|---|
| OpenAI | Responses API의 최종 JSON은 `text.format` 구조화 출력, 앱 기능 호출은 JSON Schema 기반 function calling이다. strict 함수 스키마는 객체별 `additionalProperties:false` 및 모든 필드 `required`를 요구한다. [구조화 출력](https://developers.openai.com/api/docs/guides/structured-outputs), [함수 호출](https://developers.openai.com/api/docs/guides/function-calling) | MVP에서는 **도구를 노출하지 않은 단일 구조화 응답**만 사용한다. `store:false`, 서버 대화 ID 미사용, 각 요청에 필요한 맥락만 전송. 거절·불완전 출력·schema 및 의미 검증 실패는 `abstain`으로 정규화한다. |
| Anthropic | Messages API는 stateless 다중 턴 입력을 받으며 `tool_use` 블록과 `tool_result`를 연결한다. JSON 결과는 `output_config.format`, 도구 입력은 `strict:true`의 별도 기능이다. [Messages](https://platform.claude.com/docs/en/api/messages/create), [구조화 출력](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) | 동일한 포트에 최종 JSON만 매핑한다. 도구 실행 루프는 사용하지 않는다. schema 컴파일 제한과 모델별 지원을 capability probe로 확인한다. |
| Google Gemini Developer API | 확인한 **Interactions** REST/SDK 예제는 `response_format: {type:'text', mime_type:'application/json', schema}`를 사용한다. 이는 GenerateContent의 매개변수 이름을 뜻하지 않는다. function calling은 별도의 함수 선언과 호출 결과 흐름이다. [Interactions 구조화 출력 예제](https://ai.google.dev/gemini-api/docs/structured-output), [함수 호출](https://ai.google.dev/gemini-api/docs/function-calling) | 먼저 endpoint family와 SDK 버전을 고정하고, 그 조합의 공식 예제로 요청 필드·저장 옵션을 확인한다. GenerateContent를 선택하면 해당 endpoint의 문서를 별도 검증한다. 공통 JSON Schema 부분집합을 로컬에서 다시 검증한다. |

어느 공급자도 schema 일치만으로 업무상 올바름을 보증하지 않는다. URL·경로·실행 명령·좌표 변경이 응답에 섞이면 무조건 거부한다. 도면 문자열과 참조 문서는 신뢰할 수 없는 **데이터**로 구분해 보낸다. 첫 릴리스에는 공급자 내장 web search, file search, code execution, MCP, 서버 저장 대화, 파일 업로드를 쓰지 않는다. 이런 기능은 별도 데이터흐름·요금·보존 검토와 명시적 프로젝트 정책이 생길 때만 추가한다.

## 앱 내부 계약

타입은 구현 언어와 무관한 조사 단계 예시다. 통합 canonical request/추출 reply의 최종 계획은 [AI 작업 계약](../ai-workflows.md)이 기준이다. 문서만 다루는 요청은 CAD snapshot 없이 sourceBundleHash에 묶고, source span은 Unicode code point 기준을 따른다. 선택된 Windows 앱의 **신뢰된 호스트 계층**이 전송 허가·비밀값·네트워크를 소유하고, UI 계층에는 요약 상태와 검증된 결과만 돌려준다. 호스트 기술은 아직 결정되지 않았다. 도메인 모델은 공급자 SDK를 import하지 않는다.

```ts
type AiTask = 'ExplainIssue' | 'ProposeIntent' | 'RankCandidates' | 'ExtractRevisionTasks';
type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'fake' | 'jev-placeholder';
type CloudPolicy = {
  mode: 'local-only' | 'per-request-consent';
  projectId: string; allowedProviders: ProviderId[]; allowedTasks: AiTask[];
  dataClass: 'public' | 'internal' | 'client-confidential' | 'restricted';
  maxInputTokens: number; maxOutputTokens: number; maxChargeUsdPerRequest: number;
  localMonthlyBudgetUsd: number; allowFreeTierGemini: false;
};
type AiRequest = {
  requestId: string; task: AiTask; projectPolicyVersion: string;
  snapshotHash: string | null; sourceBundleHash: string; profileHash: string; locale: 'ja-JP' | 'en-US';
  promptVersion: string; contextVersion: string; schemaVersion: string;
  candidateIds?: string[]; evidence: MinimizedEvidence;
  sourceSpans?: { sourceId: string; start: number; end: number }[];
  consentReceiptId: string; deadlineMs: number;
};
type AiReply =
  | { kind: 'explanation'; issueId: string; text: string; evidenceIds: string[] }
  | { kind: 'intent'; candidateIds: string[]; rationale: string; evidenceIds: string[] }
  | { kind: 'ranking'; rankedCandidateIds: string[]; rationale?: string }
  | { kind: 'revisionDraft'; tasks: {
      draftId: string; instruction: string; sourceSpanRefs: string[];
      targetCandidateIds: string[]; unresolvedFields: string[];
    }[] }
  | { kind: 'abstain'; reason: 'policy'|'refusal'|'invalid'|'timeout'|'quota'|'unavailable' };
interface AiProvider {
  capabilities(modelId: string): Promise<CapabilityReport>;
  estimate(request: AiRequest, modelId: string): Promise<CostBound>;
  invoke(request: AiRequest, modelId: string, signal: AbortSignal): Promise<ProviderEnvelope>;
}
```

`ProviderEnvelope`의 원시 텍스트는 SDK 경계에서만 파싱한다. 검증기는 공통 schema에 추가하여 (a) 현재 snapshot/profile hash 동일, (b) 모든 issue/evidence/candidate ID가 입력의 부분집합, (c) 후보 중복 없음, (d) 지정 locale의 설명 길이 상한 및 금지 필드 없음, (e) 수정 명령·새 좌표·법규 확정문 없음, (f) 응답 수락 시 consent와 policy 버전 유효를 검사한다. `RankCandidates`의 정상 기권·실패는 기존 결정론 순서를 반환한다. `ExplainIssue`는 측정값·rule ID·근거를 있는 그대로 보여 주고, AI 문장은 추가 설명으로 표시한다. `ProposeIntent`는 허용 action ID의 **선택 제안**일 뿐 Plan 생성이 아니다.

`ExtractRevisionTasks`는 일본어로 작성된 사용자 제공 수정 메모의 **원문을 바꾸지 않고** 보관하며, 전송에도 원문 span과 필요한 참조 정보만 쓴다. 응답의 각 초안은 원문 offset/span 별칭, 입력 목록 안의 대상 후보 별칭, 미해결 필드(예: 층·기준 그리드·치수 해석), 제안 문장을 포함한다. span은 원문과 byte/문자 기준을 명시해 재검증한다. 대상이 하나로 결정되지 않으면 후보를 남기고 기권 또는 사람 선택으로 보낸다. 사용자가 초안을 편집·승인하면 별도 업무 작업 목록에 기록할 수 있으나 이 포트는 Plan 또는 Jw 쓰기 호출을 생성하지 않는다.

## 전송 최소화와 동의

`MinimizedEvidence`는 요청별 allowlist serializer로 만든다. `ExplainIssue`에는 rule ID/버전, 위반 수치·단위·임계값, 익명화된 entity ID, 필요한 근거 조각만; `ProposeIntent`에는 사용자의 선택 텍스트와 허용 action ID, 필요한 속성만; `RankCandidates`에는 유한 후보 별칭·정규화된 특징값·하드 제약만 담는다. `ExtractRevisionTasks`에는 사용자가 선택한 수정 메모 원문과 위치 참조, 필요한 대상 후보 별칭만 담는다. 일본어 원문을 번역·정규화하거나 도면 문자를 바꾸지 않는다. 출력 언어는 `locale`로 지정하며 `ja-JP`와 `en-US`를 지원한다. JWW 전체, 파일 경로, 고객명, 주소, 도면 title block, 레이어 원문, 선택하지 않은 자유 형식 메모, 인접 도면, 감사 기록은 기본 제외한다. 필요하면 사용자가 필드별 추가 전송을 승인한다. 이름 치환만으로 재식별 불가능하다고 주장하지 않는다. 좌표·치수·프로젝트 특징 자체도 기밀로 취급한다.

전송 직전 내부 ID를 **요청별 무작위 별칭**으로 바꾸고, 응답 검증 후 로컬에서만 역매핑한다. 정적 JSON schema의 필드명·enum·const·정규식에는 프로젝트명, 고객명, 원시 객체 ID, 원문 문구를 넣지 않는다. 공급자는 schema를 캐시할 수 있으므로 후보 허용 목록은 요청 데이터에 두고 로컬 validator가 부분집합 여부를 확인한다. 이는 별칭이 포함된 payload 자체의 기밀성을 없애지 않는다.

전송 미리보기에는 실제 JSON의 사람이 읽을 수 있는 표현, 누락/마스킹 목록, 공급자와 모델 ID, 계정 과금 주체, 보존·학습 조건 링크, **예상 비용과 로컬 예산 기준**, 동의가 적용되는 `requestId`/snapshot hash를 보여 준다. payload hash를 로컬 영수증에 남긴다. 취소·다른 선택·다른 프로젝트·hash 변경은 영수증을 무효화한다. 전송 **전** 취소는 호출을 막는다. 전송 **후** 취소는 UI 대기 및 후속 로컬 적용을 중지하고 늦게 온 응답을 폐기하지만, 공급자 처리·보존·청구의 취소나 삭제를 보장하지 않는다. 자동 재시도는 **동일 payload·동일 공급자·동일 모델·동일 동의 범위**에서만 허용한다. 다른 공급자로 자동 우회하면 새 수신자 동의가 필요하다. restricted 자료는 회사 정책상 local-only로 잠그는 것이 권장값이다.

로컬 감사 기록에는 시각, 사용자/프로젝트 내부 ID, task, 공급자/모델, prompt/context/schema 버전, snapshot/payload hash, 동의 영수증, 토큰/비용/지연, 결과 상태를 남기고 payload 원문과 API key는 남기지 않는다. 디버그 원문 저장은 기본 꺼짐이며 별도의 기간 제한 및 암호화 정책이 필요하다. 전송 전에 경로·메일·전화·주소·고객명 패턴을 검사하되, 정규식으로 모든 민감정보가 제거된다고 보장하지 않는다.

## 계정·보존·요금 경계

| 방식 | 과금과 키 | 운영 판단 |
|---|---|---|
| BYOK, 사무소 계정 | 사무소가 각 공급자 API 프로젝트와 요금을 소유한다. Windows 호스트의 OS 자격 증명 저장소에 key/reference를 두고 프로세스 메모리로만 읽는다. UI 계층, 도면, 로그, 설정 JSON, installer에 key를 넣지 않는다. | 초기 파일럿 권장. 회사 관리자가 key 회전·폐기, 허용 모델, 공급자 대시보드 한도와 청구를 관리한다. 각 PC의 로컬 월 예산은 **권고/로컬 차단**이며 PC 간 동시 사용을 합산하는 보장된 사무소 총액 한도가 아니다. 개인 소비자 챗 구독은 API 과금·보존 조건의 증거가 아니다. |
| 관리형 office gateway | 사무소 또는 제품 운영자가 서버에서 공급자 키를 관리하고 사용자 인증·프로젝트별 예산·전송 감사·속도 제한을 집행한다. | 사무소 전체의 강제 한도가 필요하면 호출 전 중앙 **예산 예약**, 동시 요청 회계, 실제 사용량 정산, 실패/timeout 예약 해제, 재시도 비용 산입을 구현한다. 공급자 측 사용 한도와 함께 운용한다. 서버 운영, 추가 신뢰 경계, gateway 로그·보존·장애 비용이 생긴다. |

OpenAI API 입력은 명시적 opt-in 없이는 모델 학습에 사용되지 않는다. 그러나 기본 abuse monitoring 로그는 통상 최대 30일이고, Responses의 application state는 기본 저장 시 30일 이상이다. 따라서 `store:false`를 명시하더라도 **무보존 보장으로 표시하지 않는다**. 승인된 조직에만 Modified Abuse Monitoring/Zero Data Retention 같은 별도 제어가 있다. [OpenAI 데이터 제어](https://developers.openai.com/api/docs/guides/your-data). Anthropic API는 상업용 조건으로 학습과 소비자 제품 정책을 구분해야 하며, 표준 API 입력·출력은 예외를 제외해 30일 이내 삭제한다. Zero Data Retention은 별도 계약/적격 기능 문제다. 구조화 출력의 schema는 별도 캐시될 수 있으므로 schema 이름·enum에 고객 정보를 넣지 않는다. [Anthropic 보존](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [상업용 학습 설명](https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training), [API 기능별 보존](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention).

Gemini Developer API의 **무료 서비스**는 입력/출력을 제품 개선에 사용하고 사람 검토가 가능하므로 고객 도면 전송 기본값으로 허용하지 않는다. 활성 결제 계정에 연결된 프로젝트를 통한 **유료 서비스**는 프롬프트와 응답을 제품 개선에 사용하지 않는다는 약관이다. 다만 유료도 남용 감시용 제한 기간 로그가 있고, 검색 grounding 같은 기능은 별도 30일 보존이 생긴다. 설정에서 유료 프로젝트 여부를 사용자 주장만으로 확정하지 말고 관리자에게 해당 API 키의 프로젝트와 활성 결제 상태 증빙을 확인받아 기록한다. 출시 시점에 이를 자동 조회할 지원 API가 확인되지 않으면 수동 재검증 절차를 두고, 확인 불가면 호출을 막는다. [Gemini 추가 약관](https://ai.google.dev/gemini-api/terms), [Gemini 보존 설명](https://ai.google.dev/gemini-api/docs/zdr). 위 조건은 사용 지역·계약·API 기능별 예외가 있으므로 출시 직전 재확인한다.

## 프롬프트·평가·모델 레지스트리

`promptVersion`, `contextVersion`, `schemaVersion`, `rulesetVersion`, `modelConfigRevision`을 별도로 고정한다. 프롬프트는 Git에 사람이 검토 가능한 원문으로, 기밀 회사 profile은 로컬 project store에 버전과 hash로 보관한다. `contextVersion`은 allowlist serializer의 변경을 의미한다. 모델 레지스트리는 `{provider, exactModelId, endpointFamily, capabilityProbeDate, structuredOutput, maxContext, maxOutput, priceSnapshotDate, enabledTasks}`를 기록한다. alias가 변할 수 있으므로 평가와 감사에는 실제 응답의 모델 ID도 기록한다. 공급자별 모델 접근, 구조화 출력 지원, 가격은 계정과 날짜에 따라 확인하고, 문서에 고정된 기본 가격/성능 약속을 넣지 않는다.

일본어 원문과 `ja-JP`/`en-US` 출력 기대값을 갖춘 기밀 제거 또는 합성 fixture를 만든다. 각 fixture는 rule evidence, 유효 후보, 기대 기권 조건, 금지 유출 문자열을 포함한다. 프롬프트 또는 모델 변경은 baseline과 비교해 schema/ID 위반 0건, 기밀 필드 전송 0건, 좌표·치수 변경 0건을 필수 통과한다. `ExplainIssue`: 근거 누락·허위 규정 인용·선택 언어 가독성; `ProposeIntent`: 허용 ID 선택 precision 및 위험 요청 기권; `RankCandidates`: 결정론 baseline 대비 top-k, 기권율; `ExtractRevisionTasks`: 원문 span 일치, 대상 후보 정확도, 미해결 필드 포착, 무승인 작업/도면 변경 0건을 본다. p50/p95 latency, 입력/출력 토큰, 후보당 비용과 provider별 실패율도 기록한다. 목표치는 실제 사무소 fixture와 예산에서 정하고, fixture를 모델 학습·벤치마크 서비스에 자동 업로드하지 않는다. **현재 이 프롬프트 평가와 실 API 성능 평가는 실행하지 않았다.**

`FakeProvider`는 고정 응답, 지연, 429/503, timeout, malformed JSON, 유효하지만 범위 밖 ID, 거절, 오래된 snapshot, 중복 응답, 비용 추정 초과, 전송 후 취소와 늦은 응답을 재현한다. 네트워크 없이 UI·정책·fallback·감사를 통합 테스트한다. 실 API smoke test는 승인된 프로젝트 테스트 예산과 선택된 계정에서 합성 데이터로 수행한다.

## 비용 및 실패 운영

요청 전 **비용 추정과 전송 차단 기준**은 공급자/모델/지역/캐시 정책을 날짜별 가격표로 조회한다. 대략 `C_est = (I_uncached×P_in + I_cached×P_cached + O×P_out)/1,000,000 + 예상 tool/region/cache_write charges`이며 모든 토큰 가격은 해당 공급자의 실제 청구 단위를 확인한다. Anthropic의 cache write/read, Google의 thinking·caching 및 OpenAI의 여러 context 구간 같은 차이를 adapter 가격 함수에 반영한다. `O`에 설정된 최대 출력 토큰을 넣어도 **청구액의 보장된 상한은 아니다**. 모델별 내부 추론 과금, 캐시 적중/쓰기, 부가 기능, 이미 처리된 실패/재시도, 환율·세금, 공급자 가격 변경 및 사용량 집계 지연이 있다. 도구는 첫 릴리스에서 비활성화한다. 실제 청구는 응답 usage와 공급자 청구 자료로 대조한다. 재시도도 비용·quota를 쓸 수 있으므로 로컬 요청 예산에는 최대 재시도 수를 포함한다. 가격 정보가 없거나 추정도 불가능하면 전송을 막는다. 사무소 전체 **강제** 예산은 중앙 gateway의 예약·동시성 회계와 공급자 한도가 필요하다. [OpenAI 가격](https://developers.openai.com/api/docs/pricing), [Anthropic 가격](https://platform.claude.com/docs/en/about-claude/pricing), [Gemini 가격](https://ai.google.dev/gemini-api/docs/pricing).

429/일시적 5xx는 공급자의 `Retry-After`를 우선하고, 없으면 jitter를 둔 지수 backoff를 사용한다. SDK 자체 재시도까지 포함해 총 횟수·벽시계 deadline을 제한한다. 인증·결제·월 한도·정책 거부·schema 불일치는 자동 재시도하지 않는다. OpenAI는 429/503과 `Retry-After` 및 quota 문제를 구분하고, Anthropic은 429 rate limit과 spend limit을 구분한다. Gemini 제한은 RPM/TPM/RPD와 프로젝트 단위 조건에 따라 바뀐다. 모든 실패는 로컬 설명/결정론 순위로 끝내며 CAD 쓰기 승인 흐름에는 영향을 주지 않는다. [OpenAI 제한](https://developers.openai.com/api/docs/guides/rate-limits), [Anthropic 제한](https://platform.claude.com/docs/en/api/rate-limits), [Gemini 제한](https://ai.google.dev/gemini-api/docs/rate-limits).

## 구현 수용 게이트

- `local-only`에서 DNS/HTTP 호출 0건, 계정 없이 inspect/preview 완료.
- 동의 없는 요청, 프로젝트 정책 위반, Gemini 무료 tier, 알 수 없는 모델/capability, 설정된 로컬 **비용 추정 기준** 초과는 전송 전 거부.
- 전송 미리보기와 실제 직렬화 payload hash가 일치하고, snapshot·profile 변경 또는 취소 시 늦은 응답을 폐기. 이미 전송된 호출의 원격 처리·청구·삭제 취소를 약속하지 않음.
- 공급자 응답에서 알 수 없는 ID·중복 ID·새 좌표·명령·schema 오류가 나오면 `abstain`; 생성된 Plan을 직접 실행하는 경로 없음.
- 공급자 장애·오프라인·429·timeout에서 결정론 결과가 유지되고 다른 공급자에게 묵시적으로 전송하지 않음.
- 원시 고객 내용과 key가 앱 로그·crash report·telemetry·UI renderer 저장소에 없음.
- prompt/context/schema/model 변경마다 합성 fixture의 `ja-JP`/`en-US` 회귀 평가와 비용/지연 기록을 재생성. `ExtractRevisionTasks`는 원문 span·대상 ID·미해결 필드·사람 승인 경계를 검증.
- 여러 PC를 쓰는 사무소 전체 강제 지출 한도를 제공한다고 표시하려면 gateway의 예약·동시 호출 회계·정산/해제 시험 통과.
- 실제 API 연결 활성화 전 각 계정의 현재 모델 접근·가격·보존·키 보관·회전과 배포 지역을 재검증.

## 확인한 1차 자료 목록

2026-09-23에 아래 **실제 페이지를 열어** 확인했다. 링크의 공급자 문서는 현재 상태를 보여 주며 출시 전에 갱신 확인이 필요하다.

| 주제 | 공식 원문 |
|---|---|
| OpenAI 형식·도구 | [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Function calling](https://developers.openai.com/api/docs/guides/function-calling) |
| OpenAI 데이터·비용·운영 | [Your data](https://developers.openai.com/api/docs/guides/your-data), [Pricing](https://developers.openai.com/api/docs/pricing), [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [Production best practices](https://developers.openai.com/api/docs/guides/production-best-practices) |
| Anthropic 형식·운영 | [Messages API](https://platform.claude.com/docs/en/api/messages/create), [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Rate limits](https://platform.claude.com/docs/en/api/rate-limits), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Anthropic 보존·학습 | [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), [Organization retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [Commercial training explanation](https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training) |
| Gemini 형식·계정 | [Structured output](https://ai.google.dev/gemini-api/docs/structured-output), [Function calling](https://ai.google.dev/gemini-api/docs/function-calling), [API keys](https://ai.google.dev/gemini-api/docs/api-key) |
| Gemini 데이터·비용·제한 | [Additional terms](https://ai.google.dev/gemini-api/terms), [Data retention](https://ai.google.dev/gemini-api/docs/zdr), [Pricing](https://ai.google.dev/gemini-api/docs/pricing), [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) |
