/**
 * Routing.
 *
 * One surface, one operator. The agency/portal/admin split is gone, and with it
 * the route guards that decided which of the three a signed-in user belonged
 * to: there is now a single authenticated area and a single public page.
 */

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { useAuth } from './lib/auth';
import { AppShell } from './components/layout';
import { Spinner } from './components/ui';

import { LoginPage } from './routes/auth';
import { DashboardPage } from './routes/dashboard';
import { RestaurantWorkspacePage, RestaurantsPage } from './routes/restaurants';
import { CampaignDetailPage, CampaignsPage } from './routes/campaigns';
import { AdDetailPage, AdsPage } from './routes/ads';
import { ContentDetailPage, ContentPage } from './routes/content';
import { AiStudioPage } from './routes/studio';
import { BrandPage } from './routes/brand';
import { CalendarPage, MediaPage, NotificationsPage, SettingsPage } from './routes/workspace';
import { TasksPage } from './routes/tasks';
import { AnalyticsPage, ReportDetailPage, ReportsPage } from './routes/insights';

function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center bg-bg">
      <Spinner className="h-7 w-7" />
    </div>
  );
}

function Guard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/*"
        element={
          <Guard>
            <AppShell>
              <Routes>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<DashboardPage />} />
                <Route path="restaurants" element={<RestaurantsPage />} />
                <Route path="restaurants/:id" element={<RestaurantWorkspacePage />} />
                <Route path="restaurants/:id/:tab" element={<RestaurantWorkspacePage />} />
                <Route path="content" element={<ContentPage />} />
                <Route path="content/:id" element={<ContentDetailPage />} />
                <Route path="campaigns" element={<CampaignsPage />} />
                <Route path="campaigns/:id" element={<CampaignDetailPage />} />
                <Route path="ads" element={<AdsPage />} />
                <Route path="ads/:id" element={<AdDetailPage />} />
                <Route path="calendar" element={<CalendarPage />} />
                <Route path="media" element={<MediaPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="reports/:id" element={<ReportDetailPage />} />
                <Route path="ai" element={<AiStudioPage />} />
                <Route path="tasks" element={<TasksPage />} />
                <Route path="brand" element={<BrandPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="dashboard" replace />} />
              </Routes>
            </AppShell>
          </Guard>
        }
      />
    </Routes>
  );
}
