import { checkSnapshot, createPlan, previewPlan, applyPlan, defaultProfile } from "../core/engine.mjs";
import { importJwcTemp } from "../jw-adapter/importer.mjs";
import { verifyCapturePair } from "../jw-adapter/capture-bundle.mjs";
import { catalogs, message } from "./locales.mjs";
import { emptyWorkspace, reviseProfile, createContextKey, recordReview, reviewsForContext, createWorkspaceStore } from "../review/store.mjs";
import { reviewCsv } from "../review/export.mjs";
import { createFieldPanel } from "./field-panel.mjs";
import { createRestorePanel } from "./restore-panel.mjs";
import { createProjectPanel } from './project-panel.mjs';
import { encodeBytes, projectStorage } from '../project/file.mjs';
import { fieldContextKey } from '../field/standards.mjs';
let fieldStorage; try { fieldStorage = window.localStorage; } catch {}
let fieldPanel = createFieldPanel(fieldStorage);
let contextGeneration = 0;

const SVG_NS = "http://www.w3.org/2000/svg";
const localeKey = "fresco-jw-assistant-locale";
const motionKey = "fresco-jw-assistant-reduce-motion";
const app = document.querySelector("#app");
const liveRegion = document.querySelector("#live-region");
let reviewStore;
try { reviewStore = createWorkspaceStore(window.localStorage, "fresco-jw-review-v1"); }
catch (storageError) { reviewStore = { load() { throw storageError; }, loadBackup() { throw storageError; }, save() { throw storageError; } }; }
function readPreference(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function savePreference(key, value) { try { localStorage.setItem(key, value); } catch { /* Keep the current session usable when storage is unavailable. */ } }

const state = {
  locale: Object.hasOwn(catalogs, readPreference(localeKey)) ? readPreference(localeKey) : "ja-JP",
  reduceMotion: readPreference(motionKey) === "true",
  baseSnapshot: null,
  snapshot: null,
  issues: [],
  selectedIssueId: null,
  selectedFixIds: new Set(),
  plan: null,
  previewSnapshot: null,
  history: [],
  error: null,
  nextFocusKey: null,
  reportJson: null,
  mode: "demo", importBytes: null, importFileName: "", importResult: null, captureMetadataBytes: null, captureMetadataFileName: "", captureVerification: null,
  importEncoding: "shift_jis", importCalibration: "unknown", importConfirmed: false,
  importGroup: "", importBusy: false, importRequest: 0, importIssues: [],
  reviewWorkspace: emptyWorkspace(), reviewStoreReady: false, reviewStoreError: null, reviewContextKey: null,
  officeShortLine: "3", officeGap: "2", officeLayers: "WALL\nOPENING\nGRID\nANNOTATION", reviewDraftStatus: "reviewing", reviewDraftNote: "", officeOpen: false
};
let officeBaseline = [state.officeShortLine, state.officeGap, state.officeLayers];
function hasUnsavedReview() {
  const saved = state.reviewContextKey && reviewsForContext(state.reviewWorkspace, state.reviewContextKey).find(item => item.issueId === state.selectedIssueId);
  return JSON.stringify([state.officeShortLine, state.officeGap, state.officeLayers]) !== JSON.stringify(officeBaseline)
    || state.reviewDraftStatus !== (saved?.status ?? 'reviewing') || state.reviewDraftNote !== (saved?.note ?? '');
}
function makeReviewRecovery() { return createRestorePanel({ id: 'review', store: reviewStore,
  title: { ja: '事務所ルール・検討記録の復元', en: 'Restore office rules and review decisions' },
  describe: (value, locale) => locale === 'ja-JP'
    ? `検討 ${value.reviews.length}件・事務所ルール ${value.profile ? 'あり' : 'なし'}`
    : `${value.reviews.length} decisions; office rules ${value.profile ? 'included' : 'absent'}`,
  hasUnsaved: () => hasUnsavedReview() || fieldPanel.hasUnsaved(),
  onRestore(next) {
    state.reviewWorkspace = next; state.reviewStoreReady = true; state.reviewStoreError = null;
    state.reviewDraftStatus = 'reviewing'; state.reviewDraftNote = ''; clearReviewContext();
    const profile = next.profile ?? state.importResult?.profile;
    if (profile) setOfficeDraft(profile);
    else { state.officeShortLine = '3'; state.officeGap = '2'; state.officeLayers = 'WALL\nOPENING\nGRID\nANNOTATION'; officeBaseline = [state.officeShortLine, state.officeGap, state.officeLayers]; }
    if (state.importBytes && state.mode === 'import') void processImport(); else render();
  },
}); }
let reviewRecovery = makeReviewRecovery();
const browserReviewStore = reviewStore;
let browserSession = null;
const projectPanel = createProjectPanel({
  hasDrafts: () => hasUnsavedReview() || fieldPanel.hasUnsaved() || state.importBusy,
  readSaved: () => ({ review: reviewStore.load(), field: fieldPanel.savedWorkspace() }),
  refresh: () => render(),
  async captureCurrent() {
    if (state.mode !== 'import' || !state.reviewContextKey || !state.importResult?.snapshot) throw Object.assign(new Error(), { code: 'E_PROJECT_IMPORT_FIRST' });
    const review = structuredClone(state.reviewWorkspace), field = fieldPanel.savedWorkspace();
    review.reviews = review.reviews.filter(item => item.contextKey === state.reviewContextKey);
    const fieldKey = await fieldContextKey(state.reviewContextKey, field.layerMap);
    field.cards = field.cards.filter(item => item.contextKey === fieldKey);
    return { format: 'fresco-jw-project', schemaVersion: 1, id: crypto.randomUUID(), name: state.importFileName,
      savedAt: new Date().toISOString(), review, field,
      capture: { name: state.importFileName, sha256: state.importResult.source.sha256, base64: encodeBytes(state.importBytes),
        metadataBase64: state.captureMetadataBytes ? encodeBytes(state.captureMetadataBytes) : null,
        encoding: state.importEncoding, coordinateMode: state.importResult.source.coordinateMode, group: state.importResult.coverage.selectedGroup } };
  },
  async install(candidate) {
    if (!browserSession) browserSession = { fieldPanel, state: { ...state } };
    const storage = projectStorage(candidate.project);
    reviewStore = createWorkspaceStore(storage, 'fresco-jw-review-v1'); fieldPanel = createFieldPanel(storage); reviewRecovery = makeReviewRecovery();
    state.reviewWorkspace = reviewStore.load(); state.reviewStoreReady = true; state.reviewStoreError = null;
    state.reviewDraftStatus = 'reviewing'; state.reviewDraftNote = '';
    state.importBytes = candidate.bytes; state.importFileName = candidate.project.capture.name;
    state.captureMetadataBytes = candidate.metadata; state.captureMetadataFileName = candidate.metadata ? 'metadata.json' : '';
    state.captureVerification = candidate.verification; state.importEncoding = candidate.project.capture.encoding;
    state.importCalibration = candidate.project.capture.coordinateMode; state.importConfirmed = true;
    state.importGroup = candidate.project.capture.group;
    if (state.reviewWorkspace.profile) setOfficeDraft(state.reviewWorkspace.profile);
    await processImport();
  },
  async close() {
    const previous = browserSession; browserSession = null;
    reviewStore = browserReviewStore; fieldPanel = previous.fieldPanel; reviewRecovery = makeReviewRecovery();
    const nextRequest = state.importRequest + 1; Object.assign(state, previous.state); state.importRequest = nextRequest;
    state.reviewDraftStatus = 'reviewing'; state.reviewDraftNote = ''; clearReviewContext();
    await loadReviewWorkspace();
    if (state.mode === 'import' && state.importBytes) await processImport();
    else setOfficeDraft(state.reviewWorkspace.profile ?? defaultProfile);
  },
});

async function loadReviewWorkspace() {
  try { state.reviewWorkspace = await reviewStore.load(); state.reviewStoreReady = true; state.reviewStoreError = null; if (state.reviewWorkspace.profile) setOfficeDraft(state.reviewWorkspace.profile); if (state.importResult?.snapshot) { state.importIssues = checkSnapshot(state.importResult.snapshot, effectiveImportProfile()); void updateReviewContext(); } render(); }
  catch { state.reviewStoreError = "load"; state.reviewStoreReady = false; render(); }
}
function setOfficeDraft(profile) { state.officeShortLine = String(profile.shortLineMm); state.officeGap = String(profile.gapMm); state.officeLayers = profile.allowedLayers.join("\n"); officeBaseline = [state.officeShortLine, state.officeGap, state.officeLayers]; }
function effectiveImportProfile() { return state.reviewWorkspace.profile ?? state.importResult?.profile ?? null; }
function clearReviewContext() { ++contextGeneration; state.reviewContextKey = null; }
async function updateReviewContext(request = state.importRequest) {
  const generation = ++contextGeneration;
  const result = state.importResult;
  if (state.mode !== "import" || !result?.snapshot || !result.source?.sha256 || !state.captureVerification && state.captureMetadataFileName) { clearReviewContext(); render(); return; }
  const profile = effectiveImportProfile(); if (!profile) { clearReviewContext(); return; }
  const groupId = result.coverage?.selectedGroup ?? (result.metadata?.groups?.length === 1 ? result.metadata.groups[0].id : null);
  if (groupId == null) { clearReviewContext(); render(); return; }
  try {
  const key = await createContextKey({ sourceHash: result.source.sha256, encoding: result.source.encoding, coordinateMode: result.source.coordinateMode, groupId, profile });
  if (generation !== contextGeneration || state.mode !== "import" || profile !== effectiveImportProfile() || request !== state.importRequest || result !== state.importResult) return;
  state.reviewContextKey = key;
  const saved = reviewsForContext(state.reviewWorkspace, key).find((item) => item.issueId === state.selectedIssueId);
  state.reviewDraftStatus = saved?.status ?? "reviewing"; state.reviewDraftNote = saved?.note ?? "";
  render();
  } catch { if (generation === contextGeneration) { clearReviewContext(); state.reviewStoreError = "load"; render(); } }
}
function reviewsInCurrentContext() { return state.reviewContextKey ? reviewsForContext(state.reviewWorkspace, state.reviewContextKey) : []; }
async function saveOfficeProfile() {
  if (!state.reviewStoreReady || state.mode !== "import") return;
  const layers = state.officeLayers.split(/\r?\n/).map(layer => layer.trim()).filter(Boolean);
  let candidate;
  try {
    if (!state.officeShortLine.trim() || !state.officeGap.trim()) throw new Error("blank");
    candidate = reviseProfile(state.reviewWorkspace, {shortLineMm:Number(state.officeShortLine), gapMm:Number(state.officeGap), allowedLayers:layers});
  } catch { state.reviewStoreError = "profile"; render(); return; }
  try { state.reviewWorkspace = reviewStore.save(candidate); }
  catch (error) { state.reviewStoreError = error?.code === "E_REVIEW_CONFLICT" ? "conflict" : "save"; render(); say("reviewNotSaved"); return; }
  state.reviewStoreError = null; setOfficeDraft(state.reviewWorkspace.profile); reviewRecovery.invalidate(); clearReviewContext(); say("officeSaved");
  if (state.importBytes) await processImport(); else render();
}
async function saveIssueReview() {
  const issue = selectedIssue(); if (state.mode !== "import" || !state.reviewContextKey || !issue || !state.reviewStoreReady) return;
  if (state.reviewDraftNote.length > 2000 || (state.reviewDraftStatus === "excluded" && !state.reviewDraftNote.trim())) { state.reviewStoreError = "reason"; render(); return; }
  try {
    const candidate = recordReview(state.reviewWorkspace, { contextKey: state.reviewContextKey, issueId: issue.id, status: state.reviewDraftStatus, note: state.reviewDraftNote });
    state.reviewWorkspace = await reviewStore.save(candidate); state.reviewStoreError = null; reviewRecovery.invalidate(); render(); say("reviewSaved");
  } catch (error) { state.reviewStoreError = error?.code === "E_REVIEW_CONFLICT" ? "conflict" : "save"; render(); say("reviewNotSaved"); }
}
async function showReviewBackup() {
  try { state.reportJson = JSON.stringify(await reviewStore.loadBackup() ?? { message: t("noBackup") }, null, 2); state.reportDialogTitle = t("backupTitle"); state.reportDialogHelp = t("backupHelp"); state.reportDialogLabel = t("backupTitle"); render(); document.querySelector("#report-dialog")?.showModal(); }
  catch { state.reviewStoreError = "backup"; render(); }
}
function showCsvExport() {
  if (!state.reviewContextKey) return;
  state.reportJson = reviewCsv(state.importIssues, reviewsInCurrentContext(), state.reviewContextKey); state.reportDialogTitle = t("csvTitle"); state.reportDialogHelp = t("csvHelp"); state.reportDialogLabel = t("csvTitle"); render(); document.querySelector("#report-dialog")?.showModal();
}
function showReadonlyDialog(title, body, label) {
  state.reportJson = JSON.stringify({ title, text: body }, null, 2); state.reportDialogTitle = title; state.reportDialogHelp = label; state.reportDialogLabel = label; render();
  document.querySelector("#report-dialog")?.showModal();
}

function t(key, values) { return message(state.locale, key, values); }
function say(key, values) { liveRegion.textContent = t(key, values); }
function element(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) node.type = options.type;
  if (options.id) node.id = options.id;
  if (options.disabled) node.disabled = true;
  if (options.attributes) for (const [name, value] of Object.entries(options.attributes)) node.setAttribute(name, String(value));
  if (options.on) for (const [name, listener] of Object.entries(options.on)) node.addEventListener(name, listener);
  return node;
}
function svgElement(tag, attributes = {}) { const node = document.createElementNS(SVG_NS, tag); for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value)); return node; }
function stableError(error) { return error && typeof error.code === "string" ? error.code : "UI_UNEXPECTED"; }
function handleError(error) { state.error = stableError(error); render(); say("statusError", { code: state.error.startsWith("E_IMPORT_") ? t("importError") : state.error.startsWith("E_BUNDLE_") ? t("captureBundleError") : state.error }); }
function fixableIssues() { return activeIssues().filter((issue) => issue.fixable); }
function selectedIssue() { return activeIssues().find((issue) => issue.id === state.selectedIssueId) || null; }
function displaySnapshot() { return state.previewSnapshot || state.snapshot; }
function activeSnapshot() { return state.mode === "import" ? state.importResult?.snapshot ?? null : displaySnapshot(); }
function activeIssues() { return state.mode === "import" ? state.importIssues : state.issues; }
function issueDescription(ruleId) { return t(`${state.mode === "import" && ["exact-duplicate", "zero-length"].includes(ruleId) ? "importIssueDescription" : "issueDescription"}.${ruleId}`); }
function ruleTitle(ruleId) { return t(({ "exact-duplicate": "exactDuplicate", "zero-length": "zeroLength", "short-line": "shortLine", "near-gap": "nearGap", "unknown-layer": "unknownLayer" })[ruleId] || "error"); }
function setLocale(locale) { state.locale = Object.hasOwn(catalogs, locale) ? locale : "ja-JP"; savePreference(localeKey, state.locale); document.documentElement.lang = state.locale; render(); say("statusLanguage"); }
function setMotion(reduceMotion) { state.reduceMotion = reduceMotion; savePreference(motionKey, String(reduceMotion)); document.body.classList.toggle("reduce-motion", reduceMotion); }
function switchMode(mode) {
  if (projectPanel.isActive()) return;
  ++state.importRequest;
  state.importBusy = false;
  state.mode = mode;
  clearReviewContext(); state.reviewDraftNote = ""; state.reviewDraftStatus = "reviewing";
  state.error = null;
  state.plan = null;
  state.previewSnapshot = null;
  state.selectedFixIds.clear();
  state.selectedIssueId = activeIssues()[0]?.id ?? null;
  render();
  if (mode === "import") void updateReviewContext();
}

async function loadDemo() {
  try {
    const response = await fetch("../fixtures/timber-plan.json", { cache: "no-store" });
    if (!response.ok) throw Object.assign(new Error("Fixture unavailable"), { code: "FIXTURE_UNAVAILABLE" });
    state.baseSnapshot = await response.json();
    state.snapshot = structuredClone(state.baseSnapshot);
    runCheck(false);
    state.error = null;
    render();
    say("statusReady");
  } catch (error) { handleError(error); }
}
function runCheck(announce = true) {
  if (state.mode === "import") {
    if (!state.importResult?.snapshot) return;
    try { state.importIssues = checkSnapshot(state.importResult.snapshot, effectiveImportProfile()); state.selectedIssueId = state.importIssues[0]?.id ?? null; state.error = null; render(); if (announce) say("statusChecked", { count: state.importIssues.length }); void updateReviewContext(); }
    catch (error) { handleError(error); }
    return;
  }
  try {
    state.issues = checkSnapshot(state.snapshot, defaultProfile);
    if (!state.selectedIssueId || !state.issues.some((issue) => issue.id === state.selectedIssueId)) state.selectedIssueId = state.issues[0]?.id ?? null;
    const validFixable = new Set(fixableIssues().map((issue) => issue.id));
    state.selectedFixIds = new Set([...state.selectedFixIds].filter((id) => validFixable.has(id)));
    state.error = null;
    render();
    if (announce) say("statusChecked", { count: state.issues.length });
  } catch (error) { handleError(error); }
}
function selectIssue(issueId) { state.selectedIssueId = issueId; const saved = state.reviewContextKey && reviewsForContext(state.reviewWorkspace, state.reviewContextKey).find((item) => item.issueId === issueId); state.reviewDraftStatus = saved?.status ?? "reviewing"; state.reviewDraftNote = saved?.note ?? ""; render(); say("statusSelected", { id: issueId }); }
function toggleFixable(issueId, checked) { if (state.mode === "import") return; if (checked) state.selectedFixIds.add(issueId); else state.selectedFixIds.delete(issueId); render(); }
function selectAllFixable() { if (state.mode === "import") return; state.selectedFixIds = new Set(fixableIssues().map((issue) => issue.id)); render(); }
function startPreview() {
  if (state.mode === "import") return;
  if (!state.selectedFixIds.size) { say("emptySelection"); return; }
  try {
    state.plan = createPlan(state.snapshot, [...state.selectedFixIds], defaultProfile);
    state.previewSnapshot = previewPlan(state.snapshot, state.plan);
    state.nextFocusKey = "apply-demo";
    state.error = null;
    render();
    say("statusPreview", { count: state.plan.removals.length });
  } catch (error) { handleError(error); }
}
function cancelPreview() { state.plan = null; state.previewSnapshot = null; state.nextFocusKey = "preview"; render(); say("statusCancelled"); }
function openApplyDialog() { const dialog = document.querySelector("#apply-dialog"); if (dialog && !dialog.open) dialog.showModal(); }
function closeDialog() { const dialog = document.querySelector("#apply-dialog"); if (dialog?.open) dialog.close(); }
function applyToDemo() {
  if (state.mode === "import") return;
  try {
    const next = applyPlan(state.snapshot, state.plan, true);
    state.history.push(state.snapshot);
    state.snapshot = next;
    state.plan = null;
    state.previewSnapshot = null;
    state.selectedFixIds.clear();
    state.nextFocusKey = "undo";
    closeDialog();
    runCheck(false);
    say("statusApplied");
  } catch (error) { state.nextFocusKey = null; closeDialog(); handleError(error); }
}
function undoPreviewEdit() {
  if (state.mode === "import") return;
  const prior = state.history.pop();
  if (!prior) return;
  state.snapshot = { ...structuredClone(prior), revision: state.snapshot.revision + 1 };
  state.nextFocusKey = state.history.length ? "undo" : "run-check";
  state.plan = null;
  state.previewSnapshot = null;
  state.selectedFixIds.clear();
  runCheck(false);
  say("statusUndone");
}
function resetDemo() {
  if (state.mode === "import") { switchMode("demo"); return; }
  if (!state.baseSnapshot) return;
  state.snapshot = structuredClone(state.baseSnapshot);
  state.history = [];
  state.plan = null;
  state.previewSnapshot = null;
  state.selectedFixIds.clear();
  runCheck(false);
  say("statusReset");
}
function exportReview() {
  if (state.mode === "import" && state.captureMetadataFileName && !state.captureVerification) return;
  const report = state.mode === "import"
    ? { generatedAt: new Date().toISOString(), mode: state.importResult?.mode ?? "jwc-temp-read-only", jwCadConnected: false, source: state.importResult?.source ?? null, metadata: state.importResult?.metadata ?? null, captureVerification: state.captureVerification ?? { integrity: "raw-unverified", sourceAuthentication: "unverified" }, coverage: state.importResult?.coverage ?? null, profile: effectiveImportProfile(), contextKey: state.reviewContextKey, reviews: reviewsInCurrentContext(), diagnostics: state.importResult?.diagnostics ?? [], issues: state.importIssues }
    : { generatedAt: new Date().toISOString(), mode: "synthetic-local", jwCadConnected: false, document: state.snapshot?.documentId ?? null, revision: state.snapshot?.revision ?? null, issues: state.issues };
  state.reportJson = JSON.stringify(report, null, 2);
  state.reportDialogTitle = t("reportTitle"); state.reportDialogHelp = t("reportHelp"); state.reportDialogLabel = t("reportJsonLabel");
  state.nextFocusKey = "settings-export";
  render();
  document.querySelector("#report-dialog")?.showModal();
  say("statusReportPrepared");
}

async function processImport() {
  if (!state.importBytes) return;
  clearReviewContext();
  // A selected metadata file remains authoritative until it has been read and
  // verified, or the user explicitly removes it. Option changes can rerender
  // this flow while File.arrayBuffer() is pending or after it failed.
  if (state.captureMetadataFileName && !state.captureMetadataBytes) {
    state.importResult = null; state.importIssues = []; state.selectedIssueId = null;
    state.importBusy = false; state.plan = null; state.previewSnapshot = null; state.selectedFixIds.clear();
    render();
    return;
  }
  const request = ++state.importRequest;
  const importFocus = document.activeElement?.dataset?.focusKey;
  state.mode = "import";
  state.importResult = null; state.importIssues = []; state.selectedIssueId = null;
  state.plan = null; state.previewSnapshot = null; state.selectedFixIds.clear();
  state.importBusy = true; state.error = null; render();
  try {
    let captureVerification = null;
    if (state.captureMetadataBytes) {
      state.captureVerification = null;
      render();
      captureVerification = await verifyCapturePair(state.importBytes, state.captureMetadataBytes);
      if (request !== state.importRequest) return;
      state.captureVerification = captureVerification;
    }
    const calibration = state.importCalibration === "unknown" || !state.importConfirmed ? undefined
      : { coordinateMode: state.importCalibration, source: "user-confirmed" };
    const result = await importJwcTemp(state.importBytes, { encoding: state.importEncoding, ...(state.importGroup ? { selectedGroup: state.importGroup } : {}), ...(calibration ? { calibration } : {}) });
    if (request !== state.importRequest) return;
    state.importResult = result; state.importBusy = false; state.mode = "import";
    if (!state.reviewWorkspace.profile && result.profile) setOfficeDraft(result.profile);
    if (captureVerification) result.captureVerification = captureVerification;
    state.importIssues = result.snapshot ? checkSnapshot(result.snapshot, effectiveImportProfile()) : [];
    state.selectedIssueId = state.importIssues[0]?.id ?? null;
    state.nextFocusKey = importFocus; render(); say(result.snapshot ? "statusImportReady" : "statusImportNeedsSetup");
    await updateReviewContext(request);
  } catch (error) {
    if (request !== state.importRequest) return;
    state.importBusy = false; state.importResult = null; state.importIssues = []; state.captureVerification = null; handleError(error);
  }
}
function chooseImportFile(file) {
  if (!file) return;
  ++state.importRequest; clearReviewContext(); state.mode = "import"; state.importBusy = true;
  state.importBytes = null; state.importResult = null; state.importIssues = [];
  state.captureMetadataBytes = null; state.captureMetadataFileName = ""; state.captureVerification = null;
  state.plan = null; state.previewSnapshot = null; state.selectedFixIds.clear(); state.selectedIssueId = null;
  state.importGroup = ""; state.importConfirmed = false; state.importCalibration = "unknown";
  if (file.size > 8 * 1024 * 1024) { state.importBusy = false; state.importFileName = file.name; state.error = "E_IMPORT_OVERSIZE"; render(); return; }
  const request = state.importRequest; state.importFileName = file.name; state.error = null; render();
  file.arrayBuffer().then((buffer) => {
    if (request !== state.importRequest) return;
    state.importBytes = new Uint8Array(buffer); state.mode = "import"; processImport();
  }).catch((error) => { if (request === state.importRequest) { state.importBusy = false; handleError(error); } });
}

function chooseCaptureMetadata(file) {
  if (!file || !state.importBytes) return;
  clearReviewContext();
  ++state.importRequest;
  state.mode = "import"; state.importBusy = true; state.importResult = null; state.importIssues = []; state.selectedIssueId = null;
  state.plan = null; state.previewSnapshot = null; state.selectedFixIds.clear();
  state.captureVerification = null; state.error = null;
  state.captureMetadataBytes = null; state.captureMetadataFileName = file.name;
  if (file.size > 64 * 1024) { state.importBusy = false; state.error = "E_BUNDLE_METADATA_OVERSIZE"; render(); return; }
  const request = state.importRequest; render();
  file.arrayBuffer().then((buffer) => {
    if (request !== state.importRequest) return;
    state.captureMetadataBytes = new Uint8Array(buffer); processImport();
  }).catch((error) => { if (request === state.importRequest) { state.importBusy = false; handleError(error); } });
}

function removeCaptureMetadata() {
  clearReviewContext();
  ++state.importRequest; state.captureMetadataBytes = null; state.captureMetadataFileName = ""; state.captureVerification = null;
  state.importResult = null; state.importIssues = []; state.error = null; state.importBusy = false;
  if (state.importBytes) processImport(); else render();
}

function renderDrawing(snapshot, issue, plan) {
  const svg = svgElement("svg", { class: "drawing", role: "img", "aria-label": t("drawing") });
  const entities = snapshot?.entities ?? [];
  const focus = issue?.location;
  const selectedEntities = issue ? entities.filter((entity) => issue.entityIds.includes(entity.id)) : entities;
  const points = (selectedEntities.length ? selectedEntities : entities).flatMap((entity) => [entity.start, entity.end]);
  if (!points.length) points.push([0, 0]);
  if (focus) points.push(focus);
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const span = Math.max(maxX - minX, maxY - minY, 20); const padding = Math.max(span * .18, 16);
  svg.setAttribute("viewBox", `${minX - padding} ${-maxY - padding} ${span + padding * 2} ${span + padding * 2}`);
  const removals = new Set(plan?.removals ?? []);
  for (const entity of entities) {
    const selected = issue?.entityIds.includes(entity.id);
    const line = svgElement("line", { x1: entity.start[0], y1: -entity.start[1], x2: entity.end[0], y2: -entity.end[1], stroke: selected ? "#805500" : "#0b3d70", "stroke-width": selected ? 4 : 2.4, "vector-effect": "non-scaling-stroke", "stroke-linecap": "round" });
    svg.append(line);
    if (removals.has(entity.id)) {
      const mark = svgElement("line", { x1: entity.start[0], y1: -entity.start[1], x2: entity.end[0], y2: -entity.end[1], stroke: "#9d2433", "stroke-width": 8, "stroke-dasharray": "6 5", opacity: ".82", "vector-effect": "non-scaling-stroke", "stroke-linecap": "round" });
      svg.append(mark);
    }
  }
  if (focus) {
    svg.append(svgElement("circle", { cx: focus[0], cy: -focus[1], r: Math.max(span * .025, 4), fill: "none", stroke: "#07599d", "stroke-width": 3, "vector-effect": "non-scaling-stroke" }));
  }
  return svg;
}

function issueRow(issue) {
  const row = element("li", { className: "issue-row" });
  if (issue.fixable) {
    const check = element("input", { className: "check", type: "checkbox", disabled: state.mode === "import" || Boolean(state.previewSnapshot), attributes: { "aria-label": `${ruleTitle(issue.ruleId)}, ${issue.id}, ${t(state.mode === "import" ? "observed" : "fixable")}`, "data-focus-key": `fix:${issue.id}` } });
    check.checked = state.selectedFixIds.has(issue.id);
    check.addEventListener("change", () => toggleFixable(issue.id, check.checked));
    const checkHit = element("label", { className: "check-hit" });
    checkHit.append(check);
    row.append(checkHit);
  } else row.append(element("span", { className: "check-placeholder", attributes: { "aria-hidden": "true" } }));
  const button = element("button", { className: "issue-row__select", type: "button", attributes: { "aria-pressed": String(issue.id === state.selectedIssueId), "data-focus-key": `issue:${issue.id}` }, on: { click: () => selectIssue(issue.id) } });
  const body = element("span", { className: "issue-row__body" });
  const title = element("span", { className: "issue-row__title" });
  title.append(element("span", { text: ruleTitle(issue.ruleId) }));
  title.append(element("span", { className: `severity-tag ${issue.severity === "error" ? "error" : "warning"}`, text: t(issue.severity === "error" ? "severityCritical" : "severityWarning") }));
  title.append(element("span", { className: `kind-tag ${issue.fixable ? "fixable" : "observed"}`, text: t(state.mode === "import" ? "observed" : issue.fixable ? "fixable" : "observed") }));
  body.append(title, element("span", { className: "issue-row__detail", text: issueDescription(issue.ruleId) }), element("span", { className: "issue-row__id", text: issue.id }));
  button.append(body); row.append(button); return row;
}

function render() {
  const focusKey = state.nextFocusKey || document.activeElement?.dataset?.focusKey;
  state.nextFocusKey = null;
  document.documentElement.lang = state.locale;
  document.title = t("pageTitle");
  const skipLink = document.querySelector("#skip-link");
  if (skipLink) skipLink.textContent = t("skipReview");
  document.body.classList.toggle("reduce-motion", state.reduceMotion);
  app.replaceChildren();
  const shell = element("div", { className: "app-shell" });
  const sidebar = element("aside", { className: "sidebar", attributes: { "aria-label": t("appName") } });
  const brand = element("a", { className: "brand", attributes: { href: "#workspace" } });
  const brandText = element("span"); brandText.append(element("span", { className: "brand-name", text: t("appName") }), element("span", { className: "brand-sub", text: t("tagline") })); brand.append(element("span", { className: "brand-mark", text: "F" }), brandText);
  sidebar.append(brand);
  sidebar.append(element('a', { className: 'nav-link', text: 'JWW Studio · 編集 / AI', attributes: { href: 'studio.html' } }));
  const nav = element("nav", { attributes: { "aria-label": t("appName") } }); const navList = element("ul", { className: "nav-list" });
  const reviewLink = element("a", { className: "nav-link", text: t("review"), attributes: { href: "#workspace", "aria-current": "page", "data-focus-key": "nav-review" } }); const settingsLink = element("a", { className: "nav-link", text: t("settings"), attributes: { href: "#settings", "data-focus-key": "nav-settings" } }); navList.append(element("li", {}), element("li", {})); navList.children[0].append(reviewLink); navList.children[1].append(settingsLink); nav.append(navList); sidebar.append(nav);
  const sideBottom = element("div", { className: "sidebar-bottom" }); sideBottom.append(element("div", { text: t("disconnected") }), element("div", { text: t("provider") })); sidebar.append(sideBottom);

  const main = element("main", { className: "main" }); const topbar = element("header", { className: "topbar" }); const titleWrap = element("div"); titleWrap.append(element("p", { className: "eyebrow", text: t(state.mode === "import" ? "readOnlyTag" : "synthetic") }), element("h1", { className: "topbar-title", text: state.mode === "import" ? (state.importFileName || t("sourceTitle")) : t("document") })); topbar.append(titleWrap, element("span", { className: "badge", text: t("disconnected") })); main.append(topbar);
  const workspace = element("section", { className: "workspace", id: "workspace", attributes: { "aria-label": t("review") } });
  workspace.append(projectPanel.render(state.locale));
  const sourcePanel = element("section", { className: "panel source-panel", attributes: { "aria-labelledby": "source-heading" } });
  const sourceHead = element("div", { className: "panel-heading" }); sourceHead.append(element("h2", { className: "panel-title", id: "source-heading", text: t("sourceTitle") })); sourcePanel.append(sourceHead);
  const sourceBody = element("div", { className: "settings-list source-controls" });
  const modeRow = element("div", { className: "mode-switch", attributes: { role: "group", "aria-label": t("sourceMode") } });
  modeRow.append(element("button", { className: `button${state.mode === "demo" ? " primary" : ""}`, type: "button", text: t("demoMode"), attributes: { "aria-pressed": String(state.mode === "demo") }, on: { click: () => switchMode("demo") } }), element("button", { className: `button${state.mode === "import" ? " primary" : ""}`, type: "button", text: t("importMode"), attributes: { "aria-pressed": String(state.mode === "import") }, on: { click: () => switchMode("import") } })); sourceBody.append(modeRow);
  const fileLabel = element("label", { className: "field-label", text: t("fileLabel") }); const fileInput = element("input", { type: "file", attributes: { accept: ".jwc,.txt,application/octet-stream", "aria-describedby": "local-file-help" } }); fileInput.addEventListener("change", () => chooseImportFile(fileInput.files?.[0])); fileInput.hidden = true; const fileButton = element("button", { className: "button", type: "button", text: t("fileLabel"), attributes: { "data-focus-key": "source-file" }, on: { click: () => fileInput.click() } }); fileLabel.append(fileButton, fileInput, element("small", { id: "local-file-help", text: t("localFileHelp") })); sourceBody.append(fileLabel);
  if (state.importBytes) {
    const metadataLabel = element("label", { className: "field-label", text: t("captureMetadataLabel") });
    const metadataInput = element("input", { type: "file", attributes: { accept: "application/json,.json", "aria-describedby": "capture-metadata-help" } });
    metadataInput.addEventListener("change", () => chooseCaptureMetadata(metadataInput.files?.[0])); metadataInput.hidden = true;
    metadataLabel.append(element("button", { className: "button", type: "button", text: t("captureMetadataChoose"), attributes: { "data-focus-key": "capture-metadata" }, on: { click: () => metadataInput.click() } }), metadataInput, element("small", { id: "capture-metadata-help", text: t("captureMetadataHelp") }));
    sourceBody.append(metadataLabel);
  }
  const encodingLabel = element("label", { className: "field-label", text: t("encoding") }); const encodingSelect = element("select", { attributes: { "aria-label": t("encoding"), "data-focus-key": "source-encoding" } }); [["utf-8", "UTF-8"], ["shift_jis", "Shift_JIS"]].forEach(([value, label]) => { const option = element("option", { text: label, attributes: { value } }); option.selected = value === state.importEncoding; encodingSelect.append(option); }); encodingSelect.value = state.importEncoding; encodingSelect.addEventListener("change", () => { state.importEncoding = encodingSelect.value; state.importResult = null; if (state.importBytes) processImport(); }); encodingLabel.append(encodingSelect); sourceBody.append(encodingLabel);
  const calibrationLabel = element("label", { className: "field-label", text: t("calibration") }); const calibrationSelect = element("select", { attributes: { "aria-label": t("calibration"), "data-focus-key": "source-calibration" } }); [["unknown", t("calibrationUnknown")], ["paper-mm", t("calibrationPaper")], ["model-mm", t("calibrationModel")]].forEach(([value, label]) => { const option = element("option", { text: label, attributes: { value } }); option.selected = value === state.importCalibration; calibrationSelect.append(option); }); calibrationSelect.value = state.importCalibration; calibrationSelect.addEventListener("change", () => { state.importCalibration = calibrationSelect.value; state.importConfirmed = false; if (state.importBytes) processImport(); else render(); }); calibrationLabel.append(calibrationSelect, element("small", { text: t("calibrationHelp") })); sourceBody.append(calibrationLabel);
  const confirmLabel = element("label", { className: "toggle" }); const confirmInput = element("input", { type: "checkbox", attributes: { "data-focus-key": "source-confirm" }, disabled: state.importCalibration === "unknown" }); confirmInput.checked = state.importConfirmed; confirmInput.addEventListener("change", () => { state.importConfirmed = confirmInput.checked; if (state.importBytes) processImport(); }); confirmLabel.append(confirmInput, element("span", { text: t("confirmCalibration") })); sourceBody.append(confirmLabel);
  if (state.importResult?.metadata?.groups?.length > 1) { const groupLabel = element("label", { className: "field-label", text: t("groupLabel") }); const groupSelect = element("select", { attributes: { "aria-label": t("groupLabel"), "data-focus-key": "source-group" } }); const emptyOption = element("option", { text: t("chooseGroup"), attributes: { value: "" } }); groupSelect.append(emptyOption); for (const group of state.importResult.metadata.groups) { const option = element("option", { text: t("groupSummary", { id: group.id, scale: group.scale ?? "—", count: group.lineCount }), attributes: { value: group.id } }); groupSelect.append(option); } groupSelect.value = state.importGroup; groupSelect.addEventListener("change", () => { state.importGroup = groupSelect.value; processImport(); }); groupLabel.append(groupSelect); sourceBody.append(groupLabel); }
  if (state.importFileName) sourceBody.append(element("p", { className: "file-name", text: t("selectedFile", { name: state.importFileName }) }));
  if (!state.captureMetadataFileName) sourceBody.append(element("p", { className: "note", text: t("captureRawUnverified") }));
  if (state.captureMetadataFileName) {
    sourceBody.append(element("p", { className: "file-name", text: t("captureMetadataSelected", { name: state.captureMetadataFileName }) }));
    sourceBody.append(element("button", { className: "button quiet", type: "button", text: t("captureMetadataRemove"), attributes: { "data-focus-key": "capture-metadata-remove" }, on: { click: removeCaptureMetadata } }));
    if (!state.captureVerification && !state.error) sourceBody.append(element("p", { className: "panel-meta", attributes: { role: "status" }, text: t("captureVerificationPending") }));
  }
  if (state.captureVerification) {
    sourceBody.append(element("p", { className: "note", text: t("captureMatchedStatus") }));
    sourceBody.append(element("p", { className: "file-name", text: t("captureMetadataTime", { time: state.captureVerification.capturedAtUtc }) }));
  }
  if (state.importBusy) sourceBody.append(element("p", { className: "panel-meta", attributes: { role: "status" }, text: t("importLoading") }));
  if (state.importResult) { const result = state.importResult; const selectedGroup = result.metadata.groups.find((group) => group.id === result.coverage.selectedGroup) ?? (result.metadata.groups.length === 1 ? result.metadata.groups[0] : null); sourceBody.append(element("p", { className: "file-name", text: t("sourceEncoding", { encoding: result.source.encoding }) })); if (selectedGroup) sourceBody.append(element("p", { className: "file-name", text: t("selectedGroupSummary", { id: selectedGroup.id, scale: selectedGroup.scale ?? "—", count: selectedGroup.lineCount }) })); sourceBody.append(element("p", { className: "note", text: t("importCoverage", { status: t(`coverage.${result.coverage.status}`), lines: result.coverage.supportedLines, excluded: result.coverage.excludedGroupLines, unsupported: result.coverage.unsupportedRecords }) })); sourceBody.append(element("p", { className: "hash-value", text: t("sourceHash", { hash: result.source.sha256 }) })); for (const reason of result.coverage.reasons) sourceBody.append(element("p", { className: "note", text: `${t(`importReason.${reason.code}`)}${reason.lineNumber ? ` (${reason.lineNumber})` : ""}` })); if (!result.snapshot) sourceBody.append(element("p", { className: "description", text: t("importNeedsSetup") })); }
  if (state.mode === "import") {
    if (projectPanel.isActive()) {
      for (const control of sourceBody.querySelectorAll('button, input, select')) control.disabled = true;
      sourceBody.append(element('p', { className: 'note', text: state.locale === 'ja-JP' ? 'プロジェクトの図面・単位・グループは固定です。別の図面を扱うにはプロジェクトを閉じてください。' : 'Project source, units and group are fixed. Close the project to work with another drawing.' }));
    }
    sourceBody.append(element("p", { className: "note", text: t("importReadOnly") }));
    const office = element("details", { className: "office-rules" }); office.open = state.officeOpen; office.addEventListener("toggle", () => { state.officeOpen = office.open; });
    const summary = element("summary", { text: t("officeRules") }); office.append(summary);
    office.append(element("p", { className: "description", text: t("officeRulesHelp") }));
    if (state.reviewWorkspace.profile) office.append(element("p", { className: "panel-meta", text: t("officeProfileVersion", { version: state.reviewWorkspace.profile.version }) }));
    else office.append(element("p", { className: "panel-meta", text: t("importerProfileActive") }));
    const shortLabel = element("label", { className: "field-label", text: t("shortLineRule") }); const shortInput = element("input", { type: "number", attributes: { min: "0", max: "1000000", step: "any", value: state.officeShortLine, "data-focus-key": "office-short" } }); shortInput.value = state.officeShortLine; shortInput.addEventListener("input", () => { state.officeShortLine = shortInput.value; }); shortLabel.append(shortInput);
    const gapLabel = element("label", { className: "field-label", text: t("gapRule") }); const gapInput = element("input", { type: "number", attributes: { min: "0.001", max: "1000000", step: "any", value: state.officeGap, "data-focus-key": "office-gap" } }); gapInput.value = state.officeGap; gapInput.addEventListener("input", () => { state.officeGap = gapInput.value; }); gapLabel.append(gapInput);
    const layerLabel = element("label", { className: "field-label", text: t("allowedLayers") }); const layersInput = element("textarea", { className: "layers-input", attributes: { rows: "4", "data-focus-key": "office-layers" } }); layersInput.value = state.officeLayers; layersInput.addEventListener("input", () => { state.officeLayers = layersInput.value; }); layerLabel.append(layersInput);
    office.append(shortLabel, gapLabel, layerLabel, element("button", { className: "button primary", type: "button", text: t("saveOfficeRules"), disabled: !state.reviewStoreReady, attributes: { "data-focus-key": "office-save" }, on: { click: saveOfficeProfile } }));
    office.append(element("p", { className: "note", text: t("officeImportOnly") }));
    if (state.reviewStoreError) sourceBody.append(element("p", { className: "error-box", attributes: { role: "alert" }, text: t(`reviewError.${state.reviewStoreError}`) }));
    sourceBody.append(office);
    const savedCount = reviewsInCurrentContext().length;
    sourceBody.append(element("p", { className: "panel-meta", text: t("reviewContextCount", { count: savedCount }) }));
    sourceBody.append(element("p", { className: "note", text: projectPanel.isActive()
      ? (state.locale === 'ja-JP' ? '記録の保存後、プロジェクトをダウンロードしてください。ルールや分類対応を変えると、以前の条件の記録は保持されますが自動で再関連付けされません。' : 'After saving records, download the project. Changing rules or layer mappings retains earlier records without automatically attaching them to new conditions.')
      : t("reviewReselectHelp") }));
    sourceBody.append(element("button", { className: "button", type: "button", text: t("exportCsv"), disabled: !state.reviewContextKey, on: { click: showCsvExport } }));
  }
  sourcePanel.append(sourceBody);
  const issues = activeIssues();
  const issuePanel = element("section", { className: "panel issue-panel", attributes: { "aria-labelledby": "issues-heading" } }); const issueHeading = element("div", { className: "panel-heading" }); issueHeading.append(element("h2", { className: "panel-title", id: "issues-heading", text: t("issues") }), element("span", { className: "panel-meta", text: state.mode === "import" && !state.importResult?.snapshot ? t("notChecked") : t("issueCount", { count: issues.length }) })); issuePanel.append(issueHeading);
  if (state.error) issuePanel.append(element("div", { className: "error-box", attributes: { role: "alert" }, text: `${t("error")}: ${state.error.startsWith("E_IMPORT_") ? t("importError") : state.error.startsWith("E_BUNDLE_") ? t("captureBundleError") : `${t("errorPrefix")} ${state.error}`}` }));
  const issueList = element("ul", { className: "issue-list", attributes: { "aria-label": t("issues") } });
  if (issues.length) issues.forEach((issue) => issueList.append(issueRow(issue))); else issueList.append(element("li", { className: "empty", text: state.mode === "import" && !state.importResult?.snapshot ? t("importNoSnapshot") : t("noIssues") })); issuePanel.append(issueList);
  const issueActions = element("div", { className: "issue-actions" }); issueActions.append(element("button", { className: "button", type: "button", text: t("selectFixable"), disabled: state.mode === "import" || !fixableIssues().length || Boolean(state.previewSnapshot), on: { click: selectAllFixable } }), element("button", { className: "button primary", type: "button", text: t("preview"), disabled: state.mode === "import" || !state.selectedFixIds.size || Boolean(state.previewSnapshot), on: { click: startPreview } })); issuePanel.append(issueActions);

  const canvasPanel = element("section", { className: "panel canvas-panel", attributes: { "aria-labelledby": "drawing-heading" } }); const canvasHead = element("div", { className: "panel-heading" }); canvasHead.append(element("h2", { className: "panel-title", id: "drawing-heading", text: t("drawing") }), element("span", { className: "panel-meta", text: state.mode === "import" ? t("readOnlyTag") : `${t("revision")} ${displaySnapshot()?.revision ?? "—"}` })); canvasPanel.append(canvasHead);
  const canvasTools = element("div", { className: "canvas-tools" }); canvasTools.append(element("span", { className: "panel-meta", text: t("coordinate") }), element("span", { className: "panel-meta", text: t("mm") })); canvasPanel.append(canvasTools);
  if (state.mode === "demo" && state.previewSnapshot && state.plan) canvasPanel.append(element("div", { className: "preview-banner", text: `${t("previewSummary", { count: state.plan.removals.length })} ${t("previewReady")}` }));
  const stage = element("div", { className: "canvas-stage" }); if (activeSnapshot()) stage.append(renderDrawing(activeSnapshot(), selectedIssue(), state.mode === "demo" ? state.plan : null)); else stage.append(element("p", { className: "empty", text: t("importNoSnapshot") })); canvasPanel.append(stage);
  const legend = element("div", { className: "canvas-legend" }); legend.append(element("span", { className: "legend-line", text: t("drawing") }), element("span", { className: "legend-line selected", text: t("selected") }), element("span", { className: "legend-line preview", text: t("previewing") })); canvasPanel.append(legend);

  const inspector = element("aside", { className: "inspector", attributes: { "aria-label": t("settings") } });
  const selected = selectedIssue(); const detailPanel = element("section", { className: "panel", attributes: { "aria-labelledby": "detail-heading" } }); const detailHead = element("div", { className: "panel-heading" }); detailHead.append(element("h2", { className: "panel-title", id: "detail-heading", text: selected ? ruleTitle(selected.ruleId) : t("issues") }), selected ? element("span", { className: `kind-tag ${selected.fixable ? "fixable" : "observed"}`, text: t(state.mode === "import" ? "observed" : selected.fixable ? "fixable" : "observed") }) : element("span")); detailPanel.append(detailHead); const detailBody = element("div", { className: "inspector-content" });
  if (selected) { const grid = element("dl", { className: "info-grid" }); const rows = [[t("location"), `${selected.location[0]}, ${selected.location[1]} ${t("mm")}`], [t("entities"), selected.entityIds.join(", ")], [t("selectedForPreview"), selected.fixable && state.selectedFixIds.has(selected.id) ? t("selected") : "—"]]; rows.forEach(([label, value]) => { const row = element("div", { className: "info-row" }); row.append(element("dt", { text: label }), element("dd", { text: value })); grid.append(row); }); detailBody.append(grid, element("p", { className: "description", text: issueDescription(selected.ruleId) }));
    if (state.mode === "import" && state.reviewContextKey) {
      const saved = reviewsForContext(state.reviewWorkspace, state.reviewContextKey).find((item) => item.issueId === selected.id);
      const editor = element("div", { className: "review-editor" }); editor.append(element("h3", { className: "panel-title", text: t("officeReview") }));
      editor.append(element("p", { className: "panel-meta", text: saved ? t("savedReview", { status: t(`reviewStatus.${saved.status}`), date: saved.updatedAt ?? "" }) : t("noSavedReview") }));
      const statusLabel = element("label", { className: "field-label", text: t("reviewStatusLabel") }); const statusSelect = element("select", { attributes: { "data-focus-key": "review-status" } });
      for (const status of ["reviewing", "excluded", "recheck"]) { const option = element("option", { text: t(`reviewStatus.${status}`), attributes: { value: status } }); statusSelect.append(option); }
      statusSelect.value = state.reviewDraftStatus; statusSelect.addEventListener("change", () => { state.reviewDraftStatus = statusSelect.value; }); statusLabel.append(statusSelect);
      const noteLabel = element("label", { className: "field-label", text: t("reviewNote") }); const noteInput = element("textarea", { className: "review-note", attributes: { maxlength: "2000", rows: "5", "data-focus-key": "review-note" } }); noteInput.value = state.reviewDraftNote; noteInput.addEventListener("input", () => { state.reviewDraftNote = noteInput.value; }); noteLabel.append(noteInput);
      editor.append(statusLabel, noteLabel, element("p", { className: "panel-meta", text: t("noteLimit", { count: state.reviewDraftNote.length }) }), element("button", { className: "button primary", type: "button", text: t("saveReview"), disabled: !state.reviewStoreReady, on: { click: saveIssueReview } }));
      editor.append(element("p", { className: "note", text: t("excludedIsNotFixed") }));
      if (state.reviewStoreError) editor.append(element("p", { className: "error-box", attributes: { role: "alert" }, text: t(`reviewError.${state.reviewStoreError}`) })); detailBody.append(editor);
    }
  } else detailBody.append(element("p", { className: "description", text: state.mode === "import" && !state.importResult?.snapshot ? t("importNoSnapshot") : t("noIssues") }));
  const actions = element("div", { className: "action-stack" }); if (state.mode === "import") { actions.append(element("button", { className: "button", type: "button", text: t("preview"), disabled: true }), element("button", { className: "button", type: "button", text: t("applyDemo"), disabled: true }), element("button", { className: "button quiet", type: "button", text: t("undo"), disabled: true })); } else if (state.previewSnapshot) { actions.append(element("button", { className: "button primary", type: "button", text: t("applyDemo"), on: { click: openApplyDialog } }), element("button", { className: "button", type: "button", text: t("cancelPreview"), on: { click: cancelPreview } })); } else { actions.append(element("button", { className: "button", type: "button", text: t("runCheck"), disabled: !state.snapshot, on: { click: () => runCheck(true) } }), element("button", { className: "button quiet", type: "button", text: t("undo"), disabled: !state.history.length, on: { click: undoPreviewEdit } })); } detailBody.append(actions); detailPanel.append(detailBody); inspector.append(detailPanel);
  const settingsPanel = element("section", { className: "panel", id: "settings", attributes: { "aria-labelledby": "settings-heading" } }); const settingsHead = element("div", { className: "panel-heading" }); settingsHead.append(element("h2", { className: "panel-title", id: "settings-heading", text: t("settings") })); settingsPanel.append(settingsHead); const settingsList = element("div", { className: "settings-list" }); const languageLabel = element("label", { className: "field-label", text: t("language") }); const select = element("select", { attributes: { "aria-label": t("language"), "data-focus-key": "settings-language" } }); [["ja-JP", t("japanese")], ["en-US", t("english")]].forEach(([value, label]) => { const option = element("option", { text: label, attributes: { value } }); option.selected = value === state.locale; select.append(option); }); select.value = state.locale; select.addEventListener("change", () => setLocale(select.value)); languageLabel.append(select); const motion = element("label", { className: "toggle" }); const motionInput = element("input", { type: "checkbox" }); motionInput.checked = state.reduceMotion; motionInput.addEventListener("change", () => { setMotion(motionInput.checked); render(); }); motion.append(motionInput, element("span", { text: t("reduceMotion") })); settingsList.append(languageLabel, motion, element("div", { className: "note", text: t("reduceMotionHelp") }), element("div", { className: "note", text: `${t("connection")}: ${t("connectionBody")}` }), element("div", { className: "note", text: `${t("shortcut")}: ${t("shortcutBody")}` }), element("button", { className: "button", type: "button", text: t("reset"), attributes: { "data-focus-key": "settings-reset" }, on: { click: resetDemo } }), element("button", { className: "button", type: "button", text: t("export"), attributes: { "data-focus-key": "settings-export" }, disabled: state.mode === "import" ? !state.importResult : !state.snapshot, on: { click: exportReview } }));
  settingsList.append(element("button", { className: "button", type: "button", text: t("backupView"), on: { click: showReviewBackup } })); settingsList.append(element("button", {className:"button", type:"button", text: state.locale === "ja-JP" ? "現在の検討データをJSONで表示" : "View current review workspace JSON", disabled: !state.reviewStoreReady, on: {click: () => { state.reportJson = JSON.stringify(state.reviewWorkspace,null,2); state.reportDialogTitle = t("backupTitle"); state.reportDialogHelp = t("backupHelp"); state.reportDialogLabel = t("backupTitle"); render(); document.querySelector("#report-dialog")?.showModal(); }}}));
  settingsList.append(element('button', { className: 'button', type: 'button', attributes: { 'data-discard-review': '' }, text: state.locale === 'ja-JP' ? '未保存の事務所ルール・検討入力を戻す' : 'Discard unsaved office and review input', disabled: !hasUnsavedReview(), on: { click: () => {
    [state.officeShortLine, state.officeGap, state.officeLayers] = officeBaseline;
    const saved = state.reviewContextKey && reviewsInCurrentContext().find(item => item.issueId === state.selectedIssueId);
    state.reviewDraftStatus = saved?.status ?? 'reviewing'; state.reviewDraftNote = saved?.note ?? ''; reviewRecovery.invalidate(); render();
  } } }));
  settingsList.append(reviewRecovery.render(state.locale));
  settingsPanel.append(settingsList); inspector.append(settingsPanel);
  workspace.append(sourcePanel, issuePanel, canvasPanel, inspector);
  workspace.append(fieldPanel.render({locale:state.locale, reviewContextKey:state.mode === "import" ? state.reviewContextKey : null, observedLayers:state.mode === "import" ? [...new Set((state.importResult?.snapshot?.entities ?? []).map(e => e.layer))] : []})); main.append(workspace, element("footer", { className: "footer", text: t(state.mode === "import" ? "importFooter" : "syntheticFooter") })); shell.append(sidebar, main); app.append(shell);
  const dialog = element("dialog", { id: "apply-dialog", attributes: { "aria-labelledby": "apply-title" } }); dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); }); const dialogContent = element("div", { className: "dialog-content" }); dialogContent.append(element("h2", { className: "dialog-title", id: "apply-title", text: t("applyTitle") }), element("p", { className: "dialog-copy", text: t("applyBody") })); const dialogActions = element("div", { className: "dialog-actions" }); dialogActions.append(element("button", { className: "button", type: "button", text: t("cancel"), on: { click: closeDialog } }), element("button", { className: "button primary", type: "button", text: t("applyConfirm"), on: { click: applyToDemo } })); dialogContent.append(dialogActions); dialog.append(dialogContent); app.append(dialog);
  if (state.reportJson) {
    const reportDialog = element("dialog", { id: "report-dialog", attributes: { "aria-labelledby": "report-title", "aria-describedby": "report-help" } });
    const reportContent = element("div", { className: "dialog-content report-content" });
    reportContent.append(element("h2", { className: "dialog-title", id: "report-title", text: state.reportDialogTitle ?? t("reportTitle") }), element("p", { className: "dialog-copy", id: "report-help", text: state.reportDialogHelp ?? t("reportHelp") }));
    const reportText = element("textarea", { className: "report-json", id: "report-json", attributes: { "aria-label": state.reportDialogLabel ?? t("reportJsonLabel"), "aria-describedby": "report-help", readonly: "", rows: "16", spellcheck: "false" } });
    reportText.value = state.reportJson;
    reportContent.append(reportText);
    const reportActions = element("div", { className: "dialog-actions" });
    reportActions.append(element("button", { className: "button primary", type: "button", text: t("close"), attributes: { "data-focus-key": "report-close" }, on: { click: () => reportDialog.close() } }));
    reportContent.append(reportActions); reportDialog.append(reportContent); app.append(reportDialog);
  }
  const focusKeys = [
    ['nav a[href="#workspace"]', 'nav-review'], ['nav a[href="#settings"]', 'nav-settings'],
    ['#settings select', 'settings-language'], ['#settings .toggle input', 'settings-motion'],
    ['.issue-actions button:first-child', 'select-fixable'], ['.issue-actions button:last-child', 'preview'],
    ['.action-stack button:first-child', state.previewSnapshot ? 'apply-demo' : 'run-check'],
    ['.action-stack button:last-child', state.previewSnapshot ? 'cancel-preview' : 'undo'],
    ['#apply-dialog button:first-of-type', 'dialog-cancel'], ['#apply-dialog button:last-of-type', 'dialog-apply']
  ];
  for (const [selector, key] of focusKeys) { const target = app.querySelector(selector); if (target) target.dataset.focusKey = key; }
  if (projectPanel.isBusy()) for (const control of app.querySelectorAll('button, input, select, textarea')) control.disabled = true;
  if (projectPanel.isActive()) app.querySelector('[data-focus-key="settings-reset"]').disabled = true;
  if (focusKey) app.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

window.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.previewSnapshot && !document.querySelector("dialog[open]")) cancelPreview(); });
function refreshRecovery() {
  projectPanel.refresh();
  reviewRecovery.refresh();
  const discard = app.querySelector('[data-discard-review]'); if (discard) discard.disabled = !hasUnsavedReview();
}
app.addEventListener('input', refreshRecovery);
app.addEventListener('change', refreshRecovery);
app.addEventListener('fieldstatechange', () => projectPanel.refresh());
window.addEventListener("beforeunload", event => { if (fieldPanel.hasUnsaved() || hasUnsavedReview() || projectPanel.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } });
render();
loadDemo();
loadReviewWorkspace();
