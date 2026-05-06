// =============================================================================
// SIGNACORE GROUP PLATFORM — TypeScript Types
// =============================================================================

export type CompanyRole = 'holding' | 'supplier' | 'franchise' | 'subcontractor';

export type JobStatus =
  | 'lead' | 'brief' | 'design' | 'quote_sent' | 'quote_approved'
  | 'deposit_received' | 'in_production' | 'installation'
  | 'completed' | 'invoiced' | 'paid' | 'cancelled';

export type CostCategory =
  | 'materials' | 'labour' | 'machine_time' | 'design' | 'delivery' | 'franchise_royalty';

export type SurfaceType = 'flat' | 'curved' | 'contour';
export type WrapType = 'full' | 'partial' | 'roof_only' | 'bonnet_only' | 'doors_only' | 'custom';
export type PaymentStatus = 'pending' | 'partial' | 'paid' | 'overdue' | 'cancelled';
export type QuoteStatus = 'draft' | 'sent' | 'approved' | 'declined' | 'expired';
export type TransactionType = 'invoice' | 'payment' | 'transfer' | 'adjustment' | 'intercompany_charge';

// =============================================================================
// ENTITIES
// =============================================================================

export interface Company {
  id: string;
  name: string;
  short_name: string;
  registration_no?: string;
  vat_no?: string;
  role: CompanyRole;
  address?: string;
  city?: string;
  province?: string;
  phone?: string;
  email?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  company_id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  phone?: string;
  is_active: boolean;
  last_login?: string;
}

export interface Client {
  id: string;
  company_name: string;
  trading_name?: string;
  contact_person?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  address?: string;
  city?: string;
  province?: string;
  postal_code?: string;
  vat_no?: string;
  payment_terms: number;
  is_active: boolean;
  notes?: string;
  created_at: string;
  // Joined
  jobs?: JobSummary[];
}

// =============================================================================
// JOBS
// =============================================================================

export interface Job {
  id: string;
  job_number: string;
  title: string;
  client_id: string;
  client_name: string;
  contact_person?: string;
  client_email?: string;
  client_phone?: string;
  primary_company_id: string;
  assigned_to?: string;
  assigned_to_name?: string;
  status: JobStatus;

  // Dates
  lead_date?: string;
  brief_date?: string;
  design_date?: string;
  quote_date?: string;
  quote_approved_date?: string;
  deposit_date?: string;
  production_start?: string;
  production_end?: string;
  installation_date?: string;
  invoice_date?: string;
  payment_date?: string;
  deadline?: string;

  // Financials
  quote_amount: number;
  deposit_amount: number;
  deposit_received: number;
  invoice_amount: number;
  amount_paid: number;
  royalty_rate: number;

  // Details
  description?: string;
  location?: string;
  special_instructions?: string;
  internal_notes?: string;
  has_installation: boolean;
  has_vehicle_wrap: boolean;
  has_vinyl_work: boolean;

  // Profit (from view)
  cost_materials?: number;
  cost_labour?: number;
  cost_machine_time?: number;
  cost_design?: number;
  cost_delivery?: number;
  cost_royalty?: number;
  total_cost?: number;
  gross_profit?: number;
  margin_percent?: number;

  // Relations
  costs?: JobCost[];
  stage_history?: StageHistory[];
  quotes?: Quote[];
  invoices?: Invoice[];

  created_at: string;
  updated_at: string;
}

export interface JobSummary {
  id: string;
  job_number: string;
  title: string;
  status: JobStatus;
  client_name?: string;
  quote_amount: number;
  invoice_amount: number;
  gross_profit?: number;
  margin_percent?: number;
  deadline?: string;
  assigned_to_name?: string;
}

export interface JobCost {
  id: string;
  job_id: string;
  category: CostCategory;
  supplier_id?: string;
  material_id?: string;
  machine_id?: string;
  material_name?: string;
  machine_name?: string;
  description: string;
  quantity: number;
  unit: string;
  unit_cost: number;
  total_cost: number;
  invoice_ref?: string;
  is_actual: boolean;
  notes?: string;
  created_at: string;
}

export interface StageHistory {
  id: string;
  job_id: string;
  from_status?: JobStatus;
  to_status: JobStatus;
  changed_by_name?: string;
  notes?: string;
  changed_at: string;
}

// =============================================================================
// QUOTES & INVOICES
// =============================================================================

export interface Quote {
  id: string;
  job_id: string;
  quote_number: string;
  version: number;
  status: QuoteStatus;
  subtotal: number;
  vat_rate: number;
  vat_amount: number;
  total: number;
  valid_until?: string;
  notes?: string;
  sent_at?: string;
  approved_at?: string;
  created_at: string;
}

export interface Invoice {
  id: string;
  job_id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  subtotal: number;
  vat_rate: number;
  vat_amount: number;
  total: number;
  amount_paid: number;
  status: PaymentStatus;
  outstanding?: number;
  client_name?: string;
  job_number?: string;
  job_title?: string;
  created_at: string;
}

// =============================================================================
// INTERCOMPANY
// =============================================================================

export interface IntercompanyTransaction {
  id: string;
  transaction_no: string;
  from_company_id: string;
  from_company_name: string;
  to_company_id: string;
  to_company_name: string;
  job_id?: string;
  job_number?: string;
  job_title?: string;
  transaction_type: TransactionType;
  amount: number;
  vat_amount: number;
  total_amount: number;
  description: string;
  reference_no?: string;
  transaction_date: string;
  status: PaymentStatus;
  notes?: string;
  created_at: string;
}

export interface IntercompanySummary {
  from_company: string;
  to_company: string;
  transaction_count: number;
  total_amount: number;
  total_vat: number;
  total_with_vat: number;
  paid_amount: number;
  outstanding_amount: number;
}

// =============================================================================
// CALCULATORS
// =============================================================================

export interface VinylCalculationInput {
  width_mm: number;
  height_mm: number;
  quantity: number;
  surface_type: SurfaceType;
  roll_width_m: number;
  vinyl_cost_per_m2: number;
  laminate_cost_per_m2: number;
  sell_price_per_m2: number;
}

export interface VinylCalculationResult {
  area_per_unit: number;
  total_area_m2: number;
  waste_factor: number;
  area_with_waste: number;
  panels_per_row: number;
  rows_needed: number;
  roll_length_used: number;
  vinyl_cost: number;
  laminate_cost: number;
  total_material_cost: number;
  total_sell_price: number;
  margin_percent: number;
}

export interface VehiclePanelDims {
  w_mm: number;
  h_mm: number;
}

export interface CustomArea {
  label: string;
  w_mm: number;
  h_mm: number;
  qty: number;
}

export interface VehicleCalculationInput {
  panels?: Record<string, VehiclePanelDims>;
  custom_areas?: CustomArea[];
  wrap_type: WrapType;
  vinyl_cost_per_m2: number;
  laminate_cost_per_m2: number;
  labour_rate_per_hour: number;
  roll_width_m: number;
  sell_price: number;
  vehicle_make?: string;
  vehicle_model?: string;
  vehicle_year?: number;
}

export interface VehicleCalculationResult {
  panel_breakdown: Record<string, number>;
  total_area_m2: number;
  vinyl_area_m2: number;
  roll_length_m: number;
  labour_hours: number;
  vinyl_cost: number;
  laminate_cost: number;
  labour_cost: number;
  total_cost: number;
  margin_percent: number;
}

// =============================================================================
// DASHBOARD
// =============================================================================

export interface DashboardKPIs {
  total_jobs: number;
  active_jobs: number;
  total_revenue: number;
  total_collected: number;
  total_costs: number;
  gross_profit: number;
  avg_margin: number;
}

export interface JobsByStatus {
  status: JobStatus;
  count: number;
  value: number;
}

export interface MonthlyRevenue {
  month: string;
  jobs: number;
  revenue: number;
  profit: number;
}

export interface GroupConsolidated {
  company_id: string;
  company: string;
  role: CompanyRole;
  total_jobs: number;
  total_revenue: number;
  total_costs: number;
  gross_profit: number;
  margin_percent: number;
}

export interface DashboardData {
  kpis: DashboardKPIs;
  jobs_by_status: JobsByStatus[];
  monthly_revenue: MonthlyRevenue[];
  top_jobs: JobSummary[];
  group_consolidated: GroupConsolidated[];
}

// =============================================================================
// AUTH
// =============================================================================

export interface AuthUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  company_id: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}
