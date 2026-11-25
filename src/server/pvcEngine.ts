import { store } from './store.js';
import {
  IGBTIndexDetail,
  IGBTVendorSummary,
  ItemRecord,
  PVCCalculationOutput,
  PVCInputData,
  ScenarioDetail,
  TenderVendorRecord,
} from './types.js';

export const GST_FACTOR = 1.18;

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function safeFloat(x: unknown): number {
  if (x === null || x === undefined || x === '') return 0.0;
  const cleaned = String(x).replace(/,/g, '').trim();
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : 0.0;
}

export function safeRound(x: unknown, n = 2): number | null {
  if (x === null || x === undefined) return null;
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  const factor = Math.pow(10, n);
  return Math.round((v + Number.EPSILON) * factor) / factor;
}

export function formatDateDDMMYYYY(dStr: string | null | undefined): string | null {
  if (!dStr) return dStr ?? null;
  const datePart = String(dStr).split('T')[0];
  const parts = datePart.split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return dStr;
}

export interface YearMonth {
  year: number;
  month: number; // 1-12
}

export function parseDateYMD(d: string | Date | null | undefined): Date | null {
  if (!d) return null;
  if (d instanceof Date) {
    return isNaN(d.getTime()) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  const s = String(d).trim();
  if (!s) return null;

  // YYYY-MM-DD or YYYY-MM-DDTHH...
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return new Date(Date.UTC(y, m - 1, day));
  }

  // DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const m = Number(dmyMatch[2]);
    let y = Number(dmyMatch[3]);
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, m - 1, day));
  }

  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

export function toMonthStart(d: string | Date | null | undefined): YearMonth | null {
  const dt = parseDateYMD(d);
  if (!dt) return null;
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1 };
}

export function previousMonth(d: string | Date | YearMonth | null | undefined, n = 1): YearMonth | null {
  let ym: YearMonth | null = null;
  if (d && typeof d === 'object' && 'year' in d && 'month' in d) {
    ym = d;
  } else {
    ym = toMonthStart(d as string | Date | null | undefined);
  }
  if (!ym) return null;
  let totalMonths = ym.year * 12 + (ym.month - 1) - n;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  return { year, month };
}

export function ymKey(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, '0')}-01`;
}

export function ymShortLabel(ym: YearMonth): string {
  return `${MONTH_SHORT[ym.month - 1]} ${ym.year}`;
}

export function ymLongLabel(ym: YearMonth): string {
  return `${MONTH_LONG[ym.month - 1]} ${ym.year}`;
}

export type IndexTable = Map<string, Record<string, number>>;

export function getItemIndexMap(itemId: number): IndexTable {
  const rows = store.getItemIndices(itemId, 'asc');
  const map: IndexTable = new Map();
  for (const r of rows) {
    const ym = toMonthStart(r.month);
    if (!ym) continue;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(r.indices_json || '{}');
    } catch {
      parsed = {};
    }
    const nums: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== null && v !== undefined && v !== '') {
        const num = Number(v);
        if (Number.isFinite(num)) nums[k] = num;
      }
    }
    map.set(ymKey(ym), nums);
  }
  return map;
}

function ieemaRow(
  idxMap: IndexTable,
  dt: string | Date | YearMonth | null | undefined,
  previous = false,
  lag = 1
): { ym: YearMonth; key: string; values: Record<string, number> } | null {
  if (!idxMap || idxMap.size === 0) {
    throw new Error('No index data available for this item.');
  }
  const target = previous
    ? previousMonth(dt, lag)
    : dt && typeof dt === 'object' && 'year' in dt && 'month' in dt
      ? dt
      : toMonthStart(dt as string | Date | null | undefined);

  if (!target) return null;
  const key = ymKey(target);
  const values = idxMap.get(key);
  if (!values) {
    throw new Error(
      `Indices for ${ymLongLabel(target)} not in data set. Please input indices for that required month.`
    );
  }
  return { ym: target, key, values };
}

export function pvcPercent(
  baseDate: string | null | undefined,
  currentDate: string | null | undefined,
  idxMap: IndexTable,
  weights: Record<string, number>,
  lag = 1
): number {
  const base = ieemaRow(idxMap, baseDate, false);
  const curr = ieemaRow(idxMap, currentDate, true, lag);
  if (!base || !curr) return 0.0;
  let total = 0.0;
  for (const [key, weight] of Object.entries(weights)) {
    const b = base.values[key];
    const c = curr.values[key];
    if (b !== undefined && b !== 0 && c !== undefined) {
      total += Number(weight) * (c - b) / b;
    }
  }
  return total;
}

export function pvcPercentDetailed(
  baseDate: string | null | undefined,
  currentDate: string | null | undefined,
  idxMap: IndexTable,
  scenario: string,
  weights: Record<string, number>,
  lag = 1
): ScenarioDetail | null {
  const base = ieemaRow(idxMap, baseDate, false);
  const curr = ieemaRow(idxMap, currentDate, true, lag);
  if (!base || !curr) return null;

  const row: ScenarioDetail = {
    scenario,
    basemonth: base.key,
    currentmonth: curr.key,
    pvcpercent: 0.0,
  };
  let total = 0.0;
  const baseMStr = ymShortLabel(base.ym);
  const currMStr = ymShortLabel(curr.ym);

  for (const [key, weight] of Object.entries(weights)) {
    const b = base.values[key];
    const c = curr.values[key];
    let contrib: number | null = null;
    if (b !== undefined && b !== 0 && c !== undefined) {
      contrib = safeRound(Number(weight) * (c - b) / b, 4);
      if (contrib !== null) total += contrib;
    }
    row[`${key}_base`] = b !== undefined ? safeRound(b, 2) : null;
    row[`${key}_current`] = c !== undefined ? safeRound(c, 2) : null;
    row[`${key}_weight`] = weight;
    row[`${key}_contributionpct`] = contrib;
    row[`${key}_actualbasemonth`] = baseMStr;
    row[`${key}_actualcurrentmonth`] = currMStr;
  }
  row.pvcpercent = safeRound(total, 4) ?? 0;
  return row;
}

// ── IGBT Helpers ──────────────────────────────────────────────────────────

function igbtIndexValues(
  idxMap: IndexTable,
  baseMonth: YearMonth,
  refMonth: YearMonth,
  currencyInput: string
) {
  const currency = (currencyInput || 'EUR').toUpperCase().trim();
  const ercol = `ER_${currency}`;

  const baseRow = ieemaRow(idxMap, baseMonth, false);
  const row1m = ieemaRow(idxMap, previousMonth(refMonth, 1), false);
  const row3m = ieemaRow(idxMap, previousMonth(refMonth, 3), false);

  if (!baseRow || !row1m || !row3m) {
    throw new Error('IGBT indices missing for one or more required months.');
  }

  const getVal = (row: Record<string, number>, col: string): number => {
    const v = row[col];
    if (v === undefined || v === null) {
      throw new Error(`Index column '${col}' is missing in the data.`);
    }
    return Number(v);
  };

  const baseidx: Record<string, number> = {
    C: getVal(baseRow.values, 'C'),
    AL: getVal(baseRow.values, 'AL'),
    FE: getVal(baseRow.values, 'FE'),
    IM: getVal(baseRow.values, 'IM'),
    W: getVal(baseRow.values, 'W'),
    D: getVal(baseRow.values, 'D'),
    ER: getVal(baseRow.values, ercol),
  };

  const curridx: Record<string, number> = {
    C: getVal(row1m.values, 'C'),
    AL: getVal(row1m.values, 'AL'),
    FE: getVal(row1m.values, 'FE'),
    IM: getVal(row1m.values, 'IM'),
    W: getVal(row1m.values, 'W'),
    D: getVal(row1m.values, 'D'),
    ER: getVal(row3m.values, ercol), // 3-month lag for ER
  };

  const basedates: Record<string, YearMonth> = {
    C: baseRow.ym, AL: baseRow.ym, FE: baseRow.ym,
    IM: baseRow.ym, W: baseRow.ym, D: baseRow.ym, ER: baseRow.ym,
  };
  const currdates: Record<string, YearMonth> = {
    C: row1m.ym, AL: row1m.ym, FE: row1m.ym,
    IM: row1m.ym, W: row1m.ym, D: row1m.ym, ER: row3m.ym,
  };

  return { baseidx, curridx, basedates, currdates };
}

function igbtP1Indigenous(
  baseidx: Record<string, number>,
  curridx: Record<string, number>,
  weights: Record<string, number>,
  indigenousPortion: number
): number {
  const Fc = Number(weights.FIXED ?? 16);
  const wC = Number(weights.C ?? 26);
  const wAL = Number(weights.AL ?? 13);
  const wFE = Number(weights.FE ?? 18);
  const wIM = Number(weights.IM ?? 9);
  const wW = Number(weights.W ?? 18);

  const factor =
    Fc +
    (wC * curridx.C) / baseidx.C +
    (wAL * curridx.AL) / baseidx.AL +
    (wFE * curridx.FE) / baseidx.FE +
    (wIM * curridx.IM) / baseidx.IM +
    (wW * curridx.W) / baseidx.W;

  return indigenousPortion * (factor / 100.0) - indigenousPortion;
}

function igbtP2Cif(cif: number, baseidx: Record<string, number>, curridx: Record<string, number>): number {
  const ER0 = baseidx.ER;
  const ER1 = curridx.ER;
  const D0 = baseidx.D;
  const D1 = curridx.D;
  return cif * ((ER1 * (100 + D1)) / (100 * ER0) - (100 + D0) / 100);
}

function igbtVendorScenario(
  rate: number,
  vendor: TenderVendorRecord,
  baseMonth: YearMonth,
  refMonth: YearMonth,
  idxMap: IndexTable,
  weights: Record<string, number>,
  scenarioLabel: string,
  basicRateForPvc?: number,
  origBaseMonth?: YearMonth,
  cifOverride?: number
): { summary: IGBTVendorSummary; indexdetails: IGBTIndexDetail[]; totalPvc: number } {
  const effRate = basicRateForPvc ?? rate;
  const effOrigBase = origBaseMonth ?? baseMonth;
  const currency = (vendor.currency || 'EUR').toUpperCase();

  const { baseidx, curridx, basedates, currdates } = igbtIndexValues(idxMap, baseMonth, refMonth, currency);
  let origidx = baseidx;
  let origdates = basedates;
  if (ymKey(effOrigBase) !== ymKey(baseMonth)) {
    const orig = igbtIndexValues(idxMap, effOrigBase, refMonth, currency);
    origidx = orig.baseidx;
    origdates = orig.basedates;
  }

  const cif = cifOverride !== undefined ? safeFloat(cifOverride) : safeFloat(vendor.cif);
  const baseduty = (cif * origidx.D) / 100;
  const indigenousPortion = effRate - cif - baseduty;
  const p1 = igbtP1Indigenous(baseidx, curridx, weights, indigenousPortion);
  const p2 = igbtP2Cif(cif, origidx, curridx);
  const totalPvc = p1 + p2;

  const baseMonthStr = ymKey(baseMonth);
  const currMonthStr = ymKey(refMonth);
  const origMonthStr = ymKey(effOrigBase);

  const summary: IGBTVendorSummary = {
    scenario: scenarioLabel,
    vendor: vendor.vendor_name,
    pono: vendor.po_no,
    currency,
    rate,
    basicrate: effRate,
    cif,
    baseduty,
    indigenous: indigenousPortion,
    p1,
    p2,
    totalpvc: totalPvc,
    basemonth: baseMonthStr,
    currentmonth: currMonthStr,
    origbasemonth: origMonthStr,
  };

  const indexColumns: Array<[string, string, boolean]> = [
    ['C', 'Copper Index', false],
    ['AL', 'Aluminium Index', false],
    ['FE', 'Iron / Steel Index', false],
    ['IM', 'Import Machine Index', false],
    ['W', 'Labour / Wage Index', false],
    ['D', 'Import Duty', true],
    ['ER', `Exchange Rate ${currency}`, true],
  ];

  const indexdetails: IGBTIndexDetail[] = indexColumns.map(([col, label, useOrig]) => {
    const bVal = useOrig ? origidx[col] : baseidx[col];
    const bDate = useOrig ? origdates[col] : basedates[col];
    const bMonthStr = useOrig ? origMonthStr : baseMonthStr;
    return {
      scenario: scenarioLabel,
      vendor: vendor.vendor_name,
      currency,
      parameter: col !== 'ER' ? col : `ER_${currency}`,
      label,
      weight: weights[col] ?? null,
      basemonth: bMonthStr,
      actualbasemonth: ymShortLabel(bDate),
      basevalue: safeRound(bVal, 4) ?? 0,
      currentmonth: currMonthStr,
      actualcurrentmonth: ymShortLabel(currdates[col]),
      currentvalue: safeRound(curridx[col], 4) ?? 0,
    };
  });

  return { summary, indexdetails, totalPvc };
}

function buildCandidates(
  rateApplied: string,
  pvcactual: number | null,
  pvccontractual: number | null,
  pvcactuallessld: number | null,
  pvccontractuallessld: number | null,
  loweractual: number | null,
  lowercontractual: number | null,
  loweractuallessld: number | null,
  lowercontractuallessld: number | null,
  lowerrateApplicable: boolean
): Record<string, number | null> {
  if (rateApplied === 'supply before due date' || rateApplied === 'supply within original dp or refixed dp') {
    return { A2: pvcactual };
  }
  if (rateApplied === 'lower rate applicable within dp') {
    const d: Record<string, number | null> = { A2: pvcactual };
    if (lowerrateApplicable) d.C1 = loweractual;
    return d;
  }
  if (rateApplied === 'supply after due date' || rateApplied === 'supply beyond original dp or refixed dp') {
    return { A2: pvcactuallessld, B2: pvccontractuallessld };
  }
  if (rateApplied === 'lower rate applicable' || rateApplied === 'lower rate applicable beyond dp without ld') {
    const d: Record<string, number | null> = { A2: pvcactual, B2: pvccontractual };
    if (lowerrateApplicable) {
      d.C1 = loweractual;
      d.D1 = lowercontractual;
    }
    return d;
  }
  if (rateApplied === 'lower rate and ld comparison' || rateApplied === 'lower rate applicable beyond dp with ld') {
    const d: Record<string, number | null> = { A2: pvcactuallessld, B2: pvccontractuallessld };
    if (lowerrateApplicable) {
      d.C1 = loweractual;
      d.D1 = lowercontractual;
    }
    return d;
  }
  if (
    rateApplied === 'lower rate with ld in further extension' ||
    rateApplied === 'lower rate applicable in further dp extension with ld'
  ) {
    const d: Record<string, number | null> = { A2: pvcactuallessld, B2: pvccontractuallessld };
    if (lowerrateApplicable) {
      d.C1 = loweractuallessld;
      d.D1 = lowercontractuallessld;
    }
    return d;
  }
  const d: Record<string, number | null> = { A2: pvcactual, B2: pvccontractual };
  if (lowerrateApplicable) {
    d.C1 = loweractual;
    d.D1 = lowercontractual;
  }
  return d;
}

function pickMinimumCandidate(candidates: Record<string, number | null>): { selected: string; fairprice: number | null } {
  let selected = 'A2';
  let minVal: number | null = null;
  for (const [k, v] of Object.entries(candidates)) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (minVal === null || v < minVal) {
      minVal = v;
      selected = k;
    }
  }
  return { selected, fairprice: minVal };
}

function calculateLD(ldScheduledDate: string | null | undefined, supplyDate: string | null | undefined, developmental: boolean) {
  let delaydays = 0;
  let ldweeks = 0;
  let ldratepct = 0.0;
  let ldapplicable = false;

  const schedTs = parseDateYMD(ldScheduledDate);
  const supplyTs = parseDateYMD(supplyDate);
  if (schedTs && supplyTs && supplyTs.getTime() > schedTs.getTime()) {
    delaydays = Math.round((supplyTs.getTime() - schedTs.getTime()) / (1000 * 60 * 60 * 24));
    ldweeks = delaydays > 0 ? Math.ceil(delaydays / 7) : 0;
    ldratepct = Math.min(ldweeks * 0.5, 10.0);
    ldapplicable = true;
  }
  if (developmental) {
    ldapplicable = false;
    ldratepct = 0.0;
    ldweeks = 0;
  }
  return { delaydays, ldweeks, ldratepct, ldapplicable };
}

export function calculateIGBTPropulsion(
  _item: ItemRecord,
  data: PVCInputData,
  tenderId: number | string,
  idxMap: IndexTable,
  weights: Record<string, number>
): PVCCalculationOutput {
  const tenderIdInt = parseInt(String(tenderId), 10);
  if (isNaN(tenderIdInt)) {
    throw new Error(`Invalid Tender ID format: ${tenderId}`);
  }
  const tender = store.getTenderById(tenderIdInt);
  if (!tender) {
    throw new Error(`Tender with ID ${tenderIdInt} not found.`);
  }
  const vendors = store.getTenderVendors(tender.id);
  if (!vendors.length) {
    throw new Error('No vendor rows configured for the selected tender.');
  }

  let selectedVendorPo = data.pono || null;
  if (!selectedVendorPo && data.vendorid) {
    const sv = vendors.find((v) => String(v.id) === String(data.vendorid));
    if (sv) selectedVendorPo = sv.po_no;
  }
  if (!selectedVendorPo && vendors.length > 0) {
    selectedVendorPo = vendors[0].po_no;
  }
  if (selectedVendorPo) {
    data.pono = selectedVendorPo;
  }

  const basicRate = safeFloat(data.basicrate || tender.basicrate);
  const pvcBaseDate = data.pvcbasedate || tender.pvcbasedate;
  const freightPerUnit = safeFloat(data.freightrateperunit || 0);
  let quantity = safeFloat(data.quantity || 1);
  if (quantity <= 0) quantity = 1.0;

  data.basicrate = basicRate;
  data.pvcbasedate = pvcBaseDate;
  data.freightrateperunit = freightPerUnit;
  data.quantity = quantity;

  let lowerRate = safeFloat(data.lowerrate || 0);
  let lowerBase = data.lowerbasicdate;
  let lowerFreight = safeFloat(data.lowerfreight || 0);

  const calDate = data.caldate;
  const origdp = data.origdp;
  const refixeddp = data.refixeddp;
  const extendeddp = data.extendeddp;
  const supplyDate = data.supdate;
  const rateApplied = (data.rateapplied || '').trim().toLowerCase();
  const developmental = Boolean(data.developmentaltender);
  const b2Needed = !['supply before due date', 'supply within original dp or refixed dp', 'lower rate applicable within dp'].includes(rateApplied);

  const pvcScheduledDp = refixeddp || origdp;
  const ldScheduledDp = extendeddp || refixeddp || origdp;

  const basemonth = toMonthStart(pvcBaseDate);
  const calmonth = toMonthStart(calDate);
  const schedmonth = toMonthStart(pvcScheduledDp);

  const subsequentVendorsMap = new Map<string, TenderVendorRecord>();
  if (data.subsequent_tenderid) {
    const subId = parseInt(String(data.subsequent_tenderid), 10);
    const subTender = !isNaN(subId) ? store.getTenderById(subId) : undefined;
    if (subTender) {
      lowerRate = safeFloat(subTender.basicrate);
      lowerBase = subTender.pvcbasedate;
      data.lowerrate = lowerRate;
      data.lowerbasicdate = lowerBase;
      const subVendors = store.getTenderVendors(subTender.id);
      for (const sv of subVendors) {
        subsequentVendorsMap.set(sv.vendor_name, sv);
      }
      if (lowerFreight === 0 && subVendors.length > 0) {
        const matched = data.vendorid
          ? vendors.find((v) => String(v.id) === String(data.vendorid))
          : undefined;
        const subMatch = matched ? subsequentVendorsMap.get(matched.vendor_name) : subVendors[0];
        if (subMatch) {
          lowerFreight = safeFloat(subMatch.freightrateperunit);
          data.lowerfreight = lowerFreight;
        }
      }
    }
  }

  const lowerbaseMonth = lowerBase ? toMonthStart(lowerBase) : null;
  const lowerrateApplicable = lowerRate > 0 && lowerbaseMonth !== null;

  const freightTotal = freightPerUnit * quantity;
  const lowerfreightTotal = lowerFreight * quantity;

  const { delaydays, ldweeks, ldratepct, ldapplicable } = calculateLD(ldScheduledDp, supplyDate, developmental);

  const allVendorSummaries: IGBTVendorSummary[] = [];
  const allIndexDetails: IGBTIndexDetail[] = [];

  const runScenario = (
    label: string,
    rate: number,
    baseM: YearMonth | null,
    refM: YearMonth | null,
    basicRateForPvc?: number,
    origBaseM?: YearMonth | null
  ): number | null => {
    if (!baseM || !refM) return null;
    const scSummaries: IGBTVendorSummary[] = [];
    const scIndices: IGBTIndexDetail[] = [];

    const vendorsToRun: TenderVendorRecord[] = [...vendors];
    if ((label === 'C1' || label === 'D1') && subsequentVendorsMap.size > 0) {
      const existingNames = new Set(vendors.map((v) => v.vendor_name));
      for (const [svName, sv] of subsequentVendorsMap.entries()) {
        if (!existingNames.has(svName)) vendorsToRun.push(sv);
      }
    }

    for (const v of vendorsToRun) {
      let cifToUse = safeFloat(v.cif);
      if ((label === 'C1' || label === 'D1') && subsequentVendorsMap.has(v.vendor_name)) {
        cifToUse = safeFloat(subsequentVendorsMap.get(v.vendor_name)!.cif);
      }
      const { summary, indexdetails } = igbtVendorScenario(
        rate,
        v,
        baseM,
        refM,
        idxMap,
        weights,
        label,
        basicRateForPvc ?? rate,
        origBaseM ?? baseM,
        cifToUse
      );
      scSummaries.push(summary);
      scIndices.push(...indexdetails);
    }

    allVendorSummaries.push(...scSummaries);
    allIndexDetails.push(...scIndices);

    if (!scSummaries.length) return null;
    const valid = scSummaries.map((s) => s.totalpvc).filter((x) => Number.isFinite(x));
    return valid.length ? Math.min(...valid) : null;
  };

  const pvca2 = runScenario('A2', basicRate, basemonth, calmonth, basicRate, basemonth);
  const pvcb2 = b2Needed ? runScenario('B2', basicRate, basemonth, schedmonth, basicRate, basemonth) : null;
  const pvcc1 = lowerrateApplicable ? runScenario('C1', lowerRate, lowerbaseMonth, calmonth, lowerRate, lowerbaseMonth) : null;

  let d1Applicable = lowerrateApplicable;
  if (lowerrateApplicable) {
    const lbdTs = parseDateYMD(lowerBase);
    const odpTs = parseDateYMD(origdp);
    if (lbdTs && odpTs && lbdTs.getTime() > odpTs.getTime()) {
      d1Applicable = false;
    }
  }
  const pvcd1 = d1Applicable && b2Needed ? runScenario('D1', lowerRate, lowerbaseMonth, schedmonth, lowerRate, lowerbaseMonth) : null;

  const withFreightGst = (baseR: number, pvcPerSet: number | null, qty: number, frt: number): number | null => {
    if (pvcPerSet === null) return null;
    return (baseR * qty + pvcPerSet * qty + frt) * GST_FACTOR;
  };

  const pvcactual = withFreightGst(basicRate, pvca2, quantity, freightTotal);
  const pvccontractual = withFreightGst(basicRate, pvcb2, quantity, freightTotal);

  const ldamtactual = ldapplicable && pvcactual !== null ? Math.max(pvcactual, 0) * (ldratepct / 100.0) : 0.0;
  const ldamtcontractual = ldapplicable && pvccontractual !== null ? Math.max(pvccontractual, 0) * (ldratepct / 100.0) : 0.0;

  const pvcactuallessld = pvcactual !== null ? pvcactual - ldamtactual : null;
  const pvccontractuallessld = pvccontractual !== null ? pvccontractual - ldamtcontractual : null;

  const loweractual = lowerrateApplicable ? withFreightGst(lowerRate, pvcc1, quantity, lowerfreightTotal) : null;
  const lowercontractual = d1Applicable ? withFreightGst(lowerRate, pvcd1, quantity, lowerfreightTotal) : null;

  const loweractuallessld = loweractual !== null ? loweractual - ldamtactual : null;
  const lowercontractuallessld = lowercontractual !== null ? lowercontractual - ldamtcontractual : null;

  const candidates = buildCandidates(
    rateApplied,
    pvcactual,
    pvccontractual,
    pvcactuallessld,
    pvccontractuallessld,
    loweractual,
    lowercontractual,
    loweractuallessld,
    lowercontractuallessld,
    lowerrateApplicable
  );
  const { selected, fairprice: pickedFair } = pickMinimumCandidate(candidates);
  const fairprice = pickedFair ?? pvcactual;

  const scenarioamounts: Record<string, number | null> = { A2: safeRound(pvcactuallessld) };
  if (b2Needed) scenarioamounts.B2 = safeRound(pvccontractuallessld);
  if (lowerrateApplicable) scenarioamounts.C1 = safeRound(loweractual);
  if (d1Applicable && b2Needed) scenarioamounts.D1 = safeRound(lowercontractual);

  const scenariodetails: ScenarioDetail[] = [];
  const ieemaScenarios: Array<[string, string | null | undefined, string | null | undefined]> = [['A2', pvcBaseDate, calDate]];
  if (b2Needed) ieemaScenarios.push(['B2', pvcBaseDate, pvcScheduledDp]);
  if (lowerrateApplicable) ieemaScenarios.push(['C1', lowerBase, calDate]);
  if (d1Applicable && b2Needed) ieemaScenarios.push(['D1', lowerBase, pvcScheduledDp]);
  for (const [sc, bd, cd] of ieemaScenarios) {
    if (bd && cd) {
      const det = pvcPercentDetailed(bd, cd, idxMap, sc, weights);
      if (det) scenariodetails.push(det);
    }
  }

  return {
    pvcactual: safeRound(pvcactual),
    pvccontractual: safeRound(pvccontractual),
    loweractual: lowerrateApplicable ? safeRound(loweractual) : null,
    lowercontractual: lowerrateApplicable ? safeRound(lowercontractual) : null,
    delaydays,
    ldweeks,
    ldratepct: safeRound(ldratepct) ?? 0,
    ldapplicable,
    ldamtactual: safeRound(ldamtactual) ?? 0,
    ldamtcontractual: safeRound(ldamtcontractual) ?? 0,
    pvcactuallessldnew: safeRound(pvcactuallessld),
    pvccontractuallessldnew: safeRound(pvccontractuallessld),
    loweractuallessld: loweractuallessld !== null ? safeRound(loweractuallessld) : null,
    lowercontractuallessld: lowercontractuallessld !== null ? safeRound(lowercontractuallessld) : null,
    fairpricenew: safeRound(fairprice),
    selectedscenarionew: selected,
    pvcperseta2: safeRound(pvca2),
    pvcpersetb2: safeRound(pvcb2),
    pvcpersetc1: pvcc1 !== null ? safeRound(pvcc1) : null,
    pvcpersetd1: pvcd1 !== null ? safeRound(pvcd1) : null,
    scenarioamounts,
    scenariodetails,
    igbtvendordetails: allVendorSummaries,
    igbtindexdetails: allIndexDetails,
    tenderno: tender.tender_no,
    pono: data.pono || null,
  };
}

export function calcSingleRecord(
  data: PVCInputData,
  idxMap: IndexTable,
  weights: Record<string, number>,
  itemCode = ''
): PVCCalculationOutput {
  const lag = itemCode === 'TRACTIONMOTOR' ? 2 : 1;
  const pvcBaseDate = data.pvcbasedate;
  const calDate = data.caldate;
  const origdp = data.origdp;
  const refixeddp = data.refixeddp;
  const extendeddp = data.extendeddp;
  const supplyDate = data.supdate;
  const lowerBaseDate = data.lowerbasicdate;

  const pvcScheduledDate = refixeddp || origdp;
  const ldScheduledDate = extendeddp || refixeddp || origdp;

  let qty = safeFloat(data.quantity);
  if (qty <= 0) {
    qty = 1.0;
    data.quantity = 1.0;
  }
  const basicRate = safeFloat(data.basicrate);
  const freightPerUnit = safeFloat(data.freightrateperunit);
  const lowerRate = safeFloat(data.lowerrate);
  const lowerFreight = safeFloat(data.lowerfreight);
  const developmental = Boolean(data.developmentaltender);
  const rateApplied = (data.rateapplied || '').trim().toLowerCase();
  const b2Needed = !['supply before due date', 'supply within original dp or refixed dp', 'lower rate applicable within dp'].includes(rateApplied);

  const freightTotal = freightPerUnit * qty;
  const lowerfreightTotal = lowerFreight * qty;
  const lowerrateApplicable = lowerRate > 0 && Boolean(lowerBaseDate);

  const pctA2 = pvcPercent(pvcBaseDate, calDate, idxMap, weights, lag);
  const pctB2 = b2Needed ? pvcPercent(pvcBaseDate, pvcScheduledDate, idxMap, weights, lag) : null;
  const pctC1 = lowerrateApplicable ? pvcPercent(lowerBaseDate, calDate, idxMap, weights, lag) : null;

  let pctD1: number | null = null;
  let lowercontractual: number | null = null;
  let pvcpersetd1: number | null = null;
  let d1Applicable = lowerrateApplicable;
  if (lowerrateApplicable) {
    const lbdTs = parseDateYMD(lowerBaseDate);
    const odpTs = parseDateYMD(origdp);
    if (lbdTs && odpTs && lbdTs.getTime() > odpTs.getTime()) {
      d1Applicable = false;
    }
  }
  if (d1Applicable && b2Needed) {
    pctD1 = pvcPercent(lowerBaseDate, pvcScheduledDate, idxMap, weights, lag);
    pvcpersetd1 = (lowerRate * (pctD1 || 0)) / 100.0;
    lowercontractual = (lowerRate * qty + pvcpersetd1 * qty + lowerfreightTotal) * GST_FACTOR;
  }

  const pvcactual = (basicRate * qty * (1 + pctA2 / 100.0) + freightTotal) * GST_FACTOR;
  const pvccontractual = pctB2 !== null ? (basicRate * qty * (1 + pctB2 / 100.0) + freightTotal) * GST_FACTOR : null;

  const { delaydays, ldweeks, ldratepct, ldapplicable } = calculateLD(ldScheduledDate, supplyDate, developmental);

  const ldamtactual = ldapplicable ? pvcactual * (ldratepct / 100.0) : 0.0;
  const ldamtcontractual = ldapplicable && pvccontractual !== null ? pvccontractual * (ldratepct / 100.0) : 0.0;

  const pvcactuallessld = pvcactual - ldamtactual;
  const pvccontractuallessld = pvccontractual !== null ? pvccontractual - ldamtcontractual : null;

  let loweractual: number | null = null;
  let pvcpersetc1: number | null = null;
  if (lowerrateApplicable) {
    pvcpersetc1 = (lowerRate * (pctC1 || 0)) / 100.0;
    loweractual = (lowerRate * qty + pvcpersetc1 * qty + lowerfreightTotal) * GST_FACTOR;
  }

  const loweractuallessld = loweractual !== null ? loweractual - ldamtactual : null;
  const lowercontractuallessld = lowercontractual !== null ? lowercontractual - ldamtcontractual : null;

  const candidates = buildCandidates(
    rateApplied,
    pvcactual,
    pvccontractual,
    pvcactuallessld,
    pvccontractuallessld,
    loweractual,
    lowercontractual,
    loweractuallessld,
    lowercontractuallessld,
    lowerrateApplicable
  );
  const { selected, fairprice: pickedFair } = pickMinimumCandidate(candidates);
  const fairprice = pickedFair ?? pvcactual;

  const scenarioamounts: Record<string, number | null> = { A2: safeRound(pvcactuallessld) };
  if (b2Needed) scenarioamounts.B2 = safeRound(pvccontractuallessld);
  if (lowerrateApplicable) scenarioamounts.C1 = safeRound(loweractual);
  if (d1Applicable && b2Needed) scenarioamounts.D1 = safeRound(lowercontractual);

  const scenariodetails: ScenarioDetail[] = [];
  const scList: Array<[string, string | null | undefined, string | null | undefined]> = [['A2', pvcBaseDate, calDate]];
  if (b2Needed) scList.push(['B2', pvcBaseDate, pvcScheduledDate]);
  if (lowerrateApplicable) scList.push(['C1', lowerBaseDate, calDate]);
  if (d1Applicable && b2Needed) scList.push(['D1', lowerBaseDate, pvcScheduledDate]);
  for (const [sc, bd, cd] of scList) {
    if (bd && cd) {
      const det = pvcPercentDetailed(bd, cd, idxMap, sc, weights, lag);
      if (det) scenariodetails.push(det);
    }
  }

  return {
    pvcactual: safeRound(pvcactual),
    pvccontractual: safeRound(pvccontractual),
    loweractual: loweractual !== null ? safeRound(loweractual) : null,
    lowercontractual: lowercontractual !== null ? safeRound(lowercontractual) : null,
    delaydays,
    ldweeks,
    ldratepct: safeRound(ldratepct) ?? 0,
    ldapplicable,
    ldamtactual: safeRound(ldamtactual) ?? 0,
    ldamtcontractual: safeRound(ldamtcontractual) ?? 0,
    pvcactuallessldnew: safeRound(pvcactuallessld),
    pvccontractuallessldnew: safeRound(pvccontractuallessld),
    loweractuallessld: loweractuallessld !== null ? safeRound(loweractuallessld) : null,
    lowercontractuallessld: lowercontractuallessld !== null ? safeRound(lowercontractuallessld) : null,
    fairpricenew: safeRound(fairprice),
    selectedscenarionew: selected,
    pvcperseta2: safeRound((basicRate * pctA2) / 100.0),
    pvcpersetb2: pctB2 !== null ? safeRound((basicRate * pctB2) / 100.0) : null,
    pvcpersetc1: lowerrateApplicable ? safeRound(pvcpersetc1) : null,
    pvcpersetd1: pvcpersetd1 !== null ? safeRound(pvcpersetd1) : null,
    scenarioamounts,
    scenariodetails,
    igbtvendordetails: [],
    igbtindexdetails: [],
    tenderno: null,
    pono: data.pono || null,
  };
}

export function calculateForItem(
  item: ItemRecord,
  data: PVCInputData,
  idxMap: IndexTable,
  weights: Record<string, number>
): PVCCalculationOutput {
  const code = (item.pvc_formula_code || '').replace(/\s+/g, '').toUpperCase();
  if (code === 'IGBTPROPULSIONSYSTEM') {
    const tenderId = data.tenderid;
    if (!tenderId) {
      throw new Error('Tender is required for IGBT Propulsion System.');
    }
    return calculateIGBTPropulsion(item, data, tenderId, idxMap, weights);
  }
  return calcSingleRecord(data, idxMap, weights, code);
}
