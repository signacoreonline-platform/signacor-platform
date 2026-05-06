import { useEffect, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, Legend
} from 'recharts';
import api from '../utils/api';
import KPICard from '../components/KPICard';
import StatusBadge from '../components/StatusBadge';
import { DashboardData, GroupConsolidated } from '../types';
import { formatZAR, formatPercent, formatDate, marginColor } from '../utils/format';
import { COMPANY_COLORS } from '../utils/constants';

const STATUS_COLORS = [
  '#6b7280','#7c3aed','#2563eb','#4f46e5','#0891b2',
  '#0d9488','#ea580c','#d97706','#65a30d','#16a34a','#059669','#dc2626'
];

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [pipeline, setPipeline] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/dashboard/overview'),
      api.get('/dashboard/pipeline'),
    ]).then(([overviewRes, pipelineRes]) => {
      setData(overviewRes.data);
      setPipeline(pipelineRes.data.slice(0, 8));
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="mt-3 text-sm text-gray-500">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  if (!data) return <div className="p-6 text-red-600">Failed to load dashboard data.</div>;

  const { kpis, jobs_by_status, monthly_revenue, top_jobs, group_consolidated } = data;

  // Format monthly data for chart
  const chartData = monthly_revenue.map(m => ({
    month: new Date(m.month).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }),
    Revenue: Math.round(Number(m.revenue)),
    Profit: Math.round(Number(m.profit)),
  }));

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Group Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Consolidated view across all four entities</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="Total Revenue" value={formatZAR(kpis.total_revenue, { compact: true })} icon="💰" color="blue" />
        <KPICard label="Gross Profit" value={formatZAR(kpis.gross_profit, { compact: true })} icon="📈" color="green"
          subValue={`${formatPercent(kpis.avg_margin)} avg margin`} />
        <KPICard label="Active Jobs" value={String(kpis.active_jobs)} icon="📋" subValue={`${kpis.total_jobs} total`} />
        <KPICard label="Outstanding" value={formatZAR(Number(kpis.total_revenue) - Number(kpis.total_collected), { compact: true })} icon="⏳" color="orange" />
      </div>

      {/* Group entity cards */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">Group Companies</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {group_consolidated.map((co: GroupConsolidated) => (
            <div key={co.company_id} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="font-semibold text-sm text-gray-900 leading-tight">{co.company}</p>
                  <p className="text-xs text-gray-400 capitalize mt-0.5">{co.role.replace('_', '/')}</p>
                </div>
                <div
                  className="w-3 h-3 rounded-full mt-0.5 flex-shrink-0"
                  style={{ backgroundColor: COMPANY_COLORS[co.company] || '#9ca3af' }}
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Revenue</span>
                  <span className="font-medium">{formatZAR(co.total_revenue, { compact: true })}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Profit</span>
                  <span className={`font-medium ${marginColor(Number(co.margin_percent))}`}>
                    {formatZAR(co.gross_profit, { compact: true })}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Margin</span>
                  <span className={`font-bold ${marginColor(Number(co.margin_percent))}`}>
                    {formatPercent(co.margin_percent)}
                  </span>
                </div>
                <div className="mt-2 w-full bg-gray-100 rounded-full h-1.5">
                  <div
                    className="h-1.5 rounded-full bg-brand-500"
                    style={{ width: `${Math.min(Number(co.margin_percent), 100)}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Revenue trend */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Revenue & Profit — Last 12 Months</h3>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="profGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `R${(v/1000).toFixed(0)}k`} />
                <Tooltip formatter={(v: number) => formatZAR(v)} />
                <Area type="monotone" dataKey="Revenue" stroke="#f97316" fill="url(#revGrad)" strokeWidth={2} />
                <Area type="monotone" dataKey="Profit" stroke="#10b981" fill="url(#profGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-gray-400 text-sm">
              No invoiced jobs yet
            </div>
          )}
        </div>

        {/* Jobs by status donut */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Jobs by Stage</h3>
          {jobs_by_status.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={jobs_by_status} dataKey="count" nameKey="status" innerRadius={50} outerRadius={80}>
                  {jobs_by_status.map((_, i) => (
                    <Cell key={i} fill={STATUS_COLORS[i % STATUS_COLORS.length]} />
                  ))}
                </Pie>
                <Legend
                  formatter={(value) => value.replace(/_/g, ' ')}
                  wrapperStyle={{ fontSize: '11px' }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-gray-400 text-sm">No jobs yet</div>
          )}
        </div>
      </div>

      {/* Pipeline table + top jobs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Active pipeline */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700">Active Pipeline</h3>
          </div>
          <div className="divide-y divide-gray-50">
            {pipeline.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-gray-400">No active jobs</p>
            )}
            {pipeline.map(job => (
              <div key={job.id} className="px-5 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{job.title}</p>
                  <p className="text-xs text-gray-500 truncate">{job.client_name} · {job.job_number}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <StatusBadge status={job.status} size="sm" />
                  {job.deadline && (
                    <span className="text-xs text-gray-400">{formatDate(job.deadline)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top jobs by revenue */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-700">Top Jobs by Revenue</h3>
          </div>
          <div className="divide-y divide-gray-50">
            {top_jobs.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-gray-400">No invoiced jobs yet</p>
            )}
            {top_jobs.slice(0, 6).map((job, i) => (
              <div key={job.id} className="px-5 py-3 flex items-center gap-3">
                <span className="text-xs font-bold text-gray-400 w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{job.title}</p>
                  <p className="text-xs text-gray-500">{job.client_name}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-gray-900">{formatZAR(job.invoice_amount, { compact: true })}</p>
                  {job.margin_percent != null && (
                    <p className={`text-xs font-medium ${marginColor(Number(job.margin_percent))}`}>
                      {formatPercent(job.margin_percent)} margin
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
