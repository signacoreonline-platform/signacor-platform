import { formatZAR, formatPercent } from '../utils/format';

interface CostBreakdownProps {
  costMaterials: number;
  costLabour: number;
  costMachineTime: number;
  costDesign: number;
  costDelivery: number;
  costRoyalty: number;
  revenue: number;
}

const SEGMENTS = [
  { key: 'costMaterials',    label: 'Materials',      color: 'bg-blue-400' },
  { key: 'costLabour',       label: 'Labour',         color: 'bg-orange-400' },
  { key: 'costMachineTime',  label: 'Machine Time',   color: 'bg-purple-400' },
  { key: 'costDesign',       label: 'Design',         color: 'bg-pink-400' },
  { key: 'costDelivery',     label: 'Delivery',       color: 'bg-yellow-400' },
  { key: 'costRoyalty',      label: 'Royalty',        color: 'bg-red-400' },
];

export default function ProfitBar(props: CostBreakdownProps) {
  const { revenue } = props;
  const values = {
    costMaterials:   props.costMaterials,
    costLabour:      props.costLabour,
    costMachineTime: props.costMachineTime,
    costDesign:      props.costDesign,
    costDelivery:    props.costDelivery,
    costRoyalty:     props.costRoyalty,
  };

  const totalCost = Object.values(values).reduce((a, b) => a + b, 0);
  const profit = revenue - totalCost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Stacked bar */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-500 font-medium">Cost breakdown vs revenue</span>
          <span className={`text-sm font-bold ${margin >= 25 ? 'text-green-600' : margin >= 10 ? 'text-yellow-600' : 'text-red-600'}`}>
            {formatPercent(margin)} margin
          </span>
        </div>
        <div className="w-full h-8 rounded-lg overflow-hidden flex bg-gray-100">
          {revenue > 0 && SEGMENTS.map(({ key, color }) => {
            const val = values[key as keyof typeof values];
            const pct = (val / revenue) * 100;
            if (pct <= 0) return null;
            return (
              <div
                key={key}
                className={`${color} h-full`}
                style={{ width: `${Math.min(pct, 100)}%` }}
                title={`${formatZAR(val)} (${pct.toFixed(1)}%)`}
              />
            );
          })}
          {profit > 0 && revenue > 0 && (
            <div
              className="bg-green-400 h-full"
              style={{ width: `${Math.min((profit / revenue) * 100, 100)}%` }}
              title={`Profit: ${formatZAR(profit)}`}
            />
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="grid grid-cols-2 gap-2">
        {SEGMENTS.map(({ key, label, color }) => {
          const val = values[key as keyof typeof values];
          const pct = revenue > 0 ? (val / revenue) * 100 : 0;
          return (
            <div key={key} className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-sm flex-shrink-0 ${color}`} />
              <div className="min-w-0">
                <p className="text-xs text-gray-600 truncate">{label}</p>
                <p className="text-xs font-medium text-gray-900">{formatZAR(val)} <span className="text-gray-400">({pct.toFixed(1)}%)</span></p>
              </div>
            </div>
          );
        })}
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-sm flex-shrink-0 bg-green-400" />
          <div>
            <p className="text-xs text-gray-600">Gross Profit</p>
            <p className="text-xs font-medium text-gray-900">{formatZAR(profit)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
