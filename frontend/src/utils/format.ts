// =============================================================================
// Formatting utilities — ZAR currency, dates, percentages
// =============================================================================

export const formatZAR = (amount: number | string | null | undefined, opts?: { compact?: boolean }): string => {
  const num = typeof amount === 'string' ? parseFloat(amount) : (amount ?? 0);
  if (isNaN(num)) return 'R 0.00';
  if (opts?.compact && Math.abs(num) >= 1_000_000) {
    return `R ${(num / 1_000_000).toFixed(1)}M`;
  }
  if (opts?.compact && Math.abs(num) >= 1_000) {
    return `R ${(num / 1_000).toFixed(1)}k`;
  }
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
  }).format(num).replace('ZAR', 'R');
};

export const formatPercent = (value: number | string | null | undefined, decimals = 1): string => {
  const num = typeof value === 'string' ? parseFloat(value) : (value ?? 0);
  if (isNaN(num)) return '0%';
  return `${num.toFixed(decimals)}%`;
};

export const formatDate = (date: string | null | undefined): string => {
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat('en-ZA', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(date));
  } catch {
    return '—';
  }
};

export const formatDateInput = (date: string | null | undefined): string => {
  if (!date) return '';
  try {
    return new Date(date).toISOString().split('T')[0];
  } catch {
    return '';
  }
};

export const formatM2 = (value: number | null | undefined): string => {
  const num = value ?? 0;
  return `${num.toFixed(3)} m²`;
};

export const formatLM = (value: number | null | undefined): string => {
  const num = value ?? 0;
  return `${num.toFixed(3)} lm`;
};

export const daysUntil = (date: string | null | undefined): number | null => {
  if (!date) return null;
  const diff = new Date(date).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
};

export const marginColor = (margin: number): string => {
  if (margin >= 40) return 'text-green-600';
  if (margin >= 25) return 'text-blue-600';
  if (margin >= 10) return 'text-yellow-600';
  return 'text-red-600';
};

export const marginBg = (margin: number): string => {
  if (margin >= 40) return 'bg-green-100 text-green-800';
  if (margin >= 25) return 'bg-blue-100 text-blue-800';
  if (margin >= 10) return 'bg-yellow-100 text-yellow-800';
  return 'bg-red-100 text-red-800';
};
