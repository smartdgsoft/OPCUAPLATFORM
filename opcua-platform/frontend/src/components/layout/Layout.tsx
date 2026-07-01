import React, { useState } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, History, Bell, Building2, BarChart3,
         Tag, LogOut, Menu, X, Wifi, Send, Zap, Boxes, Brain, ShieldCheck, Plug, Sparkles } from "lucide-react";
import { useAuthStore } from "../../store/authStore";
import { useFeatures } from "../../hooks/useFeatures";

export default function Layout() {
  const [open, setOpen] = useState(true);
  const { user, clearAuth } = useAuthStore();
  const nav = useNavigate();
  const features = useFeatures();

  const NAV = [
    { to: "/dashboard", label: "Dashboard",    Icon: LayoutDashboard, always: true },
    { to: "/opcua",     label: "OPC UA Client",Icon: Wifi,            always: true },
    { to: "/connectivity",label: "Data Sources", Icon: Plug,          always: features.connector_hub },
    { to: "/write",     label: "Write Control",Icon: Send,            always: features.write },
    { to: "/methods",   label: "Methods",      Icon: Zap,             always: features.methods },
    { to: "/history",   label: "History",      Icon: History,         always: true },
    { to: "/alarms",    label: "Alarms",       Icon: Bell,            always: true },
    { to: "/assets",    label: "Assets",       Icon: Building2,       always: true },
    { to: "/twin",      label: "Digital Twin", Icon: Boxes,           always: features.digital_twin },
    { to: "/predictive",label: "Predictive",   Icon: Brain,           always: features.twin_predictive },
    { to: "/closed-loop",label: "Closed-Loop",  Icon: ShieldCheck,     always: features.closed_loop_advisory },
    { to: "/solvers",   label: "Problem Solvers",Icon: Sparkles,       always: features.problem_templates },
    { to: "/analytics", label: "Analytics",    Icon: BarChart3,       always: true },
    { to: "/tags",      label: "Tags",         Icon: Tag,             always: true },
  ].filter(n => n.always);

  const logout = () => { clearAuth(); nav("/login"); };

  return (
    <div style={{ display: "flex", height: "100vh", background: "#f4f5f7", fontFamily: "system-ui, sans-serif" }}>
      <style>{`
        nav::-webkit-scrollbar { width: 6px; }
        nav::-webkit-scrollbar-track { background: transparent; }
        nav::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
        nav::-webkit-scrollbar-thumb:hover { background: #475569; }
        nav { scrollbar-width: thin; scrollbar-color: #334155 transparent; }
      `}</style>
      <aside style={{ width: open ? 220 : 60, background: "#0f172a", display: "flex",
        flexDirection: "column", transition: "width 0.2s", flexShrink: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 12px", display: "flex", alignItems: "center", gap: 10,
          borderBottom: "1px solid #1e293b" }}>
          <Wifi size={22} color="#38bdf8" style={{ flexShrink: 0 }} />
          {open && <span style={{ color: "#f1f5f9", fontWeight: 600, fontSize: 15, whiteSpace: "nowrap" }}>
            OPC UA Platform
          </span>}
          <button onClick={() => setOpen(!open)} style={{ marginLeft: "auto", background: "none",
            border: "none", color: "#94a3b8", cursor: "pointer", padding: 4 }}>
            {open ? <X size={16} /> : <Menu size={16} />}
          </button>
        </div>
        <nav style={{ flex: 1, padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2,
          overflowY: "auto", overflowX: "hidden", minHeight: 0 }}>
          {NAV.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} style={{ textDecoration: "none" }}>
              {({ isActive }) => (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px",
                  borderRadius: 8, background: isActive ? "#1e3a5f" : "transparent",
                  color: isActive ? "#38bdf8" : "#94a3b8", cursor: "pointer", whiteSpace: "nowrap" }}>
                  <Icon size={18} style={{ flexShrink: 0 }} />
                  {open && <span style={{ fontSize: 14 }}>{label}</span>}
                </div>
              )}
            </NavLink>
          ))}
        </nav>
        <div style={{ padding: "12px 8px", borderTop: "1px solid #1e293b" }}>
          {open && (
            <div style={{ padding: "6px 10px", marginBottom: 6 }}>
              <div style={{ color: "#f1f5f9", fontSize: 13, fontWeight: 500 }}>{user?.username}</div>
              <div style={{ color: "#64748b", fontSize: 11 }}>{user?.role}</div>
            </div>
          )}
          <button onClick={logout} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10,
            padding: "9px 10px", borderRadius: 8, background: "none", border: "none",
            color: "#94a3b8", cursor: "pointer" }}>
            <LogOut size={18} style={{ flexShrink: 0 }} />
            {open && <span style={{ fontSize: 14 }}>Logout</span>}
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, overflow: "auto", padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}
