import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Layout from "./components/layout/Layout";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import HistoryPage from "./pages/HistoryPage";
import AlarmsPage from "./pages/AlarmsPage";
import AssetsPage from "./pages/AssetsPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import TagsPage from "./pages/TagsPage";
import OpcUAClientPage from "./pages/OpcUAClientPage";
import WriteControlPage from "./pages/WriteControlPage";
import MethodCallPage from "./pages/MethodCallPage";
import DigitalTwinPage from "./pages/DigitalTwinPage";
import { useAuthStore } from "./store/authStore";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard"  element={<DashboardPage />} />
            <Route path="opcua"      element={<OpcUAClientPage />} />
            <Route path="write"      element={<WriteControlPage />} />
            <Route path="methods"    element={<MethodCallPage />} />
            <Route path="history"    element={<HistoryPage />} />
            <Route path="alarms"     element={<AlarmsPage />} />
            <Route path="assets"     element={<AssetsPage />} />
            <Route path="twin"        element={<DigitalTwinPage />} />
            <Route path="analytics"  element={<AnalyticsPage />} />
            <Route path="tags"       element={<TagsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
