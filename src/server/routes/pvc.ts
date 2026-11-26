import express from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import {
  calculateForItem,
  formatDateDDMMYYYY,
  getItemIndexMap,
  parseDateYMD,
  safeFloat,
} from '../pvcEngine.js';
import { store } from '../store.js';
import {
  PVCInputData,
  ScenarioDetail,
  TenderMasterRecord,
  TenderVendorRecord,
} from '../types.js';
import { flashMessage, requireLogin } from './auth.js';

export const pvcRouter = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const SC_MAP: Record<string, string> = {
  A2: 'Actual PVC',
  B2: 'Contractual PVC',
  C1: 'Lower Actual PVC',
  D1: 'Lower Contractual PVC',
};

const SC_SUBTITLE: Record<string, string> = {
  A2: 'Base Rate · Call Date',
  B2: 'Base Rate · Scheduled DP',
  C1: 'Lower Rate · Call Date',
  D1: 'Lower Rate · Scheduled DP',
};

function sanitizeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildResultObj(payload: Record<string, unknown>) {
  return {
    data: payload,
    scenarioamounts: (payload.scenarioamounts as Record<string, unknown>) || {},
    scenariodetails: (payload.scenariodetails as unknown[]) || [],
    igbtvendordetails: (payload.igbtvendordetails as unknown[]) || [],
    igbtindexdetails: (payload.igbtindexdetails as unknown[]) || [],
  };
}

function normalizeExcelDate(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === 'number' && val > 20000 && val < 90000) {
    const parsed = XLSX.SSF.parse_date_code(val);
    if (parsed) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }
  const dt = parseDateYMD(String(val));
  if (dt) {
    return dt.toISOString().slice(0, 10);
  }
  return String(val).trim() || null;
}

export interface ComparisonRow {
  code: string;
  label: string;
  subtitle: string;
  gross: number;
  ld: number;
  net: number;
  pvcPerSet: number | null;
  pvcPercent: number | null;
  isSelected: boolean;
  isLowest: boolean;
  varianceFromFair: number;
  barPct: number;
}

function buildComparisonSummary(payload: Record<string, unknown>, rateAppliedRaw: string | null | undefined) {
  const rateApplied = String(rateAppliedRaw || '').trim().toLowerCase();
  const b2Needed = !['supply before due date', 'supply within original dp or refixed dp', 'lower rate applicable within dp'].includes(rateApplied);
  const scenarioAmounts = (payload.scenarioamounts as Record<string, number | null>) || {};
  const scenariodetails = (payload.scenariodetails as ScenarioDetail[]) || [];
  const pctMap = new Map<string, number>();
  for (const d of scenariodetails) {
    pctMap.set(d.scenario, Number(d.pvcpercent ?? 0));
  }

  const ldApplicable = Boolean(payload.ldapplicable);
  const selectedScenario = String(payload.selectedscenario || 'A2');

  const rawCandidates: Array<{
    code: string;
    gross: number | null;
    ld: number;
    net: number | null;
    pvcPerSet: number | null;
    show: boolean;
  }> = [
    {
      code: 'A2',
      gross: sanitizeNum(payload.pvcactual),
      ld: ldApplicable ? Number(payload.ldamtactual || 0) : 0,
      net: sanitizeNum(payload.pvcactuallessldnew) ?? sanitizeNum(payload.pvcactual),
      pvcPerSet: sanitizeNum(payload.pvcperseta2),
      show: true,
    },
    {
      code: 'B2',
      gross: sanitizeNum(payload.pvccontractual),
      ld: ldApplicable ? Number(payload.ldamtcontractual || 0) : 0,
      net: sanitizeNum(payload.pvccontractuallessldnew) ?? sanitizeNum(payload.pvccontractual),
      pvcPerSet: sanitizeNum(payload.pvcpersetb2),
      show: b2Needed && sanitizeNum(payload.pvccontractual) !== null,
    },
    {
      code: 'C1',
      gross: sanitizeNum(payload.loweractual),
      ld: 0,
      net:
        rateApplied.includes('further') && sanitizeNum(payload.loweractuallessld) !== null
          ? sanitizeNum(payload.loweractuallessld)
          : sanitizeNum(payload.loweractual),
      pvcPerSet: sanitizeNum(payload.pvcpersetc1),
      show: 'C1' in scenarioAmounts && sanitizeNum(payload.loweractual) !== null,
    },
    {
      code: 'D1',
      gross: sanitizeNum(payload.lowercontractual),
      ld: 0,
      net:
        rateApplied.includes('further') && sanitizeNum(payload.lowercontractuallessld) !== null
          ? sanitizeNum(payload.lowercontractuallessld)
          : sanitizeNum(payload.lowercontractual),
      pvcPerSet: sanitizeNum(payload.pvcpersetd1),
      show: b2Needed && 'D1' in scenarioAmounts && sanitizeNum(payload.lowercontractual) !== null,
    },
  ];

  const active = rawCandidates.filter((c) => c.show && c.net !== null);
  const nets = active.map((c) => c.net as number);
  const maxNet = nets.length ? Math.max(...nets) : 1;
  const minNet = nets.length ? Math.min(...nets) : 0;
  const fairPrice = sanitizeNum(payload.fairprice) ?? minNet;
  const savingsVsHighest = Math.max(0, maxNet - fairPrice);

  const rows: ComparisonRow[] = active.map((c) => {
    const netVal = c.net as number;
    const grossVal = c.gross ?? netVal;
    const barPct = maxNet > 0 ? Math.max(12, Math.min(100, Math.round((netVal / maxNet) * 100))) : 100;
    return {
      code: c.code,
      label: SC_MAP[c.code] || c.code,
      subtitle: SC_SUBTITLE[c.code] || '',
      gross: grossVal,
      ld: c.ld,
      net: netVal,
      pvcPerSet: c.pvcPerSet,
      pvcPercent: pctMap.has(c.code) ? pctMap.get(c.code)! : null,
      isSelected: c.code === selectedScenario,
      isLowest: Math.abs(netVal - minNet) < 0.01,
      varianceFromFair: Math.max(0, netVal - fairPrice),
      barPct,
    };
  });

  return {
    rows,
    fairPrice,
    maxNet,
    minNet,
    savingsVsHighest,
    selectedLabel: SC_MAP[selectedScenario] || selectedScenario,
  };
}

// ── Single PVC Calculator ─────────────────────────────────────────────────

pvcRouter.get('/calculator', requireLogin, (_req, res) => {
  res.locals.request.endpoint = 'pvc.calculator';
  const items = store.getItems();
  const tenders = store.getTendersByNumberAsc();
  res.clearCookie('last_calc_id');
  res.render('index.html', { items, tenders });
});

pvcRouter.post('/calculate', requireLogin, (req, res) => {
  res.locals.request.endpoint = 'pvc.calculate';
  const body = req.body as Record<string, string>;
  const itemidRaw = body.itemid || body.item_id;
  if (!itemidRaw) {
    flashMessage(req, 'Please select an item.', 'danger');
    res.redirect('/pvc/calculator');
    return;
  }

  const item = store.getItemById(parseInt(itemidRaw, 10));
  if (!item) {
    flashMessage(req, 'Selected item not found.', 'danger');
    res.redirect('/pvc/calculator');
    return;
  }

  const idxMap = getItemIndexMap(item.id);
  if (idxMap.size === 0) {
    flashMessage(
      req,
      'Indices not configured for this item. Please add them via Item Indices.',
      'danger'
    );
    res.redirect('/pvc/calculator');
    return;
  }

  let weights: Record<string, number> = {};
  try {
    weights = JSON.parse(item.weights_json || '{}');
  } catch {
    weights = {};
  }

  const currentUser = res.locals.current_user;
  const data: PVCInputData = {
    user_id: currentUser.id,
    username: currentUser.username,
    basicrate: safeFloat(body.basicrate),
    quantity: safeFloat(body.quantity),
    freightrateperunit: safeFloat(body.freightrateperunit),
    pvcbasedate: body.pvcbasedate || null,
    origdp: body.origdp || null,
    refixeddp: body.refixeddp || null,
    extendeddp: body.extendeddp || null,
    caldate: body.caldate || null,
    supdate: body.supdate || null,
    lowerrate: safeFloat(body.lowerrate),
    lowerfreight: safeFloat(body.lowerfreight),
    lowerbasicdate: body.lowerbasicdate || null,
    rateapplied: body.rateapplied || null,
    tenderid: body.tenderid || body.tender_id || null,
    vendorid: body.vendorid || body.vendor_id || null,
    subsequent_tenderid: body.subsequent_tenderid || null,
    pono: body.pono || null,
    developmentaltender: Boolean(body.developmentaltender),
  };

  let resultRow;
  try {
    resultRow = calculateForItem(item, data, idxMap, weights);
  } catch (err) {
    flashMessage(
      req,
      err instanceof Error ? err.message : 'Calculation failed. Please check your inputs and index data.',
      'danger'
    );
    res.redirect('/pvc/calculator');
    return;
  }

  const payload = {
    pvcactual: sanitizeNum(resultRow.pvcactual),
    pvccontractual: sanitizeNum(resultRow.pvccontractual),
    loweractual: sanitizeNum(resultRow.loweractual),
    lowercontractual: sanitizeNum(resultRow.lowercontractual),
    ldamtactual: sanitizeNum(resultRow.ldamtactual) ?? 0.0,
    ldamtcontractual: sanitizeNum(resultRow.ldamtcontractual) ?? 0.0,
    fairprice: sanitizeNum(resultRow.fairpricenew),
    pvcactuallessldnew: sanitizeNum(resultRow.pvcactuallessldnew),
    pvccontractuallessldnew: sanitizeNum(resultRow.pvccontractuallessldnew),
    loweractuallessld: sanitizeNum(resultRow.loweractuallessld),
    lowercontractuallessld: sanitizeNum(resultRow.lowercontractuallessld),
    delaydays: resultRow.delaydays || 0,
    ldweeks: resultRow.ldweeks || 0,
    ldratepct: sanitizeNum(resultRow.ldratepct) ?? 0.0,
    ldapplicable: Boolean(resultRow.ldapplicable),
    selectedscenario: resultRow.selectedscenarionew || 'A2',
    pvcperseta2: sanitizeNum(resultRow.pvcperseta2),
    pvcpersetb2: sanitizeNum(resultRow.pvcpersetb2),
    pvcpersetc1: sanitizeNum(resultRow.pvcpersetc1),
    pvcpersetd1: sanitizeNum(resultRow.pvcpersetd1),
    tenderno: resultRow.tenderno || null,
    pono: resultRow.pono || null,
    scenarioamounts: resultRow.scenarioamounts || {},
    scenariodetails: resultRow.scenariodetails || [],
    igbtvendordetails: resultRow.igbtvendordetails || [],
    igbtindexdetails: resultRow.igbtindexdetails || [],
    developmentaltender: Boolean(data.developmentaltender),
  };

  const scenarioamountsJson = JSON.stringify(payload.scenarioamounts);
  const scenariodetailsJson = JSON.stringify(payload.scenariodetails);
  const igbtVendorDetailsJson = JSON.stringify(payload.igbtvendordetails);

  const lastCalcCookie = req.cookies?.last_calc_id;
  let calc =
    lastCalcCookie && /^\d+$/.test(String(lastCalcCookie))
      ? store.getPVCResultById(parseInt(String(lastCalcCookie), 10))
      : undefined;

  if (calc && (calc.user_id !== currentUser.id || calc.item_id !== item.id)) {
    calc = undefined;
  }

  const recordData = {
    user_id: currentUser.id,
    username: currentUser.username,
    item_id: item.id,
    basicrate: data.basicrate || 0,
    quantity: data.quantity || 0,
    freightrateperunit: data.freightrateperunit || 0,
    pvcbasedate: data.pvcbasedate,
    origdp: data.origdp,
    refixeddp: data.refixeddp,
    extendeddp: data.extendeddp,
    caldate: data.caldate,
    supdate: data.supdate,
    rateapplied: data.rateapplied,
    pvcactual: payload.pvcactual,
    pvccontractual: payload.pvccontractual,
    loweractual: payload.loweractual,
    lowercontractual: payload.lowercontractual,
    ldamtactual: payload.ldamtactual,
    ldamtcontractual: payload.ldamtcontractual,
    fairprice: payload.fairprice,
    selectedscenario: payload.selectedscenario,
    pvcactuallessldnew: payload.pvcactuallessldnew,
    pvccontractuallessldnew: payload.pvccontractuallessldnew,
    loweractuallessld: payload.loweractuallessld,
    lowercontractuallessld: payload.lowercontractuallessld,
    delaydays: payload.delaydays,
    ldweeksnew: payload.ldweeks,
    ldratepctnew: payload.ldratepct,
    ldapplicable: payload.ldapplicable,
    pvcperseta2: payload.pvcperseta2,
    pvcpersetb2: payload.pvcpersetb2,
    pvcpersetc1: payload.pvcpersetc1,
    pvcpersetd1: payload.pvcpersetd1,
    tenderno: payload.tenderno,
    pono: payload.pono,
    scenarioamounts_json: scenarioamountsJson,
    scenariodetails_json: scenariodetailsJson,
    igbt_vendor_details_json: igbtVendorDetailsJson,
  };

  let savedId: number;
  if (calc) {
    store.updatePVCResult(calc.id, recordData, currentUser.id);
    savedId = calc.id;
  } else {
    const created = store.createPVCResult(recordData, currentUser.id);
    savedId = created.id;
  }

  const comparison = buildComparisonSummary(payload, data.rateapplied);

  const displayData = {
    ...data,
    pvcbasedate: formatDateDDMMYYYY(data.pvcbasedate),
    origdp: formatDateDDMMYYYY(data.origdp),
    refixeddp: formatDateDDMMYYYY(data.refixeddp),
    extendeddp: formatDateDDMMYYYY(data.extendeddp),
    caldate: formatDateDDMMYYYY(data.caldate),
    supdate: formatDateDDMMYYYY(data.supdate),
    lowerbasicdate: formatDateDDMMYYYY(data.lowerbasicdate),
  };

  const action = body.action;
  res.cookie('last_calc_id', String(savedId), {
    maxAge: 3600 * 1000,
    httpOnly: true,
    sameSite: req.secure ? 'none' : 'lax',
    secure: req.secure,
  });

  res.render('result.html', {
    item: item.name,
    itemobj: item,
    data: displayData,
    result: buildResultObj(payload),
    calcid: savedId,
    auto_summary: action === 'summary',
    comparison,
  });
});

// ── View Saved Calculation ────────────────────────────────────────────────

pvcRouter.get('/calc/:calcid', requireLogin, (req, res) => {
  res.locals.request.endpoint = 'pvc.view_calc';
  const calcId = parseInt(req.params.calcid, 10);
  const calc = store.getPVCResultById(calcId);
  const currentUser = res.locals.current_user;
  if (!calc || (!currentUser.is_admin && calc.user_id !== currentUser.id)) {
    res.status(404).send('Calculation not found');
    return;
  }

  const item = calc.item;
  const data = {
    basicrate: calc.basicrate ? Number(calc.basicrate.toFixed(2)) : 0,
    quantity: calc.quantity ? Number(calc.quantity.toFixed(2)) : 0,
    freightrateperunit: calc.freightrateperunit ? Number(calc.freightrateperunit.toFixed(2)) : 0,
    pvcbasedate: formatDateDDMMYYYY(calc.pvcbasedate),
    origdp: formatDateDDMMYYYY(calc.origdp),
    refixeddp: formatDateDDMMYYYY(calc.refixeddp),
    extendeddp: formatDateDDMMYYYY(calc.extendeddp),
    caldate: formatDateDDMMYYYY(calc.caldate),
    supdate: formatDateDDMMYYYY(calc.supdate),
    rateapplied: calc.rateapplied,
    lowerrate: null,
    lowerfreight: 0,
    lowerbasicdate: null,
    developmentaltender: false,
  };

  let scenarioamounts: Record<string, number | null> = {};
  let scenariodetails: ScenarioDetail[] = [];
  let igbtvendordetails = [];
  try { scenarioamounts = JSON.parse(calc.scenarioamounts_json || '{}'); } catch { scenarioamounts = {}; }
  try { scenariodetails = JSON.parse(calc.scenariodetails_json || '[]'); } catch { scenariodetails = []; }
  try { igbtvendordetails = JSON.parse(calc.igbt_vendor_details_json || '[]'); } catch { igbtvendordetails = []; }

  const payload = {
    pvcactual: calc.pvcactual,
    pvccontractual: calc.pvccontractual,
    loweractual: calc.loweractual,
    lowercontractual: calc.lowercontractual,
    ldamtactual: calc.ldamtactual,
    ldamtcontractual: calc.ldamtcontractual,
    fairprice: calc.fairprice,
    selectedscenario: calc.selectedscenario,
    ldapplicable: calc.ldapplicable,
    pvcactuallessldnew: calc.pvcactuallessldnew,
    pvccontractuallessldnew: calc.pvccontractuallessldnew,
    loweractuallessld: calc.loweractuallessld,
    lowercontractuallessld: calc.lowercontractuallessld,
    delaydays: calc.delaydays,
    ldweeks: calc.ldweeksnew,
    ldratepct: calc.ldratepctnew,
    pvcperseta2: calc.pvcperseta2,
    pvcpersetb2: calc.pvcpersetb2,
    pvcpersetc1: calc.pvcpersetc1,
    pvcpersetd1: calc.pvcpersetd1,
    tenderno: calc.tenderno,
    pono: calc.pono,
    scenarioamounts,
    scenariodetails,
    igbtvendordetails,
    igbtindexdetails: [],
    developmentaltender: false,
  };

  const comparison = buildComparisonSummary(payload, calc.rateapplied);

  res.render('result.html', {
    item: item ? item.name : '',
    itemobj: item || null,
    data,
    result: buildResultObj(payload),
    calcid: calc.id,
    auto_summary: false,
    comparison,
  });
});

// ── Export Single Calculation to Excel ───────────────────────────────────

pvcRouter.get('/calc/:calcid/excel', requireLogin, (req, res) => {
  const calcId = parseInt(req.params.calcid, 10);
  const calc = store.getPVCResultById(calcId);
  const currentUser = res.locals.current_user;
  if (!calc || (!currentUser.is_admin && calc.user_id !== currentUser.id)) {
    res.status(404).send('Calculation not found');
    return;
  }

  const item = calc.item;
  const maindata = {
    'Calc ID': calc.id,
    User: calc.username,
    Item: item ? item.name : '',
    'Basic Rate': calc.basicrate,
    Quantity: calc.quantity,
    FreightUnit: calc.freightrateperunit,
    'PVC Base Date': calc.pvcbasedate,
    'Original DP': calc.origdp,
    'Refixed DP': calc.refixeddp,
    'Extended DP': calc.extendeddp,
    'Call Date': calc.caldate,
    'Supply Date': calc.supdate,
    'Rate Applied': calc.rateapplied,
    'PVC Actual': calc.pvcactual,
    'PVC Contractual': calc.pvccontractual,
    'Lower Actual': calc.loweractual,
    'Lower Contractual': calc.lowercontractual,
    'LD Days': calc.delaydays,
    'LD Weeks': calc.ldweeksnew,
    'LD Rate': calc.ldratepctnew,
    'LD Amt Actual': calc.ldamtactual,
    'LD Amt Contractual': calc.ldamtcontractual,
    'PVC Actual-LD': calc.pvcactuallessldnew,
    'PVC Contractual-LD': calc.pvccontractuallessldnew,
    'Lower Actual-LD': calc.loweractuallessld,
    'Lower Contr-LD': calc.lowercontractuallessld,
    'Fair Price': calc.fairprice,
    'Selected Scenario': calc.selectedscenario ? SC_MAP[calc.selectedscenario] || calc.selectedscenario : '',
    'Tender No': calc.tenderno,
    'PO No': calc.pono,
  };

  let saObj: Record<string, unknown> = {};
  let sdArr: Array<Record<string, unknown>> = [];
  let igbtArr: Array<Record<string, unknown>> = [];
  try { saObj = JSON.parse(calc.scenarioamounts_json || '{}') || {}; } catch { saObj = {}; }
  try { sdArr = JSON.parse(calc.scenariodetails_json || '[]') || []; } catch { sdArr = []; }
  try { igbtArr = JSON.parse(calc.igbt_vendor_details_json || '[]') || []; } catch { igbtArr = []; }

  const sadata = Object.entries(saObj).map(([sc, amount]) => ({
    Scenario: SC_MAP[sc] || sc,
    Amount: amount,
  }));

  const sddata = sdArr.map((det) => {
    const sc = String(det.scenario || '');
    const row: Record<string, unknown> = {
      Scenario: SC_MAP[sc] || sc,
      'Base Month': det.basemonth,
      'Current Month': det.currentmonth,
      PVC: det.pvcpercent,
    };
    for (const [k, v] of Object.entries(det)) {
      if (!['scenario', 'basemonth', 'currentmonth', 'pvcpercent'].includes(k)) {
        row[k] = v;
      }
    }
    return row;
  });

  const igbtvendors = igbtArr.map((v) => ({
    ...v,
    scenario: v.scenario ? SC_MAP[String(v.scenario)] || v.scenario : v.scenario,
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([maindata]), 'PVC Result');
  if (sadata.length > 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sadata), 'Scenario Amounts');
  }
  if (sddata.length > 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sddata), 'Index Details');
  }
  if (igbtvendors.length > 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(igbtvendors), 'IGBT Vendors');
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="PVC_Calc_${calc.id}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Bulk PVC Calculator ───────────────────────────────────────────────────

pvcRouter.get('/bulk_calculator', requireLogin, (_req, res) => {
  res.locals.request.endpoint = 'pvc.bulk_calculator';
  const items = store.getItems();
  res.render('bulk_pvc_calculator.html', { items });
});

pvcRouter.post('/bulk_calculate', requireLogin, upload.single('data_file'), (req, res) => {
  if (!req.file) {
    flashMessage(req, 'A data file is required.', 'danger');
    res.redirect('/pvc/bulk_calculator');
    return;
  }

  let rawRows: Array<Record<string, unknown>> = [];
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const firstSheet = wb.SheetNames[0];
    rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[firstSheet], { defval: null });
  } catch (err) {
    flashMessage(req, `Error reading the data file: ${err instanceof Error ? err.message : String(err)}`, 'danger');
    res.redirect('/pvc/bulk_calculator');
    return;
  }

  if (!rawRows.length) {
    flashMessage(req, 'No records were found in the uploaded Excel file.', 'warning');
    res.redirect('/pvc/bulk_calculator');
    return;
  }

  const normalizedRows = rawRows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.toLowerCase().replace(/\s+/g, '')] = v;
    }
    return out;
  });

  if (!('tenderno' in normalizedRows[0])) {
    flashMessage(req, "The uploaded Excel file must contain a 'tenderno' column.", 'danger');
    res.redirect('/pvc/bulk_calculator');
    return;
  }

  const allTenders = store.getTenders();
  const tendersMap = new Map<string, TenderMasterRecord & { item?: ReturnType<typeof store.getItemById> }>();
  for (const t of allTenders) {
    tendersMap.set(t.tender_no, t);
  }
  const vendorsMap = new Map<number, TenderVendorRecord[]>();
  for (const v of store.getAllVendors()) {
    const list = vendorsMap.get(v.tender_id) || [];
    list.push(v);
    vendorsMap.set(v.tender_id, list);
  }

  const results: Array<Record<string, unknown>> = [];
  let lastItemName = 'Bulk';

  for (const row of normalizedRows) {
    const data: Record<string, unknown> = { ...row };
    for (const dateCol of ['pvcbasedate', 'origdp', 'refixeddp', 'extendeddp', 'caldate', 'supdate', 'lowerbasicdate']) {
      if (dateCol in data && data[dateCol] !== null && data[dateCol] !== undefined) {
        data[dateCol] = normalizeExcelDate(data[dateCol]);
      }
    }

    try {
      const tenderNo = data.tenderno ? String(data.tenderno).trim() : '';
      if (!tenderNo) throw new Error("Row is missing a 'tenderno'.");
      const tender = tendersMap.get(tenderNo);
      if (!tender) throw new Error(`Tender No '${tenderNo}' not found in the database.`);
      const item = tender.item;
      if (!item) throw new Error(`Tender '${tenderNo}' is not linked to a valid item.`);
      lastItemName = item.name;

      data.tenderid = tender.id;

      if (data.pono) {
        const poStr = String(data.pono).trim();
        const tenderVendors = vendorsMap.get(tender.id) || [];
        const matchV = tenderVendors.find((v) => v.po_no === poStr);
        if (matchV) {
          data.vendorid = matchV.id;
          data.vendorname = matchV.vendor_name;
          if (!data.freightrateperunit) data.freightrateperunit = matchV.freightrateperunit;
        }
      }

      const isLower = ['1', 'true', 'yes'].includes(String(data.lowerrateapplicable ?? '').toLowerCase());
      if (isLower) {
        data.lowerrateapplicable = true;
        const subTenderNo = data.subsequenttenderno ? String(data.subsequenttenderno).trim() : '';
        if (subTenderNo) {
          const subTender = tendersMap.get(subTenderNo);
          if (subTender) {
            data.subsequent_tenderid = subTender.id;
            if (!data.lowerrate) data.lowerrate = subTender.basicrate;
            if (!data.lowerbasicdate) data.lowerbasicdate = subTender.pvcbasedate;
            const isIgbt = (item.pvc_formula_code || '').replace(/\s+/g, '').toUpperCase() === 'IGBTPROPULSIONSYSTEM';
            if (isIgbt && data.vendorname) {
              const subVendors = vendorsMap.get(subTender.id) || [];
              const subVendor = subVendors.find((v) => v.vendor_name === data.vendorname);
              if (subVendor && !data.lowerfreight) {
                data.lowerfreight = subVendor.freightrateperunit;
              }
            }
          }
        }
      }

      if (!data.rateapplied) {
        const supDt = parseDateYMD(data.supdate as string);
        const origDt = parseDateYMD(data.origdp as string);
        const refixDt = parseDateYMD(data.refixeddp as string);
        const latestDp = refixDt || origDt;
        if (supDt && latestDp) {
          const lowerFlag = data.lowerrateapplicable === true || safeFloat(data.lowerrate) > 0;
          if (supDt.getTime() <= latestDp.getTime()) {
            data.rateapplied = lowerFlag ? 'Lower Rate Applicable Within DP' : 'Supply Within Original DP or Refixed DP';
          } else {
            data.rateapplied = lowerFlag ? 'Lower Rate Applicable Beyond DP With LD' : 'Supply Beyond Original DP or Refixed DP';
          }
        }
      }

      const idxMap = getItemIndexMap(item.id);
      if (idxMap.size === 0) throw new Error(`Indices not configured for item '${item.name}'.`);
      let weights: Record<string, number> = {};
      try { weights = JSON.parse(item.weights_json || '{}'); } catch { weights = {}; }

      const pvcInput: PVCInputData = {
        basicrate: safeFloat(data.basicrate || tender.basicrate),
        quantity: safeFloat(data.quantity || 1),
        freightrateperunit: safeFloat(data.freightrateperunit),
        pvcbasedate: (data.pvcbasedate as string) || tender.pvcbasedate,
        origdp: (data.origdp as string) || null,
        refixeddp: (data.refixeddp as string) || null,
        extendeddp: (data.extendeddp as string) || null,
        caldate: (data.caldate as string) || null,
        supdate: (data.supdate as string) || null,
        lowerrate: safeFloat(data.lowerrate),
        lowerfreight: safeFloat(data.lowerfreight),
        lowerbasicdate: (data.lowerbasicdate as string) || null,
        rateapplied: (data.rateapplied as string) || null,
        tenderid: tender.id,
        vendorid: data.vendorid as number | undefined,
        subsequent_tenderid: data.subsequent_tenderid as number | undefined,
        pono: data.pono ? String(data.pono) : null,
        developmentaltender: ['1', 'true', 'yes'].includes(String(data.developmentaltender ?? '').toLowerCase()),
      };

      const resRow = calculateForItem(item, pvcInput, idxMap, weights);
      const flatRow: Record<string, unknown> = {
        ...data,
        pvcactual: resRow.pvcactual,
        pvccontractual: resRow.pvccontractual,
        loweractual: resRow.loweractual,
        lowercontractual: resRow.lowercontractual,
        delaydays: resRow.delaydays,
        ldweeks: resRow.ldweeks,
        ldratepct: resRow.ldratepct,
        ldapplicable: resRow.ldapplicable,
        ldamtactual: resRow.ldamtactual,
        ldamtcontractual: resRow.ldamtcontractual,
        pvcactuallessldnew: resRow.pvcactuallessldnew,
        pvccontractuallessldnew: resRow.pvccontractuallessldnew,
        loweractuallessld: resRow.loweractuallessld,
        lowercontractuallessld: resRow.lowercontractuallessld,
        fairpricenew: resRow.fairpricenew,
        selectedscenarionew: resRow.selectedscenarionew,
        pvcperseta2: resRow.pvcperseta2,
        pvcpersetb2: resRow.pvcpersetb2,
        pvcpersetc1: resRow.pvcpersetc1,
        pvcpersetd1: resRow.pvcpersetd1,
      };
      if ('passed_amount' in flatRow) {
        flatRow.difference = safeFloat(flatRow.passed_amount) - safeFloat(flatRow.fairpricenew);
      }
      results.push(flatRow);
    } catch (err) {
      results.push({ ...data, calculation_error: err instanceof Error ? err.message : String(err) });
    }
  }

  const outWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(results), 'Bulk_PVC_Results');
  const buf = XLSX.write(outWb, { type: 'buffer', bookType: 'xlsx' });
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeName = lastItemName.replace(/[^A-Za-z0-9_-]/g, '_');

  res.setHeader('Content-Disposition', `attachment; filename="Bulk_PVC_Report_${safeName}_${dateStamp}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
