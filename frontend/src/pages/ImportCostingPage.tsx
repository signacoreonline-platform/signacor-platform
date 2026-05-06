import { useEffect, useState } from 'react';
import api from '../utils/api';
import { formatZAR, formatDate } from '../utils/format';

interface Shipment {
  id: string; reference: string; supplier_name: string; origin_country: string;
  invoice_currency: string; invoice_amount_foreign: number; exchange_rate: number;
  invoice_amount_zar: number; freight_cost: number; insurance_cost: number;
  customs_duty_rate: number; customs_duty_amount: number; vat_on_import: number;
  agent_fees: number; clearing_fees: number; inland_transport: number;
  total_landed_cost: number; landed_cost_factor: number;
  arrival_date?: string; status: string; notes?: string; created_at: string;
}

interface NewShipmentForm {
  reference: string; supplier_name: string; origin_country: string;
  invoice_currency: string; invoice_amount_foreign: string; exchange_rate: string;
  freight_cost: string; insurance_cost: string; customs_duty_rate: string;
  agent_fees: string; clearing_fees: string; inland_transport: string;
  arrival_date: string; notes: string;
}

const EMPTY_FORM: NewShipmentForm = {
  reference: '', supplier_name: '', origin_country: '', invoice_currency: 'USD',
  invoice_amount_foreign: '', exchange_rate: '18.50',
  freight_cost: '0', insurance_cost: '0', customs_duty_rate: '20',
  agent_fees: '0', clearing_fees: '0', inland_transport: '0',
  arrival_date: '', notes: '',
};

const CURRENCIES = ['USD','EUR','GBP','CNY','JPY','CHF','AUD'];

function calcLandedCost(form: NewShipmentForm) {
  const invoiceForex = parseFloat(form.invoice_amount_foreign) || 0;
  const rate = parseFloat(form.exchange_rate) || 1;
  const invoiceZAR = invoiceForex * rate;
  const freight = parseFloat(form.freight_cost) || 0;
  const insurance = parseFloat(form.insurance_cost) || 0;
  const cif = invoiceZAR + freight + insurance; // CIF value
  const dutyRate = parseFloat(form.customs_duty_rate) / 100 || 0;
  const duty = cif * dutyRate;
  const vatOnImport = (cif + duty) * 0.15; // 15% VAT on import
  const agentFees = parseFloat(form.agent_fees) || 0;
  const clearingFees = parseFloat(form.clearing_fees) || 0;
  const inland = parseFloat(form.inland_transport) || 0;
  const totalLanded = invoiceZAR + freight + insurance + duty + vatOnImport + agentFees + clearingFees + inland;
  const landedFactor = invoiceZAR > 0 ? totalLanded / invoiceZAR : 1;
  return { invoiceZAR, cif, duty, vatOnImport, totalLanded, landedFactor };
}

export default function ImportCostingPage() {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<NewShipmentForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Shipment | null>(null);

  const live = calcLandedCost(form);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/imports/shipments');
      setShipments(res.data || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  const f = (k: keyof NewShipmentForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }));

  const handleCreate = async () => {
    setSaving(true);
    try {
      await api.post('/imports/shipments', {
        ...form,
        invoice_amount_foreign: parseFloat(form.invoice_amount_foreign),
        exchange_rate: parseFloat(form.exchange_rate),
        customs_duty_rate: parseFloat(form.customs_duty_rate) / 100,
        freight_cost: parseFloat(form.freight_cost) || 0,
        insurance_cost: parseFloat(form.insurance_cost) || 0,
        agent_fees: parseFloat(form.agent_fees) || 0,
        clearing_fees: parseFloat(form.clearing_fees) || 0,
        inland_transport: parseFloat(form.inland_transport) || 0,
        ...live,
      });
      setShowNew(false); setForm(EMPTY_FORM); await fetchData();
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const totalLandedAll = shipments.reduce((s, sh) => s + Number(sh.total_landed_cost), 0);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Import Costing</h1>
          <p className="text-sm text-gray-500 mt-0.5">Uniontech Holdings SA — landed cost calculation for imported materials</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary">+ New Shipment</button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Shipments', value: String(shipments.length), icon: '🚢' },
          { label: 'Total Landed Cost', value: formatZAR(totalLandedAll, { compact: true }), icon: '💰' },
          { label: 'Active (in transit)', value: String(shipments.filter(s => s.status === 'in_transit').length), icon: '⏳' },
          { label: 'Avg Landed Factor', value: shipments.length > 0 ? `${(shipments.reduce((s, sh) => s + Number(sh.landed_cost_factor), 0) / shipments.length).toFixed(3)}×` : '—', icon: '📊' },
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

      {/* Shipments list */}
      {loading ? (
        <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" /></div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Ref','Supplier','Origin','Invoice (Foreign)','Exchange Rate','Invoice (ZAR)','Duty','VAT (Import)','Other Costs','Total Landed','LCF','Arrival','Status'].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {shipments.length === 0 ? (
                  <tr><td colSpan={13} className="px-4 py-12 text-center text-gray-400">No shipments recorded yet</td></tr>
                ) : shipments.map(sh => (
                  <tr key={sh.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(sh)}>
                    <td className="px-3 py-3 font-mono text-xs text-gray-500">{sh.reference}</td>
                    <td className="px-3 py-3 font-medium text-gray-900">{sh.supplier_name}</td>
                    <td className="px-3 py-3 text-gray-600">{sh.origin_country}</td>
                    <td className="px-3 py-3">{sh.invoice_currency} {Number(sh.invoice_amount_foreign).toLocaleString()}</td>
                    <td className="px-3 py-3">{Number(sh.exchange_rate).toFixed(4)}</td>
                    <td className="px-3 py-3 font-medium">{formatZAR(sh.invoice_amount_zar)}</td>
                    <td className="px-3 py-3">{formatZAR(sh.customs_duty_amount)} <span className="text-gray-400 text-xs">({(Number(sh.customs_duty_rate) * 100).toFixed(0)}%)</span></td>
                    <td className="px-3 py-3">{formatZAR(sh.vat_on_import)}</td>
                    <td className="px-3 py-3">{formatZAR(Number(sh.agent_fees) + Number(sh.clearing_fees) + Number(sh.inland_transport))}</td>
                    <td className="px-3 py-3 font-bold text-gray-900">{formatZAR(sh.total_landed_cost)}</td>
                    <td className="px-3 py-3">
                      <span className={`font-bold text-xs ${Number(sh.landed_cost_factor) > 1.5 ? 'text-red-600' : Number(sh.landed_cost_factor) > 1.3 ? 'text-yellow-600' : 'text-green-600'}`}>
                        {Number(sh.landed_cost_factor).toFixed(3)}×
                      </span>
                    </td>
                    <td className="px-3 py-3 text-gray-500">{formatDate(sh.arrival_date)}</td>
                    <td className="px-3 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium capitalize ${
                        sh.status === 'received' ? 'bg-green-100 text-green-700' :
                        sh.status === 'in_transit' ? 'bg-blue-100 text-blue-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>{sh.status.replace('_', ' ')}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Landed cost explainer */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
        <strong>Landed Cost Formula:</strong> Invoice (ZAR) + Freight + Insurance + Customs Duty + VAT on Import (15%) + Agent Fees + Clearing Fees + Inland Transport
        <br /><span className="text-blue-600 text-xs mt-1 block">The Landed Cost Factor (LCF) = Total Landed ÷ Invoice ZAR. Apply this multiplier to all cost prices for accurate job costing.</span>
      </div>

      {/* New Shipment Modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h2 className="text-lg font-semibold">New Import Shipment</h2>
              <button onClick={() => setShowNew(false)} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
            </div>
            <div className="p-6 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference *</label>
                <input value={form.reference} onChange={f('reference')} className="input" placeholder="IMP-2024-001" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Supplier Name *</label>
                <input value={form.supplier_name} onChange={f('supplier_name')} className="input" placeholder="3M China Ltd" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Origin Country</label>
                <input value={form.origin_country} onChange={f('origin_country')} className="input" placeholder="China" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Arrival Date</label>
                <input type="date" value={form.arrival_date} onChange={f('arrival_date')} className="input" />
              </div>

              <div className="col-span-2 text-xs font-semibold text-gray-500 uppercase tracking-wide pt-2">Invoice Details</div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                <select value={form.invoice_currency} onChange={f('invoice_currency')} className="input">
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Invoice Amount ({form.invoice_currency})</label>
                <input type="number" value={form.invoice_amount_foreign} onChange={f('invoice_amount_foreign')} className="input" placeholder="10000.00" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Exchange Rate (R per 1 {form.invoice_currency})</label>
                <input type="number" step="0.0001" value={form.exchange_rate} onChange={f('exchange_rate')} className="input" />
              </div>
              <div className="flex items-end">
                <div className="bg-gray-50 rounded-lg p-3 w-full">
                  <p className="text-xs text-gray-500">Invoice in ZAR</p>
                  <p className="text-lg font-bold text-gray-900">{formatZAR(live.invoiceZAR)}</p>
                </div>
              </div>

              <div className="col-span-2 text-xs font-semibold text-gray-500 uppercase tracking-wide pt-2">Shipping & Import Costs</div>
              {[
                { key: 'freight_cost',      label: 'Freight Cost (ZAR)' },
                { key: 'insurance_cost',    label: 'Insurance (ZAR)' },
                { key: 'customs_duty_rate', label: 'Customs Duty Rate (%)' },
                { key: 'agent_fees',        label: 'Agent / Broker Fees (ZAR)' },
                { key: 'clearing_fees',     label: 'Clearing & Forwarding (ZAR)' },
                { key: 'inland_transport',  label: 'Inland Transport (ZAR)' },
              ].map(({ key, label }) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
                  <input type="number" step="0.01" value={form[key as keyof NewShipmentForm]}
                    onChange={f(key as keyof NewShipmentForm)} className="input" />
                </div>
              ))}

              {/* Live calculation */}
              <div className="col-span-2 bg-brand-50 border border-brand-200 rounded-xl p-4 space-y-2">
                <p className="text-xs font-semibold text-brand-700 uppercase tracking-wide">Live Landed Cost Calculation</p>
                {[
                  { label: 'Invoice (ZAR)', value: live.invoiceZAR },
                  { label: `Customs Duty (${form.customs_duty_rate}% on CIF)`, value: live.duty },
                  { label: 'VAT on Import (15%)', value: live.vatOnImport },
                  { label: 'Other costs (freight/insurance/fees)', value: (parseFloat(form.freight_cost)||0)+(parseFloat(form.insurance_cost)||0)+(parseFloat(form.agent_fees)||0)+(parseFloat(form.clearing_fees)||0)+(parseFloat(form.inland_transport)||0) },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between text-sm">
                    <span className="text-brand-700">{label}</span>
                    <span className="font-medium text-brand-900">{formatZAR(value)}</span>
                  </div>
                ))}
                <div className="flex justify-between text-sm font-bold border-t border-brand-300 pt-2">
                  <span className="text-brand-800">Total Landed Cost</span>
                  <span className="text-brand-900">{formatZAR(live.totalLanded)}</span>
                </div>
                <div className="flex justify-between text-sm font-bold">
                  <span className="text-brand-800">Landed Cost Factor (LCF)</span>
                  <span className={`font-bold ${live.landedFactor > 1.5 ? 'text-red-600' : live.landedFactor > 1.3 ? 'text-yellow-600' : 'text-green-600'}`}>
                    {live.landedFactor.toFixed(4)}×
                  </span>
                </div>
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={form.notes} onChange={f('notes')} rows={2} className="input" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 justify-end sticky bottom-0 bg-white">
              <button onClick={() => setShowNew(false)} className="btn-secondary">Cancel</button>
              <button onClick={handleCreate} disabled={saving || !form.reference || !form.supplier_name || !form.invoice_amount_foreign} className="btn-primary">
                {saving ? 'Saving…' : 'Record Shipment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shipment detail modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Shipment: {selected.reference}</h2>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-700 text-2xl">×</button>
            </div>
            <dl className="space-y-3">
              {[
                { label: 'Supplier', value: selected.supplier_name },
                { label: 'Origin', value: selected.origin_country },
                { label: `Invoice (${selected.invoice_currency})`, value: `${selected.invoice_currency} ${Number(selected.invoice_amount_foreign).toLocaleString()}` },
                { label: 'Exchange Rate', value: `R${Number(selected.exchange_rate).toFixed(4)} per ${selected.invoice_currency}` },
                { label: 'Invoice (ZAR)', value: formatZAR(selected.invoice_amount_zar) },
                { label: 'Freight', value: formatZAR(selected.freight_cost) },
                { label: 'Insurance', value: formatZAR(selected.insurance_cost) },
                { label: `Customs Duty (${(Number(selected.customs_duty_rate) * 100).toFixed(0)}%)`, value: formatZAR(selected.customs_duty_amount) },
                { label: 'VAT on Import', value: formatZAR(selected.vat_on_import) },
                { label: 'Agent Fees', value: formatZAR(selected.agent_fees) },
                { label: 'Clearing Fees', value: formatZAR(selected.clearing_fees) },
                { label: 'Inland Transport', value: formatZAR(selected.inland_transport) },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between">
                  <dt className="text-sm text-gray-500">{label}</dt>
                  <dd className="text-sm font-medium text-gray-900">{value}</dd>
                </div>
              ))}
              <div className="flex justify-between border-t-2 border-gray-300 pt-3">
                <dt className="text-base font-bold text-gray-700">Total Landed Cost</dt>
                <dd className="text-base font-bold text-gray-900">{formatZAR(selected.total_landed_cost)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-sm font-semibold text-gray-600">Landed Cost Factor</dt>
                <dd className={`text-sm font-bold ${Number(selected.landed_cost_factor) > 1.5 ? 'text-red-600' : Number(selected.landed_cost_factor) > 1.3 ? 'text-yellow-600' : 'text-green-600'}`}>
                  {Number(selected.landed_cost_factor).toFixed(4)}×
                </dd>
              </div>
            </dl>
            {selected.notes && <p className="mt-4 text-sm text-gray-600 bg-gray-50 rounded-lg p-3">{selected.notes}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
