import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import { Client } from '../types';
import { formatDate } from '../utils/format';

interface NewClientForm {
  company_name: string; trading_name: string; contact_person: string;
  email: string; phone: string; mobile: string; address: string;
  city: string; province: string; postal_code: string;
  vat_no: string; payment_terms: string; notes: string;
}
const EMPTY: NewClientForm = {
  company_name: '', trading_name: '', contact_person: '',
  email: '', phone: '', mobile: '', address: '',
  city: '', province: '', postal_code: '',
  vat_no: '', payment_terms: '30', notes: '',
};

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<NewClientForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  const fetchClients = async () => {
    setLoading(true);
    try {
      const res = await api.get('/clients', { params: { search: search || undefined, limit: 100 } });
      setClients(res.data.clients || []);
      setTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchClients(); }, [search]);

  const handleCreate = async () => {
    setSaving(true);
    try {
      const res = await api.post('/clients', { ...form, payment_terms: parseInt(form.payment_terms) });
      setShowNew(false); setForm(EMPTY);
      navigate(`/clients/${res.data.id}`);
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const f = (k: keyof NewClientForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }));

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} clients on record</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary">+ New Client</button>
      </div>

      <input
        type="text" value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search by company name, contact or email…"
        className="input max-w-md"
      />

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : clients.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-4xl mb-3">🏢</p>
          <p className="text-gray-500">No clients found. Add your first client to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {clients.map(c => (
            <Link key={c.id} to={`/clients/${c.id}`}
              className="card p-5 hover:shadow-md hover:border-brand-300 transition-all block">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-brand-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <span className="text-brand-700 font-bold text-sm">
                    {c.company_name.substring(0, 2).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 truncate">{c.company_name}</p>
                  {c.trading_name && <p className="text-xs text-gray-400">t/a {c.trading_name}</p>}
                  {c.contact_person && <p className="text-sm text-gray-600 mt-1">{c.contact_person}</p>}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                    {c.email && <span>✉ {c.email}</span>}
                    {c.phone && <span>☎ {c.phone}</span>}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    {c.city && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{c.city}</span>}
                    <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded">Net {c.payment_terms} days</span>
                    {c.vat_no && <span className="text-xs bg-green-50 text-green-600 px-2 py-0.5 rounded">VAT</span>}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* New Client Modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h2 className="text-lg font-semibold">New Client</h2>
              <button onClick={() => setShowNew(false)} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-4">
              {/* Company info */}
              <div className="col-span-2 text-xs font-semibold text-gray-500 uppercase tracking-wide pt-2">Company Information</div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Company Name *</label>
                <input value={form.company_name} onChange={f('company_name')} className="input" placeholder="ABC Motors (Pty) Ltd" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Trading Name</label>
                <input value={form.trading_name} onChange={f('trading_name')} className="input" placeholder="ABC Motors" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">VAT Number</label>
                <input value={form.vat_no} onChange={f('vat_no')} className="input" placeholder="4123456789" />
              </div>

              {/* Contact */}
              <div className="col-span-2 text-xs font-semibold text-gray-500 uppercase tracking-wide pt-2">Contact Details</div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Contact Person</label>
                <input value={form.contact_person} onChange={f('contact_person')} className="input" placeholder="John Smith" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input type="email" value={form.email} onChange={f('email')} className="input" placeholder="john@abcmotors.co.za" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input value={form.phone} onChange={f('phone')} className="input" placeholder="044 123 4567" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mobile</label>
                <input value={form.mobile} onChange={f('mobile')} className="input" placeholder="082 123 4567" />
              </div>

              {/* Address */}
              <div className="col-span-2 text-xs font-semibold text-gray-500 uppercase tracking-wide pt-2">Address</div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Street Address</label>
                <input value={form.address} onChange={f('address')} className="input" placeholder="123 Main Street" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                <input value={form.city} onChange={f('city')} className="input" placeholder="George" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Province</label>
                <select value={form.province} onChange={f('province')} className="input">
                  <option value="">Select province…</option>
                  {['Western Cape','Eastern Cape','Northern Cape','KwaZulu-Natal','Gauteng','Limpopo','Mpumalanga','North West','Free State'].map(p => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Postal Code</label>
                <input value={form.postal_code} onChange={f('postal_code')} className="input" placeholder="6530" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Terms (days)</label>
                <select value={form.payment_terms} onChange={f('payment_terms')} className="input">
                  {['0','7','14','21','30','45','60'].map(d => <option key={d} value={d}>Net {d} days</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={form.notes} onChange={f('notes')} rows={3} className="input" placeholder="Any notes about this client…" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 justify-end sticky bottom-0 bg-white">
              <button onClick={() => setShowNew(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleCreate} disabled={saving || !form.company_name} className="btn-primary">
                {saving ? 'Creating…' : 'Create Client'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
