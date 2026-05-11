import React, { useEffect, useMemo, useState } from "react";

const LOCAL_SETTINGS = "dk_live_settings_v1";
const LOCAL_ROWS = "dk_live_rows_v1";
const LOCAL_CHECKINS = "dk_live_checkins_v1";

const ENV_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const ENV_SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const ENV_BOARD_ID = import.meta.env.VITE_BOARD_ID || "daytona-kia-main";

const defaultSettings = {
  boardId: ENV_BOARD_ID,
  date: todayIso(),
  temp: "80°F",
  condition: "Cloudy",
  location: "Daytona Beach, FL",
  vehicleSpotlight: "2027 Kia Telluride",
  vehicleImage: "",
  logoImage: "",
  supabaseUrl: ENV_SUPABASE_URL,
  supabaseAnonKey: ENV_SUPABASE_ANON_KEY,
};

const sqlSetup = `create table if not exists public.dk_board_settings (
  board_id text primary key,
  display_date date not null,
  temp text,
  condition text,
  location text,
  vehicle_spotlight text,
  vehicle_image text,
  logo_image text,
  updated_at timestamptz default now()
);

create table if not exists public.dk_appointments (
  id text primary key,
  board_id text not null,
  appt_date date,
  appt_ms bigint,
  appt_raw text,
  time_display text,
  client_name text,
  sales_consultant text,
  vehicle text,
  source_type text,
  checked_in boolean default false,
  checked_in_at text,
  sort_order int,
  uploaded_at timestamptz default now()
);

alter table public.dk_board_settings enable row level security;
alter table public.dk_appointments enable row level security;

drop policy if exists dk_settings_all on public.dk_board_settings;
drop policy if exists dk_appointments_all on public.dk_appointments;

create policy dk_settings_all on public.dk_board_settings for all using (true) with check (true);
create policy dk_appointments_all on public.dk_appointments for all using (true) with check (true);`;

const demoRows = [
  { id: "demo-1", client_name: "Franklin, Jovon", sales_consultant: "Bowersock, Josh", appt_raw: "05/11/2026 9:00 AM", time_display: "9:00:00 AM", vehicle: "2022 Kia K5 (Used)", appt_ms: new Date(2026, 4, 11, 9, 0).getTime(), checked_in: false, checked_in_at: "" },
  { id: "demo-2", client_name: "Snider, Sharon L", sales_consultant: "Queen, Isaiah", appt_raw: "05/11/2026 10:00 AM", time_display: "10:00:00 AM", vehicle: "", appt_ms: new Date(2026, 4, 11, 10, 0).getTime(), checked_in: false, checked_in_at: "" },
  { id: "demo-3", client_name: "Horne, Dante", sales_consultant: "Bowersock, Josh", appt_raw: "05/11/2026 11:00 AM", time_display: "11:00:00 AM", vehicle: "", appt_ms: new Date(2026, 4, 11, 11, 0).getTime(), checked_in: false, checked_in_at: "" },
];

export default function App() {
  const [page, setPage] = useState("display");
  const [settings, setSettings] = useState(function () {
    const saved = readJson(LOCAL_SETTINGS, defaultSettings);
    return Object.assign({}, saved, {
      boardId: saved.boardId || ENV_BOARD_ID,
      vehicleImage: saved.vehicleImage || "",
      logoImage: saved.logoImage || "",
      supabaseUrl: saved.supabaseUrl || ENV_SUPABASE_URL,
      supabaseAnonKey: saved.supabaseAnonKey || ENV_SUPABASE_ANON_KEY,
    });
  });
  const [rows, setRows] = useState(function () { return readJson(LOCAL_ROWS, demoRows); });
  const [csvText, setCsvText] = useState("");
  const [status, setStatus] = useState("Demo mode: add Supabase URL and anon key on the Admin page to sync across computers.");
  const [busy, setBusy] = useState(false);
  const [autoWeather, setAutoWeather] = useState(false);

  const connected = Boolean(settings.supabaseUrl && settings.supabaseAnonKey);
  const boardDate = useMemo(function () { return new Date(settings.date + "T00:00:00"); }, [settings.date]);
  const checkedCount = rows.filter(function (r) { return r.checked_in; }).length;
  const soldCount = rows.filter(function (r) { return r.status === "sold"; }).length;

  useEffect(function () { localStorage.setItem(LOCAL_SETTINGS, JSON.stringify(settings)); }, [settings]);
  useEffect(function () { localStorage.setItem(LOCAL_ROWS, JSON.stringify(rows)); }, [rows]);

  useEffect(function () {
    if (!connected) return;
    loadCloud();
    const timer = setInterval(function () { loadCloud(true); }, 4000);
    return function () { clearInterval(timer); };
  }, [connected, settings.boardId]);

  useEffect(function () {
    const timer = setInterval(function () {
      const newDate = todayIso();
      setSettings(function (old) { return old.date === newDate ? old : Object.assign({}, old, { date: newDate }); });
    }, 60000);
    return function () { clearInterval(timer); };
  }, []);

  useEffect(function () {
    refreshWeather(false);
    const timer = setInterval(function () { refreshWeather(true); }, 900000);
    return function () { clearInterval(timer); };
  }, []);

  async function refreshWeather(silent) {
    try {
      const geoUrl = "https://geocoding-api.open-meteo.com/v1/search?name=Daytona%20Beach&count=1&language=en&format=json";
      const geoRes = await fetch(geoUrl);
      const geo = await geoRes.json();
      const place = geo && geo.results && geo.results[0];
      if (!place) return;
      const weatherUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + place.latitude + "&longitude=" + place.longitude + "&current=temperature_2m,weather_code&temperature_unit=fahrenheit";
      const weatherRes = await fetch(weatherUrl);
      const weather = await weatherRes.json();
      const current = weather.current || {};
      const next = Object.assign({}, settings, {
        date: todayIso(),
        temp: Math.round(Number(current.temperature_2m)) + "°F",
        condition: weatherCodeLabel(current.weather_code),
        location: "Daytona Beach, FL",
      });
      setSettings(next);
      localStorage.setItem(LOCAL_SETTINGS, JSON.stringify(next));
      if (connected) await saveSettingsCloud(next);
      if (!silent) setStatus("Date and weather updated automatically.");
    } catch (err) {
      if (!silent) setStatus("Weather update failed. You can still enter weather manually.");
    }
  }

  async function api(table, params) {
    const url = trimSlash(settings.supabaseUrl) + "/rest/v1/" + table + (params && params.query ? "?" + params.query : "");
    const res = await fetch(url, {
      method: params && params.method ? params.method : "GET",
      headers: Object.assign({
        apikey: settings.supabaseAnonKey,
        Authorization: "Bearer " + settings.supabaseAnonKey,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      }, params && params.headers ? params.headers : {}),
      body: params && params.body ? JSON.stringify(params.body) : undefined,
    });
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function loadCloud(silent) {
    if (!connected) return;
    try {
      if (!silent) setBusy(true);
      const settingRows = await api("dk_board_settings", { query: "board_id=eq." + encodeURIComponent(settings.boardId) + "&limit=1" });
      if (settingRows && settingRows[0]) {
        const s = settingRows[0];
        setSettings(function (old) { return Object.assign({}, old, { date: s.display_date || old.date, temp: s.temp || old.temp, condition: s.condition || old.condition, location: s.location || old.location, vehicleSpotlight: s.vehicle_spotlight || old.vehicleSpotlight, vehicleImage: s.vehicle_image || old.vehicleImage || "", logoImage: s.logo_image || old.logoImage || "" }); });
      }
      const appts = await api("dk_appointments", { query: "board_id=eq." + encodeURIComponent(settings.boardId) + "&order=sort_order.asc" });
      setRows((appts || []).map(fromDbRow));
      if (!silent) setStatus("Connected. Loaded live board from Supabase.");
    } catch (err) {
      setStatus("Supabase load error: " + String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettingsCloud(nextSettings) {
    setSettings(nextSettings);
    if (!nextSettings.supabaseUrl || !nextSettings.supabaseAnonKey) return;
    try {
      setBusy(true);
      await apiWith(nextSettings, "dk_board_settings", {
        method: "POST",
        query: "on_conflict=board_id",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: [{ board_id: nextSettings.boardId, display_date: nextSettings.date, temp: nextSettings.temp, condition: nextSettings.condition, location: nextSettings.location, vehicle_spotlight: nextSettings.vehicleSpotlight, vehicle_image: nextSettings.vehicleImage || "", logo_image: nextSettings.logoImage || "" }],
      });
      setStatus("Settings saved online.");
    } catch (err) {
      setStatus("Settings save error: " + String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function apiWith(s, table, params) {
    const url = trimSlash(s.supabaseUrl) + "/rest/v1/" + table + (params && params.query ? "?" + params.query : "");
    const res = await fetch(url, {
      method: params && params.method ? params.method : "GET",
      headers: Object.assign({ apikey: s.supabaseAnonKey, Authorization: "Bearer " + s.supabaseAnonKey, "Content-Type": "application/json", Prefer: "return=representation" }, params && params.headers ? params.headers : {}),
      body: params && params.body ? JSON.stringify(params.body) : undefined,
    });
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function uploadRows(newRows) {
    setRows(newRows);
    localStorage.setItem(LOCAL_ROWS, JSON.stringify(newRows));
    if (!connected) {
      setStatus("CSV loaded locally. Add Supabase credentials to make it live across computers.");
      setPage("display");
      return;
    }
    try {
      setBusy(true);
      await api("dk_appointments", { method: "DELETE", query: "board_id=eq." + encodeURIComponent(settings.boardId) });
      const body = newRows.map(function (r, i) { return toDbRow(r, settings.boardId, i); });
      if (body.length) await api("dk_appointments", { method: "POST", body: body });
      await saveSettingsCloud(settings);
      setStatus(String(newRows.length) + " appointments uploaded online. Other computers will update within a few seconds.");
      setPage("display");
    } catch (err) {
      setStatus("Upload error: " + String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function processCsv(text) {
    const parsed = parseCSV(text);
    const normalized = normalizeRows(parsed, settings.date, settings.boardId);
    await uploadRows(normalized);
  }

  async function handleFile(file) {
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    await processCsv(text);
  }

  async function toggleCheckin(row) {
    const now = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const nextChecked = !row.checked_in;
    const nextAt = nextChecked ? now : "";
    const nextRows = rows.map(function (r) { return r.id === row.id ? Object.assign({}, r, { checked_in: nextChecked, checked_in_at: nextAt }) : r; });
    setRows(nextRows);
    if (!connected) return;
    try {
      await api("dk_appointments", { method: "PATCH", query: "id=eq." + encodeURIComponent(row.id), body: { checked_in: nextChecked, checked_in_at: nextAt } });
      setStatus(nextChecked ? row.client_name + " checked in." : row.client_name + " unchecked.");
    } catch (err) {
      setStatus("Check-in sync error: " + String(err.message || err));
    }
  }

  async function setDisposition(row, disposition) {
    const nextStatus = row.status === disposition ? "pending" : disposition;
    const now = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const nextRows = rows.map(function (r) {
      if (r.id !== row.id) return r;
      return Object.assign({}, r, { status: nextStatus, checked_in: nextStatus === "sold" ? true : r.checked_in, checked_in_at: nextStatus === "sold" && !r.checked_in_at ? now : r.checked_in_at });
    });
    setRows(nextRows);
    if (!connected) return;
    try {
      const patch = { status: nextStatus };
      if (nextStatus === "sold") { patch.checked_in = true; patch.checked_in_at = row.checked_in_at || now; }
      await api("dk_appointments", { method: "PATCH", query: "id=eq." + encodeURIComponent(row.id), body: patch });
      setStatus(row.client_name + " marked " + nextStatus + ".");
    } catch (err) {
      setStatus("Disposition sync error: " + String(err.message || err));
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <nav className="sticky top-0 z-50 flex flex-wrap items-center gap-2 border-b border-white/10 bg-slate-950 p-3">
        <Tab active={page === "display"} onClick={function () { setPage("display"); }}>TV Display</Tab>
        <Tab active={page === "admin"} onClick={function () { setPage("admin"); }}>Admin Upload</Tab>
        <Tab active={page === "checkin"} onClick={function () { setPage("checkin"); }}>Check In</Tab>
        <Tab active={page === "setup"} onClick={function () { setPage("setup"); }}>Supabase Setup</Tab>
        <div className="ml-auto text-sm font-bold text-white/70">{connected ? "LIVE ONLINE" : "LOCAL DEMO"} • {rows.length} rows • {checkedCount} checked in</div>
      </nav>

      {status ? <div className="border-b border-white/10 bg-slate-900 px-4 py-2 text-sm font-bold text-amber-200">{busy ? "Working... " : ""}{status}</div> : null}

      {page === "display" ? <DisplayBoard rows={rows} settings={settings} boardDate={boardDate} checkedCount={checkedCount} soldCount={soldCount} /> : null}
      {page === "admin" ? <AdminPage settings={settings} saveSettingsCloud={saveSettingsCloud} csvText={csvText} setCsvText={setCsvText} processCsv={processCsv} handleFile={handleFile} rows={rows} connected={connected} loadCloud={loadCloud} refreshWeather={refreshWeather} /> : null}
      {page === "checkin" ? <CheckinPage rows={rows} toggleCheckin={toggleCheckin} setDisposition={setDisposition} boardDate={boardDate} /> : null}
      {page === "setup" ? <SetupPage sqlSetup={sqlSetup} /> : null}
    </div>
  );
}

function Tab({ active, onClick, children }) {
  return <button type="button" onClick={onClick} className={(active ? "bg-amber-400 text-slate-950" : "bg-white/10 text-white hover:bg-white/20") + " rounded-xl px-4 py-2 text-sm font-black shadow"}>{children}</button>;
}

function AdminPage({ settings, saveSettingsCloud, csvText, setCsvText, processCsv, handleFile, rows, connected, loadCloud, refreshWeather }) {
  function update(name, value) { saveSettingsCloud(Object.assign({}, settings, { [name]: value })); }
  return (
    <main className="mx-auto max-w-7xl p-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-3xl bg-white p-6 text-slate-950 shadow-2xl">
          <div className="text-sm font-black uppercase tracking-[0.25em] text-amber-600">Admin</div>
          <h1 className="mt-2 text-4xl font-black">Upload CSV & Control Live Board</h1>
          <p className="mt-2 text-slate-600">Upload the CSV here. If Supabase is connected, the TV display and check-in screen on other computers update automatically. You can save Supabase credentials permanently in Vercel Environment Variables so every device connects automatically.</p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Input label="Board ID" value={settings.boardId} onChange={function (v) { update("boardId", v); }} />
            <div className="sm:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="block text-xs font-black uppercase tracking-widest text-slate-600">Logo Image URL</label>
              <input value={settings.logoImage || ""} onChange={function (e) { update("logoImage", e.target.value); }} placeholder="Paste direct logo image URL, like https://example.com/logo.png" className="mt-3 w-full rounded-xl border border-slate-300 bg-white p-3 font-bold text-slate-950 outline-none focus:ring-4 focus:ring-amber-300" />
              {settings.logoImage ? <div className="mt-4"><img src={settings.logoImage} alt="Logo preview" className="max-h-28 rounded-xl bg-white object-contain p-2 shadow" /><button type="button" onClick={function () { update("logoImage", ""); }} className="mt-3 rounded-xl bg-rose-600 px-4 py-2 font-black text-white">Remove Logo</button></div> : <p className="mt-3 text-sm font-semibold text-slate-500">This replaces the top-left KIA / Daytona Kia text block on the TV display.</p>}
            </div>
            <Input label="Display Date" type="date" value={settings.date} onChange={function (v) { update("date", v); }} />
            <Input label="Temperature" value={settings.temp} onChange={function (v) { update("temp", v); }} />
            <Input label="Weather" value={settings.condition} onChange={function (v) { update("condition", v); }} />
            <Input label="Location" value={settings.location} onChange={function (v) { update("location", v); }} />
            <Input label="Vehicle Spotlight" value={settings.vehicleSpotlight} onChange={function (v) { update("vehicleSpotlight", v); }} />
            <div className="sm:col-span-2 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="block text-xs font-black uppercase tracking-widest text-slate-600">Telluride / Spotlight Image</label>
              <input value={settings.vehicleImage && settings.vehicleImage.indexOf("data:image") !== 0 ? settings.vehicleImage : ""} onChange={function (e) { update("vehicleImage", e.target.value); }} placeholder="Paste image URL here, like https://example.com/telluride.jpg" className="mt-3 w-full rounded-xl border border-slate-300 bg-white p-3 font-bold text-slate-950 outline-none focus:ring-4 focus:ring-amber-300" />
              <div className="mt-3 text-center text-xs font-black uppercase tracking-widest text-slate-400">or upload image file</div>
              <input type="file" accept="image/*" onChange={async function (e) { const file = e.target.files && e.target.files[0]; if (!file) return; const dataUrl = await fileToDataUrl(file); update("vehicleImage", dataUrl); }} className="mt-3 block w-full cursor-pointer rounded-xl border border-slate-300 bg-white p-3 font-bold text-slate-950" />
              {settings.vehicleImage ? <div className="mt-4"><img src={settings.vehicleImage} alt="Vehicle spotlight preview" className="max-h-40 rounded-xl object-cover shadow" /><button type="button" onClick={function () { update("vehicleImage", ""); }} className="mt-3 rounded-xl bg-rose-600 px-4 py-2 font-black text-white">Remove Image</button></div> : <p className="mt-3 text-sm font-semibold text-slate-500">Paste a public image URL, or upload a compressed JPG/PNG. It saves online and appears on the TV display.</p>}
            </div>
          </div>
          <div className="mt-8 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-5">
            <label className="block text-sm font-black uppercase tracking-widest text-slate-600">Upload CSV File</label>
            <input type="file" accept=".csv,text/csv" onChange={function (e) { handleFile(e.target.files && e.target.files[0]); }} className="mt-3 block w-full cursor-pointer rounded-xl border border-slate-300 bg-white p-3 font-bold text-slate-950" />
            <p className="mt-3 text-sm font-semibold text-slate-500">Uses Client, Salesperson/User, Appt Date, Type, and Vehicle. Extra columns are ignored.</p>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" onClick={function () { if (csvText.trim()) processCsv(csvText); }} className="rounded-xl bg-slate-950 px-5 py-3 font-black text-white shadow-lg">Load Pasted CSV</button>
            <button type="button" onClick={function () { loadCloud(false); }} className="rounded-xl bg-amber-400 px-5 py-3 font-black text-slate-950 shadow-lg">Refresh From Cloud</button>
            <button type="button" onClick={function () { refreshWeather(false); }} className="rounded-xl bg-blue-600 px-5 py-3 font-black text-white shadow-lg">Auto Update Date/Weather</button>
          </div>
          <div className={(connected ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900") + " mt-6 rounded-2xl p-4 font-black"}>{connected ? "Connected to Supabase for cross-computer live updates." : "Not connected yet. Add Supabase URL and anon key below."}</div>
        </section>

        <section className="rounded-3xl bg-white p-6 text-slate-950 shadow-2xl">
          <div className="text-sm font-black uppercase tracking-[0.25em] text-amber-600">Online Connection</div>
          <h2 className="mt-2 text-3xl font-black">Supabase Credentials</h2>
          <div className="mt-5 grid gap-4">
            <Input label="Supabase Project URL" value={settings.supabaseUrl} onChange={function (v) { update("supabaseUrl", v); }} placeholder="https://your-project.supabase.co" />
            <Input label="Supabase Anon Public Key" value={settings.supabaseAnonKey} onChange={function (v) { update("supabaseAnonKey", v); }} placeholder="eyJ..." />
          </div>
          <h2 className="mt-8 text-3xl font-black">Paste CSV Backup</h2>
          <textarea value={csvText} onChange={function (e) { setCsvText(e.target.value); }} className="mt-4 h-48 w-full rounded-2xl border border-slate-300 p-4 font-mono text-sm text-slate-950 outline-none focus:ring-4 focus:ring-amber-300" placeholder="Paste CSV here if file upload does not work." />
          <div className="mt-4 rounded-2xl bg-slate-100 p-4"><div className="font-black">Current Board Preview</div><div className="mt-1 text-sm font-semibold text-slate-600">{rows.length} rows loaded.</div><div className="mt-3 max-h-56 overflow-auto rounded-xl bg-white p-3 text-sm">{rows.length === 0 ? <div className="text-slate-500">No appointments loaded.</div> : rows.map(function (r) { return <div key={r.id} className="border-b border-slate-100 py-2"><b>{r.time_display || "Blank time"}</b> — {r.client_name} — {r.sales_consultant} {r.vehicle ? "— " + r.vehicle : ""}</div>; })}</div></div>
        </section>
      </div>
    </main>
  );
}

function Input({ label, value, onChange, type, placeholder }) {
  return <label className="block"><div className="mb-2 text-xs font-black uppercase tracking-widest text-slate-600">{label}</div><input type={type || "text"} value={value || ""} placeholder={placeholder || ""} onChange={function (e) { onChange(e.target.value); }} className="w-full rounded-xl border border-slate-300 px-4 py-3 text-lg font-bold text-slate-950 outline-none focus:ring-4 focus:ring-amber-300" /></label>;
}

function DisplayBoard({ rows, settings, boardDate, checkedCount, soldCount }) {
  const visibleRows = rows.slice(0, 24);
  const fillerRows = Array.from({ length: Math.max(0, 24 - visibleRows.length) });
  return (
    <div className="mx-auto flex min-h-[calc(100vh-93px)] w-screen flex-col overflow-hidden bg-white text-slate-950">
      <div className="grid flex-1 grid-cols-[5.2fr_1.25fr]">
        <main className="flex flex-col px-8 pt-5">
          <div className="grid grid-cols-[420px_1fr] items-center gap-8">
            <div className="border-r border-slate-300 pr-8">{settings.logoImage ? <div className="flex h-40 items-center justify-center overflow-visible"><img src={settings.logoImage} alt="Daytona Kia logo" className="max-h-40 w-[360px] max-w-full object-contain" /></div> : <><div className="text-7xl font-black tracking-[-0.12em]">KIA</div><div className="mt-2 text-3xl font-black tracking-[0.18em]">DAYTONA KIA</div><div className="mt-4 flex items-center gap-4 text-base font-bold uppercase tracking-[0.16em] text-amber-700"><span className="h-px flex-1 bg-amber-600" /> Movement That Inspires <span className="h-px flex-1 bg-amber-600" /></div></>}</div>
            <div className="text-center"><div className="text-4xl font-black uppercase tracking-[0.18em] text-amber-700">Welcome to Daytona Kia</div><div className="mt-4 text-7xl font-black uppercase tracking-[-0.03em] text-slate-950">VIP Appointments Today</div></div>
          </div>
          <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 shadow-xl">
            <div className="grid grid-cols-[1.02fr_1.28fr_1.08fr_1.28fr] bg-slate-950 text-white"><Header label="Appointment Time" icon="◷" /><Header label="Client Name" icon="👤" /><Header label="Sales Consultant" icon="👤" /><Header label="Vehicle" icon="▰" /></div>
            <div className="text-[28px] font-semibold tracking-wide">
              {visibleRows.map(function (row, idx) { return <div key={row.id} className={(row.status === "sold" ? "bg-amber-100" : row.checked_in ? "bg-emerald-50" : idx % 2 ? "bg-slate-50" : "bg-white") + " grid h-[54px] grid-cols-[1.02fr_1.28fr_1.08fr_1.28fr] items-center border-b border-slate-200"}><Cell center>{row.time_display}</Cell><Cell>{row.status === "sold" ? <span className="mr-2 rounded bg-amber-500 px-2 py-1 text-base font-black text-white">SOLD</span> : row.checked_in ? <span className="mr-2 text-emerald-600">✓</span> : null}{row.client_name}</Cell><Cell center>{row.sales_consultant}</Cell><Cell center>{row.vehicle}</Cell></div>; })}
              {fillerRows.map(function (_, idx) { return <div key={"filler-" + idx} className={(idx % 2 ? "bg-slate-50" : "bg-white") + " grid h-[54px] grid-cols-[1.02fr_1.28fr_1.08fr_1.28fr] items-center border-b border-slate-200"}><Cell /><Cell /><Cell /><Cell /></div>; })}
            </div>
          </div>
        </main>
        <aside className="flex flex-col bg-slate-950 text-white"><div className="border-b border-white/20 p-8"><div className="flex items-center gap-8"><div className="text-6xl text-amber-400">◫</div><div><div className="text-3xl font-bold uppercase tracking-widest">{formatWeekday(boardDate)}</div><div className="mt-3 text-5xl font-black uppercase tracking-wider">{formatDate(boardDate)}</div></div></div></div><div className="relative flex-1 overflow-hidden bg-gradient-to-b from-slate-800 to-slate-950 p-8"><div className="flex items-center gap-8"><div className="text-7xl">{weatherIcon(settings.condition)}</div><div className="text-7xl font-black">{settings.temp}</div></div><div className="mt-4 text-2xl font-bold uppercase tracking-widest">{settings.location}</div><div className="mt-3 text-2xl font-bold uppercase tracking-widest">{settings.condition}</div><div className="mt-10 rounded-3xl bg-black/30 p-6 shadow-2xl ring-1 ring-white/10"><div className="text-sm uppercase tracking-[0.3em] text-amber-400">Live Status</div><div className="mt-4 text-5xl font-black">{checkedCount}/{rows.length}</div><div className="mt-2 text-lg font-bold uppercase tracking-widest text-white/80">Checked In</div><div className="mt-4 text-4xl font-black text-amber-400">{soldCount}</div><div className="mt-1 text-lg font-bold uppercase tracking-widest text-white/80">Sold</div></div><div className="absolute bottom-8 left-6 right-6 overflow-hidden rounded-3xl border border-white/10 bg-black/30 text-center shadow-xl">{settings.vehicleImage ? <img src={settings.vehicleImage} alt="Vehicle spotlight" className="h-80 w-full object-cover" /> : <div className="flex h-80 items-center justify-center bg-gradient-to-br from-slate-800 to-slate-950 text-8xl">🚙</div>}<div className="bg-black/50 p-4 text-2xl font-black uppercase tracking-[0.18em]">{settings.vehicleSpotlight}</div></div></div></aside>
      </div>
      <footer className="grid h-[130px] grid-cols-[1fr_390px] items-center bg-slate-950 px-12 text-white"><div className="flex items-center gap-8"><div className="text-6xl text-amber-500">☆</div><div className="h-16 w-px bg-amber-500" /><div><div className="text-2xl font-bold uppercase tracking-[0.12em]">Thank you for choosing Daytona Kia! Please see reception upon arrival.</div><div className="mt-3 text-3xl font-black uppercase tracking-[0.13em] text-amber-500">We look forward to serving you!</div></div></div><div className="text-center text-3xl font-black italic uppercase tracking-[0.12em]">Movement That <span className="text-amber-500">Inspires</span></div></footer>
    </div>
  );
}

function CheckinPage({ rows, toggleCheckin, setDisposition, boardDate }) {
  return <main className="mx-auto max-w-6xl p-6"><div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><div className="text-sm font-bold uppercase tracking-[0.3em] text-amber-400">Daytona Kia</div><h1 className="mt-2 text-4xl font-black">Customer Check-In</h1><p className="mt-2 text-slate-300">{formatWeekday(boardDate)} • {formatDate(boardDate)}</p></div><div className="rounded-2xl bg-white/10 px-5 py-3 font-bold">Tap a button to update the TV board</div></div><div className="grid gap-3">{rows.length === 0 ? <div className="rounded-2xl bg-white p-8 text-center text-xl font-black text-slate-950">No appointments loaded. Go to Admin Upload first.</div> : null}{rows.map(function (row) { return <div key={row.id} className={(row.checked_in ? "bg-emerald-100" : "bg-white") + " grid grid-cols-[125px_1fr_auto] items-center gap-4 rounded-2xl p-4 text-slate-950 shadow-lg"}><div className="text-2xl font-black">{row.time_display || "—"}</div><div><div className="text-2xl font-black">{row.client_name}</div><div className="mt-1 text-sm font-semibold text-slate-600">{row.sales_consultant} {row.vehicle ? "• " + row.vehicle : ""}</div></div><div className="flex gap-2"><button type="button" onClick={function () { toggleCheckin(row); }} className={(row.checked_in ? "bg-emerald-600" : "bg-slate-950 hover:bg-slate-800") + " rounded-xl px-5 py-4 text-lg font-black text-white shadow"}>{row.checked_in ? "Checked " + row.checked_in_at : "Check In"}</button><button type="button" onClick={function () { setDisposition(row, "sold"); }} className={(row.status === "sold" ? "bg-amber-500" : "bg-amber-700 hover:bg-amber-800") + " rounded-xl px-5 py-4 text-lg font-black text-white shadow"}>{row.status === "sold" ? "Sold ✓" : "Sold"}</button></div></div>; })}</div></main>;
}

function SetupPage({ sqlSetup }) {
  return <main className="mx-auto max-w-5xl p-6"><section className="rounded-3xl bg-white p-6 text-slate-950 shadow-2xl"><div className="text-sm font-black uppercase tracking-[0.25em] text-amber-600">Supabase Setup</div><h1 className="mt-2 text-4xl font-black">Database Tables</h1><p className="mt-2 text-slate-600">In Supabase, open SQL Editor, paste this, and run it. Then copy your Project URL and anon public key into Admin Upload.</p><pre className="mt-6 overflow-auto rounded-2xl bg-slate-950 p-5 text-sm text-emerald-200">{sqlSetup}</pre></section></main>;
}

function Header({ label, icon }) { return <div className="flex h-16 items-center justify-center gap-3 border-r border-white/20 text-lg font-black uppercase tracking-widest"><span className="text-2xl">{icon}</span><span>{label}</span></div>; }
function Cell({ children, center }) { return <div className={(center ? "text-center " : "") + "truncate border-r border-slate-200 px-5"}>{children}</div>; }

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if (code === 34 && quoted && next === 34) { cell += String.fromCharCode(34); i++; }
    else if (code === 34) quoted = !quoted;
    else if (code === 44 && !quoted) { row.push(cell); cell = ""; }
    else if ((code === 10 || code === 13) && !quoted) { if (code === 13 && next === 10) i++; row.push(cell); if (row.some(function (v) { return clean(v); })) rows.push(row); row = []; cell = ""; }
    else cell += text[i];
  }
  row.push(cell);
  if (row.some(function (v) { return clean(v); })) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map(clean);
  return rows.slice(1).map(function (r) { const obj = {}; headers.forEach(function (h, i) { obj[h] = clean(r[i] || ""); }); return obj; });
}

function normalizeRows(rawRows, selectedDateString, boardId) {
  const target = new Date(selectedDateString + "T00:00:00").getTime();
  const mapped = rawRows.map(function (r, index) {
    const parsed = parseApptDate(r["Appt Date"]);
    const day = parsed ? new Date(parsed.year, parsed.month, parsed.day).getTime() : null;
    const salesRaw = clean(r["Salesperson/User"]);
    const client = titleName(r.Client);
    const apptRaw = clean(r["Appt Date"]);
    const sales = salesRaw ? titleName(salesRaw) : "VIP";
    const vehicle = titleName(r.Vehicle);
    return { id: makeId(boardId, client, apptRaw, sales, vehicle), board_id: boardId, client_name: client, source_type: clean(r.Type), sales_consultant: sales, appt_raw: apptRaw, appt_ms: parsed ? parsed.date.getTime() : null, appt_date: parsed ? toIsoDate(parsed.year, parsed.month, parsed.day) : null, day: day, time_display: parsed ? formatTimeParts(parsed.hour, parsed.minute) : "", vehicle: vehicle, checked_in: false, checked_in_at: "", status: "pending", sort_order: index };
  }).filter(function (r) { return r.client_name; }).filter(function (r) { return r.day === target || !r.appt_ms; });
  const best = new Map();
  mapped.forEach(function (r) { const key = r.client_name.toLowerCase() + "|" + (r.appt_raw || "blank"); const old = best.get(key); if (!old || scoreRow(r) > scoreRow(old)) best.set(key, r); });
  return Array.from(best.values()).sort(function (a, b) { if (a.appt_ms && b.appt_ms) return a.appt_ms - b.appt_ms || a.client_name.localeCompare(b.client_name); if (a.appt_ms && !b.appt_ms) return -1; if (!a.appt_ms && b.appt_ms) return 1; return a.client_name.localeCompare(b.client_name); }).map(function (r, i) { return Object.assign({}, r, { sort_order: i }); });
}

function parseApptDate(value) {
  const raw = clean(value);
  if (!raw) return null;
  const parts = raw.split(" ");
  if (parts.length < 3) return null;
  const dateBits = parts[0].split("/").map(Number);
  const timeBits = parts[1].split(":").map(Number);
  if (dateBits.length !== 3 || timeBits.length < 2) return null;
  let hour = timeBits[0];
  const minute = timeBits[1];
  const ampm = String(parts[2]).toUpperCase();
  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  const date = new Date(dateBits[2], dateBits[0] - 1, dateBits[1], hour, minute);
  if (Number.isNaN(date.getTime())) return null;
  return { date: date, year: dateBits[2], month: dateBits[0] - 1, day: dateBits[1], hour: hour, minute: minute };
}

function toDbRow(r, boardId, i) { return { id: r.id, board_id: boardId, appt_date: r.appt_date, appt_ms: r.appt_ms, appt_raw: r.appt_raw, time_display: r.time_display, client_name: r.client_name, sales_consultant: r.sales_consultant, vehicle: r.vehicle, source_type: r.source_type, checked_in: Boolean(r.checked_in), checked_in_at: r.checked_in_at || "", status: r.status || "pending", sort_order: i }; }
function fromDbRow(r) { return { id: r.id, board_id: r.board_id, appt_date: r.appt_date, appt_ms: r.appt_ms, appt_raw: r.appt_raw || "", time_display: r.time_display || "", client_name: r.client_name || "", sales_consultant: r.sales_consultant || "VIP", vehicle: r.vehicle || "", source_type: r.source_type || "", checked_in: Boolean(r.checked_in), checked_in_at: r.checked_in_at || "", status: r.status || "pending", sort_order: r.sort_order || 0 }; }
function makeId(boardId, client, apptRaw, sales, vehicle) { return slug(boardId + "-" + client + "-" + (apptRaw || "blank") + "-" + sales + "-" + vehicle); }
function slug(s) { return String(s).toLowerCase().split("").map(function (ch) { const ok = "abcdefghijklmnopqrstuvwxyz0123456789".indexOf(ch) >= 0; return ok ? ch : "-"; }).join("").replaceAll("---", "-").replaceAll("--", "-").slice(0, 180); }
function toIsoDate(year, month, day) { return String(year) + "-" + String(month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0"); }
function formatTimeParts(hour24, minute) { let h = hour24; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return String(h) + ":" + String(minute).padStart(2, "0") + ":00 " + ap; }
function formatDate(date) { return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }).toUpperCase(); }
function todayIso() { const d = new Date(); return String(d.getFullYear()) + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function weatherCodeLabel(code) { const c = Number(code); if (c === 0) return "Clear"; if ([1, 2].indexOf(c) >= 0) return "Partly Cloudy"; if (c === 3) return "Cloudy"; if ([45, 48].indexOf(c) >= 0) return "Fog"; if ([51, 53, 55, 56, 57].indexOf(c) >= 0) return "Drizzle"; if ([61, 63, 65, 66, 67, 80, 81, 82].indexOf(c) >= 0) return "Rain"; if ([71, 73, 75, 77, 85, 86].indexOf(c) >= 0) return "Snow"; if ([95, 96, 99].indexOf(c) >= 0) return "Thunderstorms"; return "Cloudy"; }
function weatherIcon(condition) { const c = String(condition || "").toLowerCase(); if (c.indexOf("thunder") >= 0) return "⛈️"; if (c.indexOf("rain") >= 0 || c.indexOf("drizzle") >= 0) return "🌧️"; if (c.indexOf("snow") >= 0) return "❄️"; if (c.indexOf("fog") >= 0) return "🌫️"; if (c.indexOf("partly") >= 0) return "🌤️"; if (c.indexOf("clear") >= 0 || c.indexOf("sun") >= 0) return "☀️"; if (c.indexOf("cloud") >= 0 || c.indexOf("overcast") >= 0) return "☁️"; return "☁️"; }
function formatWeekday(date) { return date.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase(); }
function scoreRow(r) { let score = 0; if (r.sales_consultant && r.sales_consultant !== "VIP") score += 100; if (r.vehicle) score += 50; if (r.appt_ms) score += 25; if (String(r.source_type).toLowerCase().indexOf("walk-in") >= 0) score += 5; return score; }
function clean(value) { return String(value == null ? "" : value).trim(); }
function titleName(value) { const s = clean(value); if (!s) return ""; return s.toLowerCase().split(" ").map(function (word) { return word.split("-").map(function (part) { return part.charAt(0).toUpperCase() + part.slice(1); }).join("-"); }).join(" ").replace("Rav4", "RAV4").replace("Ev6", "EV6").replace("Ev9", "EV9"); }
function rowKey(row) { return row.id; }
function readJson(key, fallback) { try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch (e) { return fallback; } }
function trimSlash(s) {
  return String(s || "")
    .trim()
    .replace(/\/rest\/v1\/?$/i, "")
    .replace(/\/$/, "");
}
function fileToDataUrl(file) { return new Promise(function (resolve, reject) { const reader = new FileReader(); reader.onload = function () { resolve(String(reader.result || "")); }; reader.onerror = reject; reader.readAsDataURL(file); }); }
