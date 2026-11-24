import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { features } from "./access.js";
import { useAuth } from "../features/auth/AuthProvider.jsx";
import Layout from "../components/Layout.jsx";
import { Button, Card, Title } from "../components/ui.jsx";
import SignInPage from "../pages/auth/SignInPage.jsx";
import HomePage from "../pages/home/HomePage.jsx";
import ProfilePage from "../pages/profile/ProfilePage.jsx";
import AnalyticsPage from "../pages/workforce/AnalyticsPage.jsx";
import AttendancePage from "../pages/workforce/AttendancePage.jsx";
import ShiftsPage from "../pages/workforce/ShiftsPage.jsx";
import OrdersPage from "../pages/orders/OrdersPage.jsx";
import OrderDetailPage from "../pages/orders/OrderDetailPage.jsx";
import PeoplePage from "../pages/people/PeoplePage.jsx";
import StationsPage from "../pages/stations/StationsPage.jsx";
import FuelPricesPage from "../pages/pricing/FuelPricesPage.jsx";
import NotFoundPage from "../pages/NotFoundPage.jsx";

function Require({ path, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/" replace />;
  if (path && !features.find((feature) => feature.path === path).show(user)) {
    return (
      <>
        <Title title="Access unavailable" />
        <Card>
          <p className="muted">
            Your account does not have access to this page.
          </p>
          <Button to="/home">Back to home</Button>
        </Card>
      </>
    );
  }
  return children ?? <Outlet />;
}

export default function App() {
  const { loading, error, retry } = useAuth();
  if (loading)
    return (
      <main className="standalone">
        <p role="status">Connecting to SmartStation…</p>
      </main>
    );
  if (error)
    return (
      <main className="standalone">
        <Card title="Could not connect">
          <p role="alert">{error.message}</p>
          <Button onClick={retry}>Retry connection</Button>
        </Card>
      </main>
    );
  return (
    <Routes>
      <Route path="/" element={<SignInPage />} />
      <Route element={<Require />}>
        <Route element={<Layout />}>
          <Route path="/home" element={<HomePage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route
            path="/orders"
            element={
              <Require path="/orders">
                <OrdersPage />
              </Require>
            }
          />
          <Route
            path="/orders/:id"
            element={
              <Require path="/orders">
                <OrderDetailPage />
              </Require>
            }
          />
          <Route
            path="/attendance"
            element={
              <Require path="/attendance">
                <AttendancePage />
              </Require>
            }
          />
          <Route
            path="/shifts"
            element={
              <Require path="/shifts">
                <ShiftsPage />
              </Require>
            }
          />
          <Route
            path="/reports"
            element={
              <Require path="/reports">
                <AnalyticsPage />
              </Require>
            }
          />
          <Route
            path="/people"
            element={
              <Require path="/people">
                <PeoplePage />
              </Require>
            }
          />
          <Route
            path="/stations"
            element={
              <Require path="/stations">
                <StationsPage />
              </Require>
            }
          />
          <Route
            path="/fuel"
            element={
              <Require path="/fuel">
                <FuelPricesPage />
              </Require>
            }
          />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
