import { useEffect, useState } from 'react';
import api from '../utils/api';
import { formatZAR } from '../utils/format';

interface Material {
  id: string; sku: string; name: string; description?: string;
  unit: string; cost_price: number; sell_price: number;
  roll_width_m?: number; category?: string; is_active: boolean;
  stock_qty?: number; reorder_level?: number;
}

interface StockMovement {
  id: string; material_id: string; material_name?: string;
  movement_type: string; quantity: number; unit_cost: number;
  reference?: string; notes?: string; created_at: string;
}

interface NewMaterialForm {
  sku: string; name: string; description: string; unit: string;
  cost_price: string; sell_price: string; roll_width_m: string;
  category: string; stock_qty: string; reorder_level: string;
}

const EMPTY_MATERIAL: NewMaterialForm = {
  sku: '', name: '', description: '', unit: 'm2',
  cost_price: '', sell_price: '', roll_width_m: '',
  category: 'vinyl', stock_qty: '0', reorder_level: '10',
};

const CATEGORIES = ['vinyl','substrate','ink','laminate','hardware','media','frame','other'];
const UNITS = ['m2','lm','each','kg','litre','roll','sheet'];

export default function InventoryPage() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'stock' | 'movements' | 'new'>('stock');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [form, setForm] = useState<NewMaterialForm>(EMPTY_MATERIAL);
  const [saving, setSaving] = useState(false);
  const [showAdjust, setShowAdjust] = useState<Material | null>(null);
  const [adjQty, setAdjQty] = useState('');
  const [adjType, setAdjType] = useState<'in' | 'out'>('in');
  const [adjNote, setAdjNote] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [matRes, movRes] = await Promise.all([
        api.get('/inventory/materials', { params: { search: search || undefined, category: catFilter || undefined } }),
        api.get('/inventory/movements'),
      ]);
      setMaterials(matRes.data.materials || []);
      setMovements(movRes.data || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, [search, catFilter]);

  const f = (k: keyof NewMaterialForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }));

  const handleCreateMaterial = async () => {
    setSaving(true);
    try {
      await api.post('/inventory/materials', {
        ...form,
        cost_price: parseFloat(form.cost_price) || 0,
        sell_price: parseFloat(form.sell_price) || 0,
        roll_width_m: form.roll_width_m ? parseFloat(form.roll_width_m) : null,
        stock_qty: parseFloat(form.stock_qty) || 0,
        reorder_level: parseFloat(form.reorder_level) || 0,
      });
      setForm(EMPTY_MATERIAL); setTab('stock'); await fetchData();
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const handleAdjust = async () => {
    if (!showAdjust) return;
    setSaving(true);
    try {
      await api.post('/inventory/movements', {
        material_id: showAdjust.id,
        movement_type: adjType,
        quantity: parseFloat(adjQty),
        notes: adjNote,
      });
      setShowAdjust(null); setAdjQty(''); setAdjNote(''); await fetchData();
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const markup = (m: Material) => m.cost_price > 0
    ? (((m.sell_price - m.cost_price) / m.cost_price) * 100).toFixed(0)
    : '—';

  const lowStock = materials.filter(m => (m.stock_qty ?? 0) <= (m.reorder_level ?? 0) && m.is_active);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="text-sm text-gray-500 mt-0.5">Signacore National Supply Group — raw materials and stock</p>
        </div>
      </div>

      {/* Low stock alert */}
      {lowStock.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <p className="font-semibold text-red-800">{lowStock.length} item{lowStock.length !== 1 ? 's' : ''} below reorder level</p>
            <p className="text-sm text-red-600 mt-0.5">{lowStock.map(m => m.name).join(', ')}</p>
          </div>
        </div>
      )}

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total SKUs', value: String(materials.length), icon: '📦' },
          { label: 'Active Items', value: String(materials.filter(m => m.is_active).length), icon: '✅' },
          { label: 'Low Stock', value: String(lowStock.length), icon: '⚠️' },
          { label: 'Stock Value (cost)', value: formatZAR(materials.reduce((s, m) => s + (m.stock_qty ?? 0) * m.cost_price, 0), { compact: true }), icon: '💰' },
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
        {([['stock','📦 Stock List'],['movements','🔄 Movements'],['new','+ Add Item']] as [typeof tab, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${tab === key ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Stock list */}
      {tab === 'stock' && (
        <div className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search materials…" className="input max-w-xs" />
            <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="input w-40">
              <option value="">All categories</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
            </select>
          </div>
          {loading ? (
            <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" /></div>
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['SKU','Name','Category','Unit','Cost Price','Sell Price','Markup','Stock Qty','Reorder','Actions'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {materials.length === 0 ? (
                      <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">No materials found. Add your first item.</td></tr>
                    ) : materials.map(m => {
                      const stockLow = (m.stock_qty ?? 0) <= (m.reorder_level ?? 0);
                      return (
                        <tr key={m.id} className={`hover:bg-gray-50 ${!m.is_active ? 'opacity-50' : ''}`}>
                          <td className="px-4 py-3 font-mono text-xs text-gray-500">{m.sku || '—'}</td>
                          <td className="px-4 py-3">
                            <p className="font-medium text-gray-900">{m.name}</p>
                            {m.roll_width_m && <p className="text-xs text-gray-400">Roll: {m.roll_width_m}m wide</p>}
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded capitalize">{m.category}</span>
                          </td>
                          <td className="px-4 py-3 text-gray-600">{m.unit}</td>
                          <td className="px-4 py-3">{formatZAR(m.cost_price)}</td>
                          <td className="px-4 py-3 font-medium">{formatZAR(m.sell_price)}</td>
                          <td className="px-4 py-3 text-green-600 font-medium">{markup(m)}%</td>
                          <td className="px-4 py-3">
                            <span className={`font-bold ${stockLow ? 'text-red-600' : 'text-gray-900'}`}>
                              {m.stock_qty ?? 0} {m.unit}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-500">{m.reorder_level ?? 0} {m.unit}</td>
                          <td className="px-4 py-3">
                            <button onClick={() => setShowAdjust(m)}
                              className="text-xs text-brand-600 hover:text-brand-800 font-medium">
                              Adjust Stock
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Movements */}
      {tab === 'movements' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Date','Material','Type','Quantity','Unit Cost','Notes'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {movements.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">No stock movements yet</td></tr>
                ) : movements.map(mv => (
                  <tr key={mv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-500 text-xs">{new Date(mv.created_at).toLocaleDateString('en-ZA')}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{mv.material_name}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${mv.movement_type === 'in' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {mv.movement_type === 'in' ? '↑ Stock In' : '↓ Stock Out'}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium">{mv.quantity}</td>
                    <td className="px-4 py-3">{mv.unit_cost ? formatZAR(mv.unit_cost) : '—'}</td>
                    <td className="px-4 py-3 text-gray-500">{mv.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add new material form */}
      {tab === 'new' && (
        <div className="card p-6 max-w-2xl">
          <h2 className="font-semibold text-gray-900 mb-5">Add New Material / SKU</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">SKU Code</label>
              <input value={form.sku} onChange={f('sku')} className="input" placeholder="VNL-3M-1080-BLK" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
              <input value={form.name} onChange={f('name')} className="input" placeholder="3M 1080 Cast Vinyl Black" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <select value={form.category} onChange={f('category')} className="input">
                {CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
              <select value={form.unit} onChange={f('unit')} className="input">
                {UNITS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cost Price (R)</label>
              <input type="number" value={form.cost_price} onChange={f('cost_price')} className="input" placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sell Price (R)</label>
              <input type="number" value={form.sell_price} onChange={f('sell_price')} className="input" placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Roll Width (m) — vinyl only</label>
              <input type="number" step="0.01" value={form.roll_width_m} onChange={f('roll_width_m')} className="input" placeholder="1.37" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Opening Stock Qty</label>
              <input type="number" value={form.stock_qty} onChange={f('stock_qty')} className="input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reorder Level</label>
              <input type="number" value={form.reorder_level} onChange={f('reorder_level')} className="input" />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea value={form.description} onChange={f('description')} rows={2} className="input" />
            </div>
          </div>
          <div className="flex gap-3 justify-end mt-5">
            <button onClick={() => setTab('stock')} className="btn-secondary">Cancel</button>
            <button onClick={handleCreateMaterial} disabled={saving || !form.name} className="btn-primary">
              {saving ? 'Saving…' : 'Add Material'}
            </button>
          </div>
        </div>
      )}

      {/* Stock Adjustment Modal */}
      {showAdjust && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold mb-1">Adjust Stock</h2>
            <p className="text-sm text-gray-500 mb-4">{showAdjust.name} — current: {showAdjust.stock_qty ?? 0} {showAdjust.unit}</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Movement Type</label>
                <div className="flex gap-3">
                  {[['in','↑ Stock In','bg-green-50 border-green-400'],['out','↓ Stock Out','bg-red-50 border-red-400']].map(([val, label, cls]) => (
                    <label key={val} className={`flex-1 flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer ${adjType === val ? cls : 'border-gray-200'}`}>
                      <input type="radio" value={val} checked={adjType === val} onChange={() => setAdjType(val as 'in' | 'out')} />
                      <span className="text-sm font-medium">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantity ({showAdjust.unit})</label>
                <input type="number" value={adjQty} onChange={e => setAdjQty(e.target.value)} className="input" placeholder="0" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input value={adjNote} onChange={e => setAdjNote(e.target.value)} className="input" placeholder="Reason for adjustment…" />
              </div>
            </div>
            <div className="flex gap-3 justify-end mt-5">
              <button onClick={() => setShowAdjust(null)} className="btn-secondary">Cancel</button>
              <button onClick={handleAdjust} disabled={saving || !adjQty} className="btn-primary">
                {saving ? 'Saving…' : 'Apply Adjustment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
