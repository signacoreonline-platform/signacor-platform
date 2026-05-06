import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import StatusBadge from '../components/StatusBadge';
import LifecycleTracker from '../components/LifecycleTracker';
import ProfitBar from '../components/ProfitBar';
import { Job, JobCost, JobStatus, CostCategory } from '../types';
import { formatZAR, formatDate, formatPercent, marginBg } from '../utils/format';
import { COST_CATEGORIES, LIFECYCLE_STAGES } from '../utils/constants';

interface CostForm {
  category: CostCategory;
  description: string;
  quantity: string;
  unit: string;
  unit_cost: string;
  is_actual: boolean;
  notes: string;
}

const EMPTY_COST: CostForm = {
  category: 'materials',
  description: '', quantity: '1', unit: 'each',
  unit_cost: '', is_actual: true, notes: '',
};

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'costs' | 'history' | 'notes'>('overview');
  const [showAddCost, setShowAddCost] = useState(false);
  const [costForm, setCostForm] = useState<CostForm>(EMPTY_COST);
  const [saving, setSaving] = useState(false);
  const [statusNote, setStatusNote] = useState('');
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<JobStatus | null>(null);

  const fetchJob = async () => {
    try {
      const res = await api.get(`/jobs/${id}`);
      setJob(res.data);
    } catch {
      navigate('/jobs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchJob(); }, [id]);

  const handleAdvanceStatus = (newStatus: JobStatus) => {
    setPendingStatus(newStatus);
    setShowStatusModal(true);
  };

  const confirmStatusChange = async () => {
    if (!pendingStatus) return;
    setSaving(true);
    try {
      await api.patch(`/jobs/${id}/status`, { status: pendingStatus, notes: statusNote });
      setShowStatusModal(false);
      setStatusNote('');
      setPendingStatus(null);
      await fetchJob();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleAddCost = async () => {
    setSaving(true);
    try {
      await api.post(`/jobs/${id}/costs`, {
        ...costForm,
        quantity: parseFloat(costForm.quantity),
        unit_cost: parseFloat(costForm.unit_cost),
      });
      setShowAddCost(false);
      setCostForm(EMPTY_COST);
      await fetchJob();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCost = async (costId: string) => {
    if (!confirm('Delete this cost entry?')) return;
    await api.delete(`/jobs/${id}/costs/${costId}`);
    await fetchJob();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!job) return null;

  const costs = job.costs || [];
  const costsByCategory = COST_CATEGORIES.reduce((acc, cat) => {
    acc[cat.value] = costs.filter(c => c.category === cat.value);
    return acc;
  }, {} as Record<string, JobCost[]>);

  const currentStageIndex = LIFECYCLE_STAGES.indexOf(job.status);
  const nextStatus = currentStageIndex < LIFECYCLE_STAGES.length - 1
    ? LIFECYCLE_STAGES[currentStageIndex + 1]
    : null;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Back button */}
      <button
        onClick={() => navigate('/jobs')}
        className="text-sm text-gray-500 hover:text-gray-900 flex items-center gap-1"
      >
        ← All Jobs
      </button>

      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex flex-wrap items-start gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-gray-400">{job.job_number}</span>
              <StatusBadge status={job.status} />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">{job.title}</h1>
            <p className="text-gray-500 mt-0.5">
              {job.client_name}
              {job.location && <> · {job.location}</>}
            </p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {nextStatus && nextStatus !== 'cancelled' && (
              <button
                onClick={() => handleAdvanceStatus(nextStatus)}
                className="bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                Advance → {nextStatus.replace(/_/g, ' ')}
              </button>
            )}
          </div>
        </div>

        {/* Lifecycle tracker */}
        <div className="border-t border-gray-100 pt-4 overflow-x-auto">
          <LifecycleTracker
            currentStatus={job.status}
            onAdvance={handleAdvanceStatus}
          />
        </div>
      </div>

      {/* Profit summary bar */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Profit & Cost Breakdown</h2>
          <div className="flex gap-4">
            <div className="text-right">
              <p className="text-xs text-gray-400">Revenue</p>
              <p className="font-bold text-gray-900">{formatZAR(job.invoice_amount || job.quote_amount)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-400">Total Cost</p>
              <p className="font-bold text-gray-900">{formatZAR(job.total_cost || 0)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-400">Gross Profit</p>
              <p className={`font-bold ${Number(job.margin_percent) >= 25 ? 'text-green-600' : Number(job.margin_percent) >= 10 ? 'text-yellow-600' : 'text-red-600'}`}>
                {formatZAR(job.gross_profit || 0)}
              </p>
            </div>
            {job.margin_percent != null && (
              <div className="text-right">
                <p className="text-xs text-gray-400">Margin</p>
                <span className={`inline-block px-2 py-0.5 rounded-full text-sm font-bold ${marginBg(Number(job.margin_percent))}`}>
                  {formatPercent(job.margin_percent)}
                </span>
              </div>
            )}
          </div>
        </div>
        <ProfitBar
          revenue={job.invoice_amount || job.quote_amount}
          costMaterials={job.cost_materials || 0}
          costLabour={job.cost_labour || 0}
          costMachineTime={job.cost_machine_time || 0}
          costDesign={job.cost_design || 0}
          costDelivery={job.cost_delivery || 0}
          costRoyalty={job.cost_royalty || 0}
        />
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="border-b border-gray-200 px-6">
          <nav className="flex gap-6 -mb-px">
            {(['overview', 'costs', 'history', 'notes'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`py-3 text-sm font-medium border-b-2 transition-colors capitalize ${
                  activeTab === tab
                    ? 'border-brand-500 text-brand-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab}
              </button>
            ))}
          </nav>
        </div>

        <div className="p-6">
          {/* Overview tab */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-700 text-sm uppercase tracking-wide">Job Details</h3>
                <dl className="space-y-2">
                  {[
                    { label: 'Client', value: job.client_name },
                    { label: 'Contact', value: job.contact_person },
                    { label: 'Email', value: job.client_email },
                    { label: 'Phone', value: job.client_phone },
                    { label: 'Location', value: job.location },
                    { label: 'Assigned To', value: job.assigned_to_name },
                    { label: 'Deadline', value: formatDate(job.deadline) },
                  ].map(({ label, value }) => value ? (
                    <div key={label} className="flex gap-3">
                      <dt className="text-sm text-gray-400 w-24 flex-shrink-0">{label}</dt>
                      <dd className="text-sm text-gray-900 font-medium">{value}</dd>
                    </div>
                  ) : null)}
                </dl>
              </div>
              <div className="space-y-4">
                <h3 className="font-semibold text-gray-700 text-sm uppercase tracking-wide">Financial Summary</h3>
                <dl className="space-y-2">
                  {[
                    { label: 'Quote', value: formatZAR(job.quote_amount) },
                    { label: 'Deposit Due', value: formatZAR(job.deposit_amount) },
                    { label: 'Deposit Received', value: formatZAR(job.deposit_received) },
                    { label: 'Invoice', value: formatZAR(job.invoice_amount) },
                    { label: 'Amount Paid', value: formatZAR(job.amount_paid) },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex gap-3">
                      <dt className="text-sm text-gray-400 w-32 flex-shrink-0">{label}</dt>
                      <dd className="text-sm text-gray-900 font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="pt-3 border-t border-gray-100 space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Franchise Royalty</span>
                    <span className="font-medium">{formatPercent(job.royalty_rate * 100, 0)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pt-2">
                  {job.has_vinyl_work && <span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded">🎨 Vinyl Work</span>}
                  {job.has_vehicle_wrap && <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded">🚗 Vehicle Wrap</span>}
                  {job.has_installation && <span className="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded">🔧 Installation</span>}
                </div>
              </div>
              {job.description && (
                <div className="col-span-2">
                  <h3 className="font-semibold text-gray-700 text-sm uppercase tracking-wide mb-2">Description</h3>
                  <p className="text-sm text-gray-700 leading-relaxed bg-gray-50 rounded-lg p-4">{job.description}</p>
                </div>
              )}
            </div>
          )}

          {/* Costs tab */}
          {activeTab === 'costs' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">
                  Total cost entries: <strong>{costs.length}</strong> · Total: <strong>{formatZAR(job.total_cost || 0)}</strong>
                </p>
                <button
                  onClick={() => setShowAddCost(true)}
                  className="bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2 rounded-lg"
                >
                  + Add Cost
                </button>
              </div>

              {COST_CATEGORIES.map(cat => {
                const catCosts = costsByCategory[cat.value] || [];
                const catTotal = catCosts.reduce((s, c) => s + Number(c.total_cost), 0);
                return (
                  <div key={cat.value} className={`rounded-xl border p-4 ${cat.color}`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span>{cat.icon}</span>
                        <span className="font-semibold text-sm text-gray-900">{cat.label}</span>
                        <span className="text-xs text-gray-500">({catCosts.length} entries)</span>
                      </div>
                      <span className="font-bold text-gray-900">{formatZAR(catTotal)}</span>
                    </div>
                    {catCosts.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-gray-500">
                            <th className="pb-1 font-medium">Description</th>
                            <th className="pb-1 font-medium text-right">Qty</th>
                            <th className="pb-1 font-medium text-right">Unit Cost</th>
                            <th className="pb-1 font-medium text-right">Total</th>
                            <th className="pb-1 font-medium text-center">Type</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {catCosts.map(cost => (
                            <tr key={cost.id} className="border-t border-white/50">
                              <td className="py-1.5 pr-4">
                                {cost.description}
                                {cost.notes && <span className="text-gray-400 text-xs block">{cost.notes}</span>}
                              </td>
                              <td className="py-1.5 text-right">{cost.quantity} {cost.unit}</td>
                              <td className="py-1.5 text-right">{formatZAR(cost.unit_cost)}</td>
                              <td className="py-1.5 text-right font-medium">{formatZAR(cost.total_cost)}</td>
                              <td className="py-1.5 text-center">
                                <span className={`text-xs px-1.5 py-0.5 rounded ${cost.is_actual ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                                  {cost.is_actual ? 'Actual' : 'Estimated'}
                                </span>
                              </td>
                              <td className="py-1.5 text-right">
                                <button
                                  onClick={() => handleDeleteCost(cost.id)}
                                  className="text-red-400 hover:text-red-600 text-xs"
                                >
                                  ×
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="text-xs text-gray-400 italic">No entries for this category</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* History tab */}
          {activeTab === 'history' && (
            <div className="space-y-3">
              {(job.stage_history || []).length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-8">No stage changes yet</p>
              ) : (
                (job.stage_history || []).map(h => (
                  <div key={h.id} className="flex gap-3 items-start">
                    <div className="w-2 h-2 rounded-full bg-brand-500 mt-1.5 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        {h.from_status && <StatusBadge status={h.from_status} size="sm" />}
                        {h.from_status && <span className="text-gray-400 text-xs">→</span>}
                        <StatusBadge status={h.to_status} size="sm" />
                        <span className="text-xs text-gray-400 ml-auto">{formatDate(h.changed_at)}</span>
                      </div>
                      {h.changed_by_name && <p className="text-xs text-gray-500 mt-0.5">by {h.changed_by_name}</p>}
                      {h.notes && <p className="text-sm text-gray-700 mt-1 bg-gray-50 rounded px-3 py-2">{h.notes}</p>}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Notes tab */}
          {activeTab === 'notes' && (
            <div className="space-y-4">
              {job.special_instructions && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">Special Instructions</h3>
                  <p className="text-sm text-gray-700 bg-yellow-50 rounded-lg p-4 border border-yellow-200">{job.special_instructions}</p>
                </div>
              )}
              {job.internal_notes && (
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">Internal Notes</h3>
                  <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-4">{job.internal_notes}</p>
                </div>
              )}
              {!job.special_instructions && !job.internal_notes && (
                <p className="text-gray-400 text-sm text-center py-8">No notes on this job</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Add Cost Modal */}
      {showAddCost && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Add Cost Entry</h2>
              <button onClick={() => setShowAddCost(false)} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={costForm.category}
                  onChange={e => setCostForm({ ...costForm, category: e.target.value as CostCategory })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {COST_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.icon} {c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input
                  value={costForm.description}
                  onChange={e => setCostForm({ ...costForm, description: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="e.g. Cast vinyl 3M 1080 – 5m²"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Qty</label>
                  <input
                    type="number"
                    value={costForm.quantity}
                    onChange={e => setCostForm({ ...costForm, quantity: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
                  <select
                    value={costForm.unit}
                    onChange={e => setCostForm({ ...costForm, unit: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {['each','m2','lm','hour','day','kg','litre','lump sum'].map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Unit Cost (R)</label>
                  <input
                    type="number"
                    value={costForm.unit_cost}
                    onChange={e => setCostForm({ ...costForm, unit_cost: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={costForm.is_actual}
                    onChange={e => setCostForm({ ...costForm, is_actual: e.target.checked })}
                    className="rounded text-brand-500"
                  />
                  Actual cost (unchecked = estimated)
                </label>
                {costForm.quantity && costForm.unit_cost && (
                  <span className="ml-auto text-sm font-bold text-gray-900">
                    Total: {formatZAR(parseFloat(costForm.quantity) * parseFloat(costForm.unit_cost))}
                  </span>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
                <input
                  value={costForm.notes}
                  onChange={e => setCostForm({ ...costForm, notes: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 justify-end">
              <button onClick={() => setShowAddCost(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              <button
                onClick={handleAddCost}
                disabled={saving || !costForm.description || !costForm.unit_cost}
                className="bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg"
              >
                {saving ? 'Saving…' : 'Add Cost'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status advance modal */}
      {showStatusModal && pendingStatus && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold mb-2">Advance Job Stage</h2>
            <p className="text-sm text-gray-600 mb-4">
              Move job to <strong>{pendingStatus.replace(/_/g, ' ')}</strong>?
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
              <textarea
                value={statusNote}
                onChange={e => setStatusNote(e.target.value)}
                rows={3}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="Any notes for this stage change…"
              />
            </div>
            <div className="flex gap-3 justify-end mt-4">
              <button onClick={() => setShowStatusModal(false)} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
              <button
                onClick={confirmStatusChange}
                disabled={saving}
                className="bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg"
              >
                {saving ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
