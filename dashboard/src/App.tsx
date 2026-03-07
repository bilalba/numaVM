import { Routes, Route, Navigate } from "react-router-dom";
import { EnvList } from "./pages/EnvList";
import { EnvDetail } from "./pages/EnvDetail";
import { Deploy } from "./pages/Deploy";
import { Plan } from "./pages/Plan";
import { Settings } from "./pages/Settings";
import { LinkSshKey } from "./pages/LinkSshKey";
import { Header } from "./components/Header";

export function App() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<EnvList />} />
        <Route path="/deploy" element={<Deploy />} />
        <Route path="/env/:slug" element={<EnvDetail />} />
        <Route path="/plan" element={<Plan />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/link-ssh" element={<LinkSshKey />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
