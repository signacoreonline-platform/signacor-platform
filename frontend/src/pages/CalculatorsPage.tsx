import { useState } from 'react';
import api from '../utils/api';
import { formatZAR, formatM2, formatLM, formatPercent } from '../utils/format';
import { VinylCalculationResult, VehicleCalculationResult, SurfaceType, WrapType } from '../types';
import { SURFACE_WASTE, DEFAULT_ROLL_WIDTH } from '../utils/constants';

type Tab = 'vinyl' | 'vehicle';

// ─── VINYL CALCULATOR ────────────────────────────────────────────────────────

const SURFACE_LABELS: Record<SurfaceType, string> = {
  flat: 'Flat surface (10% waste)',
  curved: 'Curved surface (20% waste)',
  contour: 'Contour / complex (25% waste)',
};

function VinylCalculator() {
  const [form, setForm] = useState({
    width_mm: '', height_mm: '', quantity: '1',
    surface_type: 'flat' as SurfaceType,
    roll_width_m: String(DEFAULT_ROLL_WIDTH),
    vinyl_cost_per_m2: '', laminate_cost_per_m2: '', sell_price_per_m2: '',
  });
  const [result, setResult] = useState<VinylCalculationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState('');
  const [saved, setSaved] = useState(false);

  const f = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }));

  const calculate = async () => {
    setLoading(true); setSaved(false);
    try {
      const res = await api.post('/calculators/vinyl/calculate', {
        width_mm: parseFloat(form.width_mm),
        height_mm: parseFloat(form.height_mm),
        quantity: parseInt(form.quantity),
        surface_type: form.surface_type,
        roll_width_m: parseFloat(form.roll_width_m),
        vinyl_cost_per_m2: parseFloat(form.vinyl_cost_per_m2) || 0,
        laminate_cost_per_m2: parseFloat(form.laminate_cost_per_m2) || 0,
        sell_price_per_m2: parseFloat(form.sell_price_per_m2) || 0,
      });
      setResult(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const save = async () => {
    if (!result) return;
    try {
      await api.post('/calculators/vinyl/save', {
        ...form, ...result,
        job_id: jobId || undefined,
        total_area_m2: result.total_area_m2,
      });
      setSaved(true);
    } catch (e) { console.error(e); }
  };

  const waste = SURFACE_WASTE[form.surface_type] || 1.10;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Inputs */}
      <div className="card p-6 space-y-5">
        <h2 className="font-semibold text-gray-900">Panel Dimensions & Material</h2>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Surface Type</label>
          <div className="space-y-2">
            {(Object.entries(SURFACE_LABELS) as [SurfaceType, string][]).map(([val, label]) => (
              <label key={val} className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${form.surface_type === val ? 'border-brand-500 bg-brand-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <input type="radio" name="surface" value={val} checked={form.surface_type === val}
                  onChange={() => setForm(p => ({ ...p, surface_type: val }))} className="text-brand-500" />
                <span className="text-sm text-gray-700">{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Width (mm)</label>
            <input type="number" value={form.width_mm} onChange={f('width_mm')} className="input" placeholder="1000" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Height (mm)</label>
            <input type="number" value={form.height_mm} onChange={f('height_mm')} className="input" placeholder="500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Qty</label>
            <input type="number" min="1" value={form.quantity} onChange={f('quantity')} className="input" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Roll Width (m) — Standard: 1.37m</label>
          <input type="number" step="0.01" value={form.roll_width_m} onChange={f('roll_width_m')} className="input" />
        </div>

        <div className="border-t border-gray-100 pt-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Pricing (per m² inc. waste)</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Vinyl cost (R/m²)</label>
              <input type="number" value={form.vinyl_cost_per_m2} onChange={f('vinyl_cost_per_m2')} className="input" placeholder="0.00" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Laminate (R/m²)</label>
              <input type="number" value={form.laminate_cost_per_m2} onChange={f('laminate_cost_per_m2')} className="input" placeholder="0.00" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Sell price (R/m²)</label>
              <input type="number" value={form.sell_price_per_m2} onChange={f('sell_price_per_m2')} className="input" placeholder="0.00" />
            </div>
          </div>
        </div>

        <button onClick={calculate} disabled={loading || !form.width_mm || !form.height_mm} className="btn-primary w-full py-3">
          {loading ? 'Calculating…' : 'Calculate'}
        </button>
      </div>

      {/* Results */}
      <div className="space-y-4">
        {result ? (
          <>
            {/* Area breakdown */}
            <div className="card p-6 space-y-4">
              <h2 className="font-semibold text-gray-900">Calculation Results</h2>

              <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-brand-600 font-medium">Net Area (raw)</p>
                  <p className="text-xl font-bold text-brand-900">{formatM2(result.total_area_m2)}</p>
                  <p className="text-xs text-brand-500">{form.quantity} × {formatM2(result.area_per_unit)}</p>
                </div>
                <div>
                  <p className="text-xs text-brand-600 font-medium">Area with {((waste - 1) * 100).toFixed(0)}% waste</p>
                  <p className="text-xl font-bold text-brand-900">{formatM2(result.area_with_waste)}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500">Roll length used</p>
                  <p className="text-lg font-bold text-gray-900">{formatLM(result.roll_length_used)}</p>
                  <p className="text-xs text-gray-400">from {form.roll_width_m}m roll</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500">Panels per row</p>
                  <p className="text-lg font-bold text-gray-900">{result.panels_per_row}</p>
                  <p className="text-xs text-gray-400">{result.rows_needed} row{result.rows_needed !== 1 ? 's' : ''} needed</p>
                </div>
              </div>

              {/* Cost breakdown */}
              <div className="border-t border-gray-100 pt-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Vinyl cost</span>
                  <span className="font-medium">{formatZAR(result.vinyl_cost)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Laminate cost</span>
                  <span className="font-medium">{formatZAR(result.laminate_cost)}</span>
                </div>
                <div className="flex justify-between text-sm font-semibold border-t border-gray-200 pt-2">
                  <span>Total Material Cost</span>
                  <span>{formatZAR(result.total_material_cost)}</span>
                </div>
              </div>

              {/* Revenue / margin */}
              {result.total_sell_price > 0 && (
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-green-600 font-medium">Sell Price</p>
                    <p className="text-xl font-bold text-green-900">{formatZAR(result.total_sell_price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-green-600 font-medium">Gross Margin</p>
                    <p className={`text-xl font-bold ${result.margin_percent >= 30 ? 'text-green-700' : result.margin_percent >= 15 ? 'text-yellow-700' : 'text-red-700'}`}>
                      {formatPercent(result.margin_percent)}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Save */}
            <div className="card p-4 flex gap-3 items-center">
              <input value={jobId} onChange={e => setJobId(e.target.value)}
                className="input flex-1" placeholder="Optional: Job ID to link this calculation" />
              <button onClick={save} className={saved ? 'btn-secondary' : 'btn-primary'}>
                {saved ? '✓ Saved' : 'Save to Job'}
              </button>
            </div>
          </>
        ) : (
          <div className="card p-12 text-center text-gray-400">
            <p className="text-4xl mb-3">🎨</p>
            <p className="text-sm">Enter dimensions and click Calculate to see results</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── VEHICLE WRAP CALCULATOR ──────────────────────────────────────────────────

type PanelKey = 'hood' | 'roof' | 'trunk' | 'door_front' | 'door_rear' |
  'fender_front' | 'fender_rear' | 'bumper_front' | 'bumper_rear' | 'mirrors';

const PANEL_DEFAULTS: Record<PanelKey, { label: string; w: number; h: number; qty: number }> = {
  hood:         { label: 'Hood / Bonnet',      w: 1500, h: 1200, qty: 1 },
  roof:         { label: 'Roof',               w: 1600, h: 1400, qty: 1 },
  trunk:        { label: 'Boot / Trunk',       w: 1500, h: 900,  qty: 1 },
  door_front:   { label: 'Front Doors',        w: 900,  h: 1100, qty: 2 },
  door_rear:    { label: 'Rear Doors',         w: 800,  h: 1100, qty: 2 },
  fender_front: { label: 'Front Fenders',      w: 700,  h: 500,  qty: 2 },
  fender_rear:  { label: 'Rear Fenders',       w: 800,  h: 500,  qty: 2 },
  bumper_front: { label: 'Front Bumper',       w: 1800, h: 450,  qty: 1 },
  bumper_rear:  { label: 'Rear Bumper',        w: 1800, h: 450,  qty: 1 },
  mirrors:      { label: 'Side Mirrors',       w: 250,  h: 200,  qty: 2 },
};

const WRAP_SCOPES: { value: WrapType; label: string; desc: string }[] = [
  { value: 'full',     label: 'Full Wrap',    desc: 'All panels — complete colour change' },
  { value: 'partial',  label: 'Partial Wrap', desc: 'Specify which panels to include' },
  { value: 'custom',   label: 'Custom',       desc: 'Manually specify areas only' },
];

function VehicleCalculator() {
  const [wrapType, setWrapType] = useState<WrapType>('full');
  const [vehicleMake, setVehicleMake] = useState('');
  const [vehicleModel, setVehicleModel] = useState('');
  const [panels, setPanels] = useState<Record<string, { w_mm: number; h_mm: number; included: boolean }>>(
    Object.fromEntries(
      Object.entries(PANEL_DEFAULTS).map(([k, v]) => [k, { w_mm: v.w, h_mm: v.h, included: true }])
    )
  );
  const [pricing, setPricing] = useState({ vinyl_cost_per_m2: '', laminate_cost_per_m2: '', labour_rate_per_hour: '', sell_price: '' });
  const [result, setResult] = useState<VehicleCalculationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  const pf = (k: keyof typeof pricing) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setPricing(p => ({ ...p, [k]: e.target.value }));

  const updatePanel = (key: string, field: 'w_mm' | 'h_mm' | 'included', value: number | boolean) =>
    setPanels(p => ({ ...p, [key]: { ...p[key], [field]: value } }));

  const calculate = async () => {
    setLoading(true); setSaved(false);
    try {
      const activePanels: Record<string, { w_mm: number; h_mm: number }> = {};
      if (wrapType === 'full') {
        // Send all panels for full wrap — backend uses standard dims
        Object.entries(panels).forEach(([k, v]) => {
          activePanels[k] = { w_mm: v.w_mm, h_mm: v.h_mm };
        });
      } else {
        // Only send included panels for partial
        Object.entries(panels).filter(([, v]) => v.included).forEach(([k, v]) => {
          activePanels[k] = { w_mm: v.w_mm, h_mm: v.h_mm };
        });
      }
      const res = await api.post('/calculators/vehicle/calculate', {
        panels: activePanels,
        wrap_type: wrapType,
        vinyl_cost_per_m2: parseFloat(pricing.vinyl_cost_per_m2) || 0,
        laminate_cost_per_m2: parseFloat(pricing.laminate_cost_per_m2) || 0,
        labour_rate_per_hour: parseFloat(pricing.labour_rate_per_hour) || 0,
        roll_width_m: DEFAULT_ROLL_WIDTH,
        sell_price: parseFloat(pricing.sell_price) || 0,
      });
      setResult(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const totalNetArea = Object.entries(panels)
    .filter(([, v]) => wrapType === 'full' ? true : v.included)
    .reduce((sum, [k, v]) => {
      const qty = PANEL_DEFAULTS[k as PanelKey]?.qty || 1;
      return sum + (v.w_mm * v.h_mm * qty) / 1e6;
    }, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Inputs */}
      <div className="card p-6 space-y-5">
        <h2 className="font-semibold text-gray-900">Vehicle & Wrap Configuration</h2>

        {/* Vehicle info */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Make</label>
            <input value={vehicleMake} onChange={e => setVehicleMake(e.target.value)} className="input" placeholder="Toyota" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
            <input value={vehicleModel} onChange={e => setVehicleModel(e.target.value)} className="input" placeholder="Hilux" />
          </div>
        </div>

        {/* Scope */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Wrap Scope</label>
          <div className="space-y-2">
            {WRAP_SCOPES.map(s => (
              <label key={s.value} className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${wrapType === s.value ? 'border-brand-500 bg-brand-50' : 'border-gray-200 hover:border-gray-300'}`}>
                <input type="radio" name="scope" value={s.value} checked={wrapType === s.value}
                  onChange={() => setWrapType(s.value)} className="mt-0.5 text-brand-500" />
                <div>
                  <p className="text-sm font-medium text-gray-800">{s.label}</p>
                  <p className="text-xs text-gray-500">{s.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Panel dimensions */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-700">Panel Dimensions (mm)</label>
            <span className="text-xs text-gray-400">Net area: {totalNetArea.toFixed(3)} m²</span>
          </div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {(Object.entries(PANEL_DEFAULTS) as [PanelKey, (typeof PANEL_DEFAULTS)[PanelKey]][]).map(([key, def]) => (
              <div key={key} className="flex items-center gap-2 text-sm">
                {wrapType !== 'full' && (
                  <input type="checkbox" checked={panels[key]?.included ?? true}
                    onChange={e => updatePanel(key, 'included', e.target.checked)}
                    className="rounded text-brand-500 flex-shrink-0" />
                )}
                <span className="w-28 text-xs text-gray-600 flex-shrink-0">{def.label} {def.qty > 1 ? `×${def.qty}` : ''}</span>
                <input type="number" value={panels[key]?.w_mm ?? def.w}
                  onChange={e => updatePanel(key, 'w_mm', parseInt(e.target.value))}
                  className="input !py-1 w-20 text-xs" placeholder="W" />
                <span className="text-gray-400 text-xs">×</span>
                <input type="number" value={panels[key]?.h_mm ?? def.h}
                  onChange={e => updatePanel(key, 'h_mm', parseInt(e.target.value))}
                  className="input !py-1 w-20 text-xs" placeholder="H" />
              </div>
            ))}
          </div>
        </div>

        {/* Pricing */}
        <div className="border-t border-gray-100 pt-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Pricing</h3>
          <div className="grid grid-cols-2 gap-3">
            {[
              { key: 'vinyl_cost_per_m2',     label: 'Vinyl (R/m²)' },
              { key: 'laminate_cost_per_m2',  label: 'Laminate (R/m²)' },
              { key: 'labour_rate_per_hour',  label: 'Labour (R/hr)' },
              { key: 'sell_price',            label: 'Sell Price (R)' },
            ].map(({ key, label }) => (
              <div key={key}>
                <label className="block text-xs text-gray-500 mb-1">{label}</label>
                <input type="number" value={pricing[key as keyof typeof pricing]}
                  onChange={pf(key as keyof typeof pricing)} className="input" placeholder="0.00" />
              </div>
            ))}
          </div>
        </div>

        <button onClick={calculate} disabled={loading} className="btn-primary w-full py-3">
          {loading ? 'Calculating…' : 'Calculate Wrap'}
        </button>
      </div>

      {/* Results */}
      <div className="space-y-4">
        {result ? (
          <>
            <div className="card p-6 space-y-4">
              <h2 className="font-semibold text-gray-900">
                Wrap Results {vehicleMake && `— ${vehicleMake} ${vehicleModel}`}
              </h2>

              {/* Area summary */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
                  <p className="text-xs text-purple-600 font-medium">Net vehicle area</p>
                  <p className="text-2xl font-bold text-purple-900">{formatM2(result.total_area_m2)}</p>
                </div>
                <div className="bg-brand-50 border border-brand-200 rounded-xl p-4">
                  <p className="text-xs text-brand-600 font-medium">Vinyl needed (15% waste)</p>
                  <p className="text-2xl font-bold text-brand-900">{formatM2(result.vinyl_area_m2)}</p>
                  <p className="text-xs text-brand-500">{formatLM(result.roll_length_m)} @ {DEFAULT_ROLL_WIDTH}m roll</p>
                </div>
              </div>

              {/* Panel breakdown */}
              <div className="bg-gray-50 rounded-lg p-3 max-h-40 overflow-y-auto">
                <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Panel Breakdown</p>
                <div className="space-y-1">
                  {Object.entries(result.panel_breakdown).map(([k, m2]) => (
                    <div key={k} className="flex justify-between text-xs">
                      <span className="text-gray-600 capitalize">{k.replace(/_/g, ' ')}</span>
                      <span className="font-medium text-gray-900">{m2.toFixed(3)} m²</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Cost breakdown */}
              <div className="space-y-2 border-t border-gray-100 pt-3">
                {[
                  { label: 'Vinyl material', value: result.vinyl_cost },
                  { label: 'Laminate', value: result.laminate_cost },
                  { label: `Labour (${result.labour_hours.toFixed(1)} hrs)`, value: result.labour_cost },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between text-sm">
                    <span className="text-gray-600">{label}</span>
                    <span className="font-medium">{formatZAR(value)}</span>
                  </div>
                ))}
                <div className="flex justify-between text-sm font-bold border-t border-gray-200 pt-2">
                  <span>Total Cost</span>
                  <span>{formatZAR(result.total_cost)}</span>
                </div>
              </div>

              {/* Margin */}
              {parseFloat(pricing.sell_price) > 0 && (
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-green-600 font-medium">Sell Price</p>
                    <p className="text-xl font-bold text-green-900">{formatZAR(parseFloat(pricing.sell_price))}</p>
                  </div>
                  <div>
                    <p className="text-xs text-green-600 font-medium">Margin</p>
                    <p className={`text-xl font-bold ${result.margin_percent >= 30 ? 'text-green-700' : result.margin_percent >= 15 ? 'text-yellow-700' : 'text-red-700'}`}>
                      {formatPercent(result.margin_percent)}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="card p-4 flex gap-3 items-center">
              <input className="input flex-1" placeholder="Optional: Job ID to link calculation" />
              <button onClick={() => setSaved(true)} className={saved ? 'btn-secondary' : 'btn-primary'}>
                {saved ? '✓ Saved' : 'Save to Job'}
              </button>
            </div>
          </>
        ) : (
          <div className="card p-12 text-center text-gray-400">
            <p className="text-4xl mb-3">🚗</p>
            <p className="text-sm">Configure vehicle panels and click Calculate</p>
            <p className="text-xs mt-1 text-gray-300">15% waste factor applied automatically</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function CalculatorsPage() {
  const [tab, setTab] = useState<Tab>('vinyl');

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Calculators</h1>
        <p className="text-sm text-gray-500 mt-0.5">Architectural vinyl and vehicle wrap material estimators</p>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        {([['vinyl', '🎨 Vinyl Calculator'], ['vehicle', '🚗 Vehicle Wrap']] as [Tab, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition-all ${tab === key ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'vinyl' ? <VinylCalculator /> : <VehicleCalculator />}
    </div>
  );
}
