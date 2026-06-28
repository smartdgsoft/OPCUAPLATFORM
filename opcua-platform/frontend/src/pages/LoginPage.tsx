import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Wifi } from "lucide-react";
import { login } from "../services/api";
import { useAuthStore } from "../store/authStore";

export default function LoginPage() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuthStore();
  const nav = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await login(username, password);
      setAuth(result.access_token, result.user);
      nav("/dashboard");
    } catch {
      setError("Invalid username or password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", background: "#0f172a",
    }}>
      <div style={{
        background: "#1e293b", borderRadius: 16, padding: "40px 36px",
        width: 360, boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32 }}>
          <Wifi size={28} color="#38bdf8" />
          <div>
            <div style={{ color: "#f1f5f9", fontSize: 18, fontWeight: 600 }}>OPC UA Platform</div>
            <div style={{ color: "#64748b", fontSize: 12 }}>Industrial Intelligence</div>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ color: "#94a3b8", fontSize: 13, display: "block", marginBottom: 6 }}>Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 8,
                background: "#0f172a", border: "1px solid #334155",
                color: "#f1f5f9", fontSize: 14, boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{ color: "#94a3b8", fontSize: 13, display: "block", marginBottom: 6 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 8,
                background: "#0f172a", border: "1px solid #334155",
                color: "#f1f5f9", fontSize: 14, boxSizing: "border-box",
              }}
            />
          </div>

          {error && (
            <div style={{ background: "#450a0a", color: "#fca5a5", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%", padding: "11px", borderRadius: 8,
              background: loading ? "#334155" : "#0ea5e9",
              border: "none", color: "#fff", fontSize: 15,
              fontWeight: 500, cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <div style={{ marginTop: 20, color: "#475569", fontSize: 12, textAlign: "center" }}>
          Default: admin / Admin@123
        </div>
      </div>
    </div>
  );
}
