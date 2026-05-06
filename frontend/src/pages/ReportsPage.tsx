import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend, LineChart, Line,
} from 'recharts';
import api from '../utils/api';
import { formatZAR, formatPercent, marginColor } from '../utils/format';
import { GroupConsolidated, DashboardData } from '../types';
import { COMPANY_COLORS } from '../utils/constants';

type ReportTab = 'profitability' | 'group' | 'pipeline';

const MARGIN_COLORS = ['#10b981','#3b82f6','#f59e0b','#ef4444'];

export default function ReportsPage() {
  const [tab, setTab] = useState<ReportTab>('profitability');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard/overview')
      .then(r => setData(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (!data) return <div className="p-6 text-red-600">Failed to load report data.</div>;

  const { group_consolidated, top_jobs, monthly_revenue, kpis } = data;

  // Build bar chart data for group entities
  const groupChartData = group_consolidated.map((c: GroupConsolidated) => ({
    name: c.company,
    Revenue: Math.round(Number(c.total_revenue)),
    Cost: Math.round(Number(c.total_costs)),
    Profit: Math.round(Number(c.gross_profit)),
    margin: Number(c.margin_percent),
  }));

  // Monthly line data
  const monthlyData = monthly_revenue.map(m => ({
    month: new Date(m.month).toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }),
    Revenue: Math.round(Number(m.revenue)),
    Profit: Math.round(Number(m.profit)),
    margin: m.revenue > 0 ? Math.round((Number(m.profit) / Number(m.revenue)) * 100) : 0,
  }));

  // Top jobs ranked by margin (descending)
  const jobsByMargin = [...top_jobs].sort((a, b) => Number(b.margin_percent ?? 0) - Number(a.margin_percent ?? 0));

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-500 mt-0.5">Group financial performance and project profitability</p>
        </div>
      </div>

      {/* Group KPI summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Revenue', value: formatZAR(kpis.total_revenue, { compact: true }), sub: 'All invoiced jobs', color: 'bg-blue-50' },
          { label: 'Gross Profit', value: formatZAR(kpis.gross_profit, { compact: true }), sub: `${formatPercent(kpis.avg_margin)} avg margin`, color: 'bg-green-50' },
          { label: 'Total Costs', value: formatZAR(kpis.total_costs, { compact: true }), sub: 'All 6 cost categories', color: 'bg-orange-50' },
          { label: 'Jobs Completed', value: String(kpis.total_jobs), sub: `${kpis.active_jobs} active`, color: 'bg-purple-50' },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className={`${color} rounded-xl border border-gray-200 p-5`}>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        {([
          ['profitability', '📊 Job Profitability'],
          ['group', '🏢 Group P&L'],
          ['pipeline', '📈 Revenue Trend'],
        ] as [ReportTab, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition-all ${tab === key ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Job Profitability Ranking ── */}
      {tab === 'profitability' && (
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">Project Profitability Ranking</h3>
              <p className="text-xs text-gray-500 mt-0.5">Sorted by gross margin % — highest to lowest</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {['Rank','Job','Client','Revenue','Total Cost','Gross Profit','Margin %'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {jobsByMargin.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-400">No invoiced jobs to rank yet</td></tr>
                  ) : jobsByMargin.map((job, i) => {
                    const margin = Number(job.margin_percent ?? 0);
                    const profit = Number(job.gross_profit ?? 0);
                    const revenue = Number(job.invoice_amount ?? 0);
                    const cost = revenue - profit;
                    return (
                      <tr key={job.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                            i === 0 ? 'bg-yellow-100 text-yellow-700' :
                            i === 1 ? 'bg-gray-100 text-gray-600' :
                            i === 2 ? 'bg-orange-100 text-orange-600' :
                            'bg-gray-50 text-gray-400'
                          }`}>{i + 1}</div>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900 truncate max-w-[200px]">{job.title}</p>
                          <p className="text-xs text-gray-400">{job.job_number}</p>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{job.client_name}</td>
                        <td className="px-4 py-3 font-medium">{formatZAR(revenue)}</td>
                        <td className="px-4 py-3 text-gray-500">{formatZAR(cost)}</td>
                        <td className="px-4 py-3 font-medium">{formatZAR(profit)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 bg-gray-100 rounded-full h-1.5">
                              <div className={`h-1.5 rounded-full ${margin >= 30 ? 'bg-green-500' : margin >= 15 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                style={{ width: `${Math.min(margin, 100)}%` }} />
                            </div>
                            <span className={`font-bold ${marginColor(margin)}`}>{formatPercent(margin)}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Margin distribution bar chart */}
          {jobsByMargin.length > 0 && (
            <div className="card p-6">
              <h3 className="font-semibold text-gray-900 mb-4">Margin Distribution by Job</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={jobsByMargin.map(j => ({
                  name: j.job_number,
                  margin: Number(j.margin_percent ?? 0),
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={40} />
                  <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                  <Bar dataKey="margin" name="Margin %" radius={[4, 4, 0, 0]}>
                    {jobsByMargin.map((j, i) => (
                      <Cell key={i} fill={Number(j.margin_percent ?? 0) >= 30 ? '#10b981' : Number(j.margin_percent ?? 0) >= 15 ? '#f59e0b' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* ── Group Consolidated P&L ── */}
      {tab === 'group' && (
        <div className="space-y-4">
          {/* Entity comparison chart */}
          <div className="card p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Revenue vs Cost vs Profit — By Entity</h3>
            {groupChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={groupChartData} barSize={30}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={v => `R${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => formatZAR(v)} />
                  <Legend />
                  <Bar dataKey="Revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Cost" fill="#f97316" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Profit" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[260px] flex items-center justify-center text-gray-400">No data yet</div>
            )}
          </div>

          {/* Entity detail table */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">Group Consolidated P&L</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {['Entity', 'Role', 'Jobs', 'Revenue', 'Total Cost', 'Gross Profit', 'Margin'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {group_consolidated.map((co: GroupConsolidated) => (
                    <tr key={co.company_id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: COMPANY_COLORS[co.company] || '#9ca3af' }} />
                          <span className="font-medium text-gray-900">{co.company}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-500 capitalize">{co.role.replace('_', '/')}</td>
                      <td className="px-4 py-3 text-gray-600">{co.total_jobs}</td>
                      <td className="px-4 py-3 font-medium">{formatZAR(co.total_revenue)}</td>
                      <td className="px-4 py-3 text-gray-500">{formatZAR(co.total_costs)}</td>
                      <td className="px-4 py-3 font-medium text-green-600">{formatZAR(co.gross_profit)}</td>
                      <td className="px-4 py-3">
                        <span className={`font-bold ${marginColor(Number(co.margin_percent))}`}>
                          {formatPercent(co.margin_percent)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {group_consolidated.length > 0 && (
                  <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                    <tr>
                      <td colSpan={3} className="px-4 py-3 font-bold text-gray-700">Group Total</td>
                      <td className="px-4 py-3 font-bold">{formatZAR(group_consolidated.reduce((s, c) => s + Number(c.total_revenue), 0))}</td>
                      <td className="px-4 py-3 font-bold">{formatZAR(group_consolidated.reduce((s, c) => s + Number(c.total_costs), 0))}</td>
                      <td className="px-4 py-3 font-bold text-green-600">{formatZAR(group_consolidated.reduce((s, c) => s + Number(c.gross_profit), 0))}</td>
                      <td className="px-4 py-3 font-bold text-gray-900">
                        {formatPercent(kpis.avg_margin)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Revenue Trend ── */}
      {tab === 'pipeline' && (
        <div className="space-y-4">
          <div className="card p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Monthly Revenue & Profit Trend</h3>
            {monthlyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="money" tickFormatter={v => `R${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="pct" orientation="right" tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number, name: string) => name === 'margin' ? `${v}%` : formatZAR(v)} />
                  <Legend />
                  <Line yAxisId="money" type="monotone" dataKey="Revenue" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} />
                  <Line yAxisId="money" type="monotone" dataKey="Profit" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} />
                  <Line yAxisId="pct" type="monotone" dataKey="margin" name="Margin %" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[280px] flex items-center justify-center text-gray-400">No invoiced jobs with dates yet</div>
            )}
          </div>

          {/* Monthly table */}
          {monthlyData.length > 0 && (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Month', 'Jobs', 'Revenue', 'Profit', 'Margin'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {monthlyData.map((m, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{m.month}</td>
                        <td className="px-4 py-3 text-gray-500">{(data.jobs_by_status as any)?.[i]?.count ?? '—'}</td>
                        <td className="px-4 py-3 font-medium">{formatZAR(m.Revenue)}</td>
                        <td className="px-4 py-3 font-medium text-green-600">{formatZAR(m.Profit)}</td>
                        <td className="px-4 py-3">
                          <span className={`font-bold ${marginColor(m.margin)}`}>{m.margin}%</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
