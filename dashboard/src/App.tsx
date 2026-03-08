import { Routes, Route, Navigate } from "react-router-dom";
import { VMList } from "./pages/VMList";
import { VMDetail } from "./pages/VMDetail";
import { Deploy } from "./pages/Deploy";
import { Plan } from "./pages/Plan";
import { Usage } from "./pages/Usage";
import { Settings } from "./pages/Settings";
import { LinkSshKey } from "./pages/LinkSshKey";
import { Header } from "./components/Header";

export function App() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<VMList />} />
        <Route path="/deploy" element={<Deploy />} />
        <Route path="/vm/:slug" element={<VMDetail />} />
        <Route path="/plan" element={<Plan />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/link-ssh" element={<LinkSshKey />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
