# Signacore Group Platform

Full-stack multi-entity business management and project profitability platform for the Signacore corporate group.

## Group Companies

| Entity | Role | Description |
|--------|------|-------------|
| **Uniontech Holdings SA** | Holding / Import-Export | Imports raw materials, calculates landed costs |
| **Signacore National Supply Group** | Supplier / Warehouse | Wholesales raw materials to group and external clients |
| **Signarama Garden Route** | Franchise / Operations | Executes all sign projects (main operational entity) |
| **Cover X Transform** | Labour Subcontractor | Installation and vinyl application labour |

---

## Architecture

```
Signacore Platform/
├── database/
│   ├── schema.sql          # Core schema — run first
│   └── schema_addons.sql   # Inventory, stock movements, import shipments — run second
├── backend/                # Node.js + Express + TypeScript API
│   ├── src/
│   │   ├── index.ts        # Express app entry point (port 3001)
│   │   ├── db/pool.ts      # PostgreSQL connection pool
│   │   ├── middleware/
│   │   │   ├── auth.ts     # JWT authentication
│   │   │   └── errorHandler.ts
│   │   └── routes/
│   │       ├── auth.ts         # POST /login, /register
│   │       ├── companies.ts    # GET /companies, /group/consolidated
│   │       ├── clients.ts      # Client CRUD
│   │       ├── jobs.ts         # Job lifecycle, cost entries, profit
│   │       ├── calculators.ts  # Vinyl + vehicle wrap calculators
│   │       ├── intercompany.ts # Intercompany transactions
│   │       ├── dashboard.ts    # KPIs, pipeline, overdue
│   │       ├── inventory.ts    # Materials, stock movements
│   │       └── imports.ts      # Import shipments, landed cost
└── frontend/               # React 18 + TypeScript + Tailwind CSS + Vite
    └── src/
        ├── App.tsx          # Router
        ├── main.tsx         # Entry point
        ├── context/         # AuthContext
        ├── types/index.ts   # All TypeScript interfaces
        ├── utils/
        │   ├── api.ts       # Axios instance (JWT auto-attach)
        │   ├── format.ts    # ZAR, %, dates, m²
        │   └── constants.ts # Job statuses, cost categories, company colours
        ├── components/
        │   ├── Layout.tsx         # Sidebar + header shell
        │   ├── StatusBadge.tsx    # Job/payment status chips
        │   ├── KPICard.tsx        # Dashboard metric card
        │   ├── ProfitBar.tsx      # Stacked cost/profit bar
        │   └── LifecycleTracker.tsx # 10-stage pipeline progress
        └── pages/
            ├── LoginPage.tsx
            ├── DashboardPage.tsx      # Group consolidated dashboard
            ├── JobsPage.tsx           # Job list + create
            ├── JobDetailPage.tsx      # Full job detail, costs, history
            ├── ClientsPage.tsx        # Client directory
            ├── ClientDetailPage.tsx   # Client + job history
            ├── CalculatorsPage.tsx    # Vinyl + vehicle wrap
            ├── IntercompanyPage.tsx   # Cross-entity transactions
            ├── InventoryPage.tsx      # Signacore stock management
            ├── ImportCostingPage.tsx  # Uniontech landed cost
            └── ReportsPage.tsx        # P&L, profitability ranking, trend
```

---

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- npm or yarn

### 1. Database

```bash
# Create database
psql -U postgres -c "CREATE DATABASE signacore;"

# Run schemas in order
psql -U postgres -d signacore -f database/schema.sql
psql -U postgres -d signacore -f database/schema_addons.sql
```

### 2. Backend

```bash
cd backend
npm install

# Copy environment file and edit
cp .env.example .env
# Edit .env:
#   DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/signacore
#   JWT_SECRET=your-long-random-secret-key
#   PORT=3001

# Create first admin user (run once)
npm run dev
# Then POST /api/auth/register with:
# { "email": "admin@signacore.co.za", "password": "...", "first_name": "Admin",
#   "last_name": "User", "role": "admin", "company_id": "<signarama-gr-uuid>" }

# Development (with auto-reload)
npm run dev

# Production build
npm run build && npm start
```

### 3. Frontend

```bash
cd frontend
npm install

# Development (proxies /api to localhost:3001)
npm run dev
# → http://localhost:3000

# Production build
npm run build
```

---

## Core Modules

### Job Lifecycle — 10 Stages
`Lead → Brief → Design → Quote Sent → Quote Approved → Deposit Received → In Production → Installation → Completed → Invoiced → Paid`

Each stage transition is recorded in `job_stage_history` with timestamp, user, and notes.

### Project Profitability — 8 Cost Categories

| # | Category | Source |
|---|----------|--------|
| 1 | Materials | Signacore National Supply Group |
| 2 | Labour | Cover X Transform |
| 3 | Machine Time | In-house equipment |
| 4 | Design | Internal design team |
| 5 | Delivery | Logistics/courier |
| 6 | Franchise Royalty | 6% of revenue (auto-calculated on invoice) |
| 7 | Subcontract | External subcontractors |
| 8 | Other | Miscellaneous costs |

### Vinyl Calculator
- Input: width × height (mm), quantity, surface type, roll width (default 1.37m)
- Waste factors: Flat 10%, Curved 20%, Contour 25%
- Outputs: net area, area with waste, roll length used, panels per row, material cost, sell price, margin

### Vehicle Wrap Calculator
- Input: per-panel dimensions (mm), wrap scope (full/partial/custom), pricing
- Standard panels: hood, roof, trunk, front/rear doors, fenders, bumpers, mirrors
- 15% wrap waste applied automatically
- Labour hours estimated from wrap scope

### Import Costing (Uniontech)
- **Landed Cost = Invoice ZAR + Freight + Insurance + Customs Duty + VAT on Import + Agent Fees + Clearing Fees + Inland Transport**
- **Landed Cost Factor (LCF)** = Total Landed ÷ Invoice ZAR — apply to all unit costs
- Supports multi-currency with configurable exchange rates
- Shipment items auto-update material cost prices on receipt

### Intercompany Transactions
- Tracks all cross-entity charges, invoices, transfers, and payments
- Group consolidation view with elimination-ready summaries
- Per-pair outstanding balance tracking

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Authenticate, returns JWT |
| GET | `/api/dashboard/overview` | Group KPIs + monthly trend |
| GET | `/api/dashboard/pipeline` | Active jobs pipeline |
| GET/POST | `/api/jobs` | List / create jobs |
| GET | `/api/jobs/:id` | Full job detail with costs |
| PATCH | `/api/jobs/:id/status` | Advance lifecycle stage |
| POST | `/api/jobs/:id/costs` | Add cost entry |
| GET/POST | `/api/clients` | List / create clients |
| GET | `/api/companies` | All four group entities |
| GET | `/api/companies/group/consolidated` | Group P&L summary |
| POST | `/api/calculators/vinyl/calculate` | Vinyl area calculation |
| POST | `/api/calculators/vehicle/calculate` | Vehicle wrap calculation |
| GET/POST | `/api/intercompany` | Transactions list / create |
| GET | `/api/intercompany/summary` | Entity-pair summary |
| GET/POST | `/api/inventory/materials` | Material catalogue |
| POST | `/api/inventory/movements` | Stock in/out/adjustment |
| GET/POST | `/api/imports/shipments` | Import shipments |
| POST | `/api/imports/calculate` | Quick landed cost calc |

---

## All Amounts in ZAR (South African Rand)

- VAT rate: 15%
- Franchise royalty: 6% (auto-calculated on invoicing)
- Currency display: `R 1 234.56` format
