import path from 'path';
import nunjucks from 'nunjucks';
import type { Express } from 'express';

export function buildUrlFor(endpoint: string, params: Record<string, unknown> = {}): string {
  const q = new URLSearchParams();
  const addPage = () => {
    if (params.page !== undefined && params.page !== null) {
      q.set('page', String(params.page));
    }
  };
  const withQuery = (base: string) => {
    const qs = q.toString();
    return qs ? `${base}?${qs}` : base;
  };

  switch (endpoint) {
    case 'static':
      return `/static/${String(params.filename || '').replace(/^\/+/, '')}`;
    case 'main.index':
      return '/';
    case 'main.history':
      addPage();
      return withQuery('/history');
    case 'auth.login':
      return '/login';
    case 'auth.register':
      return '/register';
    case 'auth.logout':
      return '/logout';
    case 'pvc.calculator':
      return '/pvc/calculator';
    case 'pvc.calculate':
      return '/pvc/calculate';
    case 'pvc.bulk_calculator':
      return '/pvc/bulk_calculator';
    case 'pvc.bulk_calculate':
      return '/pvc/bulk_calculate';
    case 'pvc.view_calc':
      return `/pvc/calc/${params.calcid}`;
    case 'pvc.export_calc_excel':
      return `/pvc/calc/${params.calcid}/excel`;
    case 'admin.items_list':
      return '/admin/items';
    case 'admin.items_new':
      return '/admin/items/new';
    case 'admin.items_edit':
      return `/admin/items/${params.itemid}/edit`;
    case 'admin.items_delete':
      return `/admin/items/${params.itemid}/delete`;
    case 'admin.item_indices_list':
      addPage();
      return withQuery(`/admin/items/${params.itemid}/indices`);
    case 'admin.item_indices_new':
      return `/admin/items/${params.itemid}/indices/new`;
    case 'admin.item_indices_edit':
      return `/admin/items/${params.itemid}/indices/${params.rowid}/edit`;
    case 'admin.item_indices_delete':
      return `/admin/items/${params.itemid}/indices/${params.rowid}/delete`;
    case 'admin.item_indices_attachment_delete':
      return `/admin/items/${params.itemid}/indices/${params.rowid}/attachments/${params.attid}/delete`;
    case 'admin.indices_bulk':
      if (params.itemid !== undefined && params.itemid !== null && params.itemid !== '') {
        q.set('itemid', String(params.itemid));
      }
      return withQuery('/admin/indices/bulk');
    case 'admin.indices_bulk_save':
      return '/admin/indices/bulk/save';
    case 'admin.indices_bulk_upload':
      return '/admin/indices/bulk/upload';
    case 'admin.indices_bulk_template':
      if (params.itemid !== undefined && params.itemid !== null && params.itemid !== '') {
        q.set('itemid', String(params.itemid));
      }
      return withQuery('/admin/indices/bulk/template');
    case 'admin.indices_bulk_month_save':
      return '/admin/indices/bulk/month';
    case 'admin.tenders_list':
      return '/admin/tenders';
    case 'admin.tenders_new':
      return '/admin/tenders/new';
    case 'admin.tenders_edit':
      return `/admin/tenders/${params.tenderid}/edit`;
    case 'admin.tenders_delete':
      return `/admin/tenders/${params.tenderid}/delete`;
    case 'admin.tender_vendors_list':
      return `/admin/tenders/${params.tenderid}/vendors`;
    case 'admin.tender_vendors_new':
      return `/admin/tenders/${params.tenderid}/vendors/new`;
    case 'admin.tender_vendors_edit':
      return `/admin/tenders/${params.tenderid}/vendors/${params.rowid}/edit`;
    case 'admin.tender_vendors_delete':
      return `/admin/tenders/${params.tenderid}/vendors/${params.rowid}/delete`;
    case 'admin.users_list':
      return '/admin/users';
    case 'admin.users_new':
      return '/admin/users/new';
    case 'admin.users_edit':
      return `/admin/users/${params.userid}/edit`;
    case 'admin.users_delete':
      return `/admin/users/${params.userid}/delete`;
    case 'admin.users_reset_password':
      return `/admin/users/${params.userid}/reset_password`;
    case 'admin.calculations_list':
      addPage();
      return withQuery('/admin/calculations');
    case 'admin.calculations_delete':
      return `/admin/calculations/${params.calcid}/delete`;
    case 'admin.audit_logs_list':
      return '/admin/audit_logs';
    case 'admin.backup_now':
      return '/admin/backup_now';
    default:
      return '/';
  }
}

function formatDateWithPattern(value: unknown, fmt: string): string {
  if (!value) return '-';
  const dt = value instanceof Date ? value : new Date(String(value));
  if (isNaN(dt.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = dt.getUTCFullYear();
  const m = pad(dt.getUTCMonth() + 1);
  const d = pad(dt.getUTCDate());
  const hh = pad(dt.getUTCHours());
  const mm = pad(dt.getUTCMinutes());
  const ss = pad(dt.getUTCSeconds());
  return fmt
    .replace('%Y', String(y))
    .replace('%m', m)
    .replace('%d', d)
    .replace('%H', hh)
    .replace('%M', mm)
    .replace('%S', ss);
}

function formatNumber(fmtStr: string, val: unknown): string {
  const n = Number(val ?? 0);
  if (!Number.isFinite(n)) return '0.00';
  const commaMatch = /\{:,\.(\d+)f\}/.exec(fmtStr);
  if (commaMatch) {
    const digits = Number(commaMatch[1]);
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  const plainBraceMatch = /\{:\.(\d+)f\}/.exec(fmtStr);
  if (plainBraceMatch) {
    return n.toFixed(Number(plainBraceMatch[1]));
  }
  const pctMatch = /%\.(\d+)f/.exec(fmtStr);
  if (pctMatch) {
    return n.toFixed(Number(pctMatch[1]));
  }
  return String(val ?? '');
}

export function configureNunjucks(app: Express | null, templatesDir: string): nunjucks.Environment {
  const env = nunjucks.configure(path.resolve(templatesDir), {
    autoescape: true,
    express: app ?? undefined,
    noCache: process.env.NODE_ENV !== 'production',
  });

  // Flask-compatible globals
  env.addGlobal('url_for', buildUrlFor);
  env.addGlobal('True', true);
  env.addGlobal('False', false);
  env.addGlobal('None', null);

  env.addGlobal('dictGet', (obj: Record<string, unknown> | null | undefined, key: string, fallback: unknown = null) => {
    if (!obj || typeof obj !== 'object') return fallback;
    const val = obj[key];
    return val !== undefined && val !== null ? val : fallback;
  });

  env.addGlobal('keys', (obj: Record<string, unknown> | null | undefined) => {
    return obj && typeof obj === 'object' ? Object.keys(obj) : [];
  });

  env.addGlobal('values', (obj: Record<string, unknown> | null | undefined) => {
    return obj && typeof obj === 'object' ? Object.values(obj) : [];
  });

  env.addGlobal('namespace', (initial: Record<string, unknown> = {}) => {
    const obj: Record<string, unknown> = { ...initial };
    delete obj.__keywords;
    obj.set = (k: string, v: unknown) => {
      obj[k] = v;
      return '';
    };
    obj.inc = (k: string, by = 1) => {
      obj[k] = (Number(obj[k]) || 0) + by;
      return '';
    };
    return obj;
  });

  env.addGlobal('strftime', formatDateWithPattern);
  env.addGlobal('pyfmt', formatNumber);
  env.addGlobal('fmt2', (v: unknown) => formatNumber('%.2f', v));
  env.addGlobal('fmt4', (v: unknown) => formatNumber('%.4f', v));
  env.addGlobal('fmtComma2', (v: unknown) => formatNumber('{:,.2f}', v));
  env.addGlobal('fmtComma4', (v: unknown) => formatNumber('{:,.4f}', v));

  // Jinja2-compatible filters
  env.addFilter('float', (v: unknown, fallback = 0) => {
    if (v === null || v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  });

  env.addFilter('int', (v: unknown, fallback = 0) => {
    if (v === null || v === undefined || v === '') return fallback;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : fallback;
  });

  env.addFilter('format', (fmtStr: string, val: unknown) => formatNumber(String(fmtStr), val));
  env.addFilter('strftime', (v: unknown, fmt = '%Y-%m-%d') => formatDateWithPattern(v, fmt));
  env.addFilter('tojson', (v: unknown) => new nunjucks.runtime.SafeString(JSON.stringify(v ?? null)));

  env.addFilter('selectattr', (arr: unknown, attr: string, opOrVal?: string, val?: unknown) => {
    if (!Array.isArray(arr)) return [];
    if (opOrVal === undefined) {
      return arr.filter((item) => item && Boolean((item as Record<string, unknown>)[attr]));
    }
    if (opOrVal === 'equalto' || opOrVal === 'eq' || opOrVal === '==') {
      return arr.filter((item) => item && (item as Record<string, unknown>)[attr] === val);
    }
    if (opOrVal === 'ne' || opOrVal === '!=') {
      return arr.filter((item) => item && (item as Record<string, unknown>)[attr] !== val);
    }
    if (opOrVal === 'in' && Array.isArray(val)) {
      return arr.filter((item) => item && val.includes((item as Record<string, unknown>)[attr]));
    }
    return arr.filter((item) => item && (item as Record<string, unknown>)[attr] === opOrVal);
  });

  env.addFilter('map', (arr: unknown, arg?: string | { attribute?: string }) => {
    if (!Array.isArray(arr)) return [];
    const attr = typeof arg === 'object' && arg !== null ? arg.attribute : arg;
    if (typeof attr !== 'string' || !attr) return arr;
    return arr.map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[attr] : undefined));
  });

  env.addFilter('unique', (arr: unknown) => {
    if (!Array.isArray(arr)) return [];
    const seen = new Set<unknown>();
    const out: unknown[] = [];
    for (const item of arr) {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
    return out;
  });

  env.addFilter('list', (arr: unknown) => {
    if (Array.isArray(arr)) return arr;
    if (arr && typeof arr === 'object') return Object.values(arr as Record<string, unknown>);
    return [];
  });

  env.addFilter('keys', (obj: unknown) => (obj && typeof obj === 'object' ? Object.keys(obj as Record<string, unknown>) : []));
  env.addFilter('values', (obj: unknown) => (obj && typeof obj === 'object' ? Object.values(obj as Record<string, unknown>) : []));

  return env;
}
