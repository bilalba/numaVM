import { Routes, Route, Navigate } from "react-router-dom";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { Overview } from "./pages/Overview";
import { Users } from "./pages/Users";
import { VMs } from "./pages/VMs";
import { Sessions } from "./pages/Sessions";
import { Events } from "./pages/Events";
import { Traffic } from "./pages/Traffic";

export function App() {
  return (
    <div className="flex flex-col h-screen">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto p-6">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/users" element={<Users />} />
            <Route path="/vms" element={<VMs />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/events" element={<Events />} />
            <Route path="/traffic" element={<Traffic />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
