import { JobStatus, PaymentStatus } from '../types';
import { JOB_STATUSES } from '../utils/constants';

interface StatusBadgeProps {
  status: JobStatus | PaymentStatus | string;
  size?: 'sm' | 'md';
}

const PAYMENT_COLORS: Record<string, string> = {
  pending:   'bg-yellow-100 text-yellow-700',
  partial:   'bg-blue-100 text-blue-700',
  paid:      'bg-green-100 text-green-700',
  overdue:   'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
};

export default function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const jobStatus = JOB_STATUSES.find((s) => s.value === status);
  const color = jobStatus?.color || PAYMENT_COLORS[status] || 'bg-gray-100 text-gray-700';
  const label = jobStatus?.label || status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <span className={`inline-flex items-center rounded-full font-medium ${color} ${size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs'}`}>
      {label}
    </span>
  );
}
