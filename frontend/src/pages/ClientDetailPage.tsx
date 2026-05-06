import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../utils/api';
import StatusBadge from '../components/StatusBadge';
import { Client } from '../types';
import { formatZAR, formatDate, formatPercent } from '../utils/format';

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<Client | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/clients/${id}`)
      .then(r => setClient(r.data))
      .catch(() => navigate('/clients'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!client) return null;

  const jobs = (client as any).jobs || [];
  const totalRevenue = jobs.reduce((s: number, j: any) => s + Number(j.invoice_amount || 0), 0);
  const totalProfit = jobs.reduce((s: number, j: any) => s + Number(j.gross_profit || 0), 0);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <button onClick={() => navigate('/clients')} className="text-sm text-gray-500 hover:text-gray-900 flex items-center gap-1">
        ← All Clients
      </button>

      {/* Header */}
      <div className="card p-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 bg-brand-100 rounded-xl flex items-center justify-center flex-shrink-0">
            <span className="text-brand-700 font-bold text-xl">{client.company_name.substring(0, 2).toUpperCase()}</span>
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-gray-900">{client.company_name}</h1>
            {client.trading_name && <p className="text-gray-500">t/a {client.trading_name}</p>}
            <div className="flex flex-wrap gap-2 mt-2">
              {client.city && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{client.city}</span>}
              <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded">Net {client.payment_terms} days</span>
              {client.vat_no && <span className="text-xs bg-green-50 text-green-600 px-2 py-0.5 rounded">VAT: {client.vat_no}</span>}
            </div>
          </div>
          {/* KPIs */}
          <div className="flex gap-6 text-right">
            <div>
              <p className="text-xs text-gray-400">Total Revenue</p>
              <p className="font-bold text-gray-900">{formatZAR(totalRevenue, { compact: true })}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Total Profit</p>
              <p className="font-bold text-green-600">{formatZAR(totalProfit, { compact: true })}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Jobs</p>
              <p className="font-bold text-gray-900">{jobs.length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Details + Jobs */}
      <div className="grid grid-cols-3 gap-5">
        {/* Contact details */}
        <div className="card p-5 space-y-3">
          <h2 className="section-title">Contact Details</h2>
          <dl className="space-y-2">
            {[
              { label: 'Contact', value: client.contact_person },
              { label: 'Email', value: client.email },
              { label: 'Phone', value: client.phone },
              { label: 'Mobile', value: client.mobile },
              { label: 'Address', value: [client.address, client.city, client.province, client.postal_code].filter(Boolean).join(', ') },
            ].map(({ label, value }) => value ? (
              <div key={label}>
                <dt className="text-xs text-gray-400">{label}</dt>
                <dd className="text-sm text-gray-900 font-medium mt-0.5">{value}</dd>
              </div>
            ) : null)}
          </dl>
          {client.notes && (
            <div className="pt-3 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-1">Notes</p>
              <p className="text-sm text-gray-700">{client.notes}</p>
            </div>
          )}
        </div>

        {/* Jobs list */}
        <div className="col-span-2 card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="section-title">Job History</h2>
            <Link to={`/jobs?client_id=${client.id}`} className="text-xs text-brand-600 hover:underline">View all →</Link>
          </div>
          {jobs.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">No jobs for this client yet</div>
          ) : (
            <div className="divide-y divide-gray-50">
              {jobs.map((j: any) => (
                <Link key={j.id} to={`/jobs/${j.id}`}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-gray-50 transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{j.title}</p>
                    <p className="text-xs text-gray-400">{j.job_number} · {formatDate(j.invoice_date)}</p>
                  </div>
                  <StatusBadge status={j.status} size="sm" />
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-bold text-gray-900">{formatZAR(j.invoice_amount)}</p>
                    {j.margin_percent != null && (
                      <p className={`text-xs ${Number(j.margin_percent) >= 25 ? 'text-green-600' : 'text-yellow-600'}`}>
                        {formatPercent(j.margin_percent)} margin
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
