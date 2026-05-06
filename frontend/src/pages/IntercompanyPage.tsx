import { useEffect, useState } from 'react';
import api from '../utils/api';
import { IntercompanyTransaction, IntercompanySummary, Company } from '../types';
import { formatZAR, formatDate } from '../utils/format';
import StatusBadge from '../components/StatusBadge';

interface NewTxForm {
  from_company_id: string; to_company_id: string;
  transaction_type: string; amount: string; vat_rate: string;
  description: string; reference_no: string; transaction_date: string; notes: string;
}
const EMPTY_TX: NewTxForm = {
  from_company_id: '', to_company_id: '', transaction_type: 'intercompany_charge',
  amount: '', vat_rate: '0.15', description: '', reference_no: '',
  transaction_date: new Date().toISOString().split('T')[0], notes: '',
};

const TX_TYPES = [
  { value: 'invoice', label: 'Invoice' },
  { value: 'payment', label: 'Payment' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'intercompany_charge', label: 'Intercompany Charge' },
  { value: 'adjustment', label: 'Adjustment' },
];

export default function IntercompanyPage() {
  const [transactions, setTransactions] = useState<IntercompanyTransaction[]>([]);
  const [summary, setSummary] = useState<IntercompanySummary[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<NewTxForm>(EMPTY_TX);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'transactions' | 'summary'>('transactions');
  const [statusFilter, setStatusFilter] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      const [txRes, sumRes, coRes] = await Promise.all([
        api.get('/intercompany', { params }),
        api.get('/intercompany/summary'),
        api.get('/companies'),
      ]);
      setTransactions(txRes.data.transactions || []);
      setTotal(txRes.data.total || 0);
      setSummary(sumRes.data || []);
      setCompanies(coRes.data || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, [statusFilter]);

  const f = (k: keyof NewTxForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }));

  const handleCreate = async () => {
    setSaving(true);
    try {
      await api.post('/intercompany', {
        ...form, amount: parseFloat(form.amount), vat_rate: parseFloat(form.vat_rate),
      });
      setShowNew(false); setForm(EMPTY_TX); await fetchData();
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const handleStatusUpdate = async (id: string, status: string) => {
    await api.patch(`/intercompany/${id}/status`, { status });
    await fetchData();
  };

  const vatAmt = parseFloat(form.amount || '0') * parseFloat(form.vat_rate || '0');
  const totalAmt = parseFloat(form.amount || '0') + vatAmt;

  // Build company lookup
  const coMap = Object.fromEntries(companies.map(c => [c.id, c.short_name]));

  // Group totals for summary table
  const totalOutstanding = summary.reduce((s, r) => s + Number(r.outstanding_amount), 0);
  const totalValue = summary.reduce((s, r) => s + Number(r.total_with_vat), 0);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Intercompany Transactions</h1>
          <p className="text-sm text-gray-500 mt-0.5">Cross-entity charges, transfers and settlements between all four group companies</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary">+ New Transaction</button>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Transactions', value: String(total), icon: '🔄' },
          { label: 'Total Value (incl. VAT)', value: formatZAR(totalValue, { compact: true }), icon: '💰' },
          { label: 'Outstanding', value: formatZAR(totalOutstanding, { compact: true }), icon: '⏳' },
          { label: 'Group Entities', value: String(companies.length), icon: '🏢' },
        ].map(({ label, value, icon }) => (
          <div key={label} className="card p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-500 font-medium">{label}</p>
                <p className="text-xl font-bold text-gray-900 mt-0.5">{value}</p>
              </div>
              <span className="text-2xl opacity-60">{icon}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        {(['transactions', 'summary'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition-all capitalize ${tab === t ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Filters */}
      {tab === 'transactions' && (
        <div className="flex gap-3">
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="input w-48">
            <option value="">All Statuses</option>
            {['pending','partial','paid','overdue'].map(s => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : tab === 'transactions' ? (
        /* Transactions table */
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Ref', 'Date', 'From → To', 'Type', 'Amount', 'VAT', 'Total', 'Status', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {transactions.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-gray-400">No transactions found</td></tr>
                ) : transactions.map(tx => (
                  <tr key={tx.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{tx.transaction_no}</td>
                    <td className="px-4 py-3 text-gray-700">{formatDate(tx.transaction_date)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded">{tx.from_company_name}</span>
                        <span className="text-gray-400 text-xs">→</span>
                        <span className="text-xs font-medium bg-brand-50 text-brand-700 px-1.5 py-0.5 rounded">{tx.to_company_name}</span>
                      </div>
                      {tx.job_number && <p className="text-xs text-gray-400 mt-0.5">Job: {tx.job_number}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded capitalize">
                        {tx.transaction_type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium">{formatZAR(tx.amount)}</td>
                    <td className="px-4 py-3 text-gray-500">{formatZAR(tx.vat_amount)}</td>
                    <td className="px-4 py-3 font-bold">{formatZAR(tx.total_amount)}</td>
                    <td className="px-4 py-3"><StatusBadge status={tx.status} size="sm" /></td>
                    <td className="px-4 py-3">
                      {tx.status === 'pending' && (
                        <button
                          onClick={() => handleStatusUpdate(tx.id, 'paid')}
                          className="text-xs text-green-600 hover:text-green-800 font-medium">
                          Mark Paid
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Summary matrix */
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">Intercompany Flow Summary</h3>
              <p className="text-xs text-gray-500 mt-0.5">Aggregated by entity pair</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {['From', 'To', 'Count', 'Sub-total', 'VAT', 'Total incl. VAT', 'Paid', 'Outstanding'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {summary.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">No intercompany activity yet</td></tr>
                  ) : summary.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{r.from_company}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{r.to_company}</td>
                      <td className="px-4 py-3 text-gray-500">{r.transaction_count}</td>
                      <td className="px-4 py-3">{formatZAR(r.total_amount)}</td>
                      <td className="px-4 py-3 text-gray-500">{formatZAR(r.total_vat)}</td>
                      <td className="px-4 py-3 font-bold">{formatZAR(r.total_with_vat)}</td>
                      <td className="px-4 py-3 text-green-600">{formatZAR(r.paid_amount)}</td>
                      <td className="px-4 py-3">
                        <span className={`font-bold ${Number(r.outstanding_amount) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {formatZAR(r.outstanding_amount)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {summary.length > 0 && (
                  <tfoot className="bg-gray-50 border-t border-gray-200">
                    <tr>
                      <td colSpan={5} className="px-4 py-3 font-bold text-gray-700">Totals</td>
                      <td className="px-4 py-3 font-bold">{formatZAR(totalValue)}</td>
                      <td className="px-4 py-3 font-bold text-green-600">
                        {formatZAR(summary.reduce((s, r) => s + Number(r.paid_amount), 0))}
                      </td>
                      <td className="px-4 py-3 font-bold text-red-600">{formatZAR(totalOutstanding)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </div>
      )}

      {/* New Transaction Modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h2 className="text-lg font-semibold">New Intercompany Transaction</h2>
              <button onClick={() => setShowNew(false)} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">From Company *</label>
                  <select value={form.from_company_id} onChange={f('from_company_id')} className="input">
                    <option value="">Select…</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.short_name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">To Company *</label>
                  <select value={form.to_company_id} onChange={f('to_company_id')} className="input">
                    <option value="">Select…</option>
                    {companies.filter(c => c.id !== form.from_company_id).map(c =>
                      <option key={c.id} value={c.id}>{c.short_name}</option>
                    )}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Transaction Type</label>
                <select value={form.transaction_type} onChange={f('transaction_type')} className="input">
                  {TX_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description *</label>
                <input value={form.description} onChange={f('description')} className="input"
                  placeholder="e.g. Supply of cast vinyl for SGR-01234" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount (excl. VAT) *</label>
                  <input type="number" value={form.amount} onChange={f('amount')} className="input" placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">VAT Rate</label>
                  <select value={form.vat_rate} onChange={f('vat_rate')} className="input">
                    <option value="0.15">15% VAT</option>
                    <option value="0">0% (VAT exempt)</option>
                  </select>
                </div>
              </div>
              {form.amount && (
                <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                  <div className="flex justify-between"><span className="text-gray-500">VAT ({(parseFloat(form.vat_rate) * 100).toFixed(0)}%)</span><span>{formatZAR(vatAmt)}</span></div>
                  <div className="flex justify-between font-bold"><span>Total</span><span>{formatZAR(totalAmt)}</span></div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Transaction Date</label>
                  <input type="date" value={form.transaction_date} onChange={f('transaction_date')} className="input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reference No.</label>
                  <input value={form.reference_no} onChange={f('reference_no')} className="input" placeholder="INV-001" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={form.notes} onChange={f('notes')} rows={2} className="input" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 justify-end sticky bottom-0 bg-white">
              <button onClick={() => setShowNew(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleCreate}
                disabled={saving || !form.from_company_id || !form.to_company_id || !form.amount || !form.description}
                className="btn-primary">
                {saving ? 'Creating…' : 'Create Transaction'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
