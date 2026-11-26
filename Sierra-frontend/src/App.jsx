import { Routes, Route } from "react-router-dom";
import Shell from "./components/Shell";
import Dashboard from "./pages/Dashboard";
import CreateProject from "./pages/CreateProject";
import ProjectView from "./pages/ProjectView";
import Runs from "./pages/Runs";
import DesignWorkspace from "./pages/DesignWorkspace";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import Diagrams from "./pages/Diagrams";
import RequireAuth from "./components/RequireAuth";
import { AuthProvider } from "./context/AuthContext";

export default function App() {
  return (
    <AuthProvider>
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/new" element={<CreateProject />} />
        <Route path="/design" element={<DesignWorkspace />} />
        <Route path="/runs" element={<Runs />} />
        <Route path="/login" element={<Login />} />
        <Route path="/diagrams" element={<RequireAuth><Diagrams /></RequireAuth>} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/project/:id" element={<ProjectView />} />
      </Routes>
    </Shell>
    </AuthProvider>
  );
}
