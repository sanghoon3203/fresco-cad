// Declarative JWW field layout, interpreted symmetrically for read and write.
// Field order follows Jw_cad jwdatafmt.txt as implemented by JinkiKeikaku/JwwExchange (Unlicense):
// CJwwHeader::Read and CData*::Serialize. Version gates use the header version, not class schema.
const seq = (...parts) => parts.flatMap(p => Array.isArray(p[0]) ? p : [p]);
const f = (type, ...names) => names.map(name => [type, name]);
const rep = (n, ...body) => ['rep', n, seq(...body)];
const block = x => typeof x[0] === 'string' ? [x] : seq(...x);
const when = (test, then, otherwise = []) => ['if', test, block(then), block(otherwise)];
const v = min => ctx => ctx.version >= min;

export const HEADER = seq(
  f('str', 'm_strMemo'), f('u32', 'm_nZumen', 'm_nWriteGLay'),
  rep(16, f('u32', 'm_anGLay', 'm_anWriteLay'), f('f64', 'm_adScale'), f('u32', 'm_anGLayProtect'),
    rep(16, f('u32', 'm_aanLay', 'm_aanLayProtect'))),
  rep(14, f('u32', 'dummy1')),
  f('u32', 'm_lnSunpou1', 'm_lnSunpou2', 'm_lnSunpou3', 'm_lnSunpou4', 'm_lnSunpou5', 'dummy2', 'nWid'),
  f('f64', 'm_DPPrtGenten_x', 'm_DPPrtGenten_y', 'm_dPrtBairitsu'), f('u32', 'm_nPrtSet', 'm_nMemoriMode'),
  f('f64', 'm_dMemoriHyoujiMin', 'm_dMemoriX', 'm_dMemoriY', 'm_DpMemoriKijunTen_x', 'm_DpMemoriKijunTen_y'),
  rep(16, rep(16, f('str', 'm_aStrLayName'))), rep(16, f('str', 'm_aStrGLayName')),
  f('f64', 'm_dKageLevel', 'm_dKageIdo'), f('u32', 'm_nKage9_15JiFlg'), f('f64', 'm_dKabeKageLevel'),
  when(v(300), f('f64', 'm_dTenkuuZuLevel', 'm_dTenkuuZuEnkoR')),
  f('u32', 'm_nMMTani3D'), f('f64', 'm_dBairitsu', 'm_DPGenten_x', 'm_DPGenten_y', 'm_dHanniBairitsu', 'm_DPHanniGenten_x', 'm_DPHanniGenten_y'),
  when(v(300), rep(8, f('f64', 'm_dZoomJumpBairitsu', 'm_DPZoomJumpGenten_x', 'm_DPZoomJumpGenten_y'), f('u32', 'm_nZoomJumpGLay'))),
  when(ctx => ctx.version < 300, rep(4, f('f64', 'm_dZoomJumpBairitsu', 'm_DPZoomJumpGenten_x', 'm_DPZoomJumpGenten_y'))),
  when(v(300), [f('f64', 'dDm1', 'dDm2', 'dDm3'), f('u32', 'dummy3'), f('f64', 'dDm4', 'dDm5', 'm_dMojiBG'), f('u32', 'm_nMojiBG')]),
  rep(10, f('f64', 'm_adFukusenSuuchi')), f('f64', 'm_dRyoygawaFukusenTomeDe'),
  rep(10, f('u32', 'm_aPenColor', 'm_anPenWidth')),
  rep(10, f('u32', 'm_aPrtPenColor', 'm_anPrtPenWidth'), f('f64', 'm_adPrtTenHankei')),
  rep(8, f('u32', 'm_alLType', 'm_anTokushuSenUintDot', 'm_anTokushuSenPich', 'm_anPrtTokushuSenPich')),
  rep(5, f('u32', 'm_alLType_Rnd', 'm_anRandSenWide_Rnd', 'm_anTokushuSenPich_Rnd', 'm_anPrtRandSenWide_Rnd', 'm_anPrtTokushuSenPich_Rnd')),
  rep(4, f('u32', 'm_alLType_Double', 'm_anTokushuSenUintDot_Double', 'm_anTokushuSenPich_Double', 'm_anPrtTokushuSenPich_Double')),
  f('u32', 'm_nDrawGamenTen', 'm_nDrawPrtTen', 'm_nBitMapFirstDraw', 'm_nGyakuDraw', 'm_nGyakuSearch', 'm_nColorPrint',
    'm_nLayJunPrint', 'm_nColJunPrint', 'm_nPrtRenzoku', 'm_nPrtKyoutsuuGray', 'm_nPrtDispOnlyNonDraw'),
  when(v(223), [f('u32', 'm_lnDrawTime', 'nEyeInit', 'm_dEye_H_Ichi_1', 'm_dEye_H_Ichi_2', 'm_dEye_H_Ichi_3'),
    f('f64', 'm_dEye_Z_Ichi_1', 'm_dEye_Y_Ichi_1', 'm_dEye_Z_Ichi_2', 'm_dEye_Y_Ichi_2', 'm_dEye_V_Ichi_3')]),
  when(v(225), f('f64', 'm_dSenNagasaSnpou', 'm_dBoxSunpouX', 'm_dBoxSunpouY', 'm_dEnHankeiSnpou')),
  when(v(230), f('u32', 'm_nSolidNinniColor', 'm_SolidColor')),
  when(v(420), [
    rep(257, f('u32', 'm_aPenColor_SXF', 'm_anPenWidth_SXF')),
    rep(257, f('str', 'm_astrUDColorName_SXF'), f('u32', 'm_aPrtPenColor_SXF', 'm_anPrtPenWidth_SXF'), f('f64', 'm_adPrtTenHankei_SXF')),
    rep(33, f('u32', 'm_alLType_SXF', 'm_anTokushuSenUintDot_SXF', 'm_anTokushuSenPich_SXF', 'm_anPrtTokushuSenPich_SXF')),
    rep(33, f('str', 'm_astrUDLTypeName_SXF'), f('u32', 'm_anUDLTypeSegment_SXF'), rep(10, f('f64', 'm_aadUDLTypePitch_SXF')))]),
  rep(10, f('f64', 'm_adMojiX', 'm_adMojiY', 'm_adMojiD'), f('u32', 'm_anMojiCol')),
  f('f64', 'm_dMojiSizeX', 'm_dMojiSizeY', 'm_dMojiKankaku'), f('u32', 'm_nMojiColor', 'm_nMojiShu'),
  f('f64', 'm_dMojiSeiriGyouKan', 'm_dMojiSeiriSuu'), f('u32', 'm_nMojiKijunZureOn'),
  rep(3, f('f64', 'm_adMojiKijunZureX')), rep(3, f('f64', 'm_adMojiKijunZureY')));

const BASE = seq(f('u32', 'm_lGroup'), f('u8', 'm_nPenStyle'), f('u16', 'm_nPenColor'), when(v(351), f('u16', 'm_nPenWidth')),
  f('u16', 'm_nLayer', 'm_nGLayer', 'm_sFlg'));
const SEN = [...BASE, ...f('f64', 'm_start_x', 'm_start_y', 'm_end_x', 'm_end_y')];
const ENKO = [...BASE, ...f('f64', 'm_start_x', 'm_start_y', 'm_dHankei', 'm_radKaishiKaku', 'm_radEnkoKaku', 'm_radKatamukiKaku', 'm_dHenpeiRitsu'), ...f('u32', 'm_bZenEnFlg')];
// CDataTen stores symbol fields only for pen style 100.
const TEN = [...BASE, ...f('f64', 'm_start_x', 'm_start_y'), ...f('u32', 'm_bKariten'),
  when((ctx, rec) => rec.m_nPenStyle === 100, [f('u32', 'm_nCode'), f('f64', 'm_radKaitenKaku', 'm_dBairitsu')])];
const MOJI = [...BASE, ...f('f64', 'm_start_x', 'm_start_y', 'm_end_x', 'm_end_y'), ...f('u32', 'm_nMojiShu'),
  ...f('f64', 'm_dSizeX', 'm_dSizeY', 'm_dKankaku', 'm_degKakudo'), ...f('str', 'm_strFontName', 'm_string')];
const SUNPOU = [...BASE, ['obj', 'm_Sen', SEN], ['obj', 'm_Moji', MOJI],
  when(v(420), [f('u16', 'm_bSxfMode'), ['obj', 'm_SenHo1', SEN], ['obj', 'm_SenHo2', SEN],
    ['obj', 'm_Ten1', TEN], ['obj', 'm_Ten2', TEN], ['obj', 'm_TenHo1', TEN], ['obj', 'm_TenHo2', TEN]])];
// CDataSolid stores an RGB color only for pen color 10.
const SOLID = [...BASE, ...f('f64', 'm_start_x', 'm_start_y', 'm_end_x', 'm_end_y', 'm_DPoint2_x', 'm_DPoint2_y', 'm_DPoint3_x', 'm_DPoint3_y'),
  when((ctx, rec) => rec.m_nPenColor === 10, f('u32', 'm_Color'))];
const BLOCK = [...BASE, ...f('f64', 'm_DPKijunTen_x', 'm_DPKijunTen_y', 'm_dBairitsuX', 'm_dBairitsuY', 'm_radKaitenKaku'), ...f('u32', 'm_nNumber')];
// m_time is MFC CTime written by Jw_cad's VC++ runtime as a 32-bit time_t (confirmed on corpus).
const LIST = [...BASE, ...f('i32', 'm_nNumber', 'm_bReffered'), ...f('u32', 'm_time'), ...f('str', 'm_strName'), ['list', 'children']];

export const CLASSES = {
  CDataSen: { spec: SEN, type: 'JwwSen', kind: 'line' },
  CDataEnko: { spec: ENKO, type: 'JwwEnko', kind: 'arc' },
  CDataTen: { spec: TEN, type: 'JwwTen', kind: 'point' },
  CDataMoji: { spec: MOJI, type: 'JwwMoji', kind: 'text' },
  CDataSunpou: { spec: SUNPOU, type: 'JwwSunpou', kind: 'dimension' },
  CDataSolid: { spec: SOLID, type: 'JwwSolid', kind: 'solid' },
  CDataBlock: { spec: BLOCK, type: 'JwwBlock', kind: 'block' },
  CDataList: { spec: LIST, type: 'JwwDataList', kind: 'blockDefinition' }
};
