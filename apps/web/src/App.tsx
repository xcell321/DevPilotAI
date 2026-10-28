import { lazy, useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { NewSessionDialog } from './components/NewSessionDialog';
import { useBackend } from './hooks/useBackend';

const CliToolsPage = lazy(() =>
  import('./pages/CliToolsPage').then((module) => ({ default: module.CliToolsPage })),
);
const NotFoundPage = lazy(() =>
  import('./pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })),
);
const OverviewPage = lazy(() =>
  import('./pages/OverviewPage').then((module) => ({ default: module.OverviewPage })),
);
const ProjectsPage = lazy(() =>
  import('./pages/ProjectsPage').then((module) => ({ default: module.ProjectsPage })),
);
const SessionsPage = lazy(() =>
  import('./pages/SessionsPage').then((module) => ({ default: module.SessionsPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const TerminalsPage = lazy(() =>
  import('./pages/TerminalsPage').then((module) => ({ default: module.TerminalsPage })),
);

export default function App() {
  const backend = useBackend();
  const navigate = useNavigate();
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  return (
    <>
      <Routes>
        <Route
          element={
            <AppLayout backend={backend} onNewSession={() => setNewSessionOpen(true)} />
          }
        >
          <Route index element={<OverviewPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="terminals" element={<TerminalsPage />} />
          <Route path="tools" element={<CliToolsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>

      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        tools={backend.overview?.tools ?? []}
        onCreated={() => {
          setNewSessionOpen(false);
          navigate('/sessions');
          void backend.refresh();
        }}
      />
    </>
  );
}
