import { Routes, Route, Navigate } from "react-router-dom";
import { EnvList } from "./pages/EnvList";
import { EnvDetail } from "./pages/EnvDetail";
import { Header } from "./components/Header";

export function App() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<EnvList />} />
        <Route path="/env/:slug" element={<EnvDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
