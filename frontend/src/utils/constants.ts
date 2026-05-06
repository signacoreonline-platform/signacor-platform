import { JobStatus, CostCategory } from '../types';

export const JOB_STATUSES: { value: JobStatus; label: string; color: string }[] = [
  { value: 'lead',             label: 'Lead',              color: 'bg-gray-100 text-gray-700' },
  { value: 'brief',            label: 'Brief',             color: 'bg-purple-100 text-purple-700' },
  { value: 'design',           label: 'Design',            color: 'bg-blue-100 text-blue-700' },
  { value: 'quote_sent',       label: 'Quote Sent',        color: 'bg-indigo-100 text-indigo-700' },
  { value: 'quote_approved',   label: 'Quote Approved',    color: 'bg-cyan-100 text-cyan-700' },
  { value: 'deposit_received', label: 'Deposit Received',  color: 'bg-teal-100 text-teal-700' },
  { value: 'in_production',    label: 'In Production',     color: 'bg-orange-100 text-orange-700' },
  { value: 'installation',     label: 'Installation',      color: 'bg-amber-100 text-amber-700' },
  { value: 'completed',        label: 'Completed',         color: 'bg-lime-100 text-lime-700' },
  { value: 'invoiced',         label: 'Invoiced',          color: 'bg-green-100 text-green-700' },
  { value: 'paid',             label: 'Paid',              color: 'bg-emerald-200 text-emerald-800' },
  { value: 'cancelled',        label: 'Cancelled',         color: 'bg-red-100 text-red-700' },
];

export const LIFECYCLE_STAGES: JobStatus[] = [
  'lead', 'brief', 'design', 'quote_sent', 'quote_approved',
  'deposit_received', 'in_production', 'installation', 'completed', 'invoiced', 'paid',
];

export const COST_CATEGORIES: { value: CostCategory; label: string; color: string; icon: string }[] = [
  { value: 'materials',        label: 'Materials (Signacore)', color: 'bg-blue-50 border-blue-200',    icon: '📦' },
  { value: 'labour',           label: 'Labour (Cover X)',      color: 'bg-orange-50 border-orange-200', icon: '🔧' },
  { value: 'machine_time',     label: 'Machine Time',          color: 'bg-purple-50 border-purple-200', icon: '⚙️' },
  { value: 'design',           label: 'Design',                color: 'bg-pink-50 border-pink-200',    icon: '🎨' },
  { value: 'delivery',         label: 'Delivery',              color: 'bg-yellow-50 border-yellow-200', icon: '🚚' },
  { value: 'franchise_royalty',label: 'Franchise Royalty (6%)', color: 'bg-red-50 border-red-200',    icon: '📋' },
];

export const COMPANY_COLORS: Record<string, string> = {
  'Uniontech':     '#6366f1',
  'Signacore':     '#f97316',
  'Signarama GR':  '#10b981',
  'Cover X':       '#8b5cf6',
};

export const SURFACE_WASTE: Record<string, number> = {
  flat:    1.10,
  curved:  1.20,
  contour: 1.35,
};

export const DEFAULT_ROLL_WIDTH = 1.37; // metres
export const FRANCHISE_ROYALTY_RATE = 0.06;
export const VAT_RATE = 0.15;
