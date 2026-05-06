import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import StatusBadge from '../components/StatusBadge';
import { Job, JobStatus } from '../types';
import { formatZAR, formatDate, formatPercent, daysUntil } from '../utils/format';
import { JOB_STATUSES } from '../utils/constants';

const STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Statuses' },
  ...JOB_STATUSES.map(s => ({ value: s.value, label: s.label })),
];

interface NewJobForm {
  title: string;
  client_id: string;
  description: string;
  location: string;
  deadline: string;
  quote_amount: string;
  has_installation: boolean;
  has_vehicle_wrap: boolean;
  has_vinyl_work: boolean;
}

const EMPTY_FORM: NewJobForm = {
  title: '', client_id: '', description: '', location: '',
  deadline: '', quote_amount: '', has_installation: false,
  has_vehicle_wrap: false, has_vinyl_work: false,
};

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showNewJob, setShowNewJob] = useState(false);
  const [form, setForm] = useState<NewJobForm>(EMPTY_FORM);
  const [clients, setClients] = useState<{ id: string; company_name: string }[]>([]);
  const [primaryCompanyId, setPrimaryCompanyId] = useState('');
  const [companies, setCompanies] = useState<{ id: string; short_name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (search) params.search = search;
      if (statusFilter) params.status = statusFilter;
      const res = await api.get('/jobs', { params });
      setJobs(res.data.jobs || []);
      setTotal(res.data.total || 0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchJobs(); }, [search, statusFilter]);

  useEffect(() => {
    api.get('/clients', { params: { limit: 200 } }).then(r => setClients(r.data.clients || []));
    api.get('/companies').then(r => {
      setCompanies(r.data);
      const sgr = r.data.find((c: any) => c.role === 'franchise');
      if (sgr) setPrimaryCompanyId(sgr.id);
    });
  }, []);

  const handleCreate = async () => {
    setSaving(true);
    try {
      const res = await api.post('/jobs', {
        ...form,
        primary_company_id: primaryCompanyId,
        quote_amount: parseFloat(form.quote_amount) || 0,
      });
      setShowNewJob(false);
      setForm(EMPTY_FORM);
      navigate(`/jobs/${res.data.id}`);
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Jobs</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} jobs in system</p>
        </div>
        <button
          onClick={() => setShowNewJob(true)}
          className="bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          + New Job
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Search jobs, clients, job numbers…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px] focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {STATUS_FILTER_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Job cards */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-gray-500">No jobs found. Create your first job to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => {
            const days = daysUntil(job.deadline);
            const isOverdue = days !== null && days < 0 && !['paid', 'cancelled', 'invoiced'].includes(job.status);
            return (
              <Link
                key={job.id}
                to={`/jobs/${job.id}`}
                className="block bg-white rounded-xl border border-gray-200 px-5 py-4 shadow-sm hover:shadow-md hover:border-brand-300 transition-all"
              >
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="text-xs font-mono text-gray-400">{job.job_number}</span>
                      <StatusBadge status={job.status} size="sm" />
                      {job.has_vehicle_wrap && <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">🚗 Wrap</span>}
                      {job.has_vinyl_work && <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">🎨 Vinyl</span>}
                      {job.has_installation && <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">🔧 Install</span>}
                    </div>
                    <p className="font-semibold text-gray-900">{job.title}</p>
                    <p className="text-sm text-gray-500 mt-0.5">
                      {job.client_name}
                      {job.assigned_to_name && <> · <span>{job.assigned_to_name}</span></>}
                    </p>
                  </div>

                  <div className="flex items-center gap-6 flex-shrink-0 text-right">
                    <div>
                      <p className="text-xs text-gray-400">Revenue</p>
                      <p className="font-bold text-gray-900">{formatZAR(job.invoice_amount || job.quote_amount)}</p>
                    </div>
                    {job.margin_percent != null && (
                      <div>
                        <p className="text-xs text-gray-400">Margin</p>
                        <p className={`font-bold ${Number(job.margin_percent) >= 25 ? 'text-green-600' : Number(job.margin_percent) >= 10 ? 'text-yellow-600' : 'text-red-600'}`}>
                          {formatPercent(job.margin_percent)}
                        </p>
                      </div>
                    )}
                    {job.deadline && (
                      <div>
                        <p className="text-xs text-gray-400">Deadline</p>
                        <p className={`text-sm font-medium ${isOverdue ? 'text-red-600' : 'text-gray-700'}`}>
                          {isOverdue ? `${Math.abs(days!)}d overdue` : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days}d`}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* New Job Modal */}
      {showNewJob && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">New Job</h2>
              <button onClick={() => setShowNewJob(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Job Title *</label>
                <input
                  value={form.title}
                  onChange={e => setForm({ ...form, title: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="e.g. ABC Motors – Full Vehicle Wrap"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Client *</label>
                <select
                  value={form.client_id}
                  onChange={e => setForm({ ...form, client_id: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="">Select client…</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Operating Company</label>
                <select
                  value={primaryCompanyId}
                  onChange={e => setPrimaryCompanyId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {companies.map(c => <option key={c.id} value={c.id}>{c.short_name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Quote Amount (ZAR)</label>
                  <input
                    type="number"
                    value={form.quote_amount}
                    onChange={e => setForm({ ...form, quote_amount: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Deadline</label>
                  <input
                    type="date"
                    value={form.deadline}
                    onChange={e => setForm({ ...form, deadline: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                <input
                  value={form.location}
                  onChange={e => setForm({ ...form, location: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="e.g. George, Western Cape"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="Brief description of the job…"
                />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Job Type</p>
                <div className="flex gap-4">
                  {[
                    { field: 'has_vinyl_work',    label: '🎨 Vinyl Work' },
                    { field: 'has_vehicle_wrap',  label: '🚗 Vehicle Wrap' },
                    { field: 'has_installation',  label: '🔧 Installation' },
                  ].map(({ field, label }) => (
                    <label key={field} className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form[field as keyof NewJobForm] as boolean}
                        onChange={e => setForm({ ...form, [field]: e.target.checked })}
                        className="rounded text-brand-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 justify-end">
              <button onClick={() => setShowNewJob(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
              <button
                onClick={handleCreate}
                disabled={saving || !form.title || !form.client_id}
                className="bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
              >
                {saving ? 'Creating…' : 'Create Job'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
