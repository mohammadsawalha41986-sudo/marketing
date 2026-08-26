/** Routing and role-based route guards. */

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { useAuth } from './lib/auth';
import { AppShell } from './components/layout';
import { Spinner } from './components/ui';

import { ForgotPasswordPage, LoginPage, RegisterPage } from './routes/auth';
import { DashboardPage } from './routes/dashboard';
import { CeoPage } from './routes/ceo';
import { ClientDetailPage, ClientsPage } from './routes/clients';
import { CampaignDetailPage, CampaignsPage } from './routes/campaigns';
import { ContentDetailPage, ContentPage, StudioPage } from './routes/content';
import { SocialPostsPage, SocialPostPage } from './routes/social';
import { LibraryPage } from './routes/library';
import { MarketingOverviewPage, PlatformWorkspacePage } from './routes/marketing';
import { ReportBuilderListPage, ReportBuilderPage } from './routes/report-builder';
import { GoogleSectionPage } from './routes/google';
import { SocialCalendarPage } from './routes/social-calendar';
import { SocialAnalyticsPage } from './routes/social-analytics';
import { BrandPage } from './routes/brand';
import { ImageAdsPage, VideoAdsPage } from './routes/ads';
import { CreativesPage } from './routes/creatives';
import { CreativePerformancePage } from './routes/creative-performance';
import { MetaCampaignsPage } from './routes/publishing';
import {
  ApprovalsPage, CalendarPage, IntegrationsPage, MediaPage, NotificationsPage, SettingsPage,
} from './routes/workspace';
import { AnalyticsPage, ReportDetailPage, ReportsPage } from './routes/insights';
import {
  AdminAuditPage, AdminClientsPage, AdminDashboardPage, AdminPlansPage, AdminSettingsPage,
  AdminSubscriptionsPage, AdminUsersPage,
} from './routes/admin';

function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center bg-bg">
      <Spinner className="h-7 w-7" />
    </div>
  );
}

/** Requires a session; optionally restricts to agency-side or super-admin roles. */
function Guard({ children, need }: { children: ReactNode; need?: 'agency' | 'superAdmin' }) {
  const { user, loading, isAgency, isSuperAdmin, isClientUser } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;

  // A portal user landing on an agency route is sent to their own dashboard
  // rather than shown an error — the route simply is not theirs.
  if (need === 'agency' && !isAgency) return <Navigate to="/client/dashboard" replace />;
  if (need === 'superAdmin' && !isSuperAdmin) return <Navigate to={isClientUser ? '/client/dashboard' : '/app/dashboard'} replace />;

  return <>{children}</>;
}

function ClientGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

/** Sends a signed-in user to the surface that matches their role. */
function RoleHome() {
  const { user, loading, isClientUser } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={isClientUser ? '/client/dashboard' : '/app/dashboard'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />

      <Route path="/" element={<RoleHome />} />

      {/* Agency workspace */}
      <Route
        path="/app/*"
        element={
          <Guard need="agency">
            <AppShell variant="agency">
              <Routes>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<DashboardPage />} />
                <Route path="ceo" element={<CeoPage />} />
                {/*
                  * Restaurants and clients are the same page. The nav says
                  * restaurants because that is what they are; /app/clients stays
                  * routed so existing links, bookmarks and the rows that link to
                  * /app/clients/:id keep resolving.
                  */}
                <Route path="restaurants" element={<ClientsPage />} />
                <Route path="restaurants/:id" element={<ClientDetailPage />} />
                <Route path="clients" element={<ClientsPage />} />
                <Route path="clients/:id" element={<ClientDetailPage />} />
                <Route path="brand" element={<BrandPage />} />
                <Route path="media" element={<MediaPage />} />
                <Route path="content" element={<ContentPage />} />
                <Route path="content/:id" element={<ContentDetailPage />} />
                {/* The content command centre. Platform is a route segment so
                    "everything on Instagram" is a place, not a filter state. */}
                {/* The Google workspace. One route entry; the section resolves
                    inside, so the group shares its loading and empty states. */}
                <Route path="google" element={<GoogleSectionPage />} />
                <Route path="google/:section" element={<GoogleSectionPage />} />
                <Route path="marketing" element={<MarketingOverviewPage />} />
                <Route path="marketing/:platform" element={<PlatformWorkspacePage />} />
                <Route path="library" element={<LibraryPage />} />
                <Route path="library/:platform" element={<LibraryPage />} />
                <Route path="social" element={<SocialPostsPage />} />
                <Route path="social/calendar" element={<SocialCalendarPage />} />
                <Route path="social/analytics" element={<SocialAnalyticsPage />} />
                <Route path="social/:id" element={<SocialPostPage />} />
                <Route path="creatives" element={<CreativesPage />} />
                <Route path="image-ads" element={<ImageAdsPage />} />
                <Route path="video-ads" element={<VideoAdsPage />} />
                <Route path="studio" element={<StudioPage />} />
                <Route path="meta-campaigns" element={<MetaCampaignsPage />} />
                <Route path="campaigns" element={<CampaignsPage />} />
                <Route path="campaigns/:id" element={<CampaignDetailPage />} />
                <Route path="calendar" element={<CalendarPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="creative-performance" element={<CreativePerformancePage />} />
                <Route path="reports" element={<ReportsPage />} />
                {/* Declared before reports/:id so "builder" is not read as an id. */}
                <Route path="reports/builders" element={<ReportBuilderListPage />} />
                <Route path="reports/builder" element={<ReportBuilderPage />} />
                <Route path="reports/builder/:id" element={<ReportBuilderPage />} />
                <Route path="reports/:id" element={<ReportDetailPage />} />
                <Route path="approvals" element={<ApprovalsPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="integrations" element={<IntegrationsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="dashboard" replace />} />
              </Routes>
            </AppShell>
          </Guard>
        }
      />

      {/* Client portal */}
      <Route
        path="/client/*"
        element={
          <ClientGuard>
            <AppShell variant="client">
              <Routes>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<DashboardPage portal />} />
                <Route path="ceo" element={<CeoPage portal />} />
                <Route path="campaigns" element={<CampaignsPage portal />} />
                <Route path="campaigns/:id" element={<CampaignDetailPage portal />} />
                <Route path="content" element={<ContentPage portal />} />
                <Route path="content/:id" element={<ContentDetailPage portal />} />
                <Route path="approvals" element={<ApprovalsPage portal />} />
                <Route path="calendar" element={<CalendarPage portal />} />
                <Route path="analytics" element={<AnalyticsPage portal />} />
                <Route path="reports" element={<ReportsPage portal />} />
                <Route path="reports/:id" element={<ReportDetailPage />} />
                <Route path="brand" element={<BrandPage portal />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="*" element={<Navigate to="dashboard" replace />} />
              </Routes>
            </AppShell>
          </ClientGuard>
        }
      />

      {/* Super admin */}
      <Route
        path="/admin/*"
        element={
          <Guard need="superAdmin">
            <AppShell variant="admin">
              <Routes>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<AdminDashboardPage />} />
                <Route path="clients" element={<AdminClientsPage />} />
                <Route path="users" element={<AdminUsersPage />} />
                <Route path="plans" element={<AdminPlansPage />} />
                <Route path="subscriptions" element={<AdminSubscriptionsPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="audit" element={<AdminAuditPage />} />
                <Route path="settings" element={<AdminSettingsPage />} />
                <Route path="*" element={<Navigate to="dashboard" replace />} />
              </Routes>
            </AppShell>
          </Guard>
        }
      />

      <Route path="*" element={<RoleHome />} />
    </Routes>
  );
}
