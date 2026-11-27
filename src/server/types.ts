export interface UserRecord {
  id: number;
  username: string;
  full_name: string | null;
  email: string | null;
  contact_no: string | null;
  designation: string | null;
  control_no: string | null;
  password_hash: string;
  is_admin: boolean;
}

export interface ComponentConfig {
  key: string;
  label: string;
  weight: number;
  lag_months?: number | null;
  source?: string | null;
}

export interface ItemRecord {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  pvc_formula_code: string;
  weights_json: string;
  extra_fields_json: string;
  lag_months?: number;
  base_lag_months?: number;
  fixed_weight?: number;
  index_source?: string | null;
  components_json?: string;
  custom_formula?: string | null;
}

export interface IndexAttachment {
  id: string;
  original_name: string;
  stored_name: string;
  mime_type: string;
  file_type: 'image' | 'pdf';
  size: number;
  url: string;
  uploaded_at: string;
}

export interface ItemIndexRecord {
  id: number;
  item_id: number;
  /** Normalized to YYYY-MM-01 */
  month: string;
  indices_json: string;
  attachments?: IndexAttachment[];
}

export interface TenderMasterRecord {
  id: number;
  item_id: number;
  tender_no: string;
  basicrate: number;
  pvcbasedate: string | null;
  freightrateperunit?: number;
  gst_rate?: number;
  created_at: string;
}

export interface TenderVendorRecord {
  id: number;
  tender_id: number;
  po_no: string | null;
  vendor_name: string;
  cif: number;
  freightrateperunit: number;
  currency: string;
}

export interface PVCResultRecord {
  id: number;
  user_id: number;
  item_id: number;
  username: string;
  created_at: string;
  basicrate: number;
  quantity: number;
  freightrateperunit: number;
  pvcbasedate: string | null;
  origdp: string | null;
  refixeddp: string | null;
  extendeddp: string | null;
  caldate: string | null;
  supdate: string | null;
  rateapplied: string | null;
  pvcactual: number | null;
  pvccontractual: number | null;
  loweractual: number | null;
  lowercontractual: number | null;
  ldamtactual: number | null;
  ldamtcontractual: number | null;
  fairprice: number | null;
  selectedscenario: string | null;
  pvcactuallessldnew: number | null;
  pvccontractuallessldnew: number | null;
  loweractuallessld: number | null;
  lowercontractuallessld: number | null;
  delaydays: number;
  ldweeksnew: number;
  ldratepctnew: number;
  ldapplicable: boolean;
  pvcperseta2: number | null;
  pvcpersetb2: number | null;
  pvcpersetc1: number | null;
  pvcpersetd1: number | null;
  tenderno: string | null;
  pono: string | null;
  scenarioamounts_json: string;
  scenariodetails_json: string;
  igbt_vendor_details_json: string;
}

export interface AuditLogRecord {
  id: number;
  user_id: number | null;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  table_name: string;
  row_id: string | null;
  old_data: string | null;
  new_data: string | null;
  timestamp: string;
}

export interface PVCInputData {
  user_id?: number;
  username?: string;
  basicrate: number;
  quantity: number;
  freightrateperunit: number;
  pvcbasedate: string | null;
  origdp: string | null;
  refixeddp: string | null;
  extendeddp: string | null;
  caldate: string | null;
  supdate: string | null;
  lowerrate: number;
  lowerfreight: number;
  lowerbasicdate: string | null;
  rateapplied: string | null;
  tenderid?: number | string | null;
  vendorid?: number | string | null;
  subsequent_tenderid?: number | string | null;
  pono?: string | null;
  vendorname?: string | null;
  developmentaltender: boolean;
  lowerrateapplicable?: boolean;
  [key: string]: unknown;
}

export interface ScenarioDetail {
  scenario: string;
  basemonth: string;
  currentmonth: string;
  pvcpercent: number;
  [key: string]: unknown;
}

export interface IGBTVendorSummary {
  scenario: string;
  vendor: string;
  pono: string | null;
  currency: string;
  rate: number;
  basicrate: number;
  cif: number;
  baseduty: number;
  indigenous: number;
  p1: number;
  p2: number;
  totalpvc: number;
  basemonth: string;
  currentmonth: string;
  origbasemonth: string;
  [key: string]: unknown;
}

export interface IGBTIndexDetail {
  scenario: string;
  vendor: string;
  currency: string;
  parameter: string;
  label?: string;
  basevalue: number;
  currentvalue: number;
  weight: number | null;
  basemonth: string;
  currentmonth: string;
  actualbasemonth?: string;
  actualcurrentmonth?: string;
  [key: string]: unknown;
}

export interface PVCCalculationOutput {
  pvcactual: number | null;
  pvccontractual: number | null;
  loweractual: number | null;
  lowercontractual: number | null;
  delaydays: number;
  ldweeks: number;
  ldratepct: number;
  ldapplicable: boolean;
  ldamtactual: number;
  ldamtcontractual: number;
  pvcactuallessldnew: number | null;
  pvccontractuallessldnew: number | null;
  loweractuallessld: number | null;
  lowercontractuallessld: number | null;
  fairpricenew: number | null;
  selectedscenarionew: string;
  pvcperseta2: number | null;
  pvcpersetb2: number | null;
  pvcpersetc1: number | null;
  pvcpersetd1: number | null;
  scenarioamounts: Record<string, number | null>;
  scenariodetails: ScenarioDetail[];
  igbtvendordetails: IGBTVendorSummary[];
  igbtindexdetails: IGBTIndexDetail[];
  tenderno: string | null;
  pono: string | null;
}

export interface Pagination<T> {
  items: T[];
  page: number;
  per_page: number;
  total: number;
  pages: number;
  has_prev: boolean;
  has_next: boolean;
  prev_num: number;
  next_num: number;
}
