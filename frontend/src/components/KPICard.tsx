interface KPICardProps {
  label: string;
  value: string;
  subValue?: string;
  icon?: string;
  trend?: { value: number; label: string };
  color?: 'default' | 'green' | 'blue' | 'orange' | 'red';
}

const colorMap = {
  default: 'bg-white',
  green:   'bg-green-50',
  blue:    'bg-blue-50',
  orange:  'bg-orange-50',
  red:     'bg-red-50',
};

export default function KPICard({ label, value, subValue, icon, trend, color = 'default' }: KPICardProps) {
  return (
    <div className={`${colorMap[color]} rounded-xl border border-gray-200 p-5 shadow-sm`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
          {subValue && <p className="mt-0.5 text-sm text-gray-500">{subValue}</p>}
        </div>
        {icon && (
          <span className="text-2xl opacity-70">{icon}</span>
        )}
      </div>
      {trend && (
        <div className="mt-3 flex items-center gap-1">
          <span className={`text-xs font-medium ${trend.value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {trend.value >= 0 ? '↑' : '↓'} {Math.abs(trend.value).toFixed(1)}%
          </span>
          <span className="text-xs text-gray-400">{trend.label}</span>
        </div>
      )}
    </div>
  );
}
